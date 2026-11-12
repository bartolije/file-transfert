// Accès Cyberduck (favoris + Trousseau) et sessions FTP / SFTP / S3 avec une interface commune :
// list(path, limit) → {entries:[{name, dir, size, mtime}], truncated}, exists, download, upload, mkdir, close.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, execFileSync } = require('node:child_process')
const ftp = require('basic-ftp')
const SftpClient = require('ssh2-sftp-client')
const s3 = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')

const HOME = os.homedir()
// shortcut: seul l'emplacement Cyberduck 8+ (Group Container) est proposé, ajouter ~/Library/Application Support/Cyberduck si besoin.
const CYBERDUCK = path.join(HOME, 'Library/Group Containers/G69SCX94XU.duck/Library/Application Support/duck/Bookmarks')
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, out) => (e ? rej(e) : res(out))))
const tilde = p => (p ? p.replace(/^~(?=\/|$)/, HOME) : p)

const DEFAULT_PORT = { ftp: 21, ftps: 21, sftp: 22, s3: 443 }

// Lit des favoris Cyberduck (.duck). macOS interdit à une appli de lire le dossier d'une autre (EPERM), sauf ce que
// l'utilisateur désigne dans la fenêtre de sélection : les fichiers sont donc lus ici, puis convertis via stdin.
function readDuckFiles(sources) {
  const files = sources.flatMap(s => (fs.statSync(s).isDirectory()
    ? fs.readdirSync(s).filter(f => f.endsWith('.duck')).map(f => path.join(s, f))
    : s.endsWith('.duck') ? [s] : []))
  if (!files.length) throw new Error('Aucun fichier .duck dans la sélection')
  return files.map(f => {
    const d = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: fs.readFileSync(f), encoding: 'utf8' }))
    return {
      id: d.UUID || crypto.randomUUID(), name: d.Nickname || d.Hostname, protocol: d.Protocol, host: d.Hostname,
      port: Number(d.Port) || DEFAULT_PORT[d.Protocol], user: d.Username || '', path: d.Path || '/',
      downloadDir: tilde(d['Download Folder']) || path.join(HOME, 'Downloads'),
      keyFile: tilde(d['Private Key File']) || null,
    }
  }).sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

// Contrôle d'un favori venu de l'interface avant de l'enregistrer.
function cleanBookmark(b) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const out = {
    name: str(b.name, 100), protocol: b.protocol, host: str(b.host, 255), port: Number(b.port || DEFAULT_PORT[b.protocol]),
    user: str(b.user, 255), path: str(b.path, 1024) || '/', downloadDir: tilde(str(b.downloadDir, 1024)) || path.join(HOME, 'Downloads'),
  }
  if (!out.name) throw new Error('Le nom est obligatoire')
  if (!(out.protocol in DEFAULT_PORT)) throw new Error('Protocole inconnu')
  if (!/^[\w.-]+$/.test(out.host)) throw new Error('Serveur invalide (lettres, chiffres, points et tirets)')
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Port invalide')
  if (!out.path.startsWith('/')) out.path = '/' + out.path
  if (!path.isAbsolute(out.downloadDir)) throw new Error('Dossier de téléchargement : chemin absolu attendu')
  return out
}

// Mot de passe enregistré par Cyberduck (macOS demande l'autorisation) ; l'appli en garde ensuite une copie chiffrée.
const keychainPassword = b => !b.user ? Promise.resolve(null)
  : run('security', ['find-internet-password', '-s', b.host, '-a', b.user, '-P', String(b.port), '-w']).then(o => o.replace(/\n$/, ''), () => null)

// ---------- SSH : vérification de la clé d'hôte avec ~/.ssh/known_hosts (comme Cyberduck) ----------
const KNOWN_HOSTS = path.join(HOME, '.ssh/known_hosts')

function hostKeyStatus(host, port, keyBase64, text) {
  const name = port === 22 ? host : `[${host}]:${port}`
  let seen = false
  for (const line of text.split('\n')) {
    const [hosts, , key] = line.trim().split(/\s+/)
    if (!key || hosts.startsWith('#') || hosts.startsWith('@')) continue
    const match = hosts.startsWith('|1|')
      ? (([, , salt, hash]) => crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash)(hosts.split('|'))
      : hosts.split(',').includes(name)
    if (!match) continue
    if (key === keyBase64) return 'ok'
    seen = true
  }
  return seen ? 'changed' : 'unknown'
}

