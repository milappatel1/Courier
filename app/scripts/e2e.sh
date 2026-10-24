#!/usr/bin/env bash
# End-to-end tests (npm run test:e2e). Builds a debug app and starts it with COURIER_E2E, which makes it run
# against the local fake Gmail API / IMAP / SMTP servers in a window that never takes focus (no activation,
# no App Nap, no background throttling). The in-app runner (src/e2e/run.ts) gives every step its own timeout,
# logs progress here and writes a JSON report; this script stops it after 12 minutes at most, checks that
# Courier never became the frontmost app, prints a summary and exits non-zero on any failure.
#
#   COURIER_E2E_SKIP_BUILD=1   reuse the last debug build
#   COURIER_E2E_DIR=<dir>      where the report, logs and the throwaway data go (default: a new temp dir)
#   COURIER_E2E_ONLY=a,b       only the steps whose names contain a or b (after the account setup)
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/e2e-lib.sh

OUT="${COURIER_E2E_DIR:-$(mktemp -d -t courier-e2e)}"
mkdir -p "$OUT"
rm -rf "$OUT/data" "$OUT/report.json"
REPORT="$OUT/report.json"
LIMIT=720

[ -n "${COURIER_E2E_SKIP_BUILD:-}" ] || e2e_build "$OUT/build.log"
e2e_find_build

echo "running in the background (report: $REPORT)"
e2e_launch "$OUT" "${COURIER_E2E_ONLY:-}"
e2e_follow "$OUT" "$LIMIT"
e2e_summary "$OUT"
