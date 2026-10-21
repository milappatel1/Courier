# Working on Courier

Everything needed to pick Courier up again is in this repository; nothing on the Mac it was built on is needed.
Start here, then read `PLAN.md` (status, ground rules, stack, decisions) and the latest `research/VERIFY-P*.md`
(what the last round changed and its known gaps).

## A fresh Mac

1. Install Xcode's command line tools (`xcode-select --install`), Rust stable (rustup) and Node 22 or later.
2. Clone the repository somewhere a cloud drive does **not** back up, or move Cargo's build folder out of it.
   A build rewrites tens of thousands of files (several GB); a backed-up `~/Downloads` once filled 67 GB of
   Google Drive's upload staging. Either set `CARGO_TARGET_DIR`, or put this in a `.cargo/config.toml` in a
   parent folder of the checkout (outside the repository):

   ```toml
   [build]
   target-dir = "/Users/<you>/Library/Caches/courier-cargo-target"
   ```

   The scripts find the build folder with `cargo metadata`, wherever it is.
3. `cd app && npm install`, then `npm run test:all` to check the setup (about 8 minutes).

The Google sign-in client isn't in the repository and never should be: each user makes their own (see
`SETUP-GOOGLE.md`) and pastes it into Settings ▸ Accounts, which keeps it in the Keychain. The tests don't need
one; they run against local fake servers.

## Everyday commands (in `app/`)

```bash
npm run tauri dev     # the app with hot reload
npm run dev           # the UI alone in a browser at /browser-preview.html (native side stubbed by dev/tauri-mock.ts)
npm run typecheck     # after every change
npm test              # Vitest
npm run test:rust     # Rust tests against fake Gmail API, IMAP and SMTP servers
npm run test:e2e      # the debug app runs real UI flows against the fakes in a background window
npm run format -- <files>   # prettier --print-width 160, on files you touched
```

End-to-end options: `COURIER_E2E_ONLY=word,word` runs only the steps whose names contain those words (after the
account setup), `COURIER_E2E_SKIP_BUILD=1` reuses the last debug build, `COURIER_E2E_DIR=<dir>` keeps the report,
app log and throwaway data there.

## Rules this project keeps

- **Clean room.** No Google code, CSS, JavaScript, icons, logos, illustrations or wording. The web client was only
  observed at runtime and measured into `research/look/LOOK-SPEC.md`; the look is re-created from that.
- **Tests never touch a real mailbox.** The Rust tests and the e2e run use the fakes in
  `app/src-tauri/src/testsupport/`, an in-memory key store and a throwaway data folder.
- **Automated runs never take focus.** `scripts/e2e.sh` launches the app with `open -g -n`, the app counts any
  activation and fails the run, and the script watches the frontmost app by process id. If you change how the app
  launches or shows windows, run the e2e and check its last line says it never came to the front.
- **Bugs get a failing test first**, committed before the fix ("Failing repro: …"), then the smallest fix.
- **Failures are said in words.** `errorText` (app/src/ipc/api.ts) turns error kinds into sentences; raw server
  text goes to the log only. The e2e run fails if any toast shows raw error text.
- **Before every commit:** typecheck, the suites you touched, and `tools/scan-secrets.sh` (it refuses OAuth
  clients, tokens, keys and the recon account's address).
- **Never commit captures of a real mailbox.** `research/goldens/`, `research/captures/` and
  `research/look/raw/` are gitignored for that reason.

## Releasing

1. Bump the version in `app/package.json`, `app/src-tauri/Cargo.toml` and `app/src-tauri/tauri.conf.json`
   (Cargo.lock follows on the next build).
2. `npm run package` builds the arm64 release, signs it ad hoc and writes `Courier-<version>-arm64.dmg`, `.zip` and
   `.sha256` into `release/` (gitignored), after checking both.
3. Commit, tag `v<version>`, push, and publish with `gh release create v<version> release/Courier-<version>-arm64.dmg
   release/Courier-<version>-arm64.zip --title "Courier <version>" --notes-file <notes>`. The notes say what was
   fixed and added, the known limitations (kept in step with the README), the test counts and the SHA-256 sums.
4. To install: quit Courier, replace `/Applications/Courier.app` with the new one. Because builds are signed ad hoc,
   macOS asks once for the Keychain password after each update (Always Allow).

Each round also ends with a `research/VERIFY-P<n>.md` and an updated status in `PLAN.md`.

## Where Courier keeps things on a Mac that uses it

These belong to the installed app, not to building it; don't delete them unless you mean to sign out of everything.

- `~/Library/Application Support/com.milappatel.courier/`: the mail cache (`courier.db`, SQLite) and settings.
- `~/Library/Logs/com.milappatel.courier/courier.log`: sync, sign-in and action log (no subjects, addresses or
  message text). Read it first when something goes wrong.
- The login Keychain, service `com.milappatel.courier`: sign-ins and the Google client, in one item (`vault-<n>`;
  `vault.json` in the data folder says which generation is current, so an update re-saves it once).

## Lessons worth keeping

- **Gmail API**: it now and then refuses a request with `400 failedPrecondition` and accepts the same one a moment
  later (retried); `403 userRateLimitExceeded` / `429` mean wait and retry, not offline. Snooze, mute, schedule send
  and star types don't exist in the API and are kept locally.
- **Label changes**: the cache applies a change at once and keeps it over anything read from the server until the
  server has it (`Db::begin_change`/`end_change`); offline it waits in `change_queue` and goes out at the next sync
  (`Engine::flush_queue`).
- **IMAP**: async-imap takes a response stream that just ends as a complete answer; `MaybeTls` turns end-of-stream
  into an error so a server that hangs up is "offline", never "done". Message ids carry the folder and UID, so a
  move changes them.
- **WebKit**: listeners don't run inside the script-free message frame (clicks, keys), so those go through native
  handlers; resize events are deferred while the test window is covered (`applyViewportSize()` after resizing).
- **Settings**: `mergeSettings` drops keys missing from `DEFAULTS`, so a new setting needs a default or it's lost on
  restart.
- **macOS focus**: tao still activates the app at launch; an app started from a process under the active app can be
  handed activation. Launch with `open -g -n`, order the window back, and count `NSApplicationDidBecomeActive`.
  Parse the frontmost app with `lsappinfo info "$(lsappinfo front)"`. Never edit a bash script while it runs.
- **Recon** (only needed to measure the web client again): the measurements are in `LOOK-SPEC.md`; the tools in
  `research/tools/` drive an isolated Chrome profile over CDP at 127.0.0.1:9222. The original recon profile and the
  redacted screenshots were never committed, so new measurements need a new throwaway account and profile.
