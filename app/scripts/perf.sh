#!/usr/bin/env bash
# Perf suite (research/PERF.md): Courier on a 20,000-conversation mailbox, in the end-to-end app built with Rust
# optimised as for a release. Each run starts the app with COURIER_E2E_ONLY=perf: (src/e2e/perf.ts: first sync,
# switching labels and tabs, search, scrolling, then 30 s of syncing every 2 s with mail arriving) and samples
# Courier's processes when perf.ts says so: resident size (ps rss) and footprint of the app and of WebKit's processes
# for its window, and their CPU over the 30 s. Then it relaunches the app on the cache that run left
# (COURIER_E2E_ONLY=perf:launch) to time the launch. Budgets are in src/e2e/perf-budgets.json: perf.ts checks what it
# measures, scripts/perf-summary.mjs checks the rest and prints the medians and ranges over the runs.
#
#   scripts/perf.sh [runs]        5 runs unless given
#   COURIER_PERF_LAUNCHES=<n>     relaunches per run (3)
#   COURIER_PERF_DIR=<dir>        where the runs go (default ~/Library/Caches/courier-perf/<date-time>)
#   COURIER_E2E_SKIP_BUILD=1      reuse the last perf build
#   COURIER_PERF_PROFILE=1        also profile the app and its page (macOS `sample`) while the views are timed and
#                                 during the 30 s of syncing, into each run's folder; profiled runs aren't for budgets
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/e2e-lib.sh

RUNS=${1:-5}
LAUNCHES=${COURIER_PERF_LAUNCHES:-3}
ROOT=${COURIER_PERF_DIR:-$HOME/Library/Caches/courier-perf/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$ROOT"
# Release optimisation without debug info or overflow checks, but with debug assertions, which the e2e hooks need;
# in a build folder of its own, so the plain e2e build isn't rebuilt each time.
export CARGO_TARGET_DIR=${COURIER_PERF_TARGET:-$HOME/Library/Caches/courier-perf-opt}
export CARGO_PROFILE_DEV_OPT_LEVEL=3 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_OVERFLOW_CHECKS=false
[ -n "${COURIER_E2E_SKIP_BUILD:-}" ] || e2e_build "$ROOT/build.log"
e2e_find_build
echo "perf runs: $ROOT"

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
# CPU time used so far (s), from ps's [[h:]m:]s.cc.
cpu_s() { ps -o time= -p "$1" 2>/dev/null | awk -F: '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; print s } END { if (!NR) print 0 }' || true; }
rss_kb() {
  local v
  v=$(ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || true)
  echo "${v:-0}"
}
footprint_kb() {
  local v
  v=$(footprint -p "$1" 2>/dev/null | sed -nE 's/.*Footprint: ([0-9.]+) (KB|MB|GB).*/\1 \2/p' | awk '{ print int($1 * ($2 == "GB" ? 1048576 : $2 == "MB" ? 1024 : 1)) }' || true)
  echo "${v:-0}"
}
# "pid=1 web=2 gpu=3 net=4" from a perf.ts line, as "app:1 web:2 gpu:3 net:4" (pids of 0 left out).
procs() { echo "$1" | grep -oE '(pid|web|gpu|net)=[0-9]+' | sed 's/^pid=/app=/' | grep -v '=0$' | tr '=' ':' || true; }

# profile <name> <seconds> <perf.ts line>: with COURIER_PERF_PROFILE, `sample`s the app and its page in the background.
profile() {
  [ -n "${COURIER_PERF_PROFILE:-}" ] || return 0
  local p
  for p in $(procs "$3" | grep -E '^(app|web):'); do
    sample "${p#*:}" "$2" -mayDie -file "$OUT/$1-${p%%:*}.sample.txt" >/dev/null 2>&1 &
  done
}

# Acts on perf.ts's marks as they reach the log, writing what it measured to $OUT/outside.jsonl.
e2e_tick() {
  local n line p name pid json
  n=$(grep -c '^\[e2e\] perf:\(mark\|window\)' "$OUT/app.log" || true)
  while [ "$n" -gt "$SEEN" ]; do
    SEEN=$((SEEN + 1))
    line=$(grep '^\[e2e\] perf:\(mark\|window\)' "$OUT/app.log" | sed -n "${SEEN}p")
    case "$line" in
      *"perf:mark rss "*)
        json="{\"kind\":\"memory\",\"label\":\"$(echo "$line" | sed -nE 's/.*perf:mark rss ([a-z]+) .*/\1/p')\""
        for p in $(procs "$line"); do
          name=${p%%:*} pid=${p#*:}
          json="$json,\"$name\":{\"rssKb\":$(rss_kb "$pid"),\"footprintKb\":$(footprint_kb "$pid")}"
        done
        echo "$json}" >>"$OUT/outside.jsonl"
        case "$line" in *"rss synced"*) profile views 50 "$line" ;; esac
        ;;
      *"perf:window cpu start"*)
        profile idle 28 "$line"
        WINDOW=$(procs "$line")
        WINDOW_T0=$(now)
        WINDOW_C0=""
        for p in $WINDOW; do WINDOW_C0="$WINDOW_C0 $(cpu_s "${p#*:}")"; done
        ;;
      *"perf:window cpu end"*)
        local t1 c0
        t1=$(now)
        json="{\"kind\":\"cpu\",\"seconds\":$(awk -v a="$WINDOW_T0" -v b="$t1" 'BEGIN { printf "%.3f", b - a }')"
        set -- $WINDOW_C0
        for p in $WINDOW; do
          c0=$1
          shift
          json="$json,\"${p%%:*}\":{\"pct\":$(awk -v c0="$c0" -v c1="$(cpu_s "${p#*:}")" -v a="$WINDOW_T0" -v b="$t1" 'BEGIN { printf "%.2f", (c1 - c0) * 100 / (b - a) }')}"
        done
        echo "$json}" >>"$OUT/outside.jsonl"
        WINDOW=""
        ;;
    esac
  done
}

