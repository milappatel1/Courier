#!/bin/sh
# Refuse to commit anything that looks like a credential or personal capture. Run before every commit.
# usage: tools/scan-secrets.sh   (scans what `git add -A` would stage)
set -e
cd "$(dirname "$0")/.."
FILES=$(git ls-files --others --cached --exclude-standard)
FAIL=0
check() {
  # $1 = description, $2 = extended regex
  HITS=$(echo "$FILES" | xargs grep -nIE "$2" 2>/dev/null | grep -v "tools/scan-secrets.sh" || true)
  if [ -n "$HITS" ]; then echo "✗ $1:"; echo "$HITS" | head -5; FAIL=1; fi
}
check "Google API key" 'AIza[0-9A-Za-z_-]{35}'
check "OAuth client secret" 'GOCSPX-[0-9A-Za-z_-]{20,}'
check "Real OAuth client id" '[0-9]{8,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com'
check "Access/refresh token" 'ya29\.[0-9A-Za-z_-]{20,}|1//0[0-9A-Za-z_-]{30,}'
check "GitHub token" 'gh[pousr]_[0-9A-Za-z]{30,}'
check "Private key" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "AWS key" 'AKIA[0-9A-Z]{16}'
check "Recon account address" 'milapthegreat'
check "Personal address" 'homeserver8605'
for f in $FILES; do
  case "$f" in
    research/goldens/*|research/captures/*|research/look/raw/*|*.eml|*.mbox|client_secret*) echo "✗ capture or personal file staged: $f"; FAIL=1;;
  esac
done
if [ "$FAIL" = 0 ]; then echo "✓ no secrets or captures found in $(echo "$FILES" | wc -l | tr -d ' ') files"; fi
exit $FAIL
