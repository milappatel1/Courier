# Grounding: conversation actions, the cache and the list while actions are in flight

Phase A of pstack's architect skill for the P12.0 flash fix. Sources: three read-only explorers (how skill) over
`engine.rs`, `db.rs`, `gmail.rs`, `store.ts`, `actions.ts`, `ListView.tsx`; the e2e repro under the user's
conditions; the Rust repro `deleting_or_archiving_a_conversation_takes_all_of_it_even_messages_older_than_this_mac_keeps`.

## How it works today

- **Actions.** `act()` (actions.ts) hides the rows at once (`hideThreads`: `leaving[id] = Infinity`), calls
  `modify_threads` per account, then `settleThreads` (`leaving[id] = listSeq + 1`) and `loadList({quiet})`.
- **Rust side.** `modify_threads` expands thread ids to the **cached** message ids (`thread_message_ids`) and calls
  `modify_messages`: `begin_change` writes the change into the cache and records it in `pending` (an overlay
  `with_pending` re-applies on every server write while the change is in flight), emits `mail-changed`, sends
  `batchModify`, `end_change` drops the overlay, refreshes the touched labels' counts, triggers that account's
  sync and emits `mail-changed` again. Offline, the change goes to `change_queue` (one row per message).
- **Listing.** `loadList` takes a sequence number, applies the cache listing, then (mail-API accounts, online)
  the server listing; a newer listing makes older ones drop their result. Rows are filtered by `hiddenThreads`;
  `stillHidden(seq)` releases a hidden row once listing `seq >= leaving[id]` arrives. The server listing's rows are
  built from the cache (`thread_summaries`), so a row the server lists shows even if the cache says it's trashed.
- **Events.** Any `mail-changed` from the current account reloads the list (and labels and the open thread)
  through one shared 250 ms debounce; a later event from another account replaces the pending refresh.
- **Sync.** Each account syncs on its own loop (60 s, or when triggered). History records overwrite cached labels
  with the record's label snapshot, re-applying only changes still pending.

## Known faults (evidence)

1. A conversation action changes only cached messages: long conversations keep older messages in the server's
   Inbox (Rust repro). The next server listing lists the conversation again, so its row comes back; the cache
   step hides it again on the next reload, so it can flicker on every refresh, and Gmail elsewhere still shows it.
2. Once an action settles, the first listing after it is trusted completely. Any data source that still lists the
   row then (a server read that started before the change and wrote after `end_change`, fault 1, another device)
   shows it again.
3. The open conversation's refetch in `refreshSoon` applies without checking the route still matches (a late
   answer for the deleted conversation can replace the next one).
4. One shared debounce timer: another account's event can drop the current account's pending refresh.
5. Cache step then server step: the page count and row order can alternate between the two on every refresh.

## Constraints the design must keep

- Undo restores exactly what was there; changes made offline keep working (change_queue, restart-safe).
- A row the user removed never comes back on screen because of stale data; it may come back only when the server
  says it's back after the change landed (changed elsewhere, or Undo).
- Once settled, the list and every count equal the server's truth.
- IMAP accounts (message ids carry folder/UID; moves change ids) keep working.
- Gmail API: `threads.modify`/`threads.trash` act on every message of a conversation server-side;
  `messages.batchModify` takes up to 1000 message ids per call; per-user rate limits apply.
