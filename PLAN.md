# Courier — plan

Courier is a brandless, clean-room macOS mail client that looks and works like the Gmail web client 1:1, minus
Google branding, Google's assets and Google-only services, with multiple accounts (Gmail API + IMAP/SMTP).

## Status

**1.0.5 released (2026-10-20)** — https://github.com/milappatel1/Courier/releases/tag/v1.0.5 (`.dmg` and `.zip`, ad-hoc signed; SHA-256 in the release notes): — notifications open their conversation and can archive it, calendar invitations with RSVP, compose labels, filter import/export, drag a conversation into a message, sender warnings, in-message jump links, recent searches. See `research/VERIFY-P9.md`.

**1.0.4 released (2026-10-20)** — https://github.com/milappatel1/Courier/releases/tag/v1.0.4 (`.dmg` and `.zip`, ad-hoc signed; SHA-256 in the release notes): — popups that stay with what they belong to (the details box, menus, the sender card), shortcuts that keep working after a click in a message, five settings that did nothing now work, Share and Paste and Match Style in the menu bar, the window remembers its frame. See `research/VERIFY-P8.md`.

**1.0.3 released (2026-10-19)** — https://github.com/milappatel1/Courier/releases/tag/v1.0.3 (`Courier-1.0.3-arm64.dmg` and `.zip`, ad-hoc signed; SHA-256 in the release notes). — the real-use round: images on by default, message frames that never cut off or grow forever, links in the default browser, attachments in their own apps, downloads straight to Downloads, trackpad swipes, exact label counts after every action, server-wide "select all" with keep-the-unticked and "Delete all except selected", Manage subscriptions, a right-click menu, and a layout from 1440 px down to phone width. See `research/VERIFY-P7.md` and the feature brief `research/GMAIL-PARITY.md`. 1.0.2 and earlier are on the releases page.

| Phase | State | Notes |
| --- | --- | --- |
| Recon | done | Look measured into `research/look/LOOK-SPEC.md`; 21 redacted goldens (local only). The recon account's display settings (Chat, Meet, side panel, density, theme, reading pane) were put back afterwards; its test mail and labels remain. |
| P0 foundations | done | `research/VERIFY-P0.md` |
| P1 main window + look | done | `research/VERIFY-P1.md` — measured boxes match the reference to 0–3 px at 1280 × 728 |
| P2 compose | done | `research/VERIFY-P2.md` |
| P3 search + filters | done | `research/VERIFY-P3.md` |
| P4 settings, themes, shortcuts | done | `research/VERIFY-P4.md` |
| P5 Mac integration | done | `research/VERIFY-P5.md` — the e2e run never takes focus (checked by the app and the script) |
| P6 snooze, schedule, unsubscribe… | done | `research/VERIFY-P6.md` |
| P7 real-use round | done | `research/VERIFY-P7.md` |
| P8 1.0.4 bug hunt | done | `research/VERIFY-P8.md` |
| P9 1.0.5 parity round | done | `research/VERIFY-P9.md` |
| P10 1.0.6 real-use bugs + hunt | done | `research/VERIFY-P10.md` — delete flash, "400: Precondition check failed", unsubscribe like the web client, stale cache after cleanups, label settings, a button sweep |
| Tests | passing | Vitest 103, Rust 54 (+2 opt-in live TLS checks), end to end 70 steps + 2 run-wide checks in ~6 min (frame recorder for flashes, every button pressed, no raw error text, window sizes 1440–420 px) |
| Real-account check | done (read-only) | 2026-10-19 with the user's own OAuth client; found bugs (first-run client setup unreachable, Inbox count from a partial cache, endless Keychain prompts after an update), fixed in 1.0.1. See `research/VERIFY-P0.md`. |

Open items: things not driven automatically (mailto/.eml/Quick Look/Share/drag-out,
pop-out compose, templates, multiple inboxes) are listed under "Known gaps" in the VERIFY notes.

## Ground rules

- Clean-room: no Google code, CSS, JS, icons, logos, illustrations or wording are copied. The real client is
  observed at runtime (REA captures, computed styles) in an isolated Chrome profile (`~/.courier-recon-chrome`,
  CDP 127.0.0.1:9222), measured into `research/look/LOOK-SPEC.md`, then re-created.
