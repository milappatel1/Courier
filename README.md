# Courier

A mail app for macOS that looks and works like the web mail client you already know, with several accounts
side by side: Gmail accounts through the Gmail API, and any other provider (iCloud, Outlook, Fastmail, Yahoo, your
own server…) through IMAP and SMTP.

Courier is an independent, clean-room project. It isn't made by or affiliated with Google, and it contains no
Google code, artwork or branding. The fonts (Google Sans and Roboto) ship under the SIL Open Font Licence and the
icons (Material Symbols) under Apache 2.0; both licences are in `app/src/styles/fonts/`.

## Install

1. Download `Courier-<version>-arm64.dmg` (or the `.zip`) from the
   [latest release](https://github.com/milappatel1/courier/releases/latest). It runs on Apple silicon Macs with
   macOS 13 or later.
2. Open the `.dmg` and drag **Courier** onto **Applications**.
3. The app is signed ad hoc, not notarised, so the first launch needs one extra step: open Courier, and when
   macOS says it can't check the app, open **System Settings ▸ Privacy & Security**, scroll to the message about
   Courier and click **Open Anyway**. (Or Control-click Courier in Applications and choose **Open**.)

Both downloads are checked against the SHA-256 sums listed in the release notes.

## Add your accounts

- **Gmail / Google Workspace**: Courier signs in through your browser with your own Google OAuth client, so your
  mail goes straight between your Mac and Google. Setting up the client takes about ten minutes once; the steps
  are in [SETUP-GOOGLE.md](SETUP-GOOGLE.md). Then choose **Add account ▸ Gmail**, sign in in the browser, and come
  back to Courier.
- **Any other provider**: choose **Add account ▸ Other mail**, type your address, and Courier finds the server
  settings. Use an app password (iCloud, Outlook, Yahoo and Fastmail all have them in their account settings).

If something looks wrong, Courier's log is at `~/Library/Logs/com.milappatel.courier/courier.log`: sync and
sign-in events, every action you take (what, on how many conversations, label ids, how it ended) and every request
the mail server refused (status and reason). Never subjects, addresses or message content.

Sign-ins live in your macOS Keychain, in a single Courier entry. After an update, macOS may ask once for your
Keychain password to let the new version read it (choose **Always Allow**); if you'd rather not, choose **Deny** and
sign in again. **Sign out** (avatar menu) removes that account's Keychain entries and its
local copy of your mail; nothing changes on the server. ⌘1…⌘9 switch accounts, and **All inboxes** shows them
together.

## What's there

Inbox with category tabs and the other inbox types (important/unread/starred first, priority, multiple
inboxes), conversation view, the reading pane on the right or below, three densities, light, dark and colour
themes, labels with colours and nesting, drag to label, archive, snooze, mute, block, unsubscribe, undo for
every action, search with all the usual operators, search chips and advanced search, filters, stacked compose
windows with rich text, attachments and inline images, signatures, templates, undo send, schedule send, the
offline outbox, keyboard shortcuts, notifications, the Dock badge, `mailto:` links and opening `.eml` files.

Also: **Manage subscriptions** (every sender with an unsubscribe option, how much they send, one-click
unsubscribe, and clearing out their old mail); **select all conversations in a view** — every page, on the
server, not just what's on screen — then untick the ones to keep, or tick a few and choose **Delete all except
selected**; a right-click menu on every conversation; two-finger swipes (right goes back and left goes forward, as in a
browser; left across a conversation in the list archives it — configurable in Settings ▸ General); and a layout that follows the
window down to phone width, where it turns into the phone app's (menu drawer, rows with pictures, a floating
Compose button).

Mac behaviour: links open in your default browser, attachments open in the app your Mac uses for them (a PDF in
Preview), downloads go straight to your Downloads folder, and Courier can be your default mail app (it offers once;
also Settings ▸ Accounts), so mail links and other apps' "Email this file" commands open a new message here.

