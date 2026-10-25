# Board

Courier is past v1 (1.0.7 released), so this board replaces STATUS.md. Rules: `~/.claude/workflow/board-template.md`
(Doing and Next hold at most 5 cards; a card moves to Done only after the verify skill passes on it).
Card: `- <title>: done when <check> · <area> · <owner>`.

## Doing

- Race fuzzer (P12.4): done when `app/src-tauri/tests/race_fuzz.rs` (WIP, 73 KB, kept out of git in .git/info/exclude) is reviewed, finished, green, and committed with the exclude line removed · app/src-tauri/tests · builder

## Next

- Full e2e rerun on a quiet Mac: done when every step passes with nothing heavy running (new since the last green run: Move to tab, `] [ ; : \` ~` shortcuts, Spelling/Autocorrect, Sign out of all accounts) · app/src/e2e · verifier
- Perf budgets (P12.5): done when `app/scripts/perf.sh` runs on a quiet Mac, budgets are set in `app/src/e2e/perf-budgets.json`, and research/PERF.md + VERIFY-P12.5.md are written · app/scripts · builder
- P12.2 differential runner: done when the same action scripts run in the web client (recon account) and in Courier with matching rows, counts, toasts and focus · research/tools · builder (needs Milap's yes on the recon-script allow rules, or a waiver)
- Parity rows: done when the 112 unverified rows are checked read-only in the recon profile and the 10 that differ are fixed · research/PARITY.md · builder
- Missing parity features: Language, custom keyboard shortcuts, vacation rich editor, visual diff tooling (L-06) · app · builder

## Backlog

- Security gate: `/claude-security` on the changes, `trivy fs`, supply-chain-risk-auditor, differential-review, rust-review · repo · reviewer
- Ultracode gates: final parity sweep and release-gate audit (ask Milap to switch ultracode on, then off) · main session
- Release 1.1.0 per DEVELOPING.md: GitHub release, hashes, install after Milap quits Courier, numbers-only real-account check · main session
- Confirm #2 (flash) and #5 (subscription count) in Milap's own use after 1.1.0 is installed, then close them · Milap + main session
- Cleanup list for Milap after the release (what of Courier leaves the Mac), asked before deleting · main session

## Done

- Category chips: Settings ▸ Labels ▸ Categories ▸ Show in message list (hide by default, read from the recon account); recon categories set back to hide in the label list (left over from the last session) · 2026-10-25

- Shift+R/A/F open the reply in its own window (K-25/27/29); filtered e2e of every new step green (Shift+R, Spelling, Move to tab, shortcuts, sign out of all) · 2026-10-25

- Saved and pushed at 8a38d03; DEV copy verified (2026-10-25) · dev-end
- Issues #1 (Updates count), #3 (scroll position), #4 (unsubscribe once) closed with commits · 2026-10-25
- Full e2e 76/76 on a quiet Mac: flash under Milap's conditions, Manage subscriptions, IMAP sign-out green · 2026-10-25
- P12.6 offline gaps: Delete forever offline (delete_queue), whole-view actions offline, snooze offline test, IMAP offline e2e step; VERIFY-P12.0.md and VERIFY-P12.6.md · 2026-10-25
- Parity fixes: T-09 row menu Move to tab, CV-04 and T-03 More menus, H-07 sign out of all, ST-11 Spelling/Autocorrect, shortcuts K-15/16/31/32/36/41/42 · 2026-10-25
- Formal model green at depth 6; it found 4 real ordering bugs, fixed in b83e334; verify-ledger skill proven able to fail · 2026-10-25
- perf-suite merged into main; perf-suite and race-fuzzer branches deleted · c9a0566
