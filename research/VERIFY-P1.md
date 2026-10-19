# VERIFY P1 — main window and the look

Scope: header and search bar, navigation, thread list, category tabs, conversation view, reading pane modes,
list/conversation actions, toasts with Undo; matched against the goldens.

## How it was checked

The browser preview (`/browser-preview.html`, 1280 × 728 at 100 %) runs the real UI on a mailbox shaped like the
recon seed (the same six self-sent messages, labels Projects, Projects/Alpha, Receipts, one PDF attachment). Boxes
and computed styles were read with `getBoundingClientRect`/`getComputedStyle` and compared with the measurements
taken from the reference client (`research/look/raw/*.json`, gitignored) and the goldens (`research/goldens/`,
gitignored). Actions were exercised by the end-to-end run against the fake servers.

| Area | Reference | Courier | Δ |
| --- | --- | --- | --- |
| Header 64; menu button 12,8 48×48; search 256,8 | 624×48 r24 | 624×48 r24 | 0 |
| Compose button 8,72 | 142×56 r16 | 143×56 r16 | +1 px (text width) |
| Nav item 0,144 240×32; icon x 26; text x 64; count right edge 228 | — | same | 0 |
| Main panel 256,64 | 1008×648 r16 | 1008×648 r16 | 0 |
| Toolbar icons, nothing selected (select, refresh, more) | 272, 332, 372 | 272, 332, 372 | 0 |
| Toolbar icons with a selection (archive, spam, delete, read, move, more) | 332, 376, 420, 480, 524, 564 | same | 0 |
| Paging chevrons | 40 apart | 1172, 1212 | — (no input-tools button) |
| Tabs strip 256,112 992×56; tab width | 244 | 244 | 0 |
| Rows 256,168 992×40; cells 3/43/30/200/flex/72; subject x 532; star x 302 | — | same | 0 |
| Row label chip 52×18 at 532,179; snippet x 707 | — | 532,179 52×18; 703 | −4 px snippet (glyph widths) |
| Attachment chip 534,405 160×30 r15 | — | 534,407 160×30 | +2 px y |
| Conversation: subject 328,132 (22/28); first message 160 (80 tall); expanded message header/to/body offsets 21/43/68 | — | same | 0 |
| Conversation header buttons | 1130, 1166, 1202 | 1130, 1166, 1202 | 0 |
| Message actions (more / reply) | 1202 / 1162 | 1202 / 1162 | 0 |
| Reply / Forward buttons | 104 / 112 × 36 | 104 / 113 × 36 | +1 px |
| Menus: More at the icon box (564,98); Label as 200 wide, checkboxes at +22, names at +48 | — | same | 0 |
| Snooze menu 256 wide, under the icon, right-aligned | 976..1232, top 278 | anchored to the icon | 0 |
| Dark theme: page #111, panel rgba(51,51,51,.8), read rows rgba(0,0,0,.5) + text 70 % white, nav icons .7 | — | same values | 0 |

## Fixed in this pass

- A selector returning a new array on every read (compose dock, `?? []` label lists) re-rendered forever.
- Rows were 1008 wide with no gutter; lists now keep the 16 px gutter (and the tab strip another 16).
- Row height was 41 (sender line 21); attachment icon got its own 30 px column (horizontal paperclip).
- Search box grew to 720; it is now 624 at 1280 like the reference.
- Toolbar spacing (44 px rhythm), select button geometry, paging position.
- User labels in the nav now use the filled label icon; expander triangle at x 18.
- The simplified toolbar is now the default (Snooze and Label as in More, "Switch to advanced toolbar").
- Menus anchor to the icon box; submenus open level with their item; Label as lists full names and categories.
- Conversation: `<h2>` margins pushed the subject 18 px down; collapsed messages were 100 px (now 80); the starred
  star had a toggle background; header and message buttons, dividers and Reply/Forward sizes.
- Dark theme read-row text, dates, counts and nav icon opacity.
- Search result rows now show the Inbox chip.

## Deliberate differences

- In the app the header leaves 72 px for the window buttons (it is the title bar), so the menu button, logo and
  search sit 72 px further right than in a browser; in full screen and in the browser preview they don't.
- No Upgrade, Gemini, apps grid or input-tools buttons, no side-panel toggle, no emoji-reaction button, no
  "Purchases" label, no storage meter; the footer text is our own ("2 accounts · up to date").
- Logo, theme thumbnails and quick-settings drawings are our own artwork.
- Text is drawn by WebKit rather than Chrome, so some glyph runs differ by a few px.

## Known gaps

- No split-pane golden (the reference didn't keep "Right of inbox" during recon); the split layout follows the
  measured list and conversation geometry.
