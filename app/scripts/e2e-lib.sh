# Building, starting and following the end-to-end app; sourced by e2e.sh and perf.sh, which run from app/.

e2e_build() {
  echo "building the debug app…"
  if ! npx tauri build --debug --bundles app >"$1" 2>&1; then
    tail -40 "$1"
    exit 1
  fi
}

# BUNDLE and BIN of the debug build, in Cargo's build directory (it can be moved with CARGO_TARGET_DIR or a .cargo/config.toml).
e2e_find_build() {
  local target
  target=$(cd src-tauri && cargo metadata --format-version 1 --no-deps | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')
  BUNDLE="$target/debug/bundle/macos/Courier.app"
  BIN="$BUNDLE/Contents/MacOS/Courier"
  [ -x "$BIN" ] || { echo "no debug build at $BUNDLE"; exit 1; }
}

# Process ID of the frontmost app (by PID, so a Courier you have open yourself doesn't count).
front_pid() { lsappinfo info "$(lsappinfo front)" 2>/dev/null | sed -nE 's/.*pid = ([0-9]+).*/\1/p' | head -1; }

# e2e_launch <dir> <only>: starts the app in the background with COURIER_E2E_ONLY=<only>; its report, log and throwaway
# data go in <dir>. Sets PID.
e2e_launch() {
  : >"$1/app.log"
  # -g: LaunchServices must not bring it forward; -n: a fresh instance next to any Courier you have open.
  open -g -n --env COURIER_E2E="$1/report.json" --env COURIER_E2E_ONLY="$2" --env COURIER_NO_PRINT=1 --stdout "$1/app.log" --stderr "$1/app.log" "$BUNDLE"
  PID=""
  for _ in $(seq 1 50); do
    PID=$(pgrep -n -f "^$BIN" || true)
    [ -n "$PID" ] && break
    sleep 0.2
  done
  [ -n "$PID" ] || { echo "the app didn't start"; exit 1; }
}

# e2e_follow <dir> <seconds>: streams the runner's progress lines until the app quits, stopping it after <seconds>, and
# sets STOLE=1 if it ever was the frontmost app. Calls e2e_tick every second when the caller defines one.
e2e_follow() {
  local shown=0 n
  STOLE=0
  for _ in $(seq 1 "$2"); do
    sleep 1
    n=$(grep -c '^\[e2e\]' "$1/app.log" || true)
    if [ "$n" -gt "$shown" ]; then
      grep '^\[e2e\]' "$1/app.log" | sed -n "$((shown + 1)),${n}p"
      shown=$n
    fi
    [ "$(front_pid)" = "$PID" ] && STOLE=1
    if declare -F e2e_tick >/dev/null; then e2e_tick; fi
    kill -0 "$PID" 2>/dev/null || break
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "timed out after ${2}s"
    kill "$PID" || true
  fi
  wait "$PID" 2>/dev/null || true
  grep '^\[e2e\]' "$1/app.log" | tail -n +"$((shown + 1))" || true
}

# e2e_summary <dir>: a line per step, the totals and whether the app ever came to the front; fails if anything did.
e2e_summary() {
  if [ ! -f "$1/report.json" ]; then
    echo "no report written; last log lines:"
    tail -30 "$1/app.log"
    return 1
  fi
  STOLE=$STOLE node -e '
const r = require(process.argv[1]);
for (const s of r.steps) {
  console.log(`${s.ok ? "✓" : "✗"} ${s.name} (${s.ms} ms)${s.tookFocus ? " [Courier was frontmost]" : ""}${s.error ? "\n    " + s.error : ""}`);
  if (s.snapshot) console.log("    UI: " + JSON.stringify(s.snapshot));
}
const stole = process.env.STOLE === "1";
console.log(`\n${r.passed} passed, ${r.failed} failed in ${Math.round(r.durationMs / 1000)} s`);
console.log(`focus: app reported ${r.focusTaken ? "ACTIVE during a step" : "never active"}; frontmost-app watch ${stole ? "SAW THE TEST APP IN FRONT" : "never saw the test app in front"}`);
process.exit(r.failed || r.focusTaken || stole ? 1 : 0);
' "$1/report.json"
}
