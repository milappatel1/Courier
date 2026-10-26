# Board

Courier is past v1 (1.0.7 released), so this board replaces STATUS.md. Rules: `~/.claude/workflow/board-template.md`
(Doing and Next hold at most 5 cards; a card moves to Done only after the verify skill passes on it).
Card: `- <title>: done when <check> · <area> · <owner>`.

## Doing


## Next

- Milap opens Courier 1.1.0 (one Keychain prompt), then a read-only, numbers-only check of the real accounts' counts against the server: done when each account's Inbox and category counts match labels.get · main session
- Cleanup after the release: the list of Courier's build caches, work copy and recon data, deleted only on Milap's yes · main session

## Backlog

- Interrogate findings filed for later: #11 bulk Undo, #12 IMAP ids across accounts, #13 lagging-listing re-read, #14 search FTS for in-flight conversations, #15 offline bulk flush speed, #16 tab news clock, #17 one overlay / ledger module · app · builder
- Security lows left from the review: server text in a few log lines (sync failed, send failed, one-click errors), tab_seen/tab_news key validation, window_open kind validation, e2e_* commands still registered in release builds (inert), IMAP expunge without UIDPLUS removes other \\Deleted mail · app/src-tauri/src · builder
- e2e focus: in the busy-accounts flash step macOS made the test app active once with no test action (handed back at once; frontmost watch never saw it); seen in 2 runs across sessions · app/src/e2e · debugger
- Parity rows (Milap allows temporary recon setting changes, restored after; resume the sweep once P12.2 frees the recon tab): 96 unverified need a setting change in the recon account (59 shortcut rows need Keyboard shortcuts on), a mail write, or network emulation; 10 differ (custom date range, compose formatting bar overflow, label palette, star tooltips, search-as-you-type …) · research/PARITY.md · builder (moved to Backlog: Milap chose the release path first, 2026-10-25)
- Visual diff that can pass: seed the Courier preview with the recon mailbox and mask by-design layout (no Chat/Meet rail, side panel, chip row), then hillclimb the 32 states under 10% · research/tools · builder
- P12.2 differential runner: resume its builder (stopped at the usage limit; work so far is committed) · research/tools · builder
- Faster All Mail on big mailboxes (#10): done when label.firstRowsMs drops well under budget with list order unchanged · app/src-tauri/src/db.rs · builder
- Fuzzer engine bugs, deferred by Milap until there's budget ("a rainy day"): #6 offline conversation change sent before an earlier Undo (A), #7 Undo after an offline change went out puts wrong labels (B), #8 Undo racing the reconnect flush is lost (D), #9 another device's change lost when an Undo races the sync (E). Each has an `#[ignore]`d repro in app/src-tauri/tests/race_fuzz.rs naming its issue; done when the repro passes un-ignored and the issue is closed · app/src-tauri/src · debugger
- Settings ▸ General ▸ Language selector stays (English US/UK) for languages Milap may add later; ST-01 stays a deliberate gap until then · app · main session
- Confirm #2 (flash) and #5 (subscription count) in Milap's own use after 1.1.0 is installed, then close them · Milap + main session
- Cleanup list for Milap after the release (what of Courier leaves the Mac), asked before deleting · main session

## Done

- 1.1.0 released: https://github.com/milappatel1/Courier/releases/tag/v1.1.0; dmg dc549931…5df2, zip 7d3746a5…4d48; both downloaded back and matched; installed in /Applications from the public zip (1.0.7 kept in ~/Library/Caches/app-backups) · 2026-10-26

- Ultracode gates (research/VERIFY-P12-GATES.md): parity sweep (81/81 matches rows cite live tests; stale rows fixed; predicate not met: 96 unverified, 8 differ) and interrogate (2 Opus reviewers; 14 act-on findings fixed with tests in f5eadde, 2479f48; 7 filed as #11–#17); e2e 86/86, Rust 81, model 83,254 paths · 2026-10-25

- Security gate: trivy and npm audit clean; /claude-security unavailable (no Workflow tool), a security-auditor review instead: 0 critical/high; fixed both mediums (vacation HTML sanitised, IMAP delete checks UIDVALIDITY) and lows 3–4 (unsubscribe address and host checks) · 9f3c0b9

- Visual parity first pass: search icon, tab widths, outline checkbox, field underline, Create filter disabled until set (0657599); the diff metric can't score these (rows masked, by-design layout), recorded in VERIFY-P12.1-visual.md · 2026-10-25

- Visual diff tooling (L-06): research/tools/visual-diff.mjs, Courier capture plan, threshold 10% of ink pixels in LOOK-SPEC.md; first run: 0 of 32 states under it (VERIFY-P12.1-visual.md lists each difference) · f3ecb20

- Perf budgets (P12.5): 3 runs on 20,000 conversations, budgets set from the medians, all within; research/PERF.md and VERIFY-P12.5.md; All Mail switch ~0.9 s filed as #10 · 2026-10-25

- Full e2e on a quiet Mac: 83/85, never in front; the 2 failures were an unsubscribe reload race (fixed c7c93f8) and test mail from a new step showing as "new" (fixed); both steps green in a rerun · 2026-10-25

- Fuzzer bug C fixed: a server listing no longer shows a conversation being binned in its old view · 1deab7c

- Race fuzzer (P12.4): green in normal runs (60 seeds × 40 steps, 24 s); long run 710 seeds × 80 steps; each invariant shown able to fail; found engine bugs A–E (ignored repros in race_fuzz.rs) · 09dea06, cdefe75, 5e0b02c
- Parity sweep fixes: Scheduled note, empty-view wording, search chips, label menu order, message/compose menu words and order, Switch to simple toolbar, Stars help text (V-08, V-14, H-02, N-05, CV-03, B-05, CP-01, CP-05, T-05, ST-14) · 2026-10-25

- Language (ST-01): Milap chose English only; PARITY.md marks it "✗ left out", README Known limitations says so · 2026-10-25

- Vacation responder message is a rich editor (bold, italic, underline, link, lists, clear), saved as HTML plus plain text (ST-23) · 2026-10-25

- Custom keyboard shortcuts: Advanced ▸ Custom keyboard shortcuts adds a Keyboard Shortcuts tab; custom keys win over defaults (ST-41) · 2026-10-25

- Category chips: Settings ▸ Labels ▸ Categories ▸ Show in message list (hide by default, read from the recon account); recon categories set back to hide in the label list (left over from the last session) · 2026-10-25

- Shift+R/A/F open the reply in its own window (K-25/27/29); filtered e2e of every new step green (Shift+R, Spelling, Move to tab, shortcuts, sign out of all) · 2026-10-25

- Saved and pushed at 8a38d03; DEV copy verified (2026-10-25) · dev-end
- Issues #1 (Updates count), #3 (scroll position), #4 (unsubscribe once) closed with commits · 2026-10-25
- Full e2e 76/76 on a quiet Mac: flash under Milap's conditions, Manage subscriptions, IMAP sign-out green · 2026-10-25
- P12.6 offline gaps: Delete forever offline (delete_queue), whole-view actions offline, snooze offline test, IMAP offline e2e step; VERIFY-P12.0.md and VERIFY-P12.6.md · 2026-10-25
- Parity fixes: T-09 row menu Move to tab, CV-04 and T-03 More menus, H-07 sign out of all, ST-11 Spelling/Autocorrect, shortcuts K-15/16/31/32/36/41/42 · 2026-10-25
- Formal model green at depth 6; it found 4 real ordering bugs, fixed in b83e334; verify-ledger skill proven able to fail · 2026-10-25
- perf-suite merged into main; perf-suite and race-fuzzer branches deleted · c9a0566