Left out on purpose, because they're Google-only services: Gemini / "Help me write", Chat, Spaces, Meet, the
Calendar/Keep/Tasks side panel, Drive and Photos attachments, confidential mode, Workspace add-ons and smart
compose.

Snooze, schedule send and mute aren't available in the Gmail API, so Courier keeps them on your Mac: snoozed and
scheduled mail need Courier running (it can be in the background) at the chosen time.

## Known limitations

- Courier keeps the last 30 days of mail (and older unread Inbox mail) on your Mac; older mail comes from the
  server page by page, so it needs a connection.
- Archiving, deleting and labelling need a connection: offline they say so and offer Try again (sends wait in
  the Outbox).
- Gmail's Purchases category isn't available through the Gmail API, so it has no tab or label in Courier.
- Unsubscribe uses the sender's one-click link (RFC 8058), else an unsubscribe email from your account, else the
  sender's web page; it can take a sender a few days to stop.
- A phone app can keep showing mail you've already deleted elsewhere until it refreshes; the server (and
  Courier) are the reference.
- Builds are signed ad hoc, not notarised (see Install), so macOS may ask for your Keychain password once after
  each update.

## Privacy

- Message HTML is shown in a sandboxed frame with no scripts and a strict content policy. Tracking pixels are
  removed and links open in your default browser. Images show by default; Settings ▸ General ▸ Images can hold
  remote images back until you click **Display images**.
- Courier has no servers of its own and sends nothing anywhere except to your mail providers.
- Your Google client ID and secret are stored in the Keychain from Settings ▸ Accounts; they're never part of the
  app or this repository.

## Build from source

You need Xcode's command line tools, Rust (stable) and Node 22 or later.

```bash
cd app
npm install
npm run tauri dev        # run with hot reload
npm run tauri build      # release build → <cargo target dir>/release/bundle/macos/Courier.app
npm run package          # what the releases are: arm64 build, ad-hoc signature, .dmg + .zip in release/
```

The cargo target directory is `app/src-tauri/target` unless you move it (`CARGO_TARGET_DIR` or a
`.cargo/config.toml`); the scripts ask `cargo metadata` where it is. Keep it out of folders that a cloud drive
backs up: every build rewrites thousands of files.

`npm run dev` and `/browser-preview.html` show the whole interface in a browser with a stand-in for the native
side (`app/dev/tauri-mock.ts`), which is handy for working on the UI.

## Tests

```bash
cd app
npm test             # Vitest: search parser, MIME round trips, sanitiser, threading, labels, dates, shortcuts
npm run test:rust    # Rust tests against local fake Gmail API, IMAP and SMTP servers
npm run test:e2e     # the debug app runs real UI flows against the fakes in a background window
npm run test:all     # all of the above
```

The automated tests never touch a real mailbox. The end-to-end run (`scripts/e2e.sh`) starts the debug build with
`COURIER_E2E`, which swaps in the fake servers, an in-memory key store and a throwaway data folder; the window
never takes focus, every step has a timeout, progress is printed as it goes, and a JSON report is written at the
end.

## Layout

```
app/
  src/core/        pure TypeScript: MIME, search parser, sanitiser, threading, labels, dates, shortcuts
  src/ipc/         typed wrappers for the Rust commands and events
  src/state/       app state (zustand): accounts, lists, compose, settings
  src/ui/          React components
  src/e2e/         the in-app end-to-end runner
  dev/             browser preview stand-in for the native side
  tests/           Vitest suites
  src-tauri/src/   Rust: OAuth, Keychain, SQLite + FTS5 cache, Gmail API, IMAP/SMTP, sync engine, outbox,
                   search, macOS integration, fake servers for tests (testsupport/)
research/          how the look was measured (LOOK-SPEC.md) and the phase-by-phase verification notes
```

## Licence

MIT for Courier's own code. Bundled fonts: SIL Open Font Licence 1.1. Icons: Apache 2.0.
