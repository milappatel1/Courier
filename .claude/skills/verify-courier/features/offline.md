# Offline

With no connection, actions (archive, delete, labels, read/unread, stars) happen on this Mac at once and wait,
even over a restart, until the connection is back; sends wait in the Outbox; Undo before then takes a change back;
each waiting change goes out exactly once.

## Sub-features

- `offline-actions` label changes queue (`change_queue`) and flush at the next sync.
- `offline-send` the Outbox.
- `offline-undo` Undo cancels a waiting change.

## How to get to it (user POV)

- Lose the connection (Wi-Fi off) and keep working; the banner says Courier is offline.

## Driving it with the e2e runner

Preconditions:

- `pat@example.com` Inbox.

- **Go offline.** `await api.e2eControl("offline", { on: true })` (the mail API and SMTP answer 503; IMAP isn't
  affected by this control).
- **Delete.** Delete a row; it leaves at once; the toast adds "It'll sync when you're back online."
- **Back online.** `offline: false`, then `sync`; the server shows the change once (Rust tests also cover a
  restart in between).
- **Proof.** The offline steps in `run.ts` pass with the frame recorder showing no row coming back on reconnect.

## Gotchas

- The `offline` control doesn't take the fake IMAP server offline; IMAP offline behaviour is covered by the Rust
  tests (`FakeImap` `offline` / `hang_up_next`).
