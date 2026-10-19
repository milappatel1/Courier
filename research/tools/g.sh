#!/bin/sh
# After an REA capture_web_screenshot: redact (boxes measured now, same page state) and save the newest result as goldens/<name>.png.
# usage: g.sh <name> [targetId]
set -e
cd "$(dirname "$0")"
T="${2:-0C76731CE66B41CA2D4E1A7D8C91D025}"
RES=$(ls -t "$HOME"/.claude/projects/-Users-milappatel-Downloads-REA/*/tool-results/mcp-rea-capture_web_screenshot-*.txt | head -1)
BOXES="${TMPDIR:-/tmp}/courier-boxes-$$.json"
node redact-boxes.mjs "$T" > "$BOXES"
./golden.sh "$RES" "$1" "$BOXES"
rm -f "$BOXES"