- Fonts: Google Sans + Roboto (OFL) bundled locally under neutral file names, with the OFL licence. Icons:
  Material Symbols (Apache-2.0). No "Gmail"/"Google" names and no M logo in the product.
- Captures (goldens, accessibility dumps) are redacted before they are saved and never committed
  (`research/goldens/`, `research/captures/` are gitignored).
- Message content from a real mailbox is never logged, committed, or sent anywhere except its own provider.
- Left out (Google-only): Gemini / Help me write, Chat, Spaces, Meet, the Calendar/Keep/Tasks side panel, Drive and
  Photos attachments, confidential mode, Workspace add-ons, smart compose.

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Shell | Tauri 2 (Rust), macOS 13+, arm64 | Overlay title bar: the header is drawn into the title bar. |
| UI | React 19 + TypeScript + Vite, zustand store | Pure logic in `app/src/core/` (no DOM/IPC) so it is unit-testable. |
| Mail HTML | sandboxed `<iframe srcdoc>` (no `allow-scripts`) + CSP + our sanitiser | Remote images blocked until "Display images", tracking pixels stripped, links → default browser. |
| Gmail | Gmail REST API over HTTPS (reqwest + rustls) | threads/messages/labels/drafts/history/settings; People API for contacts when granted. |
| Others | IMAP (async-imap, IDLE) + SMTP (lettre) | App passwords; discovery = built-in table → autoconfig → ISPDB → SRV → guesses. |
| Auth | OAuth 2 + PKCE (S256), system browser, loopback redirect `http://127.0.0.1:<port>` | Client ID/secret entered by the user in Settings ▸ Accounts → Keychain. |
| Secrets | macOS Keychain (security-framework) | `SecretStore` trait; in-memory store only for the e2e run. |
| Cache | SQLite (rusqlite, bundled) + FTS5 | Raw RFC 822 for the offline window, metadata for everything listed. |
| MIME | TypeScript builder/parser (display, compose, show original); Rust `mail-parser` for indexing | Rust sends raw bytes it is given; it never builds MIME. |
| Search | TS parser (chips, advanced search, filters) + Rust parser/compiler (local index, fake server, local filters) | Shared fixture `app/tests/fixtures/search-cases.json` keeps both parsers identical. |
| Tests | Vitest (`npm test`), cargo tests with fake Gmail/IMAP/SMTP servers (`npm run test:rust`), in-app e2e (`npm run test:e2e`) | Fake servers live in `src-tauri/src/testsupport/` (debug + test builds only). |

## Layout

```
mail-clone/
  PLAN.md  README.md  SETUP-GOOGLE.md  .gitignore
  app/                      Tauri + React app
    src/core/               pure modules: search, mime, sanitize, threading, labels, dates, addresses, shortcuts
    src/ipc/                typed wrappers for the Rust commands + events
    src/state/              zustand stores (accounts, mailbox, compose, settings, toasts)
    src/ui/                 React components (header, nav, list, conversation, compose, settings, menus…)
    src/styles/             tokens.css (from LOOK-SPEC) + component CSS, fonts, icons
    src/e2e/                in-app end-to-end runner (debug builds, COURIER_E2E)
    dev/tauri-mock.ts       native-side stub for /browser-preview.html
    tests/                  Vitest suites
    src-tauri/src/          Rust: accounts, oauth, keychain, db, gmail/, imap/, smtp, sync engine, outbox,
                            snooze, search, notify, macos, e2e, testsupport/
    src-tauri/tests/        Rust integration tests against the fake servers
  research/
    look/LOOK-SPEC.md       measured look (committed); raw measurements gitignored
    tools/                  CDP/REA helper scripts
    goldens/ captures/      redacted captures (gitignored, local only)
    VERIFY-P0.md … VERIFY-P6.md
  release/                  build output (gitignored)
```

## Data model (SQLite)

`accounts`, `labels`, `messages` (+ `message_labels`, `fts` FTS5), `threads` (derived), `outbox` (undo-send /
scheduled / offline), `snoozes`, `muted`, `star_types`, `contacts`, `templates`, `signatures`, `local_filters`,
`blocked`, `kv` (settings), `sync_state` (Gmail history ID, IMAP UIDVALIDITY/UIDNEXT/MODSEQ per folder).

## Behaviour decisions (API gaps)

- **Snooze**: local. Gmail: INBOX is removed on the server and a local snooze record keeps it in "Snoozed";
  at the time the thread gets INBOX back and floats to the top. IMAP: hidden locally. Needs the app running.
