#!/usr/bin/env bash
# Create a stable self-signed code-signing certificate for release signing,
# exported as a .p12 ready for the release workflow secrets.
#
# Why self-signed is enough: TCC anchors an app's permission grants on the
# signature's designated requirement (`identifier + certificate leaf`), not
# on Apple's trust in the certificate. Reusing ONE cert for every release
# keeps that requirement constant, so Accessibility / Screen Recording
# grants survive updates. (Apple's blessing via notarization is only needed
# to clear Gatekeeper on browser-downloaded apps — not for npm installs,
# which carry no quarantine attribute.)
#
# Keep the generated key.pem + cert.pem somewhere safe and permanent: losing
# them means the next release signs under a new leaf and every user
# re-grants once. If you later enroll in the Apple Developer Program, swap
# the workflow secrets for a Developer ID cert (users re-grant that once).
#
# Usage: ./scripts/make-signing-cert.sh [output-dir]
# Then, for the Release workflow:
#   base64 -i <dir>/id.p12 | pbcopy      -> secret APPLICATION_CERT_BASE64
#   secret CERT_PASSWORD  = the password you enter below
#   secret SIGN_IDENTITY  = "pi-computer-use Self Signed"
set -euo pipefail

OUT_DIR="${1:-./signing}"
CN="pi-computer-use Self Signed"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

read -r -s -p "Password for the exported .p12: " P12_PASS
echo

cat > cert.conf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = pi-computer-use Self Signed
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

# 10-year validity so the signing identity does not silently expire between
# releases (an expired leaf would change grant behavior).
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -config cert.conf

# macOS `security`/Keychain cannot read OpenSSL 3's default PKCS12 MAC; the
# legacy PBE + SHA1 MAC flags are required for `security import` to accept it.
openssl pkcs12 -export -out id.p12 -inkey key.pem -in cert.pem \
  -passout "pass:${P12_PASS}" -name "$CN" \
  -legacy -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1

rm -f cert.conf
echo
echo "Wrote $OUT_DIR/{key.pem,cert.pem,id.p12}. Back these up permanently."
echo "SIGN_IDENTITY secret value: $CN"
