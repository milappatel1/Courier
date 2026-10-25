# Board

Courier is past v1 (1.0.7 released), so this board replaces STATUS.md. Rules: `~/.claude/workflow/board-template.md`
(Doing and Next hold at most 5 cards; a card moves to Done only after the verify skill passes on it).
Card: `- <title>: done when <check> · <area> · <owner>`.

## Doing

- Fix the fuzzer's engine bugs: done when each `#[ignore]` repro in app/src-tauri/tests/race_fuzz.rs passes un-ignored and the fuzzer's KNOWN list is empty. A: offline conversation change sent before an earlier Undo's rows (flush order). B: Undo after the offline change went out inserts the literal inverse. C: server listing that ingests a conversation while it's binned lists it in the old view. D: Undo of a waiting change racing the reconnect flush. E: remote change lost when an Undo's ack stamps a message newer than the sync's read · app/src-tauri/src · main session (debugger if one beats two attempts)
- P12.2 differential runner (Milap allowed the recon scripts 2026-10-25): done when the same action scripts run in the web client (recon account) and in Courier with matching rows, counts, toasts and focus · research/tools · builder (web side waits until the read-only sweep frees the recon tab)
- Visual diff tooling (L-06): done when research/tools/visual-diff.mjs compares Courier and web goldens under a LOOK-SPEC threshold with masks, and states over it are listed · research/tools · builder

## Next

- Full e2e rerun on a quiet Mac: done when every step passes with nothing heavy running (new since the last green run: Move to tab, `] [ ; : \` ~` shortcuts, Spelling/Autocorrect, Sign out of all accounts) · app/src/e2e · verifier
- Perf budgets (P12.5): done when `app/scripts/perf.sh` runs on a quiet Mac, budgets are set in `app/src/e2e/perf-budgets.json`, and research/PERF.md + VERIFY-P12.5.md are written · app/scripts · builder
- Parity rows: 96 unverified need a setting change in the recon account (59 shortcut rows need Keyboard shortcuts on), a mail write, or network emulation; 10 differ (custom date range, compose formatting bar overflow, label palette, star tooltips, search-as-you-type …) · research/PARITY.md · builder

## Backlog

- Settings ▸ General ▸ Language selector stays (English US/UK) for languages Milap may add later; ST-01 stays a deliberate gap until then · app · main session
- Security gate: `/claude-security` on the changes, `trivy fs`, supply-chain-risk-auditor, differential-review, rust-review · repo · reviewer
- Ultracode gates: final parity sweep and release-gate audit (ask Milap to switch ultracode on, then off) · main session
- Release 1.1.0 per DEVELOPING.md: GitHub release, hashes, install after Milap quits Courier, numbers-only real-account check · main session
- Confirm #2 (flash) and #5 (subscription count) in Milap's own use after 1.1.0 is installed, then close them · Milap + main session
- Cleanup list for Milap after the release (what of Courier leaves the Mac), asked before deleting · main session

## Done

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
