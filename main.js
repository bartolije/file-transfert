const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { CYBERDUCK, readDuckFiles, cleanBookmark, keychainPassword, connect, createQueue, summarize } = require('./backends')
const { latestUpdate, installUpdate } = require('./update')

// ~/Library/Application Support/File Transfert/
const DATA = app.getPath('userData')
const STORE = path.join(DATA, 'bookmarks.json') // favoris, dans l'ordre d'affichage
const SECRETS = path.join(DATA, 'secrets.json') // mots de passe chiffrés par safeStorage (clé du Trousseau réservée à l'appli)
const OLD_BOOKMARKS = path.join(DATA, 'Bookmarks') // copies .duck des versions 0.1.x

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fallback } }
const writeJson = (f, v) => { // écriture atomique : un plantage ne laisse jamais un fichier à moitié écrit
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 })
  fs.renameSync(f + '.tmp', f)
}

let win
let bookmarks = []
let secrets = readJson(SECRETS, {})
const passwords = {} // promesse du mot de passe par favori, le temps de la session
const browse = {} // session dédiée à la navigation, par favori
const idle = {} // sessions de transfert libres, par favori
const byId = id => bookmarks.find(b => b.id === id) ?? (() => { throw new Error('Favori inconnu') })()
const publicList = () => bookmarks.map(b => ({ ...b, hasSecret: b.id in secrets }))
const saveBookmarks = () => writeJson(STORE, bookmarks)

function saveSecret(id, pwd) {
  if (!safeStorage.isEncryptionAvailable()) return // garde en mémoire seulement
  secrets[id] = safeStorage.encryptString(pwd).toString('base64')
  writeJson(SECRETS, secrets)
}

// Mot de passe : copie chiffrée de l'appli, sinon Trousseau de Cyberduck (une demande macOS, puis copie chiffrée).
function secretFor(b) {
  return (passwords[b.id] ??= (async () => {
    if (secrets[b.id]) try { return safeStorage.decryptString(Buffer.from(secrets[b.id], 'base64')) } catch {}
    const pwd = await keychainPassword(b)
    if (pwd) saveSecret(b.id, pwd)
    return pwd
  })())
}

// Coupe les connexions d'un favori modifié ou supprimé.
function forget(id) {
  delete passwords[id]
  dropBrowse(id)
  idle[id]?.splice(0).forEach(s => s.close())
}

const confirmHostKey = (b, fingerprint) => dialog.showMessageBox(win, {
  type: 'warning', buttons: ['Refuser', 'Faire confiance'], defaultId: 0, cancelId: 0,
  message: `Clé d'hôte inconnue pour ${b.host}:${b.port}`,
  detail: `Empreinte ${fingerprint}\nElle sera ajoutée à ~/.ssh/known_hosts.`,
}).then(r => r.response === 1)

async function open(id) {
  const b = byId(id)
  return connect(b, await secretFor(b), confirmHostKey) // promesse partagée : une seule lecture même si plusieurs connexions s'ouvrent ensemble
}

const dropBrowse = id => {
  browse[id]?.then(s => s.close(), () => {})
  delete browse[id]
}

// Navigation : une session réutilisée ; si une session ancienne échoue (coupée par le serveur), un essai avec une neuve.
async function withBrowse(id, f) {
  const fresh = !browse[id]
  browse[id] ??= open(id)
  try {
    return await f(await browse[id])
  } catch (e) {
    dropBrowse(id)
    if (fresh) throw e
    return withBrowse(id, f)
  }
}

async function withSession(id, f) {
  const s = idle[id]?.pop() ?? (await open(id))
  try {
    const r = await f(s)
    ;(idle[id] ??= []).push(s)
    return r
  } catch (e) {
    s.close()
    throw e
  }
}

// ---------- Transferts ----------
let jobs = []
let overwrite = false
const queue = createQueue(runJob, () => {
  if (!queue.running && !queue.pending) for (const id in idle) idle[id].splice(0).forEach(s => s.close()) // évite les connexions mortes au prochain lot
  notify()
})

