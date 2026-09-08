#!/bin/sh
# Builds the Developer ID .p12 from the request generated earlier and stores the five release secrets in GitHub.
# Run this yourself; it prompts for each secret and never prints them. Prerequisites in ~/Desktop/JustZen-signing:
#   developer-id.key, DeveloperIDG2CA.cer (already there) and the developerID_application.cer downloaded from Apple.
# Also needs the AuthKey_XXXXXXXXXX.p8 from App Store Connect in ~/Downloads.
set -eu
REPO=kierankeene122/just-zen
D="$HOME/Desktop/JustZen-signing"
OPENSSL=/usr/bin/openssl
CER=$(ls "$D"/*.cer 2>/dev/null | grep -v DeveloperIDG2CA | head -1 || true)
P8=$(ls "$HOME/Downloads"/AuthKey_*.p8 2>/dev/null | head -1 || true)
[ -n "$CER" ] || { echo "Download the Developer ID Application certificate from Apple into $D first."; exit 1; }
[ -n "$P8" ] || { echo "Download the App Store Connect API key (AuthKey_….p8) into ~/Downloads first."; exit 1; }
"$OPENSSL" x509 -inform der -in "$CER" -out "$D/developer-id.pem"
"$OPENSSL" x509 -inform der -in "$D/DeveloperIDG2CA.cer" -out "$D/DeveloperIDG2CA.pem"
"$OPENSSL" x509 -in "$D/developer-id.pem" -noout -subject | grep -q "Developer ID Application" || { echo "That certificate is not a Developer ID Application certificate."; exit 1; }
[ "$("$OPENSSL" x509 -in "$D/developer-id.pem" -noout -modulus)" = "$("$OPENSSL" rsa -in "$D/developer-id.key" -noout -modulus)" ] || { echo "Certificate does not match developer-id.key."; exit 1; }
echo "Choose a password for the certificate bundle (you will be asked for it twice, then once more to store it):"
"$OPENSSL" pkcs12 -export -inkey "$D/developer-id.key" -in "$D/developer-id.pem" -certfile "$D/DeveloperIDG2CA.pem" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -out "$D/DeveloperID.p12"
base64 -i "$D/DeveloperID.p12" | gh secret set CSC_LINK -R "$REPO"
echo "Enter the same bundle password:"; gh secret set CSC_KEY_PASSWORD -R "$REPO"
gh secret set APPLE_API_KEY -R "$REPO" < "$P8"
# The Key ID is part of the .p8 filename; the Issuer ID is the team-wide value shown at the top of the Team Keys page.
KEY_ID=$(basename "$P8" .p8 | sed "s/^AuthKey_//")
ISSUER_ID="${APPLE_API_ISSUER:-34e9cffe-14e3-4723-91dd-60f1c451db24}"
gh secret set APPLE_API_KEY_ID -R "$REPO" --body "$KEY_ID"
gh secret set APPLE_API_ISSUER -R "$REPO" --body "$ISSUER_ID"
rm -f "$D/DeveloperID.p12"
echo; echo "Stored:"; gh secret list -R "$REPO"
echo; echo "Done. Keep $D somewhere safe (it holds your signing key) and delete $P8 if you do not need it elsewhere."
