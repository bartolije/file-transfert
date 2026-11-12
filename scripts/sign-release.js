// Signe le zip d'une release pour la mise à jour automatique (exécuté par la CI).
// Usage : UPDATE_SIGNING_KEY="<clé privée PEM>" node scripts/sign-release.js <zip> <version> <arch>
const fs = require('node:fs')
const crypto = require('node:crypto')
const { signedMessage, verify } = require('../update')

const [zipPath, version, arch] = process.argv.slice(2)
const key = process.env.UPDATE_SIGNING_KEY
if (!key || !zipPath || !version || !arch) {
  console.error('Usage : UPDATE_SIGNING_KEY=… node scripts/sign-release.js <zip> <version> <arch>')
  process.exit(1)
}
const zip = fs.readFileSync(zipPath)
const sig = crypto.sign(null, signedMessage(version, arch, zip), key).toString('base64')
// Garde-fou : la clé du secret doit correspondre à la clé publique embarquée, sinon personne ne pourrait installer la mise à jour.
if (!verify(zip, sig, version, arch)) {
  console.error('La clé de signature ne correspond pas à PUBLIC_KEY dans update.js')
  process.exit(1)
}
fs.writeFileSync(`${zipPath}.sig`, sig + '\n')
console.log(`Signé : ${zipPath}.sig`)
