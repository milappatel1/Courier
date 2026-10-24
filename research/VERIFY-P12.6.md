# VERIFY P12.6: the offline gaps left by 1.0.7

Playbook: pstack bug-fix (failing test committed before each fix). Decision trail: `research/decisions.tsv`,
phase `P12.6`. All checks against the local fakes: the mail API's `offline` flag (503 to everything) and the IMAP
server's (connections reset, new ones refused).

| Gap (VERIFY-P11) | Now | Commits | Proof |
| --- | --- | --- | --- |
| Delete forever needed a connection | Made at once: the messages leave the cache and wait in `delete_queue` over a restart; nothing the server says meanwhile brings them back; when the connection is back they go out after any waiting label change, once. An IMAP message whose move is still waiting needs the connection | `7685cc4` repro, `e4b5930` | Rust `delete_forever_offline_is_made_at_once_survives_a_restart_and_goes_out_once_online`, `imap_delete_forever_offline_waits_and_expunges_once_online` |
| Acting on every conversation in a view needed a connection | Offline, the view's conversations come from the cache, change here at once and wait as conversation changes, so each conversation's messages this Mac doesn't keep go with it; the toast says it'll sync when back online | `f011054` repro, `fc7aa42` | Rust `acting_on_a_whole_view_offline_changes_the_conversations_here_and_they_go_out_once_online` |
| Snooze and unsnooze on mail-API accounts weren't queued | Already fixed this round: snooze goes through the label-change queue (`1bd6e7b`) | `7685cc4` (test) | Rust `snoozing_and_unsnoozing_offline_wait_and_reach_the_server_once_back` |
| The e2e `offline` control didn't cover IMAP | `{on: true, imap: true}` takes the IMAP server offline too | `c876243` | e2e "offline (IMAP): a delete is made at once, waits, and reaches the server when back online" |

## Known gaps

- Offline, a whole-view action changes only the conversations this Mac has for the view (the cache keeps the last
  30 days plus older unread Inbox mail); older conversations of the view need a connection. Its toast has no Undo.
- Creating or editing labels still needs a connection (the server names the label).