- **Schedule send**: local queue (outbox with `send_at`), shown under "Scheduled"; UI says the app must be running.
- **Undo send**: same queue with `send_at = now + delay` (5/10/20/30 s, Settings ▸ General).
- **Mute**: local list; the sync engine archives new messages on muted threads.
- **Multiple star types**: server gets STARRED; the star type is stored locally.
- **Block sender**: Gmail = a server filter `from:x → Trash` remembered as "blocked"; IMAP = local filter.
- **Report phishing**: marks spam (the API has no phishing report) and says so.
- **Filters for IMAP accounts**: local filters applied by the sync engine on new mail.
- **Categories**: Gmail CATEGORY_* labels; IMAP accounts have no tabs (as in Gmail with categories off).

## Phases

- **P0** — scaffold, accounts (Gmail + IMAP), OAuth PKCE + loopback, Keychain, SQLite/FTS5 cache, sync engine
  (Gmail history, IMAP UID/IDLE), fake servers, test runners, browser preview stub.
- **P1** — header/search bar, nav, thread list, conversation view, reading pane modes, actions (archive, delete,
  spam, read, star, important, label, move, mute, block), drag to labels, toasts with Undo; goldens matched.
- **P2** — compose windows (stacked, minimise, pop-out, full screen), rich text toolbar, attachments + inline
  images, Cc/Bcc + autocomplete, aliases, signatures, templates, plain-text mode, spell check, drafts autosave
  (server-synced), send, undo send, reply/reply all/forward (inline, as attachment).
- **P3** — search operators (Gmail API for Gmail, local index for IMAP/offline), chips, advanced search,
  create filter from search, filters, categories, inbox types.
- **P4** — Settings (General, Labels, Inbox, Accounts, Filters and blocked addresses, Forwarding and POP/IMAP,
  Advanced, Offline, Themes), themes incl. dark, density, quick settings, full keyboard shortcut set + menus.
- **P5** — Mac: menus, Dock badge, notifications (per account/label), mailto: handler, Quick Look, drag-out,
  .eml open, Share menu, sleep/wake, offline mode + outbox, VoiceOver labels, full keyboard use.
- **P6** — snooze, schedule send, multiple inboxes, unsubscribe (List-Unsubscribe, RFC 8058 one-click), print,
  show original, download .eml.

Each phase ends with `research/VERIFY-Pn.md` (what was checked, how — app / browser preview / headless —
what was fixed, known gaps), a typecheck, and a re-run of the suites.

## Testing

- `npm test` — Vitest: search parser, MIME build/parse + compose→MIME→parse round trips, sanitiser, threading,
  label mapping, Gmail-style dates, addresses, shortcuts, outbox/undo logic.
- `npm run test:rust` — cargo tests against the fake Gmail API server and fake IMAP/SMTP servers started by the
  tests: sync + incremental history, send, drafts, labels, token refresh, Keychain wrapper, offline outbox,
  local search, IMAP discovery/IDLE.
- `npm run test:e2e` — debug app with `COURIER_E2E=<report.json>`: background window, no focus
  (`activate_ignoring_other_apps(false)`, `focused(false)`, throttling off, App Nap off), fake servers in-process,
  real UI flows, per-step timeouts, progress log, JSON report, quits.
- `/browser-preview.html` — UI with `dev/tauri-mock.ts` standing in for the native side.
- `npm run test:all` — everything. Automated tests never touch a real mailbox.

## Risks

| Risk | Mitigation |
| --- | --- |
| Gmail API gaps (snooze, mute, superstars, phishing, blocked list) | Local implementations listed above; documented gaps. |
| Testing-mode OAuth: refresh tokens expire after 7 days | Re-auth prompt on `invalid_grant`, account kept. |
| Keychain ACL prompts after each ad-hoc-signed rebuild | Expected for unsigned builds; e2e uses an in-memory store. |
| Pixel match across fonts/WebKit vs Chrome | Same fonts bundled; compare at 100 % with tolerance; record deltas in VERIFY. |
| Remote content leaks (images, CSS url(), links) | Sanitiser + CSP in srcdoc + sandbox without scripts; tests. |
| Focus stealing during tests | Background e2e window; clicks only through the frontmost guard; browser pane otherwise. |
| Huge scope | Pure modules first with tests; each phase verified before moving on. |
