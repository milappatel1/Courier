# VERIFY P3 — search, chips, filters, categories, inbox types

## How it was checked

| What | How | Result |
| --- | --- | --- |
| Query parser: fields, quotes, `-`, `+`, `OR`, `AND` and the bar form of OR, `{}`, `()`, dates, relative times, sizes, categories, `list:`, `deliveredto:`, `rfc822msgid:` | shared fixture `app/tests/fixtures/search-cases.json` (32 cases) run by both Vitest and `search::shared_fixture_matches_typescript_parser` in Rust | pass in both |
| Local evaluation (IMAP accounts and offline): fields, boolean structure, free text, `is:`/`has:`/`in:` | Vitest `search.test.ts › evaluate`, Rust `search::evaluate` | pass |
| SQL compile over the cache (FTS5 for free text, label resolution) | Rust `db::upsert_list_and_search`, `tests/engine.rs::views_categories_search_and_unified` | pass |
| Advanced search form ⇄ query, date-within, chips add/replace/remove, filter criteria ⇄ query | Vitest `search.test.ts` | pass |
| Search in the app: `from:cara has:attachment` → 1 result; "Is unread" chip adds/removes `is:unread`; `label:projects is:starred`; advanced search From | end-to-end "searches with operators, filter chips and advanced search" | pass |
| Create a filter from the search options (server filter with the star action) | end-to-end "creates a filter from the search options" | pass after the fix below |
| Chip row and panel geometry: chips 85/110/133/66/88 wide (reference 84/110/134/66/90), toolbar icons at y 134, rows at 168; panel 720 × 440 at (256, 55), checkbox at (284, 400) | browser preview vs `raw/search.json`, `raw/adv-search.json`, goldens | ≤ 2 px |
| Categories (tabs from Settings ▸ Inbox, Forums off by default), Primary-only Inbox count, inbox types | `tests/engine.rs::views_categories_search_and_unified`, Rust `db::inbox_count_covers_primary_only`, preview | pass |

## Fixed in this pass

- `label:projects` also matched Projects/Alpha in both search engines and the local resolver; the reference returns
  the exact label only (the search golden shows two results), so both now match exactly.
- Running a search left the search options open, so the next click on the options button closed them.
- The "Has attachment" checkbox in the panel picked up the search input's styles (`.search input`), turning it into
  a 434 × 46 box; the rule now targets only the search box's own input.
- The panel covered the search box; it now hangs below it like the reference, with "1 day" as the date default.
- Search result rows now show an Inbox chip.

## Known gaps

- Gmail accounts search through the Gmail API when online (same operators); the "Showing most relevant" sort
  isn't offered (the API has no relevance ordering).
- `AROUND` isn't supported by the local evaluator (IMAP/offline); it's passed through as words.
