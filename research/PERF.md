# Performance: Courier on a 20,000-conversation mailbox

## Method

`app/scripts/perf.sh [runs]` builds the end-to-end app with Rust optimised as for a release (its own Cargo folder),
starts it in the background window against the fake mail API holding a 20,000-conversation mailbox
(`app/src/e2e/perf-budgets.json` ▸ `mailbox`: seed 11, pages of 100) and runs the `perf:` steps of
`app/src/e2e/perf.ts`:

- first sync of the account, then switching views (All Mail ↔ Inbox), Inbox tabs, a search, scrolling a
  100-row page;
- 30 s of syncing every 2 s with mail arriving, sampling CPU and memory of the app, its WebKit processes and the
  fake from outside (`ps`, `footprint`);
- three relaunches on the cache that run left, timing first paint and the first rows.

`app/scripts/perf-summary.mjs <dir>` prints the median and range of every number over the runs and checks the
budgets. Each step also fails on its own when a number it measures is over budget.

## Results (2026-10-25, 3 runs, Apple M2, 8 cores, 16 GB, macOS 27.0.1)

Nothing else heavy ran during the runs (the first run started right after its build, load average 19.9 falling).

| What | Median | Range | Budget |
| --- | --- | --- | --- |
| Launch to first paint (cache of 20,000) | 1193 ms | 379–1282 ms (9 relaunches) | 1700 ms |
| Launch to the Inbox's rows | 1358 ms | 1284–1617 ms | 2000 ms |
| First sync (fake server answers in ~1.4 s of it) | 1782 ms | 1779–2118 ms | 2800 ms |
| Switching All Mail ↔ Inbox: first rows | 894 ms | 892–1098 ms | 1400 ms |
| Switching All Mail ↔ Inbox: settled from the server | 1930 ms | 1928–2371 ms | 3000 ms |
| Inbox tab: first rows / settled | 203 / 577 ms | 202–230 / 559–662 ms | 320 / 900 ms |
| Search: first rows / settled | 197 / 442 ms | 195–219 / 400–567 ms | 320 / 800 ms |
| Scrolling 100 rows: p95 frame / longest / slow frames | 17 / 30 ms / 1 | 17–18 / 22–33 ms / 0–1 | 22 / 50 ms / 4 |
| Memory, all processes (footprint): idle / views / syncing | 383 / 410 / 341 MB | 322–391 / 388–419 / 336–357 MB | 520 / 560 / 480 MB |
| CPU while syncing every 2 s with mail arriving | 70% of one core | 68–74% | 95% |

Budgets sit about 1.3–1.5× above the median and above the worst run, so noise passes and a real regression fails.

## What the numbers say

- **Switching to All Mail is the slow view** (issue #10). The cache call takes 870 ms of the 894; Inbox tabs and
  searches take ~200 ms for the same 100 rows. Read from the code: `Db::list_thread_ids` computes a sort date with a
  correlated subquery for every conversation in the view (all 20,000 for All Mail) after a full `labels LIKE` scan
  and a separate `COUNT(DISTINCT)`. Not yet measured in isolation.
- **CPU while syncing** is dominated by the list call each sync triggers (`cpu.listCallPct` 61%): every 2 s the
  visible list is re-read. Courier syncs every 30 s or more by default, so in use it's a small fraction of this.
- Launch first paint has a long tail (one relaunch at 379 ms, the rest ~1.2 s): first paint waits for the cached
  list.
- Scrolling holds 60 frames a second with at most one slow frame.
