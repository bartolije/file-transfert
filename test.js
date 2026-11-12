const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const { sortEntries } = require('./sort')
const { createQueue, hostKeyStatus, splitS3 } = require('./backends')

const e = (name, dir, size = null, mtime = null) => ({ name, dir, size, mtime })
const names = list => list.map(x => x.name)

test('dossiers en premier, tri naturel sans casse ni accents', () => {
  const list = [e('fichier10.txt', false), e('Zeta', true), e('fichier2.txt', false), e('école', true), e('alpha', true)]
  assert.deepStrictEqual(names(sortEntries(list)), ['alpha', 'école', 'Zeta', 'fichier2.txt', 'fichier10.txt'])
  assert.deepStrictEqual(names(sortEntries(list, { desc: true })), ['Zeta', 'école', 'alpha', 'fichier10.txt', 'fichier2.txt'])
  assert.deepStrictEqual(names(sortEntries(list, { foldersFirst: false })), ['alpha', 'école', 'fichier2.txt', 'fichier10.txt', 'Zeta'])
})

test('tri par taille : valeurs absentes en tête, égalités départagées par nom', () => {
  const list = [e('b', false, 5), e('a', false, 5), e('c', false, 1), e('d', true)]
  assert.deepStrictEqual(names(sortEntries(list, { key: 'size', foldersFirst: false })), ['d', 'c', 'a', 'b'])
})

test('la file respecte le parallélisme, réglable à chaud', async () => {
  let live = 0
  let max = 0
  let q
  const done = new Promise(res => {
    let n = 0
    q = createQueue(async () => {
      max = Math.max(max, ++live)
      await new Promise(r => setTimeout(r, 5))
      live--
      if (++n === 20) res()
    })
  })
  q.limit = 3
  q.push(...Array.from({ length: 10 }, (_, i) => i))
  assert.strictEqual(q.running, 3)
  q.limit = 6
  q.push(...Array.from({ length: 10 }, (_, i) => i))
  await done
  assert.strictEqual(max, 6)
})

test('known_hosts : en clair, haché, port non standard, clé changée', () => {
  const key = Buffer.from('cle-de-test').toString('base64')
  const salt = crypto.randomBytes(20)
  const hashed = `|1|${salt.toString('base64')}|${crypto.createHmac('sha1', salt).update('[sftp.example.io]:2222').digest('base64')}`
  const text = `a.example.com,192.0.2.1 ssh-ed25519 ${key}\n${hashed} ssh-ed25519 ${key}\n`
  assert.strictEqual(hostKeyStatus('192.0.2.1', 22, key, text), 'ok')
  assert.strictEqual(hostKeyStatus('sftp.example.io', 2222, key, text), 'ok')
  assert.strictEqual(hostKeyStatus('sftp.example.io', 22, key, text), 'unknown')
  assert.strictEqual(hostKeyStatus('a.example.com', 22, 'autre', text), 'changed')
})

test('chemins S3', () => {
  assert.deepStrictEqual(splitS3('/'), { bucket: '', key: '' })
  assert.deepStrictEqual(splitS3('/b/a/c.txt'), { bucket: 'b', key: 'a/c.txt' })
  assert.deepStrictEqual(splitS3('/b/a/'), { bucket: 'b', key: 'a/' })
})

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { newer, signedMessage, verify, installUpdate } = require('./update')

test('comparaison de versions', () => {
  assert.ok(newer('0.2.0', '0.1.9'))
  assert.ok(newer('v1.0.0', '0.9.9'))
  assert.ok(newer('0.1.10', '0.1.9'))
  assert.ok(!newer('0.1.0', '0.1.0'))
  assert.ok(!newer('0.1.0', '0.2.0'))
})

test('signature : refus si le zip, la version ou l\'architecture changent', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const zip = Buffer.from('contenu du zip')
  const sig = crypto.sign(null, signedMessage('1.2.3', 'arm64', zip), privateKey).toString('base64')
  assert.ok(verify(zip, sig, '1.2.3', 'arm64', publicKey))
  assert.ok(!verify(Buffer.from('contenu modifié'), sig, '1.2.3', 'arm64', publicKey))
  assert.ok(!verify(zip, sig, '9.9.9', 'arm64', publicKey))
  assert.ok(!verify(zip, sig, '1.2.3', 'x64', publicKey))
  assert.ok(!verify(zip, sig, '1.2.3', 'arm64')) // clé embarquée : une clé de test ne passe pas
})

test('installation : bundle remplacé si signé, intact sinon', { skip: process.platform !== 'darwin' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-test-'))
  const make = (dir, v) => { fs.mkdirSync(path.join(dir, 'Test.app/Contents'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Test.app/Contents/version'), v) }
  make(path.join(tmp, 'installee'), 'ancienne')
  make(path.join(tmp, 'nouvelle'), 'nouvelle')
  execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(tmp, 'nouvelle/Test.app'), path.join(tmp, 'maj.zip')])
  const zip = fs.readFileSync(path.join(tmp, 'maj.zip'))
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const files = { '/maj.zip': zip, '/maj.zip.sig': crypto.sign(null, signedMessage('2.0.0', 'arm64', zip), privateKey).toString('base64') }
  const server = http.createServer((req, res) => (files[req.url] ? res.end(files[req.url]) : res.writeHead(404).end())).listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  const bundle = path.join(tmp, 'installee/Test.app')
  const u = { version: '2.0.0', zip: base + '/maj.zip', sig: base + '/maj.zip.sig' }
  try {
    await assert.rejects(installUpdate({ ...u, version: '3.0.0' }, 'arm64', bundle, publicKey), /Signature invalide/)
    assert.strictEqual(fs.readFileSync(path.join(bundle, 'Contents/version'), 'utf8'), 'ancienne')
    await installUpdate(u, 'arm64', bundle, publicKey)
    assert.strictEqual(fs.readFileSync(path.join(bundle, 'Contents/version'), 'utf8'), 'nouvelle')
    assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'installee')), ['Test.app']) // aucun reste de travail
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
