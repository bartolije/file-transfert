/* global api, sortEntries, reorder */
const $ = id => document.getElementById(id)
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

const prefs = { key: 'name', desc: false, foldersFirst: true, limit: 4, overwrite: false, ...store.get('prefs') }
const savePrefs = () => store.set('prefs', prefs)
let bookmarks = []
let current = null
let cwd = '/'
let entries = []
let shown = []
let selected = new Set()
let anchor = null
let refreshAfterTransfers = false
let wasBusy = false
let emptyText = null // message à la place de la liste (connexion en cours ou impossible)

const errMsg = e => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
const joinPath = (dir, name) => (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name
const fmtSize = n => {
  if (n == null) return ''
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${i ? n.toFixed(1).replace('.', ',') : n} ${units[i]}`
}
const fmtRate = r => (r > 0 ? `${fmtSize(Math.round(r))}/s` : '')
const fmtDuration = sec => {
  if (sec == null || !isFinite(sec)) return ''
  const t = Math.ceil(sec)
  if (t < 60) return `${t} s`
  if (t < 3600) return `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`
  return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')} min`
}
const fmtDate = ms => (ms ? new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '')

function notice(text, isError = false) {
  const n = $('notice')
  n.hidden = !text
  n.textContent = text || ''
  n.className = isError ? 'error' : ''
}

// ---------- Mot de passe manquant ou refusé ----------
const AUTH_ERROR = /authentication methods failed|Login incorrect|^530|InvalidAccessKeyId|SignatureDoesNotMatch|password/i

function askPassword(message) {
  const d = $('pwd')
  $('pwdmsg').textContent = message
  $('pwdinput').value = ''
  d.showModal()
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok' ? $('pwdinput').value : null), { once: true }))
}

async function withAuth(f) {
  try {
    return await f()
  } catch (e) {
    if (!AUTH_ERROR.test(errMsg(e))) throw e
    const label = current.protocol === 's3' ? `Clé secrète S3 pour ${current.user}` : `Mot de passe pour ${current.user}@${current.host}`
    const pwd = await askPassword(`${label} (refusé ou absent du Trousseau)`)
    if (pwd == null) throw e
    await api.password(current.id, pwd)
    return withAuth(f)
  }
}

// ---------- Accès (favoris) ----------
let dragId = null

function renderBookmarks() {
  const ul = $('bookmarks')
  ul.replaceChildren(...bookmarks.map((b, i) => {
    const li = document.createElement('li')
    li.draggable = true
    const btn = document.createElement('button')
    btn.className = 'open'
    btn.title = 'Glisser ou Alt+↑/↓ pour déplacer'
    btn.setAttribute('aria-current', String(b.id === current?.id))
    const proto = document.createElement('span')
    proto.className = 'proto'
    proto.textContent = b.protocol.toUpperCase()
    const small = document.createElement('small')
    small.textContent = b.user ? `${b.user}@${b.host}` : b.host
    btn.append(proto, b.name, small)
    btn.onclick = () => openBookmark(b)
    btn.onkeydown = ev => {
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return
      ev.preventDefault()
      const target = bookmarks[i + (ev.key === 'ArrowUp' ? -1 : 1)]
      if (target) moveBookmark(b.id, target.id, true)
    }
    const edit = document.createElement('button')
    edit.className = 'edit'
    edit.textContent = '✎'
    edit.title = 'Modifier, renommer ou supprimer'
    edit.setAttribute('aria-label', `Modifier ${b.name}`)
    edit.onclick = () => editBookmark(b)
    li.ondragstart = ev => { dragId = b.id; ev.dataTransfer.effectAllowed = 'move' }
    li.ondragend = () => { dragId = null }
    li.ondragover = ev => { if (dragId && dragId !== b.id) { ev.preventDefault(); li.classList.add('over') } }
    li.ondragleave = () => li.classList.remove('over')
    li.ondrop = ev => {
      ev.preventDefault()
      li.classList.remove('over')
      if (dragId && dragId !== b.id) moveBookmark(dragId, b.id)
    }
    li.append(btn, edit)
    return li
  }))
}

async function moveBookmark(fromId, toId, refocus = false) {
  try {
    showBookmarks(await api.reorderBookmarks(reorder(bookmarks.map(b => b.id), fromId, toId)))
    if (refocus) $('bookmarks').children[bookmarks.findIndex(b => b.id === fromId)]?.querySelector('.open')?.focus()
  } catch (e) {
    notice(errMsg(e), true)
  }
}

// Formulaire d'ajout / modification
const PORTS = { ftp: 21, ftps: 21, sftp: 22, s3: 443 }
const form = $('editForm')
let editing = null

function protocolLabels() {
  const p = form.protocol.value
  const port = Number(form.port.value)
  if (!port || Object.values(PORTS).includes(port)) form.port.value = PORTS[p]
  if (p === 's3' && !form.host.value) form.host.value = 's3.amazonaws.com'
  $('userLabel').textContent = p === 's3' ? 'Access Key ID' : 'Utilisateur'
  $('secretLabel').textContent = p === 's3' ? 'Secret Access Key' : 'Mot de passe'
}
form.protocol.onchange = protocolLabels

function editBookmark(b) {
  editing = b
  $('editTitle').textContent = b ? `Modifier « ${b.name} »` : 'Nouvel accès'
  for (const k of ['name', 'host', 'user', 'path', 'downloadDir']) form[k].value = b?.[k] ?? ''
  form.protocol.value = b?.protocol ?? 'sftp'
  form.port.value = b?.port ?? ''
  form.secret.value = ''
  form.secret.placeholder = b?.hasSecret ? '•••••• enregistré (laisser vide = inchangé)' : 'Vide : repris de Cyberduck ou demandé à la connexion'
  $('editDelete').hidden = !b
  $('editError').textContent = ''
  protocolLabels()
  $('edit').showModal()
  form.name.focus()
}

form.onsubmit = async ev => {
  if (ev.submitter?.value !== 'ok') return
  ev.preventDefault()
  const data = Object.fromEntries(['name', 'protocol', 'host', 'port', 'user', 'path', 'downloadDir'].map(k => [k, form[k].value]))
  try {
    const list = await api.saveBookmark({ ...data, id: editing?.id }, form.secret.value)
    $('edit').close()
    const wasCurrent = editing && editing.id === current?.id
    showBookmarks(list)
    if (wasCurrent) openBookmark(current) // reconnexion avec les nouveaux paramètres
  } catch (e) {
    $('editError').textContent = errMsg(e)
  }
}

$('editDelete').onclick = async () => {
  if (!confirm(`Supprimer « ${editing.name} » ?\nLe mot de passe gardé par l'appli est effacé ; Cyberduck n'est pas touché.`)) return
  try {
    showBookmarks(await api.deleteBookmark(editing.id))
    $('edit').close()
  } catch (e) {
    $('editError').textContent = errMsg(e)
  }
}
$('add').onclick = () => editBookmark(null)

// Changer d'accès vide tout de suite la liste : jamais les dossiers de l'accès précédent sous le nom du nouveau.
function openBookmark(b) {
  current = b
  entries = []
  selected = new Set()
  anchor = null
  cwd = b.path || '/'
  $('path').value = cwd
  emptyText = `Connexion à ${b.name}…`
  renderBookmarks()
  for (const id of ['up', 'path', 'refresh']) $(id).disabled = false
  $('upload').disabled = true // pas d'envoi tant que la connexion n'est pas établie
  $('check').hidden = b.protocol !== 's3'
  $('terminal').hidden = b.protocol !== 'sftp'
  render()
  go(cwd)
}

// ---------- Navigation ----------
async function go(path) {
  const b = current
  notice(`Connexion à ${b.name}…`)
  try {
    const res = await withAuth(() => api.list(b.id, path))
    if (b.id !== current?.id) return
    cwd = path
    emptyText = null
    $('upload').disabled = false
    entries = res.entries
    selected = new Set()
    anchor = null
    $('path').value = cwd
    notice(res.truncated ? `Dossier très volumineux : seules les ${entries.length.toLocaleString('fr-FR')} premières entrées sont affichées.` : '')
    render()
  } catch (e) {
    if (b.id !== current?.id) return
    notice(errMsg(e), true)
    if (emptyText) { // échec de la connexion elle-même (pas d'un sous-dossier) : on le dit dans la liste
      emptyText = `Connexion impossible à ${b.name} : ${errMsg(e)}`
      render()
    }
  }
}

const parent = p => p.replace(/\/[^/]*\/?$/, '') || '/'

function render() {
  shown = sortEntries(entries, prefs)
  for (const btn of document.querySelectorAll('th button')) {
    btn.parentElement.setAttribute('aria-sort', btn.dataset.key === prefs.key ? (prefs.desc ? 'descending' : 'ascending') : 'none')
    btn.textContent = btn.textContent.replace(/ [▲▼]$/, '') + (btn.dataset.key === prefs.key ? (prefs.desc ? ' ▼' : ' ▲') : '')
  }
  $('foldersFirst').checked = prefs.foldersFirst
  $('files').replaceChildren(...shown.map(e => {
    const tr = document.createElement('tr')
    tr.tabIndex = 0
    tr.entry = e
    tr.setAttribute('aria-selected', String(selected.has(e)))
    const name = document.createElement('td')
    const ico = document.createElement('span')
    ico.className = 'ico'
    ico.textContent = e.dir ? '📁' : '📄'
    name.append(ico, e.name) // nom distant inséré en texte, jamais en HTML
    name.title = e.name
    const size = document.createElement('td')
    size.textContent = e.dir ? '' : fmtSize(e.size)
    const date = document.createElement('td')
    date.textContent = fmtDate(e.mtime)
    tr.append(name, size, date)
    return tr
  }))
  $('empty').hidden = shown.length > 0
  $('empty').textContent = emptyText ?? (current ? 'Dossier vide.' : 'Choisir un accès à gauche.')
  updateButtons()
}

function updateButtons() {
  $('download').disabled = !selected.size
  for (const tr of $('files').children) tr.setAttribute('aria-selected', String(selected.has(tr.entry)))
}

function select(e, ev) {
  if (ev.shiftKey && anchor) {
    const [a, b] = [shown.indexOf(anchor), shown.indexOf(e)].sort((x, y) => x - y)
    selected = new Set(shown.slice(a, b + 1))
  } else if (ev.metaKey || ev.ctrlKey) {
    selected.has(e) ? selected.delete(e) : selected.add(e)
    anchor = e
  } else {
    selected = new Set([e])
    anchor = e
  }
  updateButtons()
}

function openEntry(e) {
  if (e.dir) go(joinPath(cwd, e.name))
  else startDownload([e], current.downloadDir)
}

const files = $('files')
files.addEventListener('click', ev => { const tr = ev.target.closest('tr'); if (tr) select(tr.entry, ev) })
files.addEventListener('dblclick', ev => { const tr = ev.target.closest('tr'); if (tr) openEntry(tr.entry) })
files.addEventListener('keydown', ev => {
  const tr = ev.target.closest('tr')
  if (!tr) return
  if (ev.key === 'Enter') openEntry(tr.entry)
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    const next = ev.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling
    if (next) { next.focus(); select(next.entry, ev) }
    ev.preventDefault()
  }
})
document.addEventListener('keydown', ev => {
  if (ev.key === 'Backspace' && current && !ev.target.matches('input')) go(parent(cwd))
})

