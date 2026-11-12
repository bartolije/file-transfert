// Tri « naturel » à la française (fichier2 avant fichier10, accents et casse ignorés).
// Dossiers en premier si demandé, quel que soit le sens du tri.
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function sortEntries(entries, { key = 'name', desc = false, foldersFirst = true } = {}) {
  const cmp = (a, b) => (key === 'name' ? 0 : (a[key] ?? -Infinity) - (b[key] ?? -Infinity) || 0) || collator.compare(a.name, b.name)
  return [...entries].sort((a, b) => (foldersFirst && a.dir !== b.dir ? (a.dir ? -1 : 1) : desc ? cmp(b, a) : cmp(a, b)))
}

if (typeof module !== 'undefined') module.exports = { sortEntries }
