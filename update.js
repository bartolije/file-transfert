// Mise à jour automatique : dernière release GitHub → zip signé en Ed25519 par la CI → remplacement du bundle .app.
// Sans compte Apple Developer, la mise à jour native d'Electron (Squirrel) est impossible ; la signature maison
// garantit qu'un zip n'est installé que s'il sort de la CI du dépôt.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = 'bartolije/file-transfert'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAhnh3eit0tV/Bc19EfRKgsix/MXm5GoZzJIijKwjxiH4=
-----END PUBLIC KEY-----`

const parse = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
function newer(candidate, current) {
  const [a, b] = [parse(candidate), parse(current)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

const assetName = (version, arch) => `File-Transfert-${version}-mac-${arch}.zip`
// La signature couvre aussi la version et l'architecture : un ancien zip signé ne peut pas se faire passer pour une version récente.
const signedMessage = (version, arch, zip) =>
  Buffer.from(`file-transfert\n${version}\n${arch}\n${crypto.createHash('sha256').update(zip).digest('hex')}\n`)
const verify = (zip, sigBase64, version, arch, key = PUBLIC_KEY) =>
  crypto.verify(null, signedMessage(version, arch, zip), key, Buffer.from(sigBase64.trim(), 'base64'))

async function latestUpdate(currentVersion, arch) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  if (!r.ok) return null
  const rel = await r.json()
  const version = rel.tag_name.replace(/^v/, '')
  if (!newer(version, currentVersion)) return null
  const zip = rel.assets.find(a => a.name === assetName(version, arch))
  const sig = rel.assets.find(a => a.name === assetName(version, arch) + '.sig')
  return zip && sig ? { version, notes: rel.body ?? '', zip: zip.browser_download_url, sig: sig.browser_download_url } : null
}

async function download(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Téléchargement impossible (HTTP ${r.status})`)
  return Buffer.from(await r.arrayBuffer())
}

// Le travail se fait à côté du bundle : même volume, donc les renommages sont atomiques.
async function installUpdate(u, arch, bundle, key = PUBLIC_KEY) {
  if (bundle.includes('/AppTranslocation/')) throw new Error('Déplacer l\'appli dans le dossier Applications avant de la mettre à jour')
  const [zip, sig] = await Promise.all([download(u.zip), download(u.sig)])
  if (!verify(zip, sig.toString(), u.version, arch, key)) throw new Error('Signature invalide : mise à jour refusée')
  const work = fs.mkdtempSync(path.join(path.dirname(bundle), '.file-transfert-maj-'))
  try {
    fs.writeFileSync(path.join(work, 'maj.zip'), zip)
    execFileSync('ditto', ['-x', '-k', path.join(work, 'maj.zip'), path.join(work, 'app')])
    const name = fs.readdirSync(path.join(work, 'app')).find(f => f.endsWith('.app'))
    if (!name) throw new Error('Archive inattendue : appli introuvable')
    const old = path.join(work, 'ancienne.app')
    fs.renameSync(bundle, old)
    try {
      fs.renameSync(path.join(work, 'app', name), bundle)
    } catch (e) {
      fs.renameSync(old, bundle) // remise en place de la version en cours
      throw e
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

module.exports = { REPO, PUBLIC_KEY, newer, assetName, signedMessage, verify, latestUpdate, installUpdate }