machine() {
  echo "$(date) $(uptime)"
  echo "cores: $(sysctl -n hw.ncpu) ($(sysctl -n hw.perflevel0.physicalcpu) performance), memory: $(($(sysctl -n hw.memsize) / 1073741824)) GB, $(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion)"
  ps -Ao pcpu=,rss=,comm= -r | head -8 || true
}

STATUS=0
for r in $(seq 1 "$RUNS"); do
  OUT="$ROOT/run-$r"
  mkdir -p "$OUT"
  machine >"$OUT/machine.txt"
  echo "== run $r of $RUNS: $(head -1 "$OUT/machine.txt")"
  SEEN=0
  WINDOW=""
  e2e_launch "$OUT" "perf:"
  e2e_follow "$OUT" 1800
  e2e_summary "$OUT" >"$OUT/summary.txt" || STATUS=1
  tail -2 "$OUT/summary.txt"
  for k in $(seq 1 "$LAUNCHES"); do
    L="$OUT/launch-$k"
    mkdir -p "$L"
    rm -rf "$L/data"
    cp -R "$OUT/data" "$L/data"
    machine >"$L/machine.txt"
    e2e_launch "$L" "perf:launch"
    e2e_follow "$L" 120 >/dev/null
    e2e_summary "$L" >"$L/summary.txt" || STATUS=1
    grep -h "^\[e2e\]   \(ok\|FAILED\)" "$L/app.log" | tail -1 || true
    rm -rf "$L/data"
  done
  du -sk "$OUT/data" | awk '{ print "cache: " int($1 / 1024) " MB" }' >>"$OUT/machine.txt"
  [ -n "${COURIER_PERF_KEEP:-}" ] || rm -rf "$OUT/data"
done
node scripts/perf-summary.mjs "$ROOT" || STATUS=1
exit $STATUS
