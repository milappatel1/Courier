# Search

A user types in the search box (operators such as `from:`, `has:attachment`, `in:`, `label:`, `older_than:`),
picks a suggestion or a filter chip, or opens advanced search; results list conversations, and a search can
become a filter.

## Sub-features

- `search-box` typing and Enter; `/` focuses the box.
- `search-operators` the operators the web client supports (shared fixture `app/tests/fixtures/search-cases.json`).
- `search-chips` the chips under the box.
- `search-advanced` the advanced search panel and Create filter.

## How to get to it (user POV)

- Click the search box or press `/`; the tune icon opens advanced search.

## Driving it with the e2e runner

Preconditions:

- `pat@example.com` Inbox.

- **Search.** `type(await el("search-input"), "from:ana")`, `key(input, "Enter")`. The rows are the conversations
  from Ana; `getState().route.list.query` is the query.
- **Advanced.** `click(await el("advanced-search"))`, tick `adv-has-attachment`, `click(await el("adv-search"))`.
- **Proof.** The search steps in `run.ts` pass; operators are also covered by Vitest `search.test.ts` and the Rust
  search tests against the same fixture.

## Gotchas

- Mail-API accounts search on the server; IMAP and offline use the local index. Check both when changing the
  parser.
