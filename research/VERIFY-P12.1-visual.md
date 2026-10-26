# VERIFY P12.1: visual diff (PARITY L-06)

Courier's look compared with the web client's by image diff, 32 states, 2026-10-25. Result: **0 of 32 states are within
the threshold.** Every state below is a finding. The threshold, tolerance and mask rules are in
`look/LOOK-SPEC.md` ("Visual diff threshold"); this file holds the run and what each state differs by.

## What was compared

- Web side: `goldens/web/<name>-1x.png`, the redacted captures of the recon account made by `tools/goldens.mjs web`
  (not touched, not recaptured). They hold Chat and Meet on, the side panel open, the nav collapsed (except `compose`,
  nav open) and 38 conversations in the Inbox.
- Courier side: `goldens/courier/<name>-1x.png`, captured by `node tools/goldens.mjs courier tools/plans/courier.json`
  from the browser preview (`/browser-preview.html`, mock mailbox, 10 Inbox conversations) in a throwaway headless
  Chrome on port 9224. Same 32 state names and viewport sizes as `plans/web.json`. The plan reserves the web's
  gutters (12 or 68 px left, 40 px right) so the two main panels have the same box, collapses the nav the way the
  web goldens are collapsed, and hides the "Open mail links" toast. Empty states are reached by archiving or
  deleting the mock mail in the capture.
- Not compared: `inbox-default` and `settings-forwarding` exist as web goldens but not in `plans/web.json`.
- Tool: `node tools/visual-diff.mjs`. Threshold 10% of ink pixels, tolerance 24/255, 1 px neighbourhood.
  Noise floor measured at 4.4%, a 2 px displacement scores 19 to 46%. Masks: Google-only chrome, mailbox-dependent
  content (every list row, footer, counts), and the capture gutters.

## Results

| state | diff % | area % | ink px | result |
| --- | ---: | ---: | ---: | --- |
| advanced-search | 47.24 | 3.43 | 27225 | FAIL |
| all-mail | 92.44 | 5.41 | 7548 | FAIL |
| category-updates-label | 84.75 | 4.32 | 6583 | FAIL |
| compose | 16.11 | 1.08 | 30609 | FAIL |
| conversation | 63.01 | 0.47 | 4917 | FAIL |
| inbox-primary | 48.26 | 1.64 | 4380 | FAIL |
| inbox-primary-1024 | 35.42 | 1.62 | 4686 | FAIL |
| inbox-primary-800 | 69.05 | 6.53 | 5205 | FAIL |
| inbox-promotions | 50.67 | 1.78 | 4531 | FAIL |
| inbox-social | 50.25 | 1.73 | 4446 | FAIL |
| inbox-updates-empty | 86.51 | 2.89 | 16999 | FAIL |
| label-view | 93.18 | 6.47 | 8950 | FAIL |
| list-more-menu | 63.84 | 5.02 | 11094 | FAIL |
| message-more-menu | 78.78 | 3.39 | 28333 | FAIL |
| quick-settings | 86.48 | 11.47 | 43063 | FAIL |
| row-context-menu | 83.55 | 7.90 | 27548 | FAIL |
| row-hover | 41.09 | 1.52 | 5262 | FAIL |
| row-selected-toolbar | 20.49 | 2.56 | 17729 | FAIL |
| search-results | 71.90 | 7.44 | 13351 | FAIL |
| sent-empty | 82.83 | 0.61 | 3757 | FAIL |
| settings-accounts | 94.55 | 10.15 | 79375 | FAIL |
| settings-advanced | 92.63 | 7.83 | 62478 | FAIL |
| settings-filters | 93.28 | 4.17 | 33093 | FAIL |
| settings-fwdandpop | 91.15 | 8.11 | 65784 | FAIL |
| settings-general | 93.96 | 8.39 | 66001 | FAIL |
| settings-inbox | 93.28 | 5.99 | 47477 | FAIL |
| settings-labels | 92.08 | 5.15 | 41358 | FAIL |
| settings-offline | 91.55 | 3.45 | 27836 | FAIL |
| spam-banner | 94.98 | 6.78 | 13534 | FAIL |
| starred | 94.35 | 6.88 | 9410 | FAIL |
| toolbar-more-menu | 54.71 | 5.07 | 18510 | FAIL |
| trash-banner | 95.44 | 5.89 | 11696 | FAIL |

