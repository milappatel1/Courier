# Courier — look spec (measured)

Measured on 2026-10-18 from the live web client in the isolated recon profile (`~/.courier-recon-chrome`), viewport
**1280 × 728 CSS px, DPR 2**, Chrome 154, light theme unless noted. Chat off, Meet hidden, side panel hidden (the
layout Courier reproduces, since those are Google-only). Values are computed styles (REA captures + `tools/measure*.mjs`);
raw JSON lives in `look/raw/` (gitignored), goldens in `goldens/` (gitignored, redacted).

Screenshots are colour-managed, so a CSS `#0b57d0` reads back as about `#3567cf` in a PNG. **CSS values below are the
source of truth**; pixel comparisons put both sides through the same Chrome capture pipeline.

## Type

| Role | Family | Size / line | Weight | Colour |
| --- | --- | --- | --- | --- |
| UI default | Google Sans → Roboto → Arial | 14 / 20 | 400 | `#202124` |
| Header (account area) | Google Sans Text (we use Google Sans) | 13 / 27 | 400 | `#1f1f1f` |
| Search input | Google Sans | 16 | 400 | `#1f1f1f` |
| Nav item | Google Sans | 14 / 20 | 400; **700** active or unread | `#202124`; active `#001d35` |
| Nav count | Google Sans | 12 / 20 | 700 when unread | `#001d35` |
| Row sender / subject | Google Sans | 14 / 20 | **700** unread, 400 read | `#202124` |
| Row snippet | Google Sans | 14 / 20 | 400 | `#5f6368` |
| Row date | Google Sans | 12 / 20 | **700** unread, 400 read | `#202124` (read `#5f6368`) |
| Label chip | Google Sans | 12 / 18 | 400 | `#444746` |
| Page count "1–6 of 6" | Google Sans | 12 | 400 | `#5e5e5e` |
| Tab label | Google Sans | 14 / 16 | 500 | active `#0b57d0`, else `#444746` |
| Conversation subject | Google Sans | 22 / 28 | 400 | `#1f1f1f` |
| Message sender | Google Sans | 14 / 20 | 700 | `#1f1f1f` |
| Sender address, time, "to me" | Google Sans | 12 / 20 | 400 | `#5e5e5e` |
| Message body | Arial | 13 / 19.5 | 400 | `#222222` |
| Collapsed message snippet | Arial | 13 / 19.5 | 400 | `#555555` |
| Compose title | Google Sans | 14 / 20 | 500 | `#041e49` |
| Compose fields | Google Sans | 14 / 20 | 400 | `#222` / labels `#444746` |
| Compose body (default "Sans Serif") | Arial | 13 / 19.5 | 400 | `#222` |
| Menu item | Google Sans | 14 / 20 | 400 | `#202124` |
| Dialog title | Google Sans | 24 / 32 | 400 | `#1f1f1f` |
| Quick settings title | Google Sans | 16 | 400 | `#202124` |
| Quick settings section | Google Sans | 12 | 500, ls .1px | `#444746` |
| Settings row label | Google Sans | 14 / 20 | 700 | `#202124` |
| Search chip | Google Sans | 14 / 18 | 500, ls .25px | `#444746` |

## Colour tokens (light / Default theme)

| Token | Value |
| --- | --- |
| `--bg` page (header + nav) | `#f8fafd` |
| `--surface` main panel | `#ffffff` |
| `--search-bg` | `#e9eef6` |
| `--compose-bg` / text | `#c2e7ff` / `#001d35` |
| `--nav-active-bg` | `#d3e3fd` |
| `--row-read-bg` | `#f2f6fc` |
| `--row-divider` | inset `0 -1px 0 0 rgba(100,121,143,.12)` |
| `--row-hover-shadow` | `inset 1px 0 0 #dadce0, inset -1px 0 0 #dadce0, 0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15)` (z-index 2) |
| `--primary` (send, active tab, star, links in chips) | `#0b57d0` |
| `--link` (quick settings, settings tabs) | `#1a73e8` |
| `--icon` | `#444746` (toolbar `#444`) |
| `--label-chip-bg` (default, uncoloured) | `#e1e3e1` |
| `--outline` (chips, reply buttons) | `#747775` |
| `--menu-shadow` / compose shadow | `0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12), 0 5px 5px -3px rgba(0,0,0,.2)` |
| `--menu-hover` | `#eeeeee` |
| `--menu-sep` | `1px #ebebeb`, margin 6px 0 |
| `--attach-chip` | inset `0 0 0 1px rgba(100,121,143,.3)` |
| settings row border | `1px #e5e5e5` |

