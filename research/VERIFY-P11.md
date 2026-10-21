# VERIFY P11 — 1.0.7

Scope: the last open item from 1.0.6's known gaps (label changes made offline failed instead of waiting), and a
bug in the IMAP layer found while testing it.

## How it was checked

- Rust tests against the fake mail API and the fake IMAP server. The fake API's `offline` flag answers every
  request with 503; the fake IMAP server got an `offline` switch (new connections and open ones are reset, as a
  network that went away) and a `hang_up_next` switch (the server closes its side tidily instead of answering,
  as one that timed out or restarted).
- A restart is a second engine opened on the same SQLite file and key store.
- The in-app end-to-end runner, in a background window that never takes focus, with the `offline` control.

## Findings

| # | Issue | Evidence | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | Archive, Trash, spam, read/unread, stars, labels and moves made offline failed with "You're offline." and Try again | VERIFY-P10 known gap; `modify_messages` ended the pending change and rolled back on `Error::Offline` | Offline, the change stays made on this Mac and waits in a new `change_queue` table (one row per message), so it survives a restart and holds over anything read from the server meanwhile. Another change to a waiting message is folded in against the labels it had before, so Undo before reconnecting leaves nothing to send. Each sync sends the queue first, oldest first, grouped by identical change; a new change waits behind earlier ones; a server listing waits until the queue has gone out (no row coming back on reconnect). A change the server then refuses is put back and a toast says so. Toasts for waiting changes add "It'll sync when you're back online." (`661963d`) | Rust `a_delete_made_offline_stays_survives_a_restart_and_goes_out_once_online_and_an_undo_cancels_one` (Gmail), `imap_changes_made_offline_go_out_in_order_once_online`, `a_change_made_offline_that_the_server_then_refuses_is_undone_and_said`; e2e "offline: a delete is made at once and waits, Undo takes it back, and it reaches the server when back online" (frame recorder: the row never comes back on reconnect) |
| 2 | An IMAP server that closes the connection instead of answering was taken for a yes: a sync "succeeded" against nothing and a label change counted as made though the server never saw it | With the fake closing tidily, about 40% of offline IMAP changes returned success with no command in the server's log. async-imap 0.12 reads a response stream that just ends as complete (`parse_mailbox` returns a default mailbox at EOF) | The connection wrapper (`MaybeTls`) turns end-of-stream into an error, so every command the server didn't answer fails as offline: the change waits and the cache stays (`2f0d26e` repro, then the fix) | Rust `an_imap_server_that_hangs_up_mid_command_is_not_taken_for_a_yes` (failing → passing) |

## Known gaps and limitations

- Acting on every conversation in a view, Delete forever, and creating or editing labels still need a
  connection: the first asks the server what's in the view; the others can't be undone or depend on the server's
  answer.
- Snooze and unsnooze on mail-API accounts aren't queued: snoozing offline hides the conversation on this Mac
  only (other devices keep showing it in the Inbox), and unsnoozing offline says it's offline.
- The e2e `offline` control takes the mail API and SMTP offline, not IMAP; IMAP offline behaviour is covered by
  the Rust tests.
