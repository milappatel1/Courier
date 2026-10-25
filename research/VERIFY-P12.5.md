# VERIFY P12.5: performance on a 20,000-conversation mailbox

Playbook: pstack perf-issue, with the benchmark-checklist (median and range over runs, machine named, what limits
each number). Method, full results and readings: `research/PERF.md`.

- Checked: launch to first paint and to rows, first sync, switching views and tabs, search, scrolling, memory, and
  CPU while syncing, on the end-to-end app built with release optimisation, 3 runs, in the background window
  (never in front).
- Budgets: set from the measured medians in `app/src/e2e/perf-budgets.json`; all 3 runs within them. A step fails
  when a number is over budget, and `app/scripts/perf-summary.mjs` fails on memory and CPU.
- Fixed: nothing this round.

## Known gaps

- Switching to All Mail takes ~0.9 s to show rows on 20,000 conversations (issue #10).
- CPU while syncing is measured at a 2-second sync interval with mail arriving, harsher than real use.
- The suite runs on the fake mail API; network time against the real server isn't part of these numbers.