function hostVerifier(b, confirmUnknown) {
  return (key, verify) => {
    const b64 = key.toString('base64')
    const text = fs.existsSync(KNOWN_HOSTS) ? fs.readFileSync(KNOWN_HOSTS, 'utf8') : ''
    const status = hostKeyStatus(b.host, b.port, b64, text)
    if (status === 'ok') return verify(true)
    if (status === 'changed') return verify(false) // clé différente de celle connue : on refuse (risque d'interception)
    const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
    Promise.resolve(confirmUnknown(b, fingerprint)).then(ok => {
      if (ok) {
        const type = key.readUInt32BE(0) && key.subarray(4, 4 + key.readUInt32BE(0)).toString()
        const name = b.port === 22 ? b.host : `[${b.host}]:${b.port}`
        fs.appendFileSync(KNOWN_HOSTS, `${text && !text.endsWith('\n') ? '\n' : ''}${name} ${type} ${b64}\n`)
      }
      verify(ok)
    }, () => verify(false))
  }
}

function sshKey(b) {
  const candidates = [b.keyFile, ...['id_ed25519', 'id_ecdsa', 'id_rsa'].map(k => path.join(HOME, '.ssh', k))]
  const file = candidates.find(f => f && fs.existsSync(f))
  return file ? fs.readFileSync(file) : undefined
}

// ---------- Sessions ----------
const posix = path.posix
const joinRemote = (dir, name) => posix.join(dir || '/', name)

async function ftpSession(b, password) {
  const c = new ftp.Client(30000)
  await c.access({ host: b.host, port: b.port, user: b.user || 'anonymous', password: password ?? 'anonymous', secure: b.protocol === 'ftps' })
  let chain = Promise.resolve()
  const serial = f => (chain = chain.then(f, f)) // basic-ftp n'accepte qu'une commande à la fois par connexion
  const withProgress = (onBytes, f) => serial(async () => {
    c.trackProgress(i => onBytes(i.bytes))
    try { return await f() } finally { c.trackProgress() }
  })
  return {
    list: p => serial(async () => ({
      entries: (await c.list(p)).filter(e => e.name !== '.' && e.name !== '..')
        .map(e => ({ name: e.name, dir: e.isDirectory, size: e.isDirectory ? null : e.size, mtime: e.modifiedAt?.getTime() ?? null })),
      truncated: false,
    })),
    // shortcut: s'appuie sur la commande SIZE ; un serveur qui ne la gère pas fera passer tout fichier pour absent.
    exists: p => serial(() => c.size(p).then(() => true, () => false)),
    download: (remote, local, onBytes) => withProgress(onBytes, () => c.downloadTo(local, remote)),
    upload: (local, remote, onBytes) => withProgress(onBytes, () => c.uploadFrom(local, remote)),
    mkdir: p => serial(() => c.ensureDir(p)),
    close: () => c.close(),
  }
}

async function sftpSession(b, password, confirmUnknown) {
  const s = new SftpClient()
  await s.connect({
    host: b.host, port: b.port, username: b.user, readyTimeout: 20000,
    password: password ?? undefined, privateKey: password ? undefined : sshKey(b),
    agent: process.env.SSH_AUTH_SOCK, hostVerifier: hostVerifier(b, confirmUnknown),
  })
  return {
    async list(p) {
      const raw = await s.list(p)
      const entries = await Promise.all(raw.map(async e => {
        let dir = e.type === 'd'
        if (e.type === 'l') dir = await s.stat(joinRemote(p, e.name)).then(st => st.isDirectory, () => false)
        return { name: e.name, dir, size: dir ? null : e.size, mtime: e.modifyTime ?? null }
      }))
      return { entries, truncated: false }
    },
    exists: p => s.exists(p).then(Boolean),
    download: (remote, local, onBytes) => s.fastGet(remote, local, { step: total => onBytes(total) }),
    upload: (local, remote, onBytes) => s.fastPut(local, remote, { step: total => onBytes(total) }),
    mkdir: async p => { if (!(await s.exists(p))) await s.mkdir(p, true) },
    close: () => s.end().catch(() => {}),
  }
}

// S3 : "/" = liste des buckets, "/bucket/a/b/" = préfixe, "/bucket/a/b.txt" = objet.
const splitS3 = p => {
  const [bucket, ...rest] = p.replace(/^\/+/, '').split('/')
  return { bucket, key: rest.join('/') }
}
const isPublicGrant = g => /\/global\/(AllUsers|AuthenticatedUsers)$/.test(g.Grantee?.URI ?? '')