for (const btn of document.querySelectorAll('th button')) {
  btn.onclick = () => {
    prefs.desc = prefs.key === btn.dataset.key ? !prefs.desc : false
    prefs.key = btn.dataset.key
    savePrefs()
    render()
  }
}
$('foldersFirst').onchange = ev => { prefs.foldersFirst = ev.target.checked; savePrefs(); render() }
$('up').onclick = () => go(parent(cwd))
$('refresh').onclick = () => go(cwd)
$('path').onkeydown = ev => { if (ev.key === 'Enter') go($('path').value.trim() || '/') }
$('terminal').onclick = () => api.terminal(current.id).catch(e => notice(errMsg(e), true))

// ---------- Transferts ----------
async function startDownload(items, dest) {
  if (!dest) return
  const b = current
  notice('Préparation du téléchargement…')
  try {
    const n = await withAuth(() => api.download(b.id, items.map(e => ({ path: joinPath(cwd, e.name), dir: e.dir, size: e.size })), dest))
    notice(`${n} fichier(s) ajouté(s) à la file → ${dest}`)
  } catch (e) {
    notice(errMsg(e), true)
  }
}

async function startUpload(paths) {
  if (!paths?.length || !current) return
  if ($('upload').disabled) return notice('Connexion en cours : attendre l\'affichage du dossier avant d\'envoyer.', true)
  if (current.protocol === 's3' && cwd === '/') return notice('Ouvrir un bucket avant d\'envoyer des fichiers.', true)
  const b = current
  notice('Préparation de l\'envoi…')
  try {
    const n = await withAuth(() => api.upload(b.id, paths, cwd))
    refreshAfterTransfers = true
    notice(`${n} fichier(s) ajouté(s) à la file → ${cwd}`)
  } catch (e) {
    notice(errMsg(e), true)
  }
}