async function runJob(j) {
  j.status = 'en cours'
  try {
    await withSession(j.id, async s => {
      const exists = j.dir === 'down' ? fs.existsSync(j.local) : await s.exists(j.remote)
      if (exists && !overwrite) return (j.status = 'ignoré (existe déjà)')
      const onBytes = n => { j.bytes = n }
      if (j.dir === 'down') {
        fs.mkdirSync(path.dirname(j.local), { recursive: true })
        await s.download(j.remote, j.local, onBytes)
      } else await s.upload(j.local, j.remote, onBytes)
      j.bytes = j.size ?? j.bytes
      j.status = 'ok'
    })
  } catch (e) {
    j.status = 'erreur'
    j.error = e.message
  }
}

let notifyTimer
function notify() {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    win?.webContents.send('transfers', { limit: queue.limit, overwrite, ...summarize(jobs) })
  }, 250)
}
setInterval(() => queue.running && notify(), 500) // progression des octets pendant les gros fichiers

const enqueue = (list, isNew = true) => {
  for (const j of list) Object.assign(j, { status: 'attente', bytes: 0, error: undefined, history: undefined })
  if (isNew) jobs.push(...list)
  queue.push(...list)
}

async function walkRemote(s, dir) {
  const { entries } = await s.list(dir) // limite infinie : un téléchargement ne doit jamais être tronqué
  const out = []
  for (const e of entries) {
    const p = path.posix.join(dir, e.name)
    if (e.dir) out.push(...(await walkRemote(s, p)).map(x => ({ ...x, rel: path.posix.join(e.name, x.rel) })))
    else out.push({ remote: p, rel: e.name, size: e.size })
  }
  return out
}

ipcMain.handle('download', (_, id, items, destDir) => withBrowse(id, async s => {
  const root = path.resolve(destDir)
  const list = []
  for (const it of items) {
    const name = path.posix.basename(it.path)
    const files = it.dir ? (await walkRemote(s, it.path)).map(f => ({ ...f, rel: path.posix.join(name, f.rel) })) : [{ remote: it.path, rel: name, size: it.size }]
    for (const f of files) {
      const local = path.resolve(root, f.rel)
      // Un nom distant du type « ../../x » ne doit jamais écrire hors du dossier choisi.
      if (!local.startsWith(root + path.sep)) throw new Error(`Chemin distant refusé : ${f.remote}`)
      list.push({ id, dir: 'down', remote: f.remote, local, name: f.rel, size: f.size })
    }
  }
  enqueue(list)
  return list.length
}))

ipcMain.handle('upload', (_, id, localPaths, remoteDir) => withBrowse(id, async s => {
  const list = []
  const dirs = new Set()
  for (const lp of localPaths) {
    const base = path.basename(lp)
    if (fs.statSync(lp).isDirectory()) {
      for (const rel of fs.readdirSync(lp, { recursive: true })) {
        const full = path.join(lp, rel)
        const st = fs.statSync(full)
        const remote = path.posix.join(remoteDir, base, ...rel.split(path.sep))
        if (st.isDirectory()) dirs.add(remote)
        else if (st.isFile()) list.push({ id, dir: 'up', local: full, remote, name: path.posix.join(base, ...rel.split(path.sep)), size: st.size })
      }
      dirs.add(path.posix.join(remoteDir, base))
    } else list.push({ id, dir: 'up', local: lp, remote: path.posix.join(remoteDir, base), name: base, size: fs.statSync(lp).size })
  }
  // Dossiers créés avant le parallèle, parents d'abord, pour éviter que deux transferts se marchent dessus.
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) await s.mkdir(d)
  enqueue(list)
  return list.length
}))

ipcMain.handle('settings', (_, { limit, overwrite: ow }) => {
  if (Number.isInteger(limit) && limit >= 1 && limit <= 64) queue.limit = limit
  if (typeof ow === 'boolean') overwrite = ow
  queue.pump()
})
ipcMain.handle('retry', () => enqueue(jobs.filter(j => j.status === 'erreur'), false))
ipcMain.handle('clear', () => {
  queue.clear()
  jobs = jobs.filter(j => j.status === 'en cours')
  notify()
})

// ---------- Navigation ----------
// ---------- Favoris ----------
const tryRead = sources => { try { return readDuckFiles(sources) } catch { return null } }

ipcMain.handle('bookmarks', () => {
  bookmarks = readJson(STORE, null)
  if (!bookmarks) { // premier lancement : anciennes copies 0.1.x, sinon Cyberduck directement
    bookmarks = tryRead([OLD_BOOKMARKS]) ?? tryRead([CYBERDUCK]) ?? []
    saveBookmarks()
    fs.rmSync(OLD_BOOKMARKS, { recursive: true, force: true })
  }
  return publicList()
})

