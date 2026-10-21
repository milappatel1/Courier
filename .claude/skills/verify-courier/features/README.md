# Courier verification map

The maintained source for verifying what a Courier user can see and do. Read this index before driving the app,
then use the matching feature file as the recipe. The full parity ledger (every view, control, setting, shortcut
and behaviour of the web client, with its status and the test that proves it) is `research/PARITY.md`.

## Baseline preconditions

- e2e runner: the debug app started by `app/scripts/verify.sh e2e …` against the fakes. After the five setup steps
  two accounts exist: a mail-API account `pat@example.com` (102 seeded messages, labels Projects, Projects/Alpha,
  Bulk, Keep) and an IMAP account `pat@example.org`. `big-accounts` adds `busy0..N@example.net` with thousands of
  conversations over the five categories.
- `scripts/verify.sh doctor` shows a debug build newer than the last code edit.
- Never drive `/Applications/Courier.app` or any real mailbox.

## Driving conventions

- Start each recipe from the Inbox of `pat@example.com` (`backToInbox()` in `run.ts`) unless it says otherwise.
- Use `data-testid` handles; change server state through `api.e2eControl`, never through the store.
- Wrap anything that changes the list in the frame recorder.
- Put the web client's measured timings on the fakes (`gmail-behaviour`) for anything timing-related.

## Proof and skip reporting

- A step passes in `report.json` and the summary's last line says the app never took focus.
- Mutations are checked on the server (`state`, `extra-labels`) as well as on screen.
- A path that can't be reached (e.g. needs the user's sign-in) is reported with the unmet precondition, not
  replaced by another path.

## Feature entry contract

Each feature file has an H1, one paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with
the e2e runner`, `Gotchas`.

## Features

- [Conversation actions](./conversation-actions.md): archive, delete, spam, move, label, read/unread, star, mute,
  snooze from the row, the toolbar, the keyboard and the open conversation; Undo; no flashes.
- [Counts](./counts.md): every number in the menu and on the Inbox tabs.
- [Search](./search.md): operators, chips, advanced search.
- [Compose and send](./compose-send.md): new message, reply, forward, drafts, undo send.
- [Offline](./offline.md): actions and sends made offline wait and go out once.
