---
name: verify-ledger
description: Formally check Courier's change ledger (pending label changes, the offline queue, stamped server reads) over every order of events. Use before committing any change to app/src-tauri/src/db.rs's pending/queue/read code or to the label-change paths in engine.rs (change, flush_queue, undo_change), and when a row or label "comes back" after an action.
---

# Verify the change ledger

## What it proves, in plain words

- **No resurrection.** After any order of events, a message shows the Inbox state of the user's latest change
  to it, unless that change was refused or another device changed it afterwards. Harm when broken: a deleted or
  archived conversation reappears in the list (the "flash" users report), or a change made offline is lost.
- **Settles.** Once every change is answered, every read delivered and one more read made, the cache's labels
  equal the server's. Harm when broken: counts and rows stay wrong until a restart.

## How

`app/src-tauri/tests/ledger_model.rs` is a bounded exhaustive explorer that runs the **real** cache code
(`courier_lib::db::Db`, in memory) under every interleaving of these events, up to `COURIER_MODEL_DEPTH` events
(default 6; the long run uses 8):

| Event | Real code it calls |
| --- | --- |
| `Local(Thread0 \| Msg1, Archive \| Inbox)` | `Db::begin_change` on the cached messages; `Db::begin_thread_change` for the conversation (as `Engine::change` does) |
| `Send(i)` / `Ack(i)` / `Refuse(i)` | server applies the change / `Db::end_change(ok)` + `Db::mark_landed` / `Db::end_change(false)` |
| `Offline(i)` / `Flush` | `Db::queue_change`, `Db::queue_thread`, `Db::thread_change_queued` / `Db::change_sent`, `Db::mark_landed`, `Db::thread_done` (as `Engine::flush_queue`) |
| `Issue` / `Deliver(i)` | `Db::begin_read` (stamp now, answer = server now) / `Read::set_labels`, `Read::upsert_message` later |
| `Remote(m, op)` | another device changes the server copy |

The world: conversation t0 = m0 (cached) + m2 (on the server only at first, cached once a read delivers it); m1 a
single message. A tool choice note: a TLA+ model would have to re-describe `fold_pending` and the stamps by
hand; exploring the real `Db` keeps the check true to the code, at the cost of a small bound.

## Run it

```bash
cd app/src-tauri && CARGO_TARGET_DIR=$PWD/target/tests cargo test --test ledger_model -- --nocapture
```

About 5 minutes at depth 6 on an M-series Mac (71,575+ paths), and it prints `ledger model: N paths checked to depth 6`.
Long run: `COURIER_MODEL_DEPTH=8` (hours; run in the background). It is also part of `tools/precommit.sh`.

## Reading a failure

The panic names the step and the path, e.g.
`after step 6 (Local(Thread0, Inbox)): m2 shows Inbox=false, but the user's latest standing change says true
path: [Local(Thread0, Archive), Send(0), Issue, Issue, Deliver(0), Local(Thread0, Inbox)]`. Replay it by hand
against the table above. Then decide:

- **Real bug**: the engine would do exactly these calls in this order. Fix `db.rs`/`engine.rs`, never the model.
  Commit a failing repro first if the path wasn't already failing.
- **Modelling error**: the model calls something the engine never does (or misses a call it makes). Fix the model
  to mirror the engine, and say which engine line it now mirrors. Example from 2026-10-24: the model changed only
  m0 for a conversation change while `Engine::change` changes every cached message of the conversation.

## Coverage record

Checked against these functions (app/src-tauri/src/db.rs unless noted): `fold_pending`, `compose`,
`begin_change`, `begin_thread_change`, `sync_thread_queue`, `end_change`, `mark_landed`, `queue_change`,
`queue_thread`, `cancel_queued_thread`, `thread_change_queued`, `thread_done`, `change_sent`, `upsert_from_server`,
`server_labels`, `rederive`, `begin_read`/`Read`; and engine.rs `Engine::change`, `Engine::flush_queue` (the call
orders the model mirrors).

Not covered: `Engine::undo_change` / `Db::cancel_queued` (undo isn't an event yet), `queue_delete` (Delete forever
offline), label counts, IMAP, more than one conversation change per conversation in flight at once beyond two
local changes, and listings (`Engine::list`; the race fuzzer `tests/race_fuzz.rs` and the e2e frame recorder
cover those).

**Sync commit: 720592b** (2026-10-24). Every function above was read against the model at this commit. When any
of them changes, re-read the matching rows of the table, rerun the check, and move this commit forward only after
confirming the model still mirrors the code.

## Proven able to fail

At 720592b the check found four real bugs before passing (see `b83e334`): a conversation change applied over a
newer message change, a waiting conversation change skipping messages cached later, opposite offline changes
cancelling, and stale-label measurement dropping a change.

Scratch breaks on a copy of the crate at 720592b (2026-10-24), both caught:

- Dropping the oldest-first sort in `fold_pending`: "No resurrection" failed after 3,266 paths (12 s) on
  `[Local(Thread0, Archive), Send(0), Issue, Issue, Deliver(0), Local(Thread0, Inbox)]`.
- `server_labels` ignoring answers that carry labels: "Settles" failed after 9 paths ("settled, but m0 shows []
  while the server has [INBOX]").

To repeat a proof without touching the shared tree: `rsync -a --exclude target app/src-tauri <scratch>/`, break
the copy, run the command above from `<scratch>/src-tauri`, then delete the copy.
