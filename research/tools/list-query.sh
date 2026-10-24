#!/usr/bin/env bash
# The cached list query (Db::list_thread_ids, app/src-tauri/src/db.rs) on a perf run's cache, as the app runs it and
# with the thread index forced on its per-conversation subquery: plan, time and whether both list the same page
# (research/PERF.md, "Courier slowness found"). Keep a cache with COURIER_PERF_KEEP=1 scripts/perf.sh 1.
#
#   research/tools/list-query.sh <perf run folder>/run-1/data/courier.db [account id]
set -euo pipefail
DB=$1
ACCOUNT=${2:-g-busy0}
NOT_BINNED="m.labels NOT LIKE '% TRASH %' AND m.labels NOT LIKE '% SPAM %'"
PRIMARY="m.labels LIKE '% INBOX %' AND (NOT (m.labels LIKE '% CATEGORY_PROMOTIONS %' OR m.labels LIKE '% CATEGORY_SOCIAL %' OR m.labels LIKE '% CATEGORY_UPDATES %')) AND $NOT_BINNED AND m.thread_id NOT IN (SELECT thread_id FROM snoozes s WHERE s.account_id = m.account_id)"
ALL="(m.labels NOT LIKE '% DRAFT %' OR m.labels LIKE '% SENT %') AND $NOT_BINNED"

page() { # <filter> <index clause>: the first 100 conversations, as list_thread_ids asks for them
  echo "WITH t AS (SELECT m.thread_id AS tid, MAX(m.internal_date) AS d FROM messages m WHERE m.account_id = '$ACCOUNT' AND ($1) GROUP BY m.thread_id)
  SELECT t.tid, MAX(COALESCE((SELECT MAX(m2.internal_date) FROM messages m2 $2 WHERE m2.account_id = '$ACCOUNT' AND m2.thread_id = t.tid AND ${NOT_BINNED//m./m2.}), t.d), t.d, COALESCE(b.at, 0)) AS sd
  FROM t LEFT JOIN bumps b ON b.account_id = '$ACCOUNT' AND b.thread_id = t.tid ORDER BY sd DESC LIMIT 100 OFFSET 0"
}

echo "sqlite3 $(sqlite3 --version | cut -d' ' -f1); $(sqlite3 -readonly "$DB" "SELECT COUNT(*) || ' messages in ' || COUNT(DISTINCT thread_id) || ' conversations' FROM messages WHERE account_id = '$ACCOUNT'")"
for view in PRIMARY ALL; do
  for idx in "" "INDEXED BY msg_thread"; do
    echo "== ${view} ${idx:-(as the app runs it)}"
    sqlite3 -readonly "$DB" "EXPLAIN QUERY PLAN $(page "${!view}" "$idx")" | grep -i "m2 USING"
    start=$(perl -MTime::HiRes=time -e 'print time')
    ids=$(sqlite3 -readonly "$DB" "$(page "${!view}" "$idx")" | shasum | cut -c1-12)
    echo "   $(perl -MTime::HiRes=time -e "printf '%.1f', (time - $start) * 1000") ms, page $ids"
  done
done
