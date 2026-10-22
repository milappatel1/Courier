# Parity ledger: Courier and the web client

One row per view, control, setting, shortcut and behaviour of the web mail client that Courier re-creates. Built
in P12.1 from `GMAIL-PARITY.md`, `look/LOOK-SPEC.md` and fresh observation of the web client in the recon profile
(captures in `research/captures/web/`, gitignored). `node research/tools/parity-count.mjs --open` counts the rows
and lists the open ones; that count plus the total pixel diff is the parity metric P12.3 climbs.

Status: **matches** (observed in both, with the test that proves it) · **differs** (both have it, behaviour or
look differs) · **missing** (Courier lacks it) · **unverified** (not yet compared this round) · **✗ Google-only**
(left out on purpose: Gemini, Chat, Meet, the side panel, Drive/Photos, confidential mode, add-ons, smart compose,
and features the mail API doesn't expose).

## Counts

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| C-01 | Menu | Inbox count: conversations whose Inbox message is unread, in Primary when tabs are on | matches | Recon: "Inbox 25" left out the 6 conversations whose only unread message was archived; Courier counts the same way | Rust `the_inbox_count_is_conversations_with_unread_inbox_mail_in_primary_starred_ones_too_when_set` |
| C-02 | Menu | Inbox count includes starred conversations when Primary includes them | matches | Recon: starred Social/Promotions conversations counted | same Rust test |
| C-03 | Menu | Category in the menu (when shown) counts every unread conversation in it, archived included, not Spam/Trash | matches | Recon: Updates 14 = labels.get threadsUnread 14, Updates label view 14 unread rows | e2e "counts mean what the web client's do" |
| C-04 | Menu | Categories hidden from the menu by default; Settings ▸ Labels ▸ Categories show/hide; shown ones sit above More | matches | Recon: Social/Updates/Forums/Promotions "hide" by default; shown, they appear after Drafts | e2e "counts mean what the web client's do" |
| C-05 | Tabs | "N new" under a tab: unread mail arrived since the tab was last opened, with senders; none for mail already there | matches | Recon: Promotions tab with 9 unread rows shows no number | e2e "counts mean what the web client's do" |
| C-06 | Menu | User label counts: unread conversations in the label | unverified | | |
| C-07 | Menu | Spam shows its unread count only with "show if unread" | unverified | | e2e "Settings ▸ Labels: show, hide and show if unread" |
| C-08 | Menu | Drafts count | unverified | | |
| C-09 | List | Page count "1–50 of N" for labels, tabs and searches ("many" when the server only estimates) | unverified | | |
| C-10 | All | Counts settle to the server's after any action and never go back | differs | e2e under the user's conditions: Inbox count 203 → 202 → 203 during a burst of deletes | e2e "deleting the top row two or three times in a row never flashes…" |
| C-11 | Purchases | The Purchases category (menu item and tab) | ✗ Google-only | The mail API exposes no CATEGORY_PURCHASES label | — |

## Views

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| V-01 | Inbox | Default inbox with Primary/Promotions/Social/Updates(/Forums) tabs | unverified | | |
| V-02 | Inbox | Primary tab = Inbox minus the enabled tabs' categories (Forums mail in Primary while its tab is off; starred ones when set) | matches | Recon query probe (2026-10-22): `category:primary` 38 = the web client's Primary; Courier asks for the Inbox minus its enabled tabs (+ starred), the same rule as its cache | Rust `starred_in_primary_and_the_auto_contacts_setting`; e2e flash step under the user's conditions |
| V-03 | Inbox | Inbox type: Important first | unverified | | |
| V-04 | Inbox | Inbox type: Unread first | unverified | | |
| V-05 | Inbox | Inbox type: Starred first | unverified | | |
| V-06 | Inbox | Inbox type: Priority Inbox (sections, options) | unverified | | |
| V-07 | Inbox | Inbox type: Multiple Inboxes (sections, position, max) | unverified | | |
| V-08 | Labels | Starred, Snoozed, Important, Sent, Scheduled, Drafts, All Mail, Spam, Trash views | unverified | | |
| V-09 | Labels | User label view; nested labels | unverified | | |
| V-10 | Labels | Category label views (Social, Updates, Forums, Promotions) list archived mail too | unverified | Recon: #category/updates lists archived Updates conversations | |
| V-11 | Search | Search results view (chips, "Inbox" chip on rows in the Inbox) | unverified | | |
| V-12 | Reading | Conversation view, no split | unverified | | |
| V-13 | Reading | Reading pane right of / below the list | unverified | | |
| V-14 | Empty | Empty views (Inbox tabs, labels, Spam, Trash, search) | unverified | | |
| V-15 | Loading | Loading bar and first paint | unverified | | |
| V-16 | Errors | Offline banner; failures said in words | unverified | | e2e "no toast showed a raw error" |
| V-17 | Subscriptions | Manage subscriptions page | unverified | | e2e "manage subscriptions…" |
| V-18 | Trash/Spam | Banners: 30-day note, Empty Trash now / Delete all spam messages now | unverified | P10 recon (measured) | e2e "Trash and Spam say what happens to their mail…" |

## Header

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| H-01 | Menu button | Main menu toggles the full menu and the rail | unverified | | |
| H-02 | Search | Search box, suggestions, recent searches | unverified | | |
| H-03 | Search | Filter chips under the search box | unverified | | |
| H-04 | Search | Advanced search panel; Create filter | unverified | | |
| H-05 | Help | Help menu (keyboard shortcuts; Google support links ✗) | unverified | | |
| H-06 | Settings | Settings gear: quick settings (density, theme, inbox type, reading pane) and See all settings | unverified | | |
| H-07 | Account | Account menu: switch, add, sign out, all inboxes | unverified | | |
| H-08 | Apps | Apps grid, Gemini, Support status | ✗ Google-only | | — |

## Menu

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| N-01 | Compose | Compose button | unverified | | |
| N-02 | System labels | Order: Inbox, Starred, Snoozed, Important, Sent, Scheduled, Drafts, All Mail, Spam, Trash; shown ones above More | unverified | Recon screenshot of the menu (2026-10-21) | e2e "Settings ▸ Labels…" |
| N-03 | More | More/Less reveals hidden system labels, Manage subscriptions, Manage labels, Create new label | unverified | | |
| N-04 | Labels | Nested label tree with colours, expand/collapse | unverified | | |
| N-05 | Labels | Label ⋮ menu: colour, show/hide in label list and message list, edit, add sublabel, remove | unverified | | |
| N-06 | Labels | Drag conversations onto a label | unverified | | |
| N-07 | Chat/Meet | Chat, Spaces, Meet in the menu | ✗ Google-only | | — |

## List toolbar and rows

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| T-01 | Select | Select checkbox and its menu (All, None, Read, Unread, Starred, Unstarred) | unverified | | |
| T-02 | Select | "Select all N conversations in this view" banner | unverified | | |
| T-03 | Toolbar | Refresh, More (Mark all as read …), page arrows, page count | unverified | | |
| T-04 | Toolbar | With a selection: Archive, Report spam, Delete, Mark read/unread, Move to, More (simplified toolbar) | unverified | LOOK-SPEC behaviour notes | |
| T-05 | Toolbar | Advanced toolbar (Snooze, Labels next to Move to) | unverified | | |
| T-06 | Rows | Hover actions: Archive, Delete, Mark read/unread, Snooze | unverified | | |
| T-07 | Rows | Checkbox, star, importance marker, sender(s) with counts, subject – snippet, label chips, attachment chips, date | unverified | | |
| T-08 | Rows | Unread rows bold; read rows grey background | unverified | | |
| T-09 | Rows | Right-click menu | unverified | | |
| T-10 | Rows | Drag rows (to labels, to compose) | unverified | | |
| T-11 | Actions | Removing a conversation from view never flashes it back, from hover, toolbar, keys or the open conversation | differs | e2e under the user's conditions: rows come back (stale reads), rows vanish (Primary/Forums) | e2e "deleting the top row two or three times in a row never flashes…" |
| T-12 | Actions | A conversation action changes every message of the conversation on the server, older ones included | differs | Rust repro: a 60-day-old message stays in the Inbox | Rust `deleting_or_archiving_a_conversation_takes_all_of_it_even_messages_older_than_this_mac_keeps` |
| T-13 | Actions | Undo in the toast restores what was there | unverified | | |
| T-14 | Density | Default, Comfortable, Compact | unverified | | |
| T-15 | Category chips | Category label chips in the message list (Settings ▸ Labels ▸ Categories ▸ Show in message list) | unverified | Recon: column exists | |

## Conversation

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| CV-01 | Toolbar | Back, Archive, Report spam, Delete, Mark unread, Snooze, Move to, Labels, More; older/newer | unverified | | |
| CV-02 | Header | Subject with label chips (removable), print all, open in new window | unverified | | |
| CV-03 | Message | Sender card, details popover, star, reply, ⋮ menu | unverified | | |
| CV-04 | Message | ⋮ menu: Reply, Forward, Delete, Mark unread from here, Report spam, Report phishing, Filter like this, Print, Download, Show original, Block | unverified | LOOK-SPEC behaviour notes | |
| CV-05 | Thread | Collapsed older messages, "N older messages", expand/collapse all | unverified | | |
| CV-06 | Opening | Opening marks read; auto-advance after archive/delete | unverified | | e2e "archiving with e moves on…" |
| CV-07 | Google-only | Translate, reactions, summary cards | ✗ Google-only | | — |

## Compose

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| CP-01 | Window | New message window: minimise, full screen, pop out, stacking | unverified | | |
| CP-02 | Recipients | To/Cc/Bcc, autocomplete, contact picker | unverified | | |
| CP-03 | Format | Formatting toolbar (undo/redo, font, size, bold, italic, underline, colour, align, lists, indent, quote, strikethrough, remove formatting) | unverified | | |
| CP-04 | Insert | Attach, link, emoji, inline image, signature | unverified | | |
| CP-05 | More | More options: default to full screen, label, plain text, print, check spelling, templates | unverified | | |
| CP-06 | Send | Send, Schedule send, Undo send window and toast | unverified | | |
| CP-07 | Drafts | Autosave and Draft saved; discard | unverified | | |
| CP-08 | Reply | Inline reply/reply all/forward; show trimmed content; forward as attachment | unverified | | |
| CP-09 | Google-only | Help me write, smart compose, confidential mode, Drive/Photos | ✗ Google-only | | — |

## Settings

The web client's tabs and settings as harvested from the recon profile on 2026-10-21
(`research/captures/web/settings-*.json`).

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| ST-01 | General | Language | unverified | | |
| ST-02 | General | Maximum page size (10, 15, 20, 25, 50, 100) | unverified | | |
| ST-03 | General | Undo Send (5, 10, 20, 30 s) | unverified | | |
| ST-04 | General | Default reply behaviour | unverified | | |
| ST-05 | General | Hover actions | unverified | | |
| ST-06 | General | Send and Archive | unverified | | e2e "settings that change the list and replies…" |
| ST-07 | General | Default text style | unverified | | |
| ST-08 | General | Images (always / ask) | unverified | | |
| ST-09 | General | Dynamic email | ✗ Google-only | AMP for email is rendered by the web client only | — |
| ST-10 | General | Grammar, Autocorrect, Smart Compose (+ personalization), Nudges, Smart Reply, smart features, Workspace smart features, Package tracking | ✗ Google-only | Google models and services | — |
| ST-11 | General | Spelling | unverified | | |
| ST-12 | General | Conversation view on/off | unverified | | |
| ST-13 | General | Desktop notifications (new mail, important mail, off) | unverified | | |
| ST-14 | General | Stars (presets, in use / not in use) | unverified | | |
| ST-15 | General | Keyboard shortcuts on/off (the web client's default is off; Courier ships on, by decision) | differs | LOOK-SPEC behaviour notes; PLAN decision | — |
| ST-16 | General | Button labels (icons / text) | unverified | | e2e "settings that change the list and replies…" |
| ST-17 | General | My picture | unverified | | |
| ST-18 | General | Create contacts for auto-complete | unverified | | |
| ST-19 | General | Importance signals for ads | ✗ Google-only | | — |
| ST-20 | General | Signature (per address, defaults for new and replies) | unverified | | |
| ST-21 | General | Personal level indicators | unverified | | |
| ST-22 | General | Snippets | unverified | | |
| ST-23 | General | Vacation responder | unverified | | |
| ST-24 | Labels | System labels show/hide/show if unread with the web client's defaults | unverified | | e2e "Settings ▸ Labels: show, hide…" |
| ST-25 | Labels | "Show in IMAP" per label | ✗ Google-only | Not exposed by the mail API | — |
| ST-26 | Labels | Categories: show in label list (default hide) | matches | Recon defaults; C-04 | e2e "counts mean…" |
| ST-27 | Labels | Categories: show in message list | unverified | | |
| ST-28 | Labels | Labels table: conversation counts, show/hide/show if unread, show in message list, remove, edit | unverified | | |
| ST-29 | Inbox | Inbox type | unverified | | |
| ST-30 | Inbox | Categories (which tabs) | unverified | | |
| ST-31 | Inbox | Include starred in Primary (the web client's default: on) | matches | Recon #settings/inbox: checked by default; Courier's default now on (UI and engine) | Rust `starred_in_primary_and_the_auto_contacts_setting` |
| ST-32 | Inbox | Enable bundling of top promo emails in Promotions | ✗ Google-only | Promotional bundling is the web client's own ranking | — |
| ST-33 | Inbox | Reading pane (no split, right, below) | unverified | | |
| ST-34 | Inbox | Importance markers; use past actions to predict importance | unverified | | |
| ST-35 | Inbox | Filtered mail: override filters | unverified | | |
| ST-36 | Accounts | Send mail as (aliases), reply from the address the message was sent to | unverified | | |
| ST-37 | Accounts | Check mail from other accounts, Grant access, Import, storage | ✗ Google-only | Server-side account features with no API | — |
| ST-38 | Accounts | Mark conversation as read when opened by others | ✗ Google-only | Delegation | — |
| ST-39 | Filters | Filters list, create, edit, delete, export, import; blocked addresses, unblock | unverified | | |
| ST-40 | Forwarding | Forwarding address, POP download, IMAP access options | unverified | | |
| ST-41 | Advanced | Templates and other advanced settings | unverified | | |
| ST-42 | Offline | Offline settings (days to keep) | unverified | | |
| ST-43 | Themes | Themes picker, custom image | unverified | | |
| ST-44 | Add-ons, Chat and Meet | Add-ons and Chat and Meet tabs | ✗ Google-only | | — |

## Keyboard shortcuts

From `app/src/core/shortcuts.ts`; the web client's own list (its help sheet) is compared in P12.2.

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| K-01 | Application | `c` Compose | unverified | | |
| K-02 | Application | `d` Compose in a new window | unverified | | |
| K-03 | Application | `/` Search mail | unverified | | |
| K-04 | Application | `?` Open keyboard shortcut help | unverified | | |
| K-05 | Application | `.` Open "more actions" menu | unverified | | |
| K-06 | Application | `v` Open "move to" menu | unverified | | |
| K-07 | Application | `l` Open "label as" menu | unverified | | |
| K-08 | Navigation | `k` Newer conversation | unverified | | |
| K-09 | Navigation | `j` Older conversation | unverified | | |
| K-10 | Navigation | `o` Open conversation | unverified | | |
| K-11 | Navigation | `Enter` Open conversation | unverified | | |
| K-12 | Navigation | `u` Back to threadlist | unverified | | |
| K-13 | Navigation | `n` Next message in open conversation | unverified | | |
| K-14 | Navigation | `p` Previous message in open conversation | unverified | | |
| K-15 | Navigation | ``` Go to next inbox section | unverified | | |
| K-16 | Navigation | `~` Go to previous inbox section | unverified | | |
| K-17 | Actions | `,` Move focus to toolbar | unverified | | |
| K-18 | Actions | `x` Select conversation | unverified | | |
| K-19 | Actions | `s` Toggle star / rotate among stars | unverified | | |
| K-20 | Actions | `e` Archive | unverified | | |
| K-21 | Actions | `m` Mute conversation | unverified | | |
| K-22 | Actions | `!` Report as spam | unverified | | |
| K-23 | Actions | `#` Delete | unverified | | |
| K-24 | Actions | `r` Reply | unverified | | |
| K-25 | Actions | `Shift+R` Reply in a new window | unverified | | |
| K-26 | Actions | `a` Reply all | unverified | | |
| K-27 | Actions | `Shift+A` Reply all in a new window | unverified | | |
| K-28 | Actions | `f` Forward | unverified | | |
| K-29 | Actions | `Shift+F` Forward in a new window | unverified | | |
| K-30 | Actions | `Shift+N` Update conversation | unverified | | |
| K-31 | Actions | `]` Archive and go to older | unverified | | |
| K-32 | Actions | `[` Archive and go to newer | unverified | | |
| K-33 | Actions | `z` Undo last action | unverified | | |
| K-34 | Actions | `Shift+I` Mark as read | unverified | | |
| K-35 | Actions | `Shift+U` Mark as unread | unverified | | |
| K-36 | Actions | `_` Mark unread from the selected message | unverified | | |
| K-37 | Actions | `+` Mark as important | unverified | | |
| K-38 | Actions | `=` Mark as important | unverified | | |
| K-39 | Actions | `-` Mark as not important | unverified | | |
| K-40 | Actions | `b` Snooze | unverified | | |
| K-41 | Actions | `;` Expand entire conversation | unverified | | |
| K-42 | Actions | `:` Collapse entire conversation | unverified | | |
| K-43 | Jumping | `g i` Go to Inbox | unverified | | |
| K-44 | Jumping | `g s` Go to Starred conversations | unverified | | |
| K-45 | Jumping | `g b` Go to Snoozed conversations | unverified | | |
| K-46 | Jumping | `g t` Go to Sent messages | unverified | | |
| K-47 | Jumping | `g d` Go to Drafts | unverified | | |
| K-48 | Jumping | `g a` Go to All Mail | unverified | | |
| K-49 | Jumping | `g l` Go to label | unverified | | |
| K-50 | Jumping | `g n` Go to next page | unverified | | |
| K-51 | Jumping | `g p` Go to previous page | unverified | | |
| K-52 | Jumping | `g u` Back to threadlist | unverified | | |
| K-53 | Jumping | `g e` Go to Settings | unverified | | |
| K-54 | Threadlist selection | `* a` Select all conversations | unverified | | |
| K-55 | Threadlist selection | `* n` Deselect all conversations | unverified | | |
| K-56 | Threadlist selection | `* r` Select read conversations | unverified | | |
| K-57 | Threadlist selection | `* u` Select unread conversations | unverified | | |
| K-58 | Threadlist selection | `* s` Select starred conversations | unverified | | |
| K-59 | Threadlist selection | `* t` Select unstarred conversations | unverified | | |

## Behaviour, toasts and dialogs

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| B-01 | Toasts | Archive/delete/spam/move/label toasts: wording, Undo, how long they stay | unverified | | |
| B-02 | Toasts | Undo send window: "Sending…", "Message sent · Undo / View message" | unverified | LOOK-SPEC | |
| B-03 | Actions | Snooze presets and Pick date & time | unverified | LOOK-SPEC | |
| B-04 | Actions | Mute; muted conversations skip the Inbox | unverified | | |
| B-05 | Actions | Mark as read when opened; mark unread from here | unverified | | |
| B-06 | Actions | Report spam / phishing; Report spam or unsubscribe dialog | unverified | P10 recon | e2e "reporting list mail as spam asks whether to unsubscribe…" |
| B-07 | Actions | Block sender; unblock | unverified | | |
| B-08 | Actions | Unsubscribe (one-click, mail, website) | unverified | P10 recon | e2e "unsubscribe as the web client does…" |
| B-09 | Dialogs | Delete forever, Empty Trash, Delete all spam: wording and confirmation | unverified | | |
| B-10 | Selection | Acting on "all N conversations" (whole view), keeping ticked ones | unverified | | |
| B-11 | Sync | Changes made elsewhere show up; counts follow | unverified | | |
| B-12 | Offline | Actions made offline wait and go out once; Undo before then | unverified | | e2e "offline: a delete is made at once and waits…" |
| B-13 | Offline | Acting on a whole view, Delete forever, snooze on mail-API accounts while offline (VERIFY-P11 gaps) | missing | VERIFY-P11 known gaps | |
| B-14 | Errors | Failures said in words; never raw server text | unverified | | e2e "no toast showed a raw error" |

## Search

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| S-01 | Operators | from, to, cc, bcc, subject, label, has (attachment, drive ✗ …), filename, in, is, after/before/older/newer, older_than/newer_than, larger/smaller, size, category, list, deliveredto, rfc822msgid, OR / {} / - / () / "" | unverified | | Vitest `search.test.ts`, shared `search-cases.json` |
| S-02 | Operators | `category:primary` means the Primary tab (Inbox minus the enabled tabs) | unverified | Recon query probe pending | |
| S-03 | Chips | Search chips (From, Any time, Has attachment, To, Is unread, Advanced search) | unverified | | |
| S-04 | Results | Rows show an "Inbox" chip when in the Inbox; search closes the options | unverified | LOOK-SPEC | |

## Look

| ID | Area | Item | Status | Evidence | Test |
| --- | --- | --- | --- | --- | --- |
| L-01 | Layout | Desktop layout at 1280 × 728 matches the measured boxes | unverified | LOOK-SPEC (2026-10-18) | |
| L-02 | Layout | Rail (700–1023 px) and phone layout (< 700 px) | unverified | | e2e "fits every window size…" |
| L-03 | Theme | Default, dark, colour themes, custom image | unverified | | |
| L-04 | Density | Default, Comfortable, Compact row heights | unverified | | |
| L-05 | Fonts and icons | Google Sans / Roboto (OFL, bundled), Material Symbols | unverified | | |
| L-06 | Visual diff | Every golden under the threshold in LOOK-SPEC (dynamic regions masked) | unverified | | |
