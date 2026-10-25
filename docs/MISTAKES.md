## Failure log

One imperative line per lesson, newest last: `- <correct behaviour>. (<yyyy-mm-dd>, <context>)`.
Only this repo's lessons; lessons for every project go in `~/.claude/workflow/LESSONS.md`.

- Run the full e2e only on a quiet Mac; a race fuzzer at ~280% CPU made steps 3–11× slower and its timeouts proved nothing. (2026-10-25, 1.1.0)
- Have a subagent commit its work after every slice; the race-fuzzer builder hit the usage limit with 73 KB uncommitted. (2026-10-25, 1.1.0)
- Ask at the start of a round for every permission the round needs: the P12.2 runner's writes to recon test mail were refused mid-run by the auto-mode check and stopped the run. (2026-10-25, 1.1.0)
- Write hand-over notes into docs/BOARD.md in this repo, never only into an app notes folder or a chat. (2026-10-25, 1.1.0)
- Build, test and edit only in ~/Work/courier-gmail-clone; on the DEV thumbdrive a typecheck took 5+ minutes against 24 s on the Mac. (2026-10-24, 1.1.0)
- Model a conversation change on every cached message of the conversation in tests/ledger_model.rs; a fixed message id ("m0") hid real ordering bugs. (2026-10-24, 1.1.0)
- Rebuild the app before re-running e2e after a UI change; the UI is bundled into the app, so a reused build still runs the old code. (2026-10-22, 1.1.0)
- Measure UI latency from frame timestamps, not from an `until` poll; a poll reported 997 ms for a pane that showed in 6 ms. (2026-10-22, 1.1.0)
- Format only the lines you touched; `cargo fmt` on the whole crate reformats it at the default width, and this repo uses a wider one. (2026-10-21, 1.1.0)
- In e2e checks, look for the expected item among all matches; a check that read the first chip, or assumed delivery order, failed on correct code. (2026-10-25, 1.1.0)
- Run at most two subagents at once on the Pro plan; four in parallel (fuzzer, visual diff, parity sweep, P12.2 runner) used up the 5-hour window and all stopped mid-task. (2026-10-25, 1.1.0)
- When a change shows at once and saves later, re-apply it after the save: a reload of the saved list in between dropped an unsubscribe the user had just confirmed. (2026-10-25, 1.1.0)
