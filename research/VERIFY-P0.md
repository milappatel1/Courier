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

## Real account (read-only, 2026-10-19)

The user's own OAuth client (project "Courier", desktop client, Testing mode, one test user) and a real Gmail
account signed in through the browser. Checked without reading any message content: one Gmail account, no
re-auth needed, history ID stored (incremental sync running), 130 recent messages indexed, labels synced, outbox
empty, no snoozes/mutes/filters created, Keychain entries under `com.milappatel.courier`; over 30 s of sampling
every connection went to Google (`2001:4860::/32`, Google LLC).

Found and fixed:
- **First run couldn't set up Gmail**: with no accounts the app shows only the welcome screen, so Settings ▸ Accounts
  (where the client is entered) was unreachable. The Add Gmail dialog now takes the client itself (Import JSON or
  paste); the end-to-end run goes through it.
- **Inbox count too low on a real mailbox** (1 vs the web client's 3): the count comes from the cache, which holds
  only the last 30 days. Each sync now asks Gmail for the unread Inbox conversations outside the tabs (one request)
  and caches any that are missing (`tests/engine.rs::old_unread_primary_mail_counts_toward_the_inbox`).
- The end-to-end frontmost-app watch compared app *names*, so a Courier the user had open counted as the test app;
  it now compares process IDs.
- **Keychain prompts that never stopped** after an update: each secret was its own item, re-read on every sync, and
  an ad-hoc-signed update counts as a new app to macOS, so prompts kept coming (and a refusal was retried every
  minute). Secrets now live in one vault item read once per launch under a lock; after an update the vault is
  re-saved by the new build (at most one prompt per update); a refusal is remembered and the accounts ask to sign
  in again, which writes a new item without touching the unreadable one; 1.0 items are migrated. Commands that touch
  secrets left the main thread, so a prompt can't freeze the window. Tests: five vault cases with a fake Keychain
  that prompts like macOS, plus a live round trip under a throwaway service name.
- **A second, larger account never finished its first sync** (the user saw "403"): Gmail answers a burst of
  requests with 403 "User-rate limit exceeded", which Courier treated as fatal, so the first sync restarted and hit
  the limit again every cycle. Now 403/429 rate limits back off (1–16 s) and retry, a lasting limit is its own
  error ("catching up", not offline), one failing message is skipped instead of failing the sync, downloads run 4
  at a time, and Settings ▸ Accounts shows each account's sync state and error. Tests:
  `first_sync_rides_out_rate_limits_and_skips_a_broken_message`, `a_lasting_rate_limit_is_reported_as_such_not_offline`
  (the fake server returns Gmail's real 403 body). Courier also writes a log
  (`~/Library/Logs/com.milappatel.courier/courier.log`: sync, sign-in and Keychain events, never mail content).
- Opt-in network test (`cargo test --lib live_tls -- --ignored`): TLS and greeting from iCloud, Yahoo, Fastmail and
  Microsoft IMAP; SMTP STARTTLS (587) and SSL (465) without logging in. All pass.

## Known gaps

- Automated tests never touch a real mailbox; the real-account check above was read-only.
- Ad-hoc signed rebuilds make macOS ask again for Keychain access the first time; expected for unsigned builds.
