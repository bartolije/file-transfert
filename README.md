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

## Favoris et Trousseau

- Au premier lancement, les favoris Cyberduck sont copiés dans `~/Library/Application Support/File Transfert/Bookmarks`. macOS peut refuser l'accès au dossier de Cyberduck : **Réimporter depuis Cyberduck** ouvre alors une fenêtre où désigner ce dossier, ce qui vaut autorisation.
- À la première connexion à un favori, macOS demande l'accès au mot de passe. Cliquer **Autoriser**, pas « Toujours autoriser » : la lecture passe par l'outil système `security`, et l'autorisation permanente vaudrait pour tout script du Mac. Le mot de passe reste en mémoire jusqu'à la fermeture de l'appli.

## Développer

```sh
npm install
git config core.hooksPath .githooks   # garde-fou avant chaque commit et push (nécessite gitleaks)
npm start                             # lancer en développement
npm test
npm run app                           # construire dist/File Transfert-darwin-arm64/File Transfert.app
```

Publier une version : mettre à jour `version` dans `package.json`, committer, puis pousser le tag `vX.Y.Z`. La CI teste, construit, signe et publie la release.
