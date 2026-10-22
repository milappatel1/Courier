# Design: stamped reads and conversation changes (P12.0 flash fix)

pstack architect, Phase B synthesis (arena). Grounding: `list-state-grounding.md`. Candidates: two runners
(candidate 1, opus xhigh, open brief; candidate 2, opus high, told to keep one source of truth), plus a
cross-judge. Both candidates converged on the same shape, which arena reads as strong agreement; the synthesis
keeps that shape and simplifies its lifetime rule.

## Problem

Three faults put a removed row back on screen (evidence in `VERIFY-P12.0.md`):

1. A conversation action changes only the messages this Mac keeps, so a long conversation stays in the server's
   Inbox (Rust repro `deleting_or_archiving_a_conversation_takes_all_of_it_…`).
2. A server answer read before a change landed is written after the change's protection ended
   (`a_server_answer_read_before_a_change_landed_never_puts_the_old_labels_back`; the e2e trace names four writers:
   history relabel, opening a thread, message ingest, the listing double-check).
3. The list alternates between the cache step and the server step on every reload, and the Primary tab asks the
   server for `category:primary` while the cache treats Primary as "Inbox minus the enabled tabs" (Forums rows
   appear and vanish).

## Usage

- Server data reaches the cache only through a `Read`, opened before the request leaves:
  `let read = db.begin_read(account); … read.set_labels(id, labels); read.upsert_message(row, raw); read.forget(id)`.
  A read's stamp comes from one monotonic clock (generation per launch << 32 | counter).
- The cache keeps what the server said (`messages.server_labels`, `server_stamp`) apart from what is shown
  (`messages.labels`), which is derived: the server's labels with every change still on its way folded on top.
  Listings, search and counts keep reading `labels` unchanged.
- A change made here: `engine.modify_threads(account, threads, add, remove) -> Changed { change_id, queued }`.
  Undo: `engine.undo_change(account, change_id)`.

## Shape

- **Newest read wins, and an acknowledgement is a read.** A label write from a read with stamp `R` applies only
  if `R >= server_stamp`. When the server acknowledges a change, Courier mints a stamp `L` and folds the change
  into `server_labels` of every cached message it covers, with stamp `L`. Every answer read before the ack
  (`R < L`) is then older than the stored base and loses; every answer read after it reflects the change. No
  landed change has to linger as an overlay for cached mail.
- **Pending changes** (sending or waiting offline) stay an overlay on `labels`, keyed by conversation for
  conversation changes (so messages ingested later in that conversation are covered) and by message otherwise.
  Persisted when they wait offline (`change_queue` gains `thread_id` and `scope`).
- **Conversation marks.** At the ack, a conversation change also leaves a mark `(thread, op, L)`. A read with
  `R < L` that inserts a message of that conversation this Mac didn't have gets `op` folded on top. A mark is
  dropped once no read with a stamp below `L` is still in flight (a registry of open reads).
- **Conversation changes cover the whole conversation.** For mail-API accounts the sender reads each conversation
  (`threads.get`, format=minimal) before changing it, under a `Read`, and sends `messages.batchModify` for every
  message the op touches (the per-message Trash/Spam rule: a non-bin change leaves trashed messages alone). The
  read also gives each message's labels before the change, kept for Undo. Offline, the conversation id waits in
  the queue and is read when the connection is back. IMAP keeps resolving to the cached messages.
- **Undo restores what was there**: a change still waiting is cancelled; a landed one gets a restore that gives
  each message back the touched labels it had (from the read above, or the cache for cached mail).
- **Counts**: the optimistic delta at registration and the freeze while pending stay; at the ack the label's
  `counts_stamp` becomes `L`, and a counts answer read before that loses.
- **Listings**: the server step drops a listed conversation whose cached labels put it outside the view when
  the conversation has a change the listing's read couldn't have seen (pending, or a mark with `L > R`). Each
  listing carries the newest change id it reflects (`ledger`); the UI hides rows from the click until a listing
  with `ledger >= change id` arrives (masks keyed `account:thread`). A quiet refresh of the same view runs only the
  server step for mail-API accounts online (no cache/server alternation). Primary is queried as "Inbox minus the
  enabled tabs' categories" (plus starred when Primary includes them). One refresh timer per account; the open
  conversation's refetch applies only if the route still points at it.

## Synthesis decision

Cross-judge (arena Phase C, a separate read-only agent): candidate 1 as base, 26/30 against 18/30, with three
grafts from candidate 2 (Restore built from stored prior labels; keep `modify_threads`/`modify_messages` as
wrappers so existing tests pass as written; `threads.get` + shared `batchModify` instead of a quota planner). It
found holes that this synthesis closes:

- *A new reply archived for good* (a conversation change covering messages inserted later): conversation marks
  cover only the message ids the server had when the change was sent, never the whole thread.
- *Re-folding a state-dependent change* (the Trash rule makes an op depend on the message): a conversation change
  is turned into per-message set/unset changes once, when it is registered (cached mail) or sent (the rest), so
  applying one twice is harmless.
- *A lagging listing after the protection ends*: a listed conversation the cache says isn't in the view, with no
  local change to explain it, is read again (`threads.get`) under a newer read and the fresh answer decides; one
  with a local change the listing couldn't have seen is dropped.
- *Counts read before the ack, answered after it*: the ack stamps the label's counts; such an answer loses.
- *"Stamp before the request" as a convention*: the mail API client's read methods take the `Read`, so a request
  can't go out without one.

Kept from the synthesis: the ack is treated as a read at `L` (changes folded into the server base at once,
narrowly for the ids the server confirmed), so no sweep or Verify pass is needed; marks need the read registry
only for ids this Mac didn't have. Rejected for now: candidate 1's quota planner, pacer and bulk phase B (the
existing retry on 429/403 paces; revisit if the race fuzzer or the perf suite shows rate limits), and
candidate 2's replacement of the queue tables (`change_queue` gains a conversation scope instead, so waiting
changes migrate in place). Known gap carried: a queued IMAP change to messages an earlier queued move renamed
goes to ids that no longer exist (as today).

## Tradeoffs accepted

- We accept one `threads.get` before each conversation change reaches the server (one round trip, 10 units), in
  exchange for covering every message and an exact Undo. The UI shows the change at once either way.
- We accept that a change made on another device between our read and our ack can be masked until the sync the
  ack triggers (seconds), in exchange for no per-message bookkeeping after the ack.
- We accept that an answer read before our ack also loses any unrelated label change it carried (a star added on
  the phone) until the next read, for the same reason.

## Next implementation step

Add the clock, `Read`, `server_labels`/`server_stamp` and derived `labels`, move every server-data writer onto
`Read`, and fold the change into the base at the ack; make the stale-read repro pass with every existing test
green. Then conversation changes (marks, send-time read, queue scope, Undo), then the listing and UI changes, then
counts.