// Ajoute les favoris Cyberduck absents de la liste, sans toucher à ceux déjà là (renommés, réordonnés…).
ipcMain.handle('importCyberduck', async () => {
  let found = tryRead([CYBERDUCK])
  if (!found) {
    // Dossier protégé par macOS : le désigner soi-même dans la fenêtre de sélection vaut autorisation.
    const r = await dialog.showOpenDialog(win, {
      defaultPath: CYBERDUCK, buttonLabel: 'Importer', properties: ['openDirectory', 'openFile', 'multiSelections', 'showHiddenFiles'],
      message: 'Sélectionner le dossier « Bookmarks » de Cyberduck (ou des fichiers .duck)',
    })
    if (r.canceled) return null
    found = readDuckFiles(r.filePaths)
  }
  const added = found.filter(f => !bookmarks.some(b => b.id === f.id))
  bookmarks.push(...added)
  saveBookmarks()
  return { list: publicList(), added: added.length }
})

ipcMain.handle('saveBookmark', (_, input, secret) => {
  const clean = cleanBookmark(input)
  let b = bookmarks.find(x => x.id === input.id)
  if (b) Object.assign(b, clean)
  else bookmarks.push((b = { id: crypto.randomUUID(), ...clean, keyFile: null }))
  saveBookmarks()
  forget(b.id)
  if (typeof secret === 'string' && secret) saveSecret(b.id, secret)
  return publicList()
})

ipcMain.handle('deleteBookmark', (_, id) => {
  forget(id)
  bookmarks = bookmarks.filter(b => b.id !== id)
  delete secrets[id]
  saveBookmarks()
  writeJson(SECRETS, secrets)
  return publicList()
})

ipcMain.handle('reorderBookmarks', (_, ids) => {
  if (!Array.isArray(ids) || ids.length !== bookmarks.length || !bookmarks.every(b => ids.includes(b.id))) throw new Error('Ordre invalide')
  bookmarks = ids.map(byId)
  saveBookmarks()
  return publicList()
})

ipcMain.handle('list', (_, id, p) => withBrowse(id, s => s.list(p, 20000))) // shortcut: affichage limité à ~20 000 entrées par dossier S3, le bandeau le signale
ipcMain.handle('password', (_, id, pwd) => {
  if (typeof pwd !== 'string' || !pwd) throw new Error('Mot de passe vide')
  passwords[id] = Promise.resolve(pwd)
  saveSecret(id, pwd)
  dropBrowse(id)
})
ipcMain.handle('publicCheck', (_, id, p) => withBrowse(id, s => s.publicCheck(p)))
ipcMain.handle('pickFolder', async (_, defaultPath) => (await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] })).filePaths[0])
ipcMain.handle('pickUpload', async () => (await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'] })).filePaths)
ipcMain.handle('terminal', (_, id) => {
  const b = byId(id)
  if (!/^[\w.-]+$/.test(b.host) || !/^[\w.@-]*$/.test(b.user)) throw new Error('Hôte ou utilisateur inattendu')
  const cmd = `ssh -p ${b.port} ${b.user ? b.user + '@' : ''}${b.host}`
  execFile('osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`, '-e', 'tell application "Terminal" to activate'])
})

// ---------- Mise à jour ----------
let update = null
async function checkUpdate() {
  if (!app.isPackaged) return
  update = await latestUpdate(app.getVersion(), process.arch).catch(() => null) // hors ligne : on réessaiera plus tard
  if (update) win?.webContents.send('update', { version: update.version, notes: update.notes })
}
ipcMain.handle('installUpdate', async () => {
  if (!update) throw new Error('Aucune mise à jour disponible')
  if (queue.running || queue.pending) throw new Error('Transferts en cours : installer la mise à jour quand ils sont terminés')
  await installUpdate(update, process.arch, path.resolve(app.getPath('exe'), '../../..'))
  app.relaunch()
  app.exit(0)
})

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 820, title: 'File Transfert',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.loadFile('index.html')
  win.webContents.once('did-finish-load', checkUpdate)
  setInterval(checkUpdate, 6 * 3600 * 1000)
})
app.on('window-all-closed', () => app.quit())