### Dark theme

| Token | Value |
| --- | --- |
| page bg | `#111111` |
| main panel | `rgba(51,51,51,.8)` |
| search | `rgba(241,243,244,.24)`, text `rgba(255,255,255,.87)` |
| header icons / text | `#e3e3e3` |
| compose button | `#ffffff`, text `#5f6368` |
| nav active | `rgba(255,255,255,.3)`; nav text + counts `#ffffff`; nav icons at opacity .7 (inverted) |
| unread row | transparent, text `#ffffff` |
| read row | `rgba(0,0,0,.5)`, text `rgba(255,255,255,.7)` |
| snippet | `rgba(255,255,255,.5)` |
| row divider | inset `0 -1px 0 0 rgba(255,255,255,.12)` |
| tab text | active `#ffffff`, else `#c4c7c5` |
| page count | `rgba(255,255,255,.7)` |
| attachment chip border | `rgba(255,255,255,.2)` |
| conversation | messages sit on a **white card** with light-theme text colours; the toolbar row stays dark |

### Colour themes (measured backdrop; our own names)

Light-panel themes: panel `rgba(255,255,255,.8)`, search `rgba(32,33,36,.12)`, compose `#fff` / `#5f6368`, nav active
`rgba(32,33,36,.12)`, read row `rgba(0,0,0,.05)`. Dark-backdrop themes switch nav/header text to white and the search box to
the dark style; panels stay light (`rgba(255,255,255,.8)`, read row `rgba(0,0,0,.09)`). "Plum" is a dark theme (panels as Dark).

| Courier name | Backdrop | Family |
| --- | --- | --- |
| Default | `#f8fafd` | default |
| Dark | `#111111` | dark |
| Sky | `#b2d5ee` | light-panel |
| Mist | `#f5f5f5` | light-panel |
| Lilac | `#cab6eb` | light-panel |
| Blush | `#f5c0d0` | light-panel |
| Honey | `#f6dc76` | light-panel |
| Lime | `#afd76b` | light-panel |
| Mint | `#ddf0e4` | light-panel |
| Lagoon | `#91dcdf` | light-panel |
| Twilight | `#55688a` | dark-backdrop |
| Walnut | `#380e00` | dark-backdrop |
| Plum | `#6a627b` | dark |
| High contrast | `#eeeeee` | light-panel, snippet `#555` |

Photo themes are Google's licensed images and are not reproduced; Courier offers a few of its own generated gradient
backdrops plus "Custom image" from a local file.

## Layout (default density, nav open)

```
0         256                                                        1264 1280
┌──────────────────────────── header 64 ───────────────────────────────────┐
│ ☰(12,8,48) logo(64..)   search 256,8 624×48 r24      help settings avatar│
├─────────┬──────────────────── main panel 1008×648, r16 ─────────────────┤
│ compose │ toolbar 48 (icons at y=78)                       1–6 of 6  ‹ ›  │
│ 8,72    │ tabs 56 (4 equal tabs, 3px bar inset 8px)                       │
│ 142×56  │ rows 40 …                                                       │
│ nav 32px│                                                                 │
│ items   │                                                                 │
└─────────┴─────────────────────────────────────────────── 16px margin ───┘
```

