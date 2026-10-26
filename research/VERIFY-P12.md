# VERIFY P12 — 1.1.0 (full parity round)

Scope: the two bugs the user still hits every day (the sidebar's Updates count is higher than the Inbox's Updates
tab; deleting the top Inbox row a few times in a row still flashes), then full 1:1 parity with the web client
(behaviour, timing, look) proved by tests, a race fuzzer, performance budgets and a bug hunt, and the 1.1.0
release. Method: pstack's figure-it-out under the autonomous-run playbook, with the investigation, bug-fix,
visual-parity, hillclimb, feature and perf-issue playbooks per step. Decision trail: `research/decisions.tsv`.
Each phase has its own note (`VERIFY-P12.0.md` … `VERIFY-P12.7.md`); this file holds the frame and the baseline.

## Frame

**Exit predicate** (written before the first change):

1. Both bugs reproduced, fixed and confirmed where the user saw them: the counts on the seeded recon account in
   the web client and in Courier, and on the user's real accounts by numbers only; the flash in the frame
   recorder under the user's conditions, and in a diagnostic log or the user's own use where needed.
2. Every row of `research/PARITY.md` matches or is ✗ (Google-only).
3. Every suite green: Vitest, Rust, end to end, the differential runner, the race fuzzer, count tests,
   performance budgets, layout checks, visual parity.
4. Visual diffs under the threshold in `LOOK-SPEC.md`, performance budgets met.
5. 1.1.0 published, both files downloaded back from the public links with matching SHA-256.

**Scope.** Two daily bugs; recon from scratch (new profile, seeded mailbox, goldens for every view, menu, dialog,
settings tab, state, density, theme and width); a parity ledger of a few hundred rows; four new suites; the three
offline gaps left by 1.0.7; a release. Blockers found while framing: the user signs in to the recon Chrome and
the debug build; the debug build must never open the real data folder or Keychain item; two other sessions build
on this Mac, so builds are slow.

**Rigor: high.** The riskiest code (sync, history, pending changes, the offline queue, the list's state while
actions are in flight) runs on the user's real mailboxes every day. Every fix gets a failing test committed first;
the queue and listing state machine gets a model checked over every interleaving; the riskiest code gets an
adversarial review before release.

## Design (phases, riskiest unknown first)

| Phase | What | Why this order |
| --- | --- | --- |
| P12.0 | The two bugs. Flash: fakes shaped like the user's accounts (several accounts syncing, thousands of conversations over five categories, latencies measured from the web client), deletes at the user's rhythm (the log shows about four a second). Counts: what each web-client number means, observed on seeded test mail, then Courier made to mean the same. | Daily pain; the flash may need a diagnostic build and the user, so it starts first. |
| P12.1 | Recon profile, seeded recon mailbox, goldens, `research/PARITY.md`, the repo's verify skill. | The ledger and goldens are the yardstick for everything after. |
| P12.2 | One action-script format run in the web client (CDP) and in Courier (e2e against fakes seeded alike), diffed step by step. | Behaviour parity by measurement, not by eye. |
| P12.3 | Close every gap the ledger shows (hillclimb on open rows + pixel diff). | Needs P12.1–P12.2. |
| P12.4 | Race fuzzer (fixed seeds + one long run) and a model of pending changes, the queue and out-of-order listings. | Separate seam (Rust tests, fakes); can run alongside P12.2. |
| P12.5 | Performance on a 20,000-conversation mailbox; budgets from measurement. | Separate seam. |
| P12.6 | Offline gaps from VERIFY-P11. | Builds on the P12.4 model. |
| P12.7 | Bug hunt until the predicate holds. | Last. |
| Release | Adversarial review (interrogate), 1.1.0 packaged, published, downloaded back and checked; installed after the user quits Courier; numbers-only check on the real accounts. | — |

## Baseline (fresh clone at `932fd2f`, before any change)

Machine shared with two other sessions' builds.

- Vitest: 103 passed (9 files).
- Rust: 58 passed, 2 ignored (opt-in live TLS checks).
- End to end: 73 passed, 0 failed in 499 s (71 steps + 2 run-wide checks); "app reported never active; frontmost-app
  watch never saw the test app in front".
- Whole `npm run test:all`: exit 0.

## Result (2026-10-26, 1.1.0)

Phase notes: `VERIFY-P12.0.md` (the bugs), `VERIFY-P12.1-visual.md` (visual diff), `VERIFY-P12.4.md` (model and
fuzzer), `VERIFY-P12.5.md` (performance), `VERIFY-P12.6.md` (offline gaps), `VERIFY-P12-GATES.md` (parity sweep and
release-gate audit). P12.2 (differential runner) and the settings-based part of the parity sweep were moved to the
board's Backlog when Milap chose the release path first (usage budget).

Exit predicate, item by item:

1. Both bugs fixed and confirmed in the frame recorder under the user's conditions and on seeded web-client mail;
   confirmation in the user's own use after install is pending (#2, #5 stay open until then). **Partly met.**
2. Every PARITY.md row matches or is ✗: 81 match, 17 ✗, 104 open. **Not met.**
3. Every suite green: Vitest 104, Rust 81 (formal model depth 6, race fuzzer), e2e 86/86 never in front; the
   differential runner isn't finished. **Met for the suites that exist.**
4. Visual diffs under threshold: 0 of 32 (rows masked, layout differs by design). Performance budgets: met.
   **Partly met.**
5. 1.1.0 published and checked: see the release.

