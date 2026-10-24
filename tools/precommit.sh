#!/bin/sh
# Before every commit: typecheck, Vitest, the Rust suite (in its own Cargo folder, `CARGO_TARGET_DIR`, by default
# app/src-tauri/target/tests; see DEVELOPING.md) and the secret scan. Stops at the first failure and says which; the last line is PASS or FAIL so a filtered log can't hide it.
# usage: tools/precommit.sh [--no-rust]
set -e
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $1"; exit 1; }
(cd app && npm run typecheck >/dev/null 2>&1) || fail "typecheck (cd app && npm run typecheck)"
(cd app && npm test >${TMPDIR:-/tmp}/courier-precommit-vitest.log 2>&1) || { tail -20 ${TMPDIR:-/tmp}/courier-precommit-vitest.log; fail "Vitest"; }
if [ "${1:-}" != "--no-rust" ]; then
  (cd app/src-tauri && CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/tests}" cargo test -- --test-threads=4 >${TMPDIR:-/tmp}/courier-precommit-rust.log 2>&1) || {
    grep -E "^error|panicked|FAILED" ${TMPDIR:-/tmp}/courier-precommit-rust.log | head -20
    fail "Rust tests"
  }
  grep -E "^test result" ${TMPDIR:-/tmp}/courier-precommit-rust.log | awk '{p+=$4; f+=$6} END {print "rust: " p " passed, " f " failed"}'
fi
sh tools/scan-secrets.sh >/dev/null || { sh tools/scan-secrets.sh; fail "secret scan"; }
echo "PASS"
