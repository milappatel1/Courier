# Courier

A mail app for macOS that looks and works like the web mail client you already know, with several accounts
side by side: Gmail accounts through the Gmail API, and any other provider (iCloud, Outlook, Fastmail, Yahoo, your
own server…) through IMAP and SMTP.

Courier is an independent, clean-room project. It isn't made by or affiliated with Google, and it contains no
Google code, artwork or branding. The fonts (Google Sans and Roboto) ship under the SIL Open Font Licence and the
icons (Material Symbols) under Apache 2.0; both licences are in `app/src/styles/fonts/`.

## Install

1. Download `Courier-1.0.0-arm64.dmg` (or the `.zip`) from the
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

Sign-ins live in your macOS Keychain. **Sign out** (avatar menu) removes that account's Keychain entries and its
local copy of your mail; nothing changes on the server. ⌘1…⌘9 switch accounts, and **All inboxes** shows them
together.

## What's there

Inbox with category tabs and the other inbox types (important/unread/starred first, priority, multiple
inboxes), conversation view, the reading pane on the right or below, three densities, light, dark and colour
themes, labels with colours and nesting, drag to label, archive, snooze, mute, block, unsubscribe, undo for
every action, search with all the usual operators, search chips and advanced search, filters, stacked compose
windows with rich text, attachments and inline images, signatures, templates, undo send, schedule send, the
offline outbox, keyboard shortcuts, notifications, the Dock badge, `mailto:` links and opening `.eml` files.

Left out on purpose, because they're Google-only services: Gemini / "Help me write", Chat, Spaces, Meet, the
Calendar/Keep/Tasks side panel, Drive and Photos attachments, confidential mode, Workspace add-ons and smart
compose.

Snooze, schedule send and mute aren't available in the Gmail API, so Courier keeps them on your Mac: snoozed and
scheduled mail need Courier running (it can be in the background) at the chosen time.

## Privacy

- Message HTML is shown in a sandboxed frame with no scripts and a strict content policy. Remote images are held
  back until you click **Display images** (or allow a sender), tracking pixels are removed, and links open in your
  default browser.
- Courier has no servers of its own and sends nothing anywhere except to your mail providers.
- Your Google client ID and secret are stored in the Keychain from Settings ▸ Accounts; they're never part of the
  app or this repository.

## Build from source

You need Xcode's command line tools, Rust (stable) and Node 22 or later.

```bash
cd app
npm install
npm run tauri dev        # run with hot reload
npm run tauri build      # release build → app/src-tauri/target/release/bundle/macos/Courier.app
npm run package          # what the releases are: arm64 build, ad-hoc signature, .dmg + .zip in release/
```

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
