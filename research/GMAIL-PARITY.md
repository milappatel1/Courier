# Courier ↔ the web mail client: feature checklist

The brief for every round of work on Courier. It lists what the web client does (and the phone app, which is
what a narrow window should look like), and where Courier stands. Wording, icons and illustrations in Courier
are our own; nothing is copied.

**Brief.** Courier should feel like the web client, feature for feature and pixel for pixel, on a Mac:
same layout, same behaviour, same shortcuts, same settings. At narrow window widths it turns into the phone
app's layout instead of squeezing the desktop one. Everything is real (no dead buttons): what the Gmail API or
IMAP can't do is done locally and said so in `PLAN.md`. Left out, because they're Google-only or proprietary:
Gemini and "Help me write", smart compose/smart reply, summary cards, Chat, Spaces, Meet, the Calendar/Keep/Tasks
side panel, Drive and Photos, confidential mode, add-ons, Translate, emoji reactions (a proprietary MIME type),
the apps grid, the Google logo and names.

Status: ✅ done · 🔧 fixed in this round · ➕ added in this round · ⛔ left out (reason)

## Mac behaviour (not in the web client, expected of a Mac app)

| Feature | Status |
| --- | --- |
| Links in messages open in the default browser (WebKit doesn't run listeners in a script-free frame; native new-window and navigation handlers now route every outside link) | 🔧 |
| Attachments open in the app the Mac uses for them (PDF → Preview), not a `qlmanage` window | 🔧 |
| Downloads go straight to ~/Downloads ("name (1).pdf" when taken), with "Show in Finder" | 🔧 |
| Download all attachments | ➕ |
| WebKit's own Download Image / Download Linked File (a message's context menu) save to Downloads too | ➕ |
| Two-finger swipe back/forward between screens | ➕ |
| Default mail app: offered once, also in Settings ▸ Accounts; other apps' "Email this file" (Scribe) and Open With → a new message with the file attached | ➕ |
| Dock badge, notifications, mailto:, .eml, Share, drag-out, sleep/wake, offline outbox | ✅ |

## Header

| Feature | Status |
| --- | --- |
| Main menu: nav ↔ rail | ✅ |
| The rail slides the whole menu out over the content while the pointer rests on it | ➕ |
| Search: operators, suggestions, filter chips, advanced search panel, create filter | ✅ |
| Quick settings panel (density, theme, inbox type, reading pane) | ✅ |
| Account menu: switch, add, sign out, all inboxes | ✅ |
| Narrow window: search becomes the phone app's rounded bar with the menu button and avatar | ➕ |
| Apps grid, Support menu, Chat status | ⛔ Google services |

## Navigation

| Feature | Status |
| --- | --- |
| Compose button; Inbox … Trash; More/Less; categories; nested labels with colours | ✅ |
| Counts update right after an action (archive, delete, read) and after changes made elsewhere | 🔧 |
| Category counts (unread) | 🔧 |
| Manage subscriptions: senders with an unsubscribe option, how much they send, one-click unsubscribe | ➕ |
| Label menu: colour, show/hide in label list and message list, edit, add sublabel, remove | ✅ |
| Drag conversations onto a label | ✅ |
| Narrow window: rail by default; phone width: an overlay drawer | ➕ |

## Conversation list

| Feature | Status |
| --- | --- |
| Toolbar (select menu, refresh, more; selection actions; simplified/advanced) | ✅ |
| "Select all N conversations in this view" covers every page on the server, not only cached mail | 🔧 |
| Keep the conversations I tick, delete (or archive) everything else in the view | ➕ |
| Bulk actions report progress and are confirmed first | ➕ |
| Row right-click menu: reply, reply all, forward, forward as attachment, archive, delete, mark read/unread, snooze, move to, label as, mute, find mail from the sender, find mail with this subject, open in a new window | ➕ |
| Attachment chips under a row (first files, "+N") | ➕ |
| Hover actions; drag rows; keyboard; density; reading pane none/right/below | ✅ |
| Two-finger swipe left on a row: archive (configurable per direction: archive, delete, mark read/unread, snooze, none), as in the phone app; right stays the back swipe by default | ➕ |
| Empty views say so (own wording, no illustration) | ➕ |
| Tabs with new-mail counts | ✅ |
| Phone width: two-line rows with an initial avatar, star on the right, compose button floating | ➕ |
| Nudges, summary cards, smart labels beyond categories | ⛔ Google's models |

## Reading

| Feature | Status |
| --- | --- |
| Messages never cut off and never grow forever (full-height and fixed-width newsletters) | 🔧 |
| Images shown by default (Settings ▸ General ▸ Images), trackers still stripped | 🔧 |
| Wide mail scrolls sideways inside its own box | 🔧 |
| Details popover, print, show original, download message, mark unread from here, block, report spam/phishing, filter like this | ✅ |
| Pointing at a sender's name shows their card: write to them, copy the address, find their mail | ➕ |
| Unsubscribe next to the sender | ✅ |
| Reply/reply all/forward, inline compose, fold of long threads | ✅ |
| Translate, reactions | ⛔ Google services / proprietary |

## Compose

| Feature | Status |
| --- | --- |
| Stacked windows, minimise, full screen, pop out | ✅ |
| Windows that don't fit a narrow window fold to their title bar (click one to bring it forward) | ➕ |
| The To / Cc / Bcc labels open a people picker (tick several, add them at once) | ➕ |
| Rich text toolbar, links, emoji, inline images, attachments, signatures, templates, plain text, spelling, schedule, undo send | ✅ |
| Phone width: compose fills the window | ➕ |
| Smart compose, Help me write, confidential mode | ⛔ Google services |

## Settings

General, Labels, Inbox, Accounts, Filters and blocked addresses, Forwarding and POP/IMAP, Advanced, Offline,
Themes: ✅ (see `research/VERIFY-P4.md`). Added: swipe actions ➕.

## Layout at every size

The window can be as narrow as a phone (400 px). Nothing overlaps or is cut off at any width; checked at
1440, 1280, 1024, 900, 768, 600 and 400 px by an automated overlap check in the browser preview and the
end-to-end run.

| Width | Layout |
| --- | --- |
| ≥ 1024 px | Desktop: nav, list, optional reading pane |
| 700–1023 px | Desktop with the nav as a rail; toolbar items fold into "More"; the search box shrinks |
| < 700 px | Phone app: drawer nav, rounded search bar, two-line rows with avatars, floating compose, full-window conversation and compose |
