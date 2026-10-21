#!/usr/bin/env bash
# Drive Courier the way a user does, for verification (the verify-courier skill in .claude/skills/).
#
#   scripts/verify.sh doctor              what's running and built; refuses nothing, changes nothing
#   scripts/verify.sh e2e <words…>        the in-app runner against the fakes, only the steps whose names contain
#                                         any of the words (after account setup); evidence in a new run folder
#   scripts/verify.sh e2e-all             every e2e step
#   scripts/verify.sh recon [seed|probe N] the debug build on the real mail API, signed in to the recon account only
#   scripts/verify.sh cleanup             stops what this script started (recorded pids), never anything else
#
# Evidence goes to ~/Library/Caches/courier-verify/<run>/ (report.json, app.log, build.log) and survives cleanup.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS="$HOME/Library/Caches/courier-verify"
PIDS="$RUNS/started.pids"
mkdir -p "$RUNS"

target_dir() { (cd src-tauri && cargo metadata --format-version 1 --no-deps | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))'); }
plist_version() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null || echo "?"; }

case "${1:-}" in
  doctor)
    T=$(target_dir)
    DBG="$T/debug/bundle/macos/Courier.app"
    echo "repo:            $(git rev-parse --short HEAD) $(git status --porcelain | wc -l | tr -d ' ') changed file(s)"
    if [ -d "$DBG" ]; then echo "debug build:     $DBG ($(plist_version "$DBG"), built $(stat -f %Sm "$DBG/Contents/MacOS/Courier"))"; else echo "debug build:     none (scripts/verify.sh e2e builds one)"; fi
    echo "installed app:   /Applications/Courier.app $(plist_version /Applications/Courier.app) — the user's own; never drive it"
    pgrep -fl "^/Applications/Courier.app/Contents/MacOS/Courier" >/dev/null && echo "                 running now (the user's real mailboxes)"
    pgrep -fl "$DBG/Contents/MacOS/Courier" | sed 's/^/e2e instance:    /' || echo "e2e instance:    none running"
    pgrep -fl "courier-recon/Courier.app" | sed 's/^/recon instance:  /' || echo "recon instance:  none running"
    lsof -nP -iTCP:1430 -sTCP:LISTEN >/dev/null 2>&1 && echo "preview:         http://localhost:1430/browser-preview.html is up" || echo "preview:         not running (npm run dev)"
    curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && echo "recon Chrome:    CDP on 127.0.0.1:9222" || echo "recon Chrome:    not running"
    ;;
  e2e | e2e-all)
    RUN="$RUNS/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$RUN"
    if [ "$1" = e2e ]; then
      shift
      [ $# -gt 0 ] || { echo "usage: scripts/verify.sh e2e <words in step names>"; exit 2; }
      ONLY=$(IFS=,; echo "$*")
    else
      ONLY=""
    fi
    echo "evidence: $RUN"
    COURIER_E2E_ONLY="$ONLY" COURIER_E2E_DIR="$RUN" bash scripts/e2e.sh | tee "$RUN/summary.txt"
    ;;
  recon)
    ADDR=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.courier-recon-chrome/Default/Preferences')))['account_info'][0]['email'])" 2>/dev/null || true)
    [ -n "$ADDR" ] || { echo "the recon Chrome profile (~/.courier-recon-chrome) isn't signed in; the user signs in first"; exit 2; }
    T=$(target_dir)
    [ -d "$T/debug/bundle/macos/Courier.app" ] || npx tauri build --debug --bundles app >"$RUNS/recon-build.log" 2>&1
    R="$HOME/Library/Caches/courier-recon"
    mkdir -p "$R"
    rm -rf "$R/Courier.app"
    cp -R "$T/debug/bundle/macos/Courier.app" "$R/"
    ENVS=(--env COURIER_RECON="$ADDR")
    [ "${2:-}" = seed ] && ENVS+=(--env COURIER_RECON_SEED=1)
    [ "${2:-}" = probe ] && ENVS+=(--env COURIER_RECON_PROBE="${3:-3}")
    open -g -n "${ENVS[@]}" --stdout "$R/stdout.log" --stderr "$R/stderr.log" "$R/Courier.app"
    sleep 2
    pgrep -n -f "$R/Courier.app/Contents/MacOS/Courier" >>"$PIDS"
    echo "recon build running in the background; log: ~/Library/Application Support/com.milappatel.courier.recon/courier.log"
    ;;
  cleanup)
    [ -f "$PIDS" ] || { echo "nothing started by this script"; exit 0; }
    while read -r pid; do [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "stopped $pid"; done <"$PIDS"
    rm -f "$PIDS"
    echo "evidence kept in $RUNS"
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
