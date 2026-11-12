# Sécurité

Pour signaler une faille, utiliser **Security → Report a vulnerability** sur GitHub (signalement privé).
Ne pas ouvrir de ticket public.

## Ce que fait l'appli de vos identifiants

- Les mots de passe sont lus une fois dans le Trousseau (entrées de Cyberduck) ou saisis dans l'appli, puis stockés chiffrés
  (`safeStorage` d'Electron) dans `~/Library/Application Support/File Transfert/secrets.json`, en accès 600. La clé de
  chiffrement est dans le Trousseau et réservée à l'appli : un autre programme ne peut pas la lire sans demande macOS.
- Aucune télémétrie. Les seules connexions sortantes sont vos serveurs (FTP, SFTP, S3) et l'API GitHub pour vérifier les mises à jour.
- Une mise à jour n'est installée que si son zip est signé par la clé Ed25519 de la CI (clé publique dans `update.js`).
  Chaque zip porte aussi une attestation de provenance GitHub : `gh attestation verify <zip> -R bartolije/file-transfert`.
- L'appli est signée avec un certificat auto-signé « File Transfert » (pas de compte Apple Developer) : la même identité
  d'une version à l'autre permet au Trousseau de garder l'autorisation donnée une fois. La clé de ce certificat n'existe
  que dans les secrets de la CI et chez le mainteneur.
