// Garde-fou avant commit / push : refuse tout secret ou donnée personnelle dans le dépôt public.
// La liste des valeurs interdites est construite à l'exécution depuis la machine (favoris Cyberduck, ~/.ssh/config,
// identité Git globale…) : elle n'est jamais écrite dans le dépôt.
// Usage : node scripts/garde-fou.js staged | history
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const mode = process.argv[2]
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
const tryRun = f => { try { return f() } catch { return '' } }

// ---------- Valeurs interdites propres à cette machine ----------
const home = os.homedir()
const local = new Set([home, os.userInfo().username, os.hostname().replace(/\.local$/, '')])
for (const key of ['user.email', 'user.name']) local.add(tryRun(() => git('config', '--global', key)).trim())
const globalEmail = tryRun(() => git('config', '--global', 'user.email')).trim()
if (globalEmail.includes('@')) local.add(globalEmail.split('@')[1]) // domaine de l'adresse pro
const bookmarkDirs = [
  path.join(home, 'Library/Group Containers/G69SCX94XU.duck/Library/Application Support/duck/Bookmarks'),
  path.join(home, 'Library/Application Support/File Transfert/Bookmarks'),
]
let bookmarksRead = 0
for (const dir of bookmarkDirs) {
  for (const f of tryRun(() => fs.readdirSync(dir)) || []) {
    if (!f.endsWith('.duck')) continue
    const d = tryRun(() => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(dir, f)], { encoding: 'utf8' })))
    if (!d) continue
    bookmarksRead++
    for (const k of ['Hostname', 'Username', 'Nickname', 'UUID']) local.add(String(d[k] ?? ''))
  }
}
// Accès créés ou modifiés dans l'appli (bookmarks.json, versions 0.2+)
for (const b of tryRun(() => JSON.parse(fs.readFileSync(path.join(home, 'Library/Application Support/File Transfert/bookmarks.json'), 'utf8'))) || []) {
  bookmarksRead++
  for (const k of ['host', 'user', 'name', 'id']) local.add(String(b[k] ?? ''))
}
for (const m of tryRun(() => fs.readFileSync(path.join(home, '.ssh/config'), 'utf8')).matchAll(/^\s*(?:HostName|User)\s+(\S+)/gim)) local.add(m[1])
const publicEndpoint = /^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/ // point d'accès S3 générique (pas un bucket)
const forbidden = [...local].filter(v => v && v.length >= 4 && !publicEndpoint.test(v) && !['root', 'admin', 'ubuntu', 'centos', 'File Transfert'].includes(v))

// ---------- Motifs génériques ----------
const allowedEmail = /@(users\.noreply\.github\.com|example\.(com|org|net))$/i
const allowedIp = /^(127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/
const patterns = [
  ['clé AWS', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jeton GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['adresse e-mail', /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, v => !allowedEmail.test(v)],
  ['adresse IP', /\b\d{1,3}(\.\d{1,3}){3}\b/g, v => !allowedIp.test(v)],
  ['chemin personnel', /\/Users\/(?!Shared\b)[\w.-]+/],
]
const forbiddenFiles = /(^|\/)(\.env[^/]*|[^/]*\.(duck|pem|p12|key)|id_(rsa|ed25519|ecdsa)[^/]*|known_hosts)$/

// ---------- Contenu à contrôler ----------
let files = []
let text = ''
let identities = []
if (mode === 'staged') {
  files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n').filter(Boolean)
  text = git('diff', '--cached', '-U0', '--no-color').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n')
  identities = [git('var', 'GIT_AUTHOR_IDENT'), git('var', 'GIT_COMMITTER_IDENT')]
} else if (mode === 'history') {
  files = git('log', '--all', '--name-only', '--format=').split('\n').filter(Boolean)
  text = git('log', '--all', '-p', '--no-color', '--format=%B')
  identities = git('log', '--all', '--format=%an <%ae>%n%cn <%ce>').split('\n').filter(Boolean)
} else {
  console.error('Usage : node scripts/garde-fou.js staged|history')
  process.exit(2)
}

const problems = []
const mask = v => (v.length <= 6 ? '***' : `${v.slice(0, 3)}…${v.slice(-2)}`)
for (const f of new Set(files)) if (forbiddenFiles.test(f)) problems.push(`fichier interdit : ${f}`)
for (const id of new Set(identities)) {
  if (!/<[^>]+@users\.noreply\.github\.com>/.test(id)) problems.push(`identité de commit non masquée : ${id.replace(/<[^>]*>.*/, '<…>')}`)
}
for (const line of text.split('\n')) {
  for (const v of forbidden) if (line.includes(v)) problems.push(`valeur propre à cette machine (${mask(v)}) : ${mask(line.trim())}`)
  for (const [name, re, keep = () => true] of patterns) {
    for (const m of line.matchAll(new RegExp(re, 'g'))) if (keep(m[0])) problems.push(`${name} (${mask(m[0])})`)
  }
}

// gitleaks en second avis : obligatoire, pour ne jamais passer en silence s'il manque.
const gitleaks = tryRun(() => execFileSync('which', ['gitleaks'], { encoding: 'utf8' }).trim())
if (!gitleaks) problems.push('gitleaks absent : brew install gitleaks')
else {
  const args = mode === 'staged' ? ['git', '--pre-commit', '--staged', '--redact', '--no-banner', '.'] : ['git', '--redact', '--no-banner', '.']
  try { execFileSync(gitleaks, args, { stdio: 'pipe' }) } catch { problems.push(`gitleaks : fuite détectée (détail : gitleaks ${args.join(' ')} --verbose)`) }
}

if (!bookmarksRead) console.warn('garde-fou : favoris Cyberduck illisibles, contrôle des noms d\'hôtes limité aux motifs génériques')
const unique = [...new Set(problems)]
if (unique.length) {
  console.error(`\n⛔ garde-fou (${mode}) : ${unique.length} problème(s)\n` + unique.map(p => `  - ${p}`).join('\n') + '\n')
  process.exit(1)
}
console.log(`✅ garde-fou (${mode}) : aucun secret ni donnée personnelle (${forbidden.length} valeurs locales contrôlées)`)