Diff images are in `goldens/diff/`
(`<name>.png`, and `<name>-side.png` showing web, Courier, diff).

## Differences that repeat across states

Measured on the 1x pixels, web golden against Courier (Courier shifted by the capture gutter).

1. **Header search box (every state, x 324 to 700).** The magnifier is at x 343 to 359, y 23 to 40 in Courier and
   x 339 to 355, y 22 to 38 on the web: 4 px right, 1 px lower. It is also much darker (darkest pixel 0 against 48,
   so about `#202124` against the web's `#444746`). The placeholder starts 1 px right and is darker too (33 against 68).
2. **Tab strip (inbox states).** Tab icons sit at x 103, 346, 590, 834 in Courier and 103, 355, 608, 861 on the web:
   a 244 px pitch against 253 px, and the active underline is 94 to 317 against 94 to 326. Courier's strip is 36 px
   narrower at the same panel width. The 244 comes from the measurement taken with the nav open (a 1008 px panel).
3. **Toolbar left (checkbox, refresh, more)** matches to the pixel; the remaining 4% there is the noise floor.
4. **Chip row above list views (all-mail, starred, trash-banner, spam-banner, label-view).** The web shows the search
   chips (From, Any time, Has attachment, To, Exclude Social, Exclude Promotions, Is unread, Advanced search) at
   y 96 and pushes the toolbar to y 144; Courier's label views have none, so its toolbar is at y 88 and its rows
   and banner start about 56 px higher. Every element below the header is therefore offset.
5. **Settings pages (8 states).** Courier's Settings has a different design from the web's, not a mis-spaced copy.
   Details below.

## States over the threshold, one by one

All of them are over; the repeated items above apply to each and are not restated.

- **inbox-primary, inbox-promotions, inbox-social (48 to 51%).** Items 1 and 2 only; toolbar matches.
  Courier also draws a 3 px blue bar on the left edge of the first row (the current-row marker) that the web does
  not show on load.
- **inbox-primary-1024 (35%).** Same as above at 1024 wide; tab pitch is again narrower.
- **inbox-primary-800 (69%).** Courier shows the medium layout with a left rail of icons (compose button and nav
  icons) and the full search box; the web at 800 collapses the header to icon buttons and shows the Chat and Meet
  rail. Header is not compared at this width; the tab strip differs as in item 2.
- **inbox-updates-empty (87%).** Courier's empty tab reads "Nothing in Updates." and one line, "New updates mail will
  show up here.", centred in the panel. The web shows "Your Updates tab is empty." and three explanatory paragraphs with
  "Learn more" and "inbox settings" links, left-aligned in a column that starts about 80 px left of centre and 25 px lower.
- **sent-empty (83%).** The web shows the single line "No sent messages! Send one now!" with a blue "Send" link, about
  y 131; Courier shows "Nothing sent yet." at about y 171, no link.
- **conversation (63%).** After masking the message header text: the web has an "Inbox x" label chip centred at
  the top and print and pop-out icons at the right; Courier shows its own chips, a pair of up and down chevrons
  (expand or collapse all) before print and open-in-window, and the page count "2 of 10". The web's message action
  row is star, emoji reaction, reply, more; Courier has star, reply, more (no reaction icon). The web has an
  emoji-reaction circle after Reply and Forward; Courier has none. Reply and Forward pills are the same size.
- **message-more-menu (79%).** The web menu has 16 entries in four groups (Reply, Forward; Delete, Mark as unread;
  Block "<sender>", Report spam, Report phishing; Filter messages like this, Translate, Print, Download message,
  Show original, Share to help improve Google) and runs to the window bottom. Courier's has 11 (Reply, Forward;
  Delete, Mark as unread; Report spam, Report phishing; Filter messages like this, Print, Download message, Show
  original, Share...) and ends well above it. Courier lacks Block and Translate; "Share to help improve Google" is
  Google's.
