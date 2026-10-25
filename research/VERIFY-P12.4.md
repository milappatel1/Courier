# VERIFY P12.4: correctness under sync races

Two checks, both against the real cache and engine code. Decision trail: `research/decisions.tsv`.

## Formal model: `app/src-tauri/tests/ledger_model.rs`

Every order of up to six events (local changes to a conversation and a message, sends, acknowledgements,
refusals, waiting offline, the flush, server reads started and delivered late, another device's change), replayed
on the real `Db`. Properties: a removed message never comes back while the user's latest change stands, and the
cache settles to the server. Green at depth 6 (71,575+ paths, about 5 minutes) after it found four real ordering
bugs (`b83e334`). How to run, what it covers and its sync commit: `.claude/skills/verify-ledger/SKILL.md`. Both
properties were shown able to fail with scratch breaks.

## Race fuzzer: `app/src-tauri/tests/race_fuzz.rs`

Two mail-API accounts on two fakes behind a recording proxy; random seeded sequences of thread and message changes,
Undo, Delete forever, another device's edits, new mail, syncs, cache and server listings, network loss and return,
latency, refusals, run two or three at a time where races matter. Invariants:

1. A conversation the user removed from a view never comes back in it while that change stands.
2. Once everything settles, the cache's labels and every count equal the server's.
3. No count goes negative.
4. Accounts never leak into each other.
5. The offline queue drains exactly once (per composed change), and nothing waits after the settle.

Each invariant was shown able to fail (`COURIER_FUZZ_FAULT=resurrect|drift|negative|leak|dupsend|swallow|stuck`).

| Run | Result |
| --- | --- |
| Normal `cargo test --test race_fuzz` (60 seeds × 40 steps, ~24 s) | green; seed 17 listed as KNOWN (issue #8) |
| Long run (710 seeds × 80 steps, `nice -n 19`, 521 s, Undo while offline left out) | 708 passed; seed 20207 = issue #9; seed 20298 a harness artefact, fixed |

## Engine bugs found

| | What | Status |
| --- | --- | --- |
| C | A server listing that brings in a conversation while it's being binned listed it in its old view | Fixed `1deab7c` (conversation-level changes count as known newer) |
| A | An offline conversation change went out before an earlier Undo's message rows | Open: issue #6, deferred by Milap |
| B | Undo of an offline conversation change after it went out queued the literal inverse (labels it never had) | Open: issue #7, deferred |
| D | Undo of a waiting change racing the reconnect flush was lost | Open: issue #8, deferred |
| E | Another device's change lost when an Undo's acknowledgement stamps the message newer than the sync's read | Open: issue #9, deferred |

Each open bug has an `#[ignore]`d reproduction naming its issue; run them with
`cd app/src-tauri && cargo test --test race_fuzz -- --ignored`.

## Known gaps

- Soft finding: after an incremental sync, label counts can stay estimates (from `apply_label_deltas`) until the
  next label refresh; a full resync makes them exact.
- A search that lags behind the server can show a just-archived conversation in the Primary tab for the lag
  window (exempt by default; `COURIER_FUZZ_LAG_STRICT=1` holds it to the rule).
- Not covered by the fuzzer: IMAP accounts, Snooze, Mute, Block, the outbox, whole-view actions, emptying a label.