- **Header**: 64 tall, transparent over `--bg`. Menu button 48×48 at (12, 8), margin 0 4px, radius 50 %, 24 px icon.
  Logo slot after it (Courier glyph 40 tall + wordmark 22 px `#444746`). Search form x = 256 (aligned with the panel),
  y = 8, 48 tall, radius 24, flexible width (624 at 1280 wide, max 720); 56 px search-icon button left, 56 px "search
  options" (tune) button right, input 16 px. Right cluster: 40×40 icon buttons (padding 8, 24 px icons) with 8 px gaps,
  avatar 40×40 (32 px image) ending 14 px from the right edge.
- **Nav**: 256 wide. Compose 56 tall at (8, 72), radius 16, padding-right 24, 56 px icon area, 14/500. Items start
  16 px below (y = 144): 32 tall, 240 wide, radius `0 16px 16px 0`; icon 20 px at x = 26 (margin-right 18), text at
  x = 64, count right-aligned with 12 px right padding. "More" uses `expand_more`. "Labels" header at y ≈ 396:
  16 px/500, x = 26, "+" 20 px icon at x = 212. Nested labels: expander triangle at x = 18, child icon +12 px.
- **Main panel**: x = 256, y = 64, to 16 px from the right and bottom, white, radius 16.
  - Toolbar 48 tall; icons 20 px at y = 78; select (checkbox + ▾) 40 wide at x = 272, then 20 px icons with 12 px side
    margins (refresh at 332, more at 372). Paging text at the right, chevrons 20 px with 20 px margin.
  - Selection toolbar: Select | Archive, Report spam, Delete | Mark as read/unread, Snooze | Move to, Label as | More.
  - Category tabs 56 tall (48 compact): equal widths; icon 20 px + label; active label `#0b57d0` and a 3 px bar with
    3 px top radius, inset 8 px each side; Promotions/Social show a second line of new senders (12 px) when unread.
- **Rows** (default): 40 tall (padding 10px 0). Cells: 3 px drag strip; checkbox cell 43 (20 px box at x = 272);
  star cell 30 (20 + 10 padding); [importance marker cell 20 when enabled]; sender cell 200 (168 + 32 padding);
  subject cell flexible (label chips, then subject, " - ", snippet, ellipsis); attachment icon cell; date cell 56 + 16
  padding, right aligned. Hover replaces the date with 4 actions (archive, delete, mark read/unread, snooze), each a
  20 px icon with 10 px margins, container right margin 6 px. Rows with attachments show chips on a second line
  (chip 30 tall, radius 15, max 160 wide, 16 px file icon, 8 px gap) → row ≈ 80 tall.
  - Comfortable: same 40 px rows, no attachment chips. Compact: 28 px rows, nav items 24 px (radius 12), compose 40
    tall, tabs 48 tall.
- **Conversation** (full page): toolbar 48 (back, archive, spam, delete | mark unread, snooze | move, labels | more;
  paging "1 of 6" + newer/older). Subject 22/28 at x = panel + 72, y = panel + 68; label chips (with ×) 12/18,
  `#e1e3e1`, radius 4; right: expand/collapse all, print all, new window (40 px buttons, 20 px icons).
  Message: avatar 40 (padding 0 16), header line = sender (14/700) + `<address>` (12, `#5e5e5e`) … time
  "8:06 PM (9 minutes ago)" (12, `#5e5e5e`), star, reply, more (40 px buttons); "to me ▾" (12, `#5e5e5e`); body
  starts 26 px below the header, Arial 13/19.5. Collapsed message = 80 px: avatar, sender, time, one-line snippet
  (Arial 13, `#555`). Messages are separated by a 1 px line (`#eef0f3` as rendered). Quoted text hides behind a
  24 × 11 "•••" pill (`#e8eaed`, radius 5.5). Attachments: header "N attachments", cards 180 × 120 (thumbnail +
  file-type icon + name 12/700 `#777`), 16 px gaps. Bottom: Reply / Forward (Reply all when several recipients)
  outline buttons 36 tall, radius 18, 1 px `#747775`, 14/500 `#444746`, padding 0 16 0 12, 8 px gap.
