#!/usr/bin/env bash
# End-to-end tests (npm run test:e2e). Builds a debug app and starts it with COURIER_E2E, which makes it run
# against the local fake Gmail API / IMAP / SMTP servers in a window that never takes focus (no activation,
# no App Nap, no background throttling). The in-app runner (src/e2e/run.ts) gives every step its own timeout,
# logs progress here and writes a JSON report; this script stops it after 5 minutes at most, checks that
# Courier never became the frontmost app, prints a summary and exits non-zero on any failure.
#
#   COURIER_E2E_SKIP_BUILD=1   reuse the last debug build
#   COURIER_E2E_DIR=<dir>      where the report, logs and the throwaway data go (default: a new temp dir)
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${COURIER_E2E_DIR:-$(mktemp -d -t courier-e2e)}"
mkdir -p "$OUT"
rm -rf "$OUT/data" "$OUT/report.json"
REPORT="$OUT/report.json"
LIMIT=300

if [ -z "${COURIER_E2E_SKIP_BUILD:-}" ]; then
  echo "building the debug app…"
  if ! npx tauri build --debug --bundles app >"$OUT/build.log" 2>&1; then
    tail -40 "$OUT/build.log"
    exit 1
  fi
fi
BUNDLE="$PWD/src-tauri/target/debug/bundle/macos/Courier.app"
BIN="$BUNDLE/Contents/MacOS/Courier"
[ -x "$BIN" ] || { echo "no debug build at $BUNDLE"; exit 1; }

# Name of the frontmost app ("Claude" ASN:… (in front) → Claude).
front() { lsappinfo info "$(lsappinfo front)" 2>/dev/null | head -1 | sed -E 's/^"([^"]*)".*/\1/'; }

echo "running in the background (report: $REPORT)"
: >"$OUT/app.log"
# -g: LaunchServices must not bring it forward; -n: a fresh instance next to any Courier you have open.
open -g -n --env COURIER_E2E="$REPORT" --env COURIER_NO_PRINT=1 --stdout "$OUT/app.log" --stderr "$OUT/app.log" "$BUNDLE"
PID=""
for _ in $(seq 1 50); do
  PID=$(pgrep -n -f "^$BIN" || true)
  [ -n "$PID" ] && break
  sleep 0.2
done
[ -n "$PID" ] || { echo "the app didn't start"; exit 1; }
STOLE=0
SHOWN=0
for _ in $(seq 1 "$LIMIT"); do
  sleep 1
  # Stream the runner's progress lines.
  N=$(grep -c '^\[e2e\]' "$OUT/app.log" || true)
  if [ "$N" -gt "$SHOWN" ]; then
    grep '^\[e2e\]' "$OUT/app.log" | sed -n "$((SHOWN + 1)),${N}p"
    SHOWN=$N
  fi
  [ "$(front)" = "Courier" ] && STOLE=1
  kill -0 "$PID" 2>/dev/null || break
done
if kill -0 "$PID" 2>/dev/null; then
  echo "timed out after ${LIMIT}s"
  kill "$PID" || true
fi
wait "$PID" 2>/dev/null || true
grep '^\[e2e\]' "$OUT/app.log" | tail -n +"$((SHOWN + 1))" || true

if [ ! -f "$REPORT" ]; then
  echo "no report written; last log lines:"
  tail -30 "$OUT/app.log"
  exit 1
fi
STOLE=$STOLE node -e '
const r = require(process.argv[1]);
for (const s of r.steps) {
  console.log(`${s.ok ? "✓" : "✗"} ${s.name} (${s.ms} ms)${s.tookFocus ? " [Courier was frontmost]" : ""}${s.error ? "\n    " + s.error : ""}`);
  if (s.snapshot) console.log("    UI: " + JSON.stringify(s.snapshot));
}
const stole = process.env.STOLE === "1";
console.log(`\n${r.passed} passed, ${r.failed} failed in ${Math.round(r.durationMs / 1000)} s`);
console.log(`focus: app reported ${r.focusTaken ? "ACTIVE during a step" : "never active"}; frontmost-app watch ${stole ? "SAW COURIER IN FRONT" : "never saw Courier in front"}`);
process.exit(r.failed || r.focusTaken || stole ? 1 : 0);
' "$REPORT"
