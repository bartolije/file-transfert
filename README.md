# File Transfert

Client FTP / SFTP / S3 pour macOS (Apple Silicon) qui reprend les favoris Cyberduck et les mots de passe enregistrés dans le Trousseau.

- **Tri** par nom, taille ou date, option **Dossiers en premier**, tri naturel (fichier2 avant fichier10)
- **Accès public ?** (S3) : blocage d'accès public, politique, propriété des objets, ACL, puis une requête anonyme réelle qui tranche
- **Transferts en parallèle** réglables à chaud (1 à 64) ; les fichiers existants sont ignorés sauf si « Écraser » est coché
- Double-clic sur un fichier : téléchargement dans le dossier du favori (~/Downloads par défaut) ; glisser-déposer depuis le Finder pour envoyer
- SFTP : clé d'hôte vérifiée avec `~/.ssh/known_hosts`, bouton **Terminal SSH**
- **Mise à jour automatique** depuis les releases GitHub, signées (voir [SECURITY.md](SECURITY.md))

## Installer

1. Télécharger `File-Transfert-<version>-mac-arm64.zip` depuis les [Releases](https://github.com/bartolije/file-transfert/releases), le décompresser et placer l'appli dans **Applications**.
2. L'appli n'est pas signée par Apple : au premier lancement, macOS la bloque. Ouvrir **Réglages Système → Confidentialité et sécurité** et cliquer sur **Ouvrir quand même** (une seule fois).
3. Les mises à jour suivantes s'installent depuis l'appli, sans ce détour.

## Accès et mots de passe

- **+** ajoute un accès ; le crayon d'un accès permet de le modifier, le renommer ou le supprimer ; glisser-déposer (ou Alt+↑/↓) change l'ordre.
- Au premier lancement, les favoris Cyberduck sont importés. **Importer depuis Cyberduck** ajoute ensuite ceux qui manquent, sans toucher aux accès existants. Si macOS refuse l'accès au dossier de Cyberduck, une fenêtre permet de le désigner, ce qui vaut autorisation.
- Mots de passe : à la première connexion, l'appli lit celui de Cyberduck dans le Trousseau (macOS demande l'autorisation : cliquer **Autoriser**), puis en garde une copie chiffrée. Le chiffrement utilise une clé du Trousseau réservée à l'appli (« File Transfert Safe Storage »). macOS demande une fois l'accès à cette clé : **Toujours autoriser** est sans risque (l'autorisation ne vaut que pour cette appli, reconnue par son certificat) et reste valable pour les versions suivantes.
- Ne pas cliquer « Toujours autoriser » sur les demandes de l'outil `security` : elles portent sur les mots de passe de Cyberduck, et l'autorisation vaudrait pour tout script du Mac.

## Développer

```sh
npm install
git config core.hooksPath .githooks   # garde-fou avant chaque commit et push (nécessite gitleaks)
npm start                             # lancer en développement
npm test
npm run app                           # construire dist/File Transfert-darwin-arm64/File Transfert.app
```

Publier une version : mettre à jour `version` dans `package.json`, committer, puis pousser le tag `vX.Y.Z`. La CI teste, construit, signe et publie la release.