- **Reading pane right/below**: list keeps toolbar; divider is draggable; the conversation pane gets its own toolbar.
- **Compose** (stacked bottom-right): 540 + shadow wide (measured box 559 × 525), bottom 16 px, right offset 61 px;
  radius 20 (top) with the compose shadow. Header 40 tall, bg `#f2f6fc`, title "New Message" 14/500 `#041e49` at
  16 px; minimize / full screen / close 24 px buttons (padding 4, gap 4). Recipients row 37 tall with "Cc Bcc"
  14 px `#444746` at the right; subject row 40 tall; 1 px `#f1f1f1` separators, 16 px side padding. Body Arial 13.
  Bottom bar padding 12 0 16: Send 72 × 36 (`#0b57d0`, white 14/500, radius `18px 0 0 18px`) + 33 px dropdown with a
  1 px white separator; then 20 px icons (formatting, attach, link, emoji, photo, signature, more) margin 4 12 4 0;
  discard at the far right. Stacked windows sit side by side right→left with 16 px gaps; minimized = 40 px title bar
  (width 260).
- **Menus**: white, radius 4, menu shadow, padding 6 0; items 32 tall, padding 6px 48px (16 when no icons), 14/20;
  hover `#eee`; separators 1 px `#ebebeb` with 6 px margins. Submenus open to the right on hover ("►").
- **Dialogs**: radius 28, width 498 (label dialog), title 24/32 padding 24 24 16, body 16 px, text buttons 40 tall
  radius 20, 14/500 `#0b57d0`; scrim `rgba(0,0,0,.32)`.
- **Quick settings**: 320-wide panel docked right (margin-left 16), white, radius 16; the main panel narrows.
  Title 16 px at (16, 16), close 20 px icon; "See all settings" full-width outline button (36 tall, `#1a73e8`
  14/500). Sections separated by 1 px `#e8e8e8`: Density (Default / Comfortable / Compact), Theme (current thumbnail +
  "View all"), Inbox type (Default / Important first / Unread first / Starred first / Priority Inbox / Multiple
  Inboxes, "Customize" links), Reading pane (No split / Right of inbox / Below inbox), Email threading (Conversation
  view checkbox). Radio rows 32 tall, 16 px margins; 72 × 50 thumbnails on the right.
- **Search results**: chips row at y = panel + 16: chips 32 tall, radius 8, 1 px `#747775`, white, 14/500 ls .25 px,
  `#444746` (From ▾, Any time ▾, Has attachment, To ▾, Is unread, Advanced search as a text link `#0b57d0`), 8 px
  gaps. The list toolbar follows below.
- **Advanced search**: panel 720 × 440 dropping from the search bar (padding 24): labels 14 px `#5f6368` at 24 px,
  fields from x + 144 with bottom-border inputs, rows 40 apart: From, To, Subject, Has the words, Doesn't have,
  Size (operator 252 / value 138 / unit 114), Date within (252 + date 257), Search (label select), Has attachment
  checkbox; buttons "Create filter" (text) and "Search" (filled `#0b57d0`), 40 tall.
- **Snooze menu**: 256 wide, radius 4, menu shadow; header "Snooze until…" 14/500 `#5f6368` (32 tall); items 32 tall:
  name at 24 px + weekday/time right-aligned; divider; "Pick date & time" with a calendar icon.
- **Toast**: bottom-left (24, 24 from the bottom), 52 tall, `#1e1e1e`-ish dark, white 14 px text, action 14/500
  `#a8c7fa`, close × at the right.
- **Settings page**: title "Settings" 22 px at panel + 16; tab row (14/500, line 40; active `#1a73e8` + underline),
  wraps to two lines at 1280. Rows: label column 14/700 at x + 24 (≈ 190 wide, with a small help link below),
  value column from x ≈ 469; 1 px `#e5e5e5` bottom border, padding 10px 0; native-style selects and radios.
  Save Changes / Cancel at the bottom.
- **Account menu**: rounded card (radius 28) under the avatar: current account (56 px avatar, name, address),
  other accounts (32 px letter avatars in the account colour), "Add another account" (+), "Sign out of all accounts".
  Courier adds the ⌘1…⌘9 hint and "All inboxes".