$('download').onclick = async () => startDownload([...selected], await api.pickFolder(current.downloadDir))
$('upload').onclick = async () => startUpload(await api.pickUpload())

const drop = $('drop')
drop.addEventListener('dragover', ev => { if (current) { ev.preventDefault(); drop.classList.add('drop') } })
drop.addEventListener('dragleave', () => drop.classList.remove('drop'))
drop.addEventListener('drop', ev => {
  ev.preventDefault()
  drop.classList.remove('drop')
  startUpload([...ev.dataTransfer.files].map(f => api.pathFor(f)).filter(Boolean))
})

$('limit').value = prefs.limit
$('overwrite').checked = prefs.overwrite
const pushSettings = () => api.settings({ limit: prefs.limit, overwrite: prefs.overwrite })
$('limit').onchange = ev => {
  const n = Math.min(64, Math.max(1, Math.round(Number(ev.target.value)) || 1))
  ev.target.value = prefs.limit = n
  savePrefs()
  pushSettings()
}
$('overwrite').onchange = ev => { prefs.overwrite = ev.target.checked; savePrefs(); pushSettings() }
$('retry').onclick = () => api.retry()
$('clear').onclick = () => api.clear()

api.onTransfers(s => {
  const parts = [`${s.done} terminé(s)`, `${s.running} en cours`, `${s.waiting} en attente`]
  if (s.skipped) parts.push(`${s.skipped} ignoré(s), déjà présents`)
  if (s.errors) parts.push(`${s.errors} erreur(s)`)
  if (s.running) parts.push(s.eta != null ? `${fmtRate(s.rate)} · fin dans ~${fmtDuration(s.eta)}` : 'estimation en cours…')
  $('stats').textContent = s.total ? parts.join(' · ') : 'Aucun transfert'
  $('retry').hidden = !s.errors
  $('queue').replaceChildren(
    ...s.active.map(j => {
      const li = document.createElement('li')
      const arrow = document.createElement('span')
      arrow.textContent = j.dir === 'down' ? '↓' : '↑'
      const name = document.createElement('span')
      name.className = 'name'
      const speed = j.rate > 0 ? ` · ${fmtRate(j.rate)}${j.eta != null ? ' · reste ' + fmtDuration(j.eta) : ''}` : ''
      name.textContent = `${j.name} — ${fmtSize(j.bytes)}${j.size ? ' / ' + fmtSize(j.size) : ''}${speed}`
      const bar = document.createElement('progress')
      bar.max = j.size || 1
      bar.value = j.size ? j.bytes : 0
      li.append(arrow, name, bar)
      return li
    }),
    ...s.failed.map(j => {
      const li = document.createElement('li')
      li.className = 'err'
      const mark = document.createElement('span')
      mark.textContent = '✕'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = `${j.name} : ${j.error}`
      name.title = j.error
      li.append(mark, name)
      return li
    }),
  )
  const busy = s.running + s.waiting > 0
  if (wasBusy && !busy && refreshAfterTransfers && current) { refreshAfterTransfers = false; go(cwd) }
  wasBusy = busy
})

