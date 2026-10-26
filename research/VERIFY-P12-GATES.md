# VERIFY P12: the release gates (ultracode, 2026-10-25)

Both gates ran with ultracode on, at Milap's request, on `main` after the security fixes (`9f3c0b9`).

## Gate 1: final parity sweep

Method: every row of `research/PARITY.md` marked **matches** must cite a test or code that exists, and those tests
must pass; then an adversarial sample of the rows.

- `python3 research/tools/parity-refs.py .` (new): 81 of 81 "matches" rows cite tests or code that exist.
- The sample found two kinds of rot, both fixed in `a1b5e62`:
  - rows that cited e2e steps by line number (`run.ts:896`) pointed at other steps once run.ts grew by several
    hundred lines; they now name the step, resolved against the file the triage read;
  - C-10, T-11, T-12 and B-13 still said differs or missing though this round fixed and tested them; L-06 now
    records the visual-diff tool and its result.
- Suites (2026-10-25, quiet Mac): e2e 85 passed, 0 failed, app never active and never in front; Rust 81 passed
  (formal model at depth 6, race fuzzer 60 seeds, engine), 4 ignored repros of issues #6–#9; Vitest 104;
  typecheck; secret scan.

**Ledger at the gate:** 202 rows: 81 matches, 17 ✗ (Google-only or left out), 8 differ, 96 unverified.
**Exit predicate "every row matches or is ✗": not met.** What stands between:

| Open | Rows | Why |
| --- | --- | --- |
| Unverified, need a recon setting changed | 68 (59 keyboard-shortcut rows need Keyboard shortcuts on) | Milap allowed temporary changes; the sweep was moved to Backlog when he chose the release path first |
| Unverified, need a change to recon mail | 21 | the P12.2 differential runner (Backlog) |
| Unverified, need network emulation | 7 | loading and offline states |
| Differ | 8 | H-02 search-as-you-type, H-03/S-03 custom date range, N-05 label palette, CP-03 formatting bar overflow, ST-14 star tooltips, ST-15 shortcuts default, L-06 visual diff |

## Gate 2: release-gate audit (pstack interrogate)

Two adversarial reviewers over `git diff 932fd2f..HEAD` of the riskiest code (the change ledger, the offline queue,
sync's stamped reads, the list state, counts): Reviewer A (Opus, xhigh: Rust internals), Reviewer B (Opus, high:
UI list state, IPC seams, counts). Both are Claude: this setup has no second model family, so agreement means less
than across families. Each critical and warning was checked against the code before it was acted on.

### Act on (fixed, each with a test)

| Finding | Raised by | Fix |
| --- | --- | --- |
| Undo did nothing for IMAP archive/delete (moved mail gets new ids) | A | `f5eadde`: Undo by conversation, adding back only labels the messages had |
| A reply arriving while its conversation's change was out kept the change's overlay for good | A | `f5eadde`: ending a conversation change recomputes all its cached messages |
| After a restart an offline message change under an offline conversation change was lost from view | A | `f5eadde`: load order and the overlay rule |
| A sign-in failure (Keychain refusal) left a change shown for good | A | `f5eadde`: sign-in fetched before the change shows |
| An online Delete forever could be undone by a read in flight | A | `f5eadde`: stamped tombstones |
| Actions in Trash and Spam changed nothing but said they did | A | `f5eadde` |
| Switching views mid-action drew a removed row again | B | `2479f48` (e2e failed at +111 ms first) |
| One account failing in a multi-account action brought back the others' rows and lost their Undo | A and B | `2479f48` |
| Move to tab didn't hide the row; unsubscribe's double-click guard freed early; Undo of an empty change failed; phone drawer "new" on the open tab; read stamping order; queued-delete tombstone order; account removal left overlays | A, B | `f5eadde`, `2479f48` |

### Consider (filed, not fixed this round)

#11 bulk Undo is the blind inverse (pre-existing) · #12 IMAP conversation ids repeat across accounts in the unified
Inbox · #13 the designed re-read of a lagging listing isn't implemented (raised by A and B) · #14 search views use
the cache's FTS for in-flight conversations · #15 large offline whole-view flushes are slow and block the account ·
#16 "N new" compares the server's date with this Mac's clock · #17 structure: one overlay, one ledger module (plus
two smaller races). Deferred earlier: #6–#9 (offline Undo ordering and races).

### Noted

The Inbox count and badge count cached mail only (older unread Inbox mail is cached, so only mail beyond the cache
cap is missed; in #17). An action finishing after an account switch clears the new view's selection (nit).

### Verdict

No open critical finding in this round's code. Ship 1.1.0 with the known gaps above listed in the release notes and
README; the parity predicate is not met and the release notes say so.

The formal model's acknowledgement step was updated to the engine's new order (beyond messages first, then the
overlay) and rerun: 83,254 paths to depth 6, green. Full e2e after the fixes: 86 passed, 0 failed, never active,
never in front.