- **list-more-menu (64%).** Both open "Mark all as read" under the three-dot menu at the same spot. The web's note
  "Select messages to see more actions" is two lines in dark grey; Courier's is one line in lighter grey, and its menu
  box is about 39 px wider.
- **toolbar-more-menu (55%).** Web items: Snooze, Add to Tasks, Label as, Forward as attachment, Filter messages like
  these, Mute, Share to help improve Google, Switch to advanced toolbar. Courier: Snooze, Label as, Forward as
  attachment, Filter messages like these, Mute, Delete all except selected, Archive all except selected, Switch to
  advanced toolbar. Add to Tasks and the Google item are Google's; "Delete/Archive all except selected" are extra.
- **row-context-menu (84%).** The web menu opens below the cursor and is clipped at the window bottom (starts at y 160
  with "Move to tab"); Courier's flips to start at y 31 so that it fits. Items: the web has Mark as unread and
  Add to Tasks that Courier lacks; Courier has the same Reply, Reply all, Forward, Forward as attachment, Archive,
  Delete, Mark as read, Snooze, Move to, Label as, Mute, search field, Open in new window.
- **row-hover (41%).** Compared on the hovered row's left cell and action cluster. The web draws a six-dot grip
  at the row's left edge; Courier's `.drag-handle` is a 3 x 20 px empty box (opacity 1 on hover, `background-image: none`)
  at x 84, so nothing is drawn. Action icons (archive, delete, mark read, snooze) are at the same x; Courier's row
  has the same lift shadow.
- **row-selected-toolbar (20%).** The select-all checkbox shows a filled dark square with a minus in Courier and an
  outlined square with a minus on the web. The selected row's checkbox is a dark filled box with a white tick in
  Courier and a light tick in an outline box with a grey round hover halo on the web. Courier's selected row date is
  bold; the selected-row blue and the toolbar icons otherwise match.
- **compose (16%).** The best state. Compared after shifting Courier 10 px left (the web's compose window sits at
  x 651 to 1207, Courier's at 661 to 1217; both are 557 wide and start at y 167). Differences: the web's footer has
  eleven icons (Send split button, Formatting "Aa", Help me write sparkle, Attach, Link, Emoji, Drive, Photo,
  Confidential, Signature, More) and Courier has seven (no Aa, sparkle, Drive or Confidential lock, and a different
  formatting glyph); Courier's To field shows a text caret. The Inbox nav above Drafts matches in layout.
- **advanced-search (47%).** The dialog is compared after a 56 px shift (it hangs off the search box). Fields and
  Search button line up, but the field underlines are `#e8e8e8` in Courier and `#9f9f9f` on the web (the From
  underline is blue on the web, it is focused), Courier's field rows are 3 px lower (underlines at y 101, 141, 181
  against 98, 138, 178), selects show a native chevron in Courier and a filled triangle on the web, Courier's date
  field shows "mm/dd/yyyy" placeholder text, and "Create filter" is blue and active in Courier but disabled grey
  on the web.
- **quick-settings (86%).** The web panel starts with "Apps in Gmail / Chat and Meet / Customize", then Density,
  then a Theme grid of eight thumbnails with "View all", then Inbox type. Courier has no Apps section, one theme
  thumbnail, and every section after Density is about 100 px higher.
- **search-results (72%).** The web's chip row starts with a Mail / Conversations / Spaces segmented control before
  Any time, Has attachment, To, Is unread. Courier has a "From: northwind" chip instead and no segmented control;
  the web's "Showing most relevant" sort control above the list is absent.
- **category-updates-label (85%).** The web shows the list directly under the toolbar with the search box reading
  "category:updates"; Courier shows the same query but adds the chip row, which pushes its toolbar 56 px lower.