// ---------- Accès public S3 ----------
$('check').onclick = async () => {
  const target = selected.size === 1 ? [...selected][0] : null
  const path = target ? joinPath(cwd, target.name) + (target.dir ? '/' : '') : cwd.replace(/\/?$/, '/')
  notice('Vérification de l\'accès public…')
  try {
    const r = await withAuth(() => api.publicCheck(current.id, path))
    notice('')
    $('rtitle').textContent = path
    $('rverdict').textContent = `${r.verdict} (HTTP ${r.status})`
    $('rverdict').className = `verdict ${r.public ? 'pub' : 'priv'}`
    const rows = [['Requête anonyme', r.url], ...Object.entries(r.config)]
    $('rdetails').replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      return [dt, dd]
    }))
    $('report').showModal()
  } catch (e) {
    notice(errMsg(e), true)
  }
}

// ---------- Démarrage ----------
function showBookmarks(list) {
  if (!list) return
  bookmarks = list
  const kept = list.find(b => b.id === current?.id) ?? null
  const removed = current && !kept
  current = kept
  if (removed) { // accès supprimé : on vide la vue
    entries = []
    emptyText = null
    cwd = '/'
    $('path').value = ''
    for (const id of ['up', 'path', 'refresh', 'upload']) $(id).disabled = true
    $('check').hidden = $('terminal').hidden = true
    render()
  }
  renderBookmarks()
  if (!list.length) notice('Aucun accès : « + » pour en créer un, ou « Importer depuis Cyberduck » en bas à gauche.', true)
}
$('import').onclick = () => api.importCyberduck().then(r => {
  if (!r) return
  showBookmarks(r.list)
  notice(r.added ? `${r.added} accès ajouté(s) depuis Cyberduck.` : 'Aucun nouvel accès dans Cyberduck.')
}, e => notice(errMsg(e), true))
render()
pushSettings()
api.bookmarks().then(showBookmarks, e => notice(errMsg(e), true))

// ---------- Mise à jour ----------
api.onUpdate(u => {
  $('updateText').textContent = `Version ${u.version} disponible.`
  $('update').hidden = false
})
$('updateBtn').onclick = async () => {
  $('updateBtn').disabled = true
  $('updateText').textContent = 'Téléchargement et vérification de la signature…'
  try {
    await api.installUpdate() // l'appli redémarre d'elle-même si tout va bien
  } catch (e) {
    $('updateText').textContent = errMsg(e)
    $('updateBtn').disabled = false
  }
}
