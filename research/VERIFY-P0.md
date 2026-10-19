# VERIFY P0 — foundations

Scope: scaffold, accounts (Gmail API + IMAP/SMTP), OAuth 2 with PKCE and a loopback redirect, Keychain, SQLite +
FTS5 cache, sync engine (Gmail history IDs, IMAP UIDs + IDLE), fake servers, test runners, browser preview stub.

## How it was checked

| What | How | Result |
| --- | --- | --- |
| OAuth: authorize URL with `code_challenge_method=S256`, loopback on 127.0.0.1, code exchange, userinfo, refresh ahead of expiry, refresh once on 401, `invalid_grant` → re-auth | `tests/providers.rs::oauth_pkce_userinfo_and_token_refresh` against the fake Gmail server | pass |
| Gmail initial sync, incremental sync from a history ID, labels, categories | `providers.rs::gmail_initial_and_incremental_sync`, `gmail_search_pages_threads_and_modify` | pass |
| Gmail drafts, send (threaded), label create/update/delete | `providers.rs::gmail_drafts_send_and_labels` | pass |
| IMAP: TLS/STARTTLS/plain connect, folder list → labels (special-use + names, modified UTF-7), UID sync, flags, moves, copies, APPEND, IDLE wake-up | `providers.rs::imap_sync_flags_moves_append_and_idle`, unit `imap::folder_mapping_and_mutf7` | pass |
| SMTP with AUTH, Bcc removed from the data | `providers.rs::smtp_send_with_auth`, unit `engine::bcc_is_stripped_and_rules_expand` | pass |
| Keychain wrapper (service `com.milappatel.courier`), memory store for tests | `providers.rs::keychain_wrapper_round_trip` | pass |
| Cache: upsert/list/search, thread order by newest message, outbox claim/undo, contacts, threading helpers, Primary-only Inbox count | unit tests in `db.rs` | pass |
| Discovery: built-in table, autoconfig | unit `discovery::builtins_and_autoconfig` | pass |
| Adding both kinds of account through the UI, switching, sign-out | end-to-end run (`npm run test:e2e`, steps 3–5 and the last one) | pass |
| Browser preview | `/browser-preview.html` with `app/dev/tauri-mock.ts` (two accounts, recon-shaped mailbox) | renders every screen |

## Fixed along the way

- Thread lists sorted by the newest *matching* message; now by the conversation's newest message overall.
- SQLite "InvalidParameterCount": numbered and bare `?` parameters mixed; the filter moved into a CTE.
- Fake IMAP returned literals as lossy UTF-8; it now returns raw bytes.
- Tauri command futures weren't `Send` (higher-ranked lifetime error) because of borrowed ids in a stream.
- After a Gmail 429/5xx outlasted the built-in retries the error was permanent, so an outbox message could fail
  for good; it is now treated as "no connection" (queued, retried with backoff).
- Coming back online didn't retry queued sends until their backoff ran out; now they go at once.
- The Inbox count included Promotions/Social/Updates; it now counts Primary only when tabs are on (Dock badge too).
- Signing out of the open account switched to another account without reloading its list (stale rows).
- A 401 while another request was already refreshing the token refreshed it a second time (the "reuse" check was
  an empty block); the newer token is now reused.

## Known gaps

- A read-only check against a real Gmail account waits until the user has created their OAuth client and signed in
  (SETUP-GOOGLE.md). Automated tests never touch a real mailbox.
- Ad-hoc signed rebuilds make macOS ask again for Keychain access the first time; expected for unsigned builds.
