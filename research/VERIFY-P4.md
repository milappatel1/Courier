# VERIFY P4 — settings, themes, density, quick settings, shortcuts

## How it was checked

| What | How | Result |
| --- | --- | --- |
| Quick settings: panel 320 wide at (944, 64) r16; title and close at y 80; "See all settings" 288 × 36 at y 116; density options 32 tall, 48 apart, thumbnails 72 × 32; inbox-type thumbnails 72 × 50; the current theme as one 60 × 40 tile with "View all" | browser preview vs `raw/quick-settings.json` and `goldens/quick-settings-*` | ≤ 3 px (thumbnail column 3 px right) |
| Density: compact rows 28 px, default 40 | end-to-end "settings and themes" (row height read from the DOM) | pass |
| Theme picker: Dark applies the dark family, Save stores it, Default restores it | end-to-end "settings and themes" | pass |
| Dark theme colours (page, panel, search, compose, nav, rows, tabs, chips) | browser preview computed styles vs `raw/inbox-dark.json` | match |
| Settings page: labels at x 280, values at x 469, tabs on two rows at 1280; Save Changes stores the page size | browser preview vs `goldens/settings-general`; end-to-end (page size 25 → 50) | pass |
| Settings open as a page, so quick settings closes (it stayed open before) | browser preview | fixed |
| Keyboard shortcuts: single keys, shifted letters, punctuation, `g`/`*` sequences with a timeout | Vitest `core.test.ts › shortcuts` | pass |
| ⌘1/⌘2 account switching through the app menu's events | end-to-end "switches accounts" | pass |
| `g` then `l` asks for a label and opens it | end-to-end "keyboard: g then l…" | pass |
| Simplified toolbar: icon positions and the More menu (Snooze, Label as ▸, …, "Switch to advanced toolbar") | browser preview; end-to-end uses More ▸ Label as | pass (the advanced layout itself isn't measured) |

## Fixed in this pass

- Quick settings header was 8 px low and the close button 6 px right; density thumbnails were 72 × 50 instead of
  72 × 32; inbox types had no thumbnails; the theme section showed two tiles instead of the current theme.
- Quick settings stayed open over the full Settings page.
- New setting `advancedToolbar` (default off, as on the web) with the switch in the More menus.
- `g` `l` (go to label) and "Save draft as template" used `window.prompt`, which the macOS web view doesn't
  provide; both now use an in-app dialog (checked end to end: `g` `l` → "Projects" opens the label).

## Known gaps

- Theme photos ("Your image") and the colour themes other than Default and Dark aren't compared against goldens
  (only the picker itself has one); their colours come from the measured theme layers.
- The shortcut matcher is unit-tested; the full shortcut set isn't driven key by key end to end.
