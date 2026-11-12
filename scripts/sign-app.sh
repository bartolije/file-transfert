#!/bin/sh
# Signe l'appli avec le certificat stable « File Transfert » : même identité à chaque version, donc macOS garde
# l'autorisation « Toujours autoriser » du Trousseau d'une mise à jour à l'autre (une signature ad hoc change à chaque build).
# Usage (CI) : MACOS_SIGNING_P12=<p12 en base64> MACOS_SIGNING_PASSWORD=<mot de passe> scripts/sign-app.sh "<appli.app>"
set -eu
APP="$1"
TMP=$(mktemp -d)
KC="$TMP/signature.keychain-db"
KCPASS=$(openssl rand -hex 16)
security list-keychains -d user > "$TMP/liste" # remise en état à la fin : le trousseau temporaire ne reste jamais
trap 'eval "set -- $(cat "$TMP/liste")"; security list-keychains -d user -s "$@"; security delete-keychain "$KC" 2>/dev/null || true; rm -rf "$TMP"' EXIT
printf '%s' "$MACOS_SIGNING_P12" | base64 --decode > "$TMP/cert.p12"
security create-keychain -p "$KCPASS" "$KC"
eval "set -- $(cat "$TMP/liste")"
security list-keychains -d user -s "$KC" "$@" # codesign ne trouve l'identité que dans un trousseau de la liste de recherche
security unlock-keychain -p "$KCPASS" "$KC"
security import "$TMP/cert.p12" -k "$KC" -P "$MACOS_SIGNING_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPASS" "$KC" >/dev/null
ID=$(security find-certificate -c "File Transfert" -Z "$KC" | awk '/SHA-1/ { print $NF }')
codesign --force --deep --sign "$ID" --keychain "$KC" "$APP"
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep designated