function s3Session(b, secret) {
  const credentials = { accessKeyId: b.user, secretAccessKey: secret }
  const clients = {}
  const client = region => (clients[region] ??= new s3.S3Client({ region, credentials }))
  const regions = {}
  const regionOf = bucket => (regions[bucket] ??= (async () => {
    try {
      const r = await client('us-east-1').send(new s3.GetBucketLocationCommand({ Bucket: bucket }))
      return r.LocationConstraint === 'EU' ? 'eu-west-1' : r.LocationConstraint || 'us-east-1'
    } catch (e) {
      const r = e.$response?.headers?.['x-amz-bucket-region']
      if (r) return r
      regions[bucket] = undefined
      throw e
    }
  })())
  const forBucket = async bucket => ({ c: client(await regionOf(bucket)), region: await regionOf(bucket) })

  return {
    async list(p, limit = Infinity) {
      const { bucket, key } = splitS3(p)
      if (!bucket) {
        const r = await client('us-east-1').send(new s3.ListBucketsCommand({}))
        return { entries: (r.Buckets ?? []).map(x => ({ name: x.Name, dir: true, size: null, mtime: x.CreationDate?.getTime() ?? null })), truncated: false }
      }
      const prefix = key && !key.endsWith('/') ? key + '/' : key
      const { c } = await forBucket(bucket)
      const entries = []
      let token
      do {
        const r = await c.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }))
        for (const cp of r.CommonPrefixes ?? []) entries.push({ name: cp.Prefix.slice(prefix.length, -1), dir: true, size: null, mtime: null })
        for (const o of r.Contents ?? []) if (o.Key !== prefix) entries.push({ name: o.Key.slice(prefix.length), dir: false, size: o.Size, mtime: o.LastModified?.getTime() ?? null })
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token && entries.length < limit)
      return { entries, truncated: Boolean(token) }
    },
    async exists(p) {
      const { bucket, key } = splitS3(p)
      const { c } = await forBucket(bucket)
      return c.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, e => {
        if (e.$metadata?.httpStatusCode === 404) return false
        throw e
      })
    },
    async download(remote, local, onBytes) {
      const { bucket, key } = splitS3(remote)
      const { c } = await forBucket(bucket)
      const r = await c.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }))
      let n = 0
      r.Body.on('data', ch => onBytes((n += ch.length)))
      await require('node:stream/promises').pipeline(r.Body, fs.createWriteStream(local))
    },
    async upload(local, remote, onBytes) {
      const { bucket, key } = splitS3(remote)
      const { c } = await forBucket(bucket)
      const up = new Upload({ client: c, params: { Bucket: bucket, Key: key, Body: fs.createReadStream(local) } })
      up.on('httpUploadProgress', p => onBytes(p.loaded ?? 0))
      await up.done()
    },
    mkdir: async () => {}, // pas de dossiers en S3 : les préfixes naissent avec les objets
    close: () => Object.values(clients).forEach(c => c.destroy()),

    // Vérifie l'accès public : configuration (blocage, politique, ACL) + test réel sans authentification.
    async publicCheck(p) {
      const { bucket, key } = splitS3(p)
      if (!bucket) throw new Error('Sélectionner un bucket, un dossier ou un fichier')
      const { c, region } = await forBucket(bucket)
      const ask = (cmd, ok, missing) => c.send(cmd).then(ok, e => (missing && e.name === missing ? missing === 'NoSuchBucketPolicy' ? 'aucune politique' : 'non configuré' : `illisible (${e.name})`))
      const grants = r => (r.Grants ?? []).map(g => `${g.Grantee?.URI?.split('/').pop() ?? g.Grantee?.DisplayName ?? g.Grantee?.ID?.slice(0, 12) + '…'} : ${g.Permission}${isPublicGrant(g) ? ' ⚠️ PUBLIC' : ''}`).join('\n')
      const isFile = key && !key.endsWith('/')
      const config = {
        'Blocage de l\'accès public (bucket)': await ask(new s3.GetPublicAccessBlockCommand({ Bucket: bucket }),
          r => Object.entries(r.PublicAccessBlockConfiguration ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n'), 'NoSuchPublicAccessBlockConfiguration'),
        'Politique du bucket': await ask(new s3.GetBucketPolicyStatusCommand({ Bucket: bucket }),
          r => (r.PolicyStatus?.IsPublic ? '⚠️ PUBLIQUE' : 'non publique'), 'NoSuchBucketPolicy'),
        'Propriété des objets': await ask(new s3.GetBucketOwnershipControlsCommand({ Bucket: bucket }),
          r => { const o = r.OwnershipControls?.Rules?.[0]?.ObjectOwnership; return o === 'BucketOwnerEnforced' ? `${o} (ACL désactivées)` : o }, 'OwnershipControlsNotFoundError'),
        'ACL du bucket': await ask(new s3.GetBucketAclCommand({ Bucket: bucket }), grants),
      }
      if (isFile) config['ACL de l\'objet'] = await ask(new s3.GetObjectAclCommand({ Bucket: bucket, Key: key }), grants)

      // Le test qui fait foi : une requête anonyme, sans aucune signature.
      const host = bucket.includes('.') ? `https://s3.${region}.amazonaws.com/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`
      const url = isFile
        ? `${host}/${key.split('/').map(encodeURIComponent).join('/')}`
        : `${host}/?list-type=2&max-keys=1${key ? '&prefix=' + encodeURIComponent(key) : ''}`
      const res = await fetch(url, { method: isFile ? 'HEAD' : 'GET', redirect: 'manual' })
      const open = res.status >= 200 && res.status < 300
      return {
        url, status: res.status, public: open,
        verdict: open
          ? (isFile ? 'PUBLIC : le fichier se télécharge sans authentification' : 'PUBLIC : le contenu se liste sans authentification')
          : (isFile ? 'Privé : accès anonyme refusé' : 'Listing anonyme refusé (les fichiers peuvent malgré tout être publics un par un : vérifier un fichier)'),
        config,
      }
    },
  }
}