- **all-mail, starred, label-view, trash-banner, spam-banner (92 to 95%).** Item 4. In the trash and spam states the
  banner ("Messages that have been in Trash more than 30 days will be automatically deleted. Empty Trash now" and the
  Spam equivalent) is a full-width grey strip directly under the toolbar in Courier (about y 112 to 158), and a
  strip below the toolbar at about y 172 to 220 on the web. The search box says "in:trash" or "in:spam" on
  the web and "Search mail" in Courier. label-view in Courier now routes by label id (`label/Label_1`), which shows
  the Projects label.
- **settings-general, labels, inbox, accounts, filters, fwdandpop, advanced, offline (91 to 95%).** The pages differ
  in design, not by offsets:
  - The title "Settings" is 7 px lower in Courier (text at y 87 to 107 against 80 to 100).
  - The tab row has different members: the web has General, Labels, Inbox, Accounts and Import, Filters and Blocked
    Addresses, Forwarding and POP/IMAP, Add-ons, Chat and Meet, Advanced, Offline, then "Themes" on a second row;
    Courier has General, Labels, Inbox, Accounts, Filters and Blocked Addresses, Forwarding and POP/IMAP, Advanced,
    Offline, Themes on one row, and the tabs are spaced wider.
  - Courier adds an account picker ("pat@example.com") and a "Close" button at the top right; the web has neither.
  - Row layout (settings-general): both label columns start at x 109, but Courier's first row sits 11 px lower
    (text at y 218 against 207), its control column starts near x 298 against the web's x 324, and the web's 1 px
    rules between rows are not drawn in Courier.
  - Footer: the web page footer (storage, Terms, last activity) is masked; Courier has none.
  - settings-labels: the web lists the system labels each with "Show in IMAP" checkboxes in a third column and
    two-state `show hide` links; Courier has no IMAP column and shows "always shown" for Inbox.
  - settings-accounts: the web has "Change account settings", "Using Gmail for work?", "Send mail as", "Grant
    access"; Courier has an Accounts list with colour swatches, a Google sign-in setup block and a default mail app
    block.
  - settings-filters: the web's blocked-address row (English-quora-digest@quora.com, from the recon account) and
    Export/Delete buttons are in a different order; Courier has "Filters run on every message that arrives", a
    New filter button and Import filters, and "Blocked senders" with "No one is blocked."
  - settings-fwdandpop and settings-advanced: same controls in a different layout, with Courier's radio groups
    one per line under the label and the web's inline.
  - settings-inbox: Courier adds "Reading pane" radios and "Importance markers"; the web has "Starred messages",
    "Bundling in Promotions" and the category illustration instead.

## How the numbers were checked

- Alignment: the Courier capture is inset by the same gutters as the web's rail and side panel; toolbar left cells
  match to the pixel (checked by position, then by the diff's 4.4% residue).
- Harness faults found and fixed during the run: the Courier redaction selectors in `goldens.mjs` were stale
  (the mock mailbox's rows were not hidden); the nav toggle in the plan acted twice when the page had not been
  reloaded (the plan now loads `about:blank` first); the row context menu clicked a different x than the web's (the
  plan now clicks at 570, 20); two "empty" states were not empty in the mock mailbox (the plan now empties them);
  `label-view` used a name where Courier routes by id.
- Not checked: dark theme, other densities, the Courier shell (`tauri`) itself; the browser preview's mock mailbox
  is not the recon mailbox, so rows are masked and row styling is not compared.

## Hillclimb attempt (2026-10-25, main session)

Fixed from the measurements above: the header search icon (no left margin, 48 px tall, `#444746` like the
placeholder; dark themes keep their light text), equal Inbox tabs up to 256 px (253 px pitch with the menu
closed), a selected row's checkbox as an outline with a tick, the advanced-search field underline `#9f9f9f`, and
"Create filter" disabled until a criterion is set. The visual diff didn't move for any of them: list rows are
masked (the two sides hold different mail), and the remaining percentages come from layout that differs by design
(no Chat/Meet rail or side panel, no chip row on non-search views, the settings pages' own design). A six-dot hover
grip was tried and dropped: its look couldn't be checked against the reference.

Known gap: the 10% threshold can't be met state by state until both sides show the same mailbox (seed the Courier
preview with the recon mailbox) and the by-design layout differences are masked; until then the per-state list
above is the record of what differs.
