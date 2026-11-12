# Sécurité

Pour signaler une faille, utiliser **Security → Report a vulnerability** sur GitHub (signalement privé).
Ne pas ouvrir de ticket public.

## Ce que fait l'appli de vos identifiants

- Les mots de passe et clés secrètes restent dans le Trousseau macOS ; l'appli les lit à la connexion et ne les garde qu'en mémoire.
- Aucune télémétrie. Les seules connexions sortantes sont vos serveurs (FTP, SFTP, S3) et l'API GitHub pour vérifier les mises à jour.
- Une mise à jour n'est installée que si son zip est signé par la clé Ed25519 de la CI (clé publique dans `update.js`).
  Chaque zip porte aussi une attestation de provenance GitHub : `gh attestation verify <zip> -R bartolije/file-transfert`.