async function connect(b, password, confirmUnknown) {
  if (b.protocol === 'ftp' || b.protocol === 'ftps') return ftpSession(b, password)
  if (b.protocol === 'sftp') return sftpSession(b, password, confirmUnknown)
  if (b.protocol === 's3') return s3Session(b, password)
  throw new Error(`Protocole non géré : ${b.protocol}`)
}

// File d'attente à parallélisme réglable à chaud : au plus `limit` tâches en cours.
function createQueue(worker, onChange = () => {}) {
  const pending = []
  let running = 0
  const q = {
    limit: 4,
    get running() { return running },
    get pending() { return pending.length },
    push(...jobs) { pending.push(...jobs); q.pump() },
    clear() { return pending.splice(0).length },
    pump() {
      while (running < q.limit && pending.length) {
        const job = pending.shift()
        running++
        Promise.resolve().then(() => worker(job)).catch(() => {}).finally(() => { running--; q.pump(); onChange() })
      }
      onChange()
    },
  }
  return q
}

// Débit sur une fenêtre glissante : assez stable pour estimer une durée, assez vif pour suivre un changement de réseau.
// (S3 envoie par blocs de 5 Mo : une fenêtre courte ferait osciller le débit entre deux blocs.)
function trackRate(j, now = Date.now(), windowMs = 10000) {
  const h = (j.history ??= [])
  h.push([now, j.bytes])
  while (h.length > 2 && now - h[1][0] >= windowMs) h.shift()
  const [t0, b0] = h[0]
  return now > t0 ? ((j.bytes - b0) * 1000) / (now - t0) : 0
}

// État des transferts envoyé à l'interface : compteurs, débit et temps restant (par fichier et global, en secondes).
function summarize(jobs, now = Date.now()) {
  const count = s => jobs.filter(j => j.status === s).length
  const active = jobs.filter(j => j.status === 'en cours').map(j => {
    const rate = trackRate(j, now)
    return { name: j.name, bytes: j.bytes, size: j.size, dir: j.dir, rate, eta: rate > 0 && j.size ? Math.max(0, j.size - j.bytes) / rate : null }
  })
  const rate = active.reduce((sum, j) => sum + j.rate, 0)
  const remaining = jobs.reduce((sum, j) => sum + (j.status === 'attente' ? (j.size ?? 0) : j.status === 'en cours' ? Math.max(0, (j.size ?? 0) - j.bytes) : 0), 0)
  return {
    total: jobs.length, waiting: count('attente'), running: active.length, done: count('ok'),
    skipped: jobs.filter(j => j.status.startsWith('ignoré')).length, errors: count('erreur'),
    active, failed: jobs.filter(j => j.status === 'erreur').slice(-50).map(({ name, error }) => ({ name, error })),
    rate, eta: rate > 0 && remaining ? remaining / rate : null,
  }
}

module.exports = { trackRate, summarize, CYBERDUCK, DEFAULT_PORT, readDuckFiles, cleanBookmark, keychainPassword, connect, createQueue, hostKeyStatus, splitS3 }
