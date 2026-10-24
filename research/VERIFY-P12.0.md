# VERIFY P12.0: the bugs (counts, the delete flash, and issues #3 to #5)

Playbooks: pstack bug-fix (reproduce first, failing test committed before the fix), runtime-forensics for the
flash, architect (arena) for the list-state redesign. Decision trail: `research/decisions.tsv`, phase `P12.0`.

## What was checked, and how

| # | Bug (the user's words, or the issue) | Reproduced | Root cause | Fix | Proof |
| --- | --- | --- | --- | --- | --- |
| 1 | "Updates on the side has more emails than inbox updates" (issue #1) | Web client on seeded recon mail: the menu's Updates = every unread Updates conversation, archived included (= labels.get threadsUnread); a tab shows "N new" only for mail that arrived since the tab was last opened. Real accounts, numbers only: server Updates unread 169 and 30 against 0 unread Inbox Updates in the cache | The tab chip showed the cache's unread count as "N new", and the categories showed in the menu, which the web client hides by default | Tab chips count only mail new since the tab was last opened; categories hidden from the menu by default (Settings ▸ Labels ▸ Categories), shown ones carry the whole-label count (`dfa99e4` repro, `94938f2` fix); Include starred in Primary on by default (`fe2eb07`) | Rust `the_inbox_count_is_…`; e2e "counts mean what the web client's do" |
| 2 | "Still flashes when I delete the first email in the Inbox a couple of times" (issue #2) | e2e under the user's conditions (three extra mail-API accounts with 3,000 conversations over five categories, mail arriving, the real API's measured timings, reads answered from the mailbox as it was and delivered late, deletes about 4 a second): `#` ×3 brought a row back after 6.6 s; also a Rust repro that deleting a conversation left its older uncached messages in the Inbox | Server reads started before a change landed were written after it (history, threads.get on open, the cached page's correction, ingest), and a conversation change only covered its cached messages | The list-state redesign (`research/architect/list-state-design.md`): stamped reads, newest wins, the server's labels kept apart from the shown ones, conversation changes resolved on the server and covering later-cached messages, Undo restoring exactly what was there, the list following what this Mac knows newer (`1bd6e7b`, `d7096ad`, `95df478`); the formal model then found four more orderings that lost a change, fixed in `b83e334` | e2e "deleting the top row two or three times in a row never flashes, with several busy accounts syncing (the user's conditions)" green (hover, toolbar, `#`, conversation open; bursts of 2 and 3); `tests/ledger_model.rs` (every ordering of six events) green |
| 3 | Going back to the list should keep the scroll position (issue #3) | e2e step written first | The list started at the top on every mount | Each list remembers where it was scrolled; back from a conversation returns there, a new pick from the menu starts at the top (`9b1c162`) | e2e "back from a conversation returns to the same place in the list; …" |
| 4 | Unsubscribing sometimes needs a second try (issue #4) | Rust: a sender with its own link in each of 25 messages got 25 requests; the page waited for all of them (about 10 s) | One request per message's link instead of per mailing list, and the page reacted only after every request | One request per list (List-Id; mail without one counts as one list) with the newest message's link; the page shows Unsubscribed at once (`c3455b5`) | Rust `one_unsubscribe_reaches_a_sender_whose_every_message_has_its_own_link`; e2e "manage subscriptions: …" (one request, shown within 1 s while the sender takes 3 s) |
| 5 | Manage subscriptions lists a different number of senders than the web client (issue #5) | Rust: senders quiet for six weeks, or with only Spam or Trash mail, were listed | All cached mail counted | One row per From address, from the last 30 days, outside Spam and Trash; unsubscribed senders stay listed (`c3455b5`) | Rust `manage_subscriptions_counts_only_recent_mail_outside_spam_and_trash` |

The frame checker's "counts went back" rule failed on a page refilling from the next page (1–48 back to 1–50,
new rows at the bottom, no removed row returning). The gate was wrong, not the app: the end of the range may now
grow back; the nav counts and totals still may never go back (`c876243`). Watching the web client refill a page
was refused by the permission check (it needs deleting test mail over CDP), so this rests on reasoning.

## Results

- Full e2e (2026-10-24, on the Mac): 76 passed, 0 failed in 519 s; "app reported never active; frontmost-app
  watch never saw the test app in front".
- Rust: all suites green (72 tests incl. the depth-6 model, 301 s); Vitest 103/103.

## Known gaps

- Issue #2 is confirmed in the frame recorder under the user's conditions; it still has to be confirmed in the
  user's own use after 1.1.0 is installed (the prompt's done-criterion). The content-free diagnostic log was not
  built, since the fakes reproduce the flash.
- Issue #5's rule comes from the web client's page on the recon account, whose seeded mail it doesn't list
  ("Nothing in Subscriptions"); the numbers on the user's real accounts are to be compared after install.
