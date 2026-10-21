# Conversation actions

A user removes conversations from a view (archive, delete, report spam, move) or changes them in place (labels,
read/unread, star, mute, snooze), from a row's hover buttons, the toolbar with a selection, keyboard shortcuts or
the open conversation, and can Undo from the toast. Rows that leave never come back on screen because of stale
data, and the change covers the whole conversation on the server.

## Sub-features

- `act-hover` hover Archive / Delete / Mark read / Snooze on a row.
- `act-toolbar` the same with one or more rows ticked (`row-checkbox`, then `tb-*`).
- `act-keys` `e`, `#`, `!`, `shift+i`/`shift+u`, `s`, `m`, `v`, `l` on the cursor row or the open conversation.
- `act-conv` the open conversation's toolbar (`conv-delete`, …), with auto-advance (Settings ▸ General).
- `act-undo` the toast's Undo puts the conversation back as it was.
- `act-whole` every message of the conversation changes on the server, including ones older than this Mac keeps.
- `act-noflash` no removed row reappears, no other row vanishes or remounts, counts move one way.

## How to get to it (user POV)

- Point at a row and click its hover icon; tick rows and use the toolbar; press a shortcut with a row under the
  cursor or a conversation open; open a conversation and use its toolbar or menu.

## Driving it with the e2e runner

Preconditions:

- `pat@example.com` Inbox is open; for realistic timing set `gmail-behaviour` latency (change ≈ 360 ms, listing ≈
  220 ms) and read `tail` latency (≈ 400 ms on `threads.get` and `history`), and add `big-accounts` with
  `traffic` for the user's conditions.

- **Hover delete.** `const rec = recordFrames(); click(await el("hover-delete", row))`. The row leaves at once; the
  server shows `TRASH` and no `INBOX` on every message of the thread (`state` or `extra-labels`).
- **Toolbar.** `click(await el("row-checkbox", row))`, wait for `getState().selected.length === 1`, `click(await
  el("tb-delete"))`.
- **Keyboard.** Blur the active element, `setState({ cursor: 0 })`, `key(document.body, "#")`.
- **Open conversation.** `click(row)`, wait for `conv-subject`, `click(await el("conv-delete"))`.
- **Bursts.** Repeat on the new top row every 250 ms, two or three times (the user's rhythm).
- **Undo.** `click(await el("toast-action", toastWith(/Undo/)))`; the row is back and the server labels match the
  labels before.
- **Proof.** `flashes(rec.stop(), goneIds, { conversationOpen })` returns no issues; the step in
  `run.ts` "deleting the top row two or three times in a row never flashes, with several busy accounts syncing"
  passes.

## Gotchas

- A conversation open in place of the list (no reading pane) takes the rows off screen; pass
  `conversationOpen: true` so the recorder only judges frames that show the list.
- With `traffic` on, aim it at accounts other than the one under test (`accounts: [1, 2]`), or new mail moves the
  counts back and forth legitimately.
- A row that comes back with "put back by list#N server" means a server listing listed it; "cache" plus a
  `[trace] … inbox … -> true at <file:line>` line in `app.log` names the cache write that undid the change.