## Icons (Material Symbols Outlined, 20 px unless noted)

menu (24), search (24), tune (24), help (24), settings (24), edit (compose, 24), inbox, star, schedule, send, draft,
label, label_important, expand_more, expand_less, arrow_drop_down, chevron_left, chevron_right, arrow_back, refresh,
more_vert, check_box_outline_blank, check_box, indeterminate_check_box, archive, unarchive, report, delete,
mark_email_unread, drafts, drive_file_move, snooze/schedule, print, open_in_new, unfold_more/unfold_less, reply,
reply_all, forward, attach_file, link, mood, image, ink_pen (signature), format_* (bold, italic, underline,
color_text, align, lists, indent, quote, strikethrough, clear), close, minimize, open_in_full, close_fullscreen.
Filled variants (FILL 1) for the active nav item and starred stars.

## Behaviour notes observed

- Self-sent mail shows "me" as the sender; a thread lists participants ("me 3" = 3 messages).
- Snippets join paragraphs without spaces (block boundaries are dropped).
- Hover actions are Archive, Delete, Mark as read (or unread), Snooze.
- "More" in the selection toolbar: Snooze, Label as ►, Forward as attachment, Filter messages like these, Mute.
- Message ⋮ menu: Reply, Forward, Delete, Mark unread from here, Report spam, Report phishing, Filter messages like
  this, Print, Download message, Show original (+ Block "Sender" for other senders). Translate is Google-only.
- Snooze presets: Later today (when there's time left today), Tomorrow 8:00 AM, This weekend / Next weekend Sat
  8:00 AM, Next week (the next Monday that isn't tomorrow, else Tuesday) 8:00 AM, Pick date & time.
- Toasts: "Message sent · Undo" during the undo window, then "Message sent · View message".
- Dark theme keeps the conversation messages on a white card.
- Keyboard shortcuts are off by default in the web client; Courier ships them **on** (desktop app; Settings ▸
  General ▸ Keyboard shortcuts turns them off).
- Settings tabs present: General, Labels, Inbox, Accounts (and Import), Filters and Blocked Addresses, Forwarding and
  POP/IMAP, Add-ons (Google-only), Chat and Meet (Google-only), Advanced, Offline, Themes.
- The default toolbar is the *simplified* one: with a selection it shows Archive, Report spam, Delete | Mark as
  read/unread, Move to | More; Snooze and Label as live in More, which ends with "Switch to advanced toolbar"
  (the advanced toolbar adds Snooze after Mark as read and Labels after Move to). Icons sit 44 px apart
  (20 px + 12 px margins), More 40 px after its neighbour; refresh at x = 332, more at 372 with nothing selected.
- Menus hang from the 20 px icon box (top = icon bottom, left = icon left), not from the 40 px hover circle;
  submenus open level with the item that opened them.
- Label as (200 wide): "Label as:" at 8 px, a search field with a magnifier, then user labels by full name
  ("Projects/Alpha", no indent) and, on Gmail accounts, Social, Updates, Forums, Promotions; checkboxes at 22 px,
  names at 48 px; Create new / Manage labels below a divider (Apply when something changed).
- `label:projects` matches the Projects label only, not Projects/Alpha (the search golden shows 2 results).
- The Inbox count is unread conversations in Primary when category tabs are on.
- Search results show an "Inbox" chip on rows that are in the Inbox; running a search closes the search options.
- Advanced search: panel top = search bar bottom − 1 (y = 55), padding 13 24 20 25; "Has attachment" checkbox
  in the label column (x + 28), text at x + 61; buttons 40 tall, 7 px below the checkbox row.
- Lists keep a 16 px gutter on the right (rows, tabs and footer are 992 wide in a 1008 panel; the tab strip has
  another 16 px inside it, so tabs are 244); the conversation keeps 32 px (message dividers stop at x = 1232,
  the message action buttons hang 10 px into the gutter).
- Search box: 624 wide at 1280 (it is `flex: 1` with a 720 max and shares the row with the right-hand buttons).
