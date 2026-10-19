#!/bin/sh
# Turn a saved REA capture_web_screenshot result into a redacted golden.
# usage: golden.sh <rea-result.txt> <name> <boxes.json>
# Writes research/goldens/<name>.png (device pixels) and <name>-1x.png (CSS pixels, for comparing at 100 %).
set -e
cd "$(dirname "$0")/.."
mkdir -p goldens
TMP="${TMPDIR:-/tmp}/courier-golden-$$.png"
jq -r '.normalized_result.artifact.data_base64' "$1" | base64 -d > "$TMP"
python3 -I tools/redact.py "$TMP" "$3" "goldens/$2.png"
rm -f "$TMP"
jq -c '{evidence: .evidence_id, viewport: .normalized_result.viewport, captured: .normalized_result.captured_at}' "$1" > "goldens/$2.meta.json"
echo "goldens/$2.png"
