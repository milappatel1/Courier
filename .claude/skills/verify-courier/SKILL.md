---
name: verify-courier
description: Drive Courier (the macOS mail app in this repo, a Tauri 2 + React clone of the web mail client) the way a user does and capture proof. Use when you change anything a user can see or do in Courier, when a bug report needs reproducing on the real UI, or before saying a fix works. Covers the in-app end-to-end runner against local fake mail servers (background window, never takes focus), the browser preview, and the recon test build against the real mail API on the throwaway recon account.
---

# Verify Courier

Courier has three surfaces you can drive. Pick the one that reaches the behaviour; never drive the user's own
Courier (`/Applications/Courier.app`) or their real mailboxes.

| Surface | What it is | Use it for |
| --- | --- | --- |
| **e2e runner** (default) | The debug app started with `COURIER_E2E`: real UI and real Rust engine against in-process fake mail servers (`app/src-tauri/src/testsupport/`), a throwaway data folder and an in-memory key store, in a window that never takes focus. Steps live in `app/src/e2e/run.ts`. | Anything end to end: actions, sync races, counts, compose/send, offline, layout, flashes (frame recorder). |
| **browser preview** | `npm run dev`, then `http://localhost:1430/browser-preview.html`; `app/dev/tauri-mock.ts` stands in for the native side. | Look and layout at any width when the user is in another app; quick UI checks. Not for sync or server behaviour. |
| **recon build** | The debug app with `COURIER_RECON=<recon address>`: its own data folder (`com.milappatel.courier.recon`), log and Keychain item; signs in **only** the recon account; logs each mail API request's time. | Real mail API behaviour and timings, seeded test mail (`seed`), listing consistency (`probe`). The user signs it in. |

Helper: `app/scripts/verify.sh` (`doctor`, `e2e <words>`, `e2e-all`, `recon [seed|probe N]`, `cleanup`).

## Launch

- **e2e runner:** `cd app && scripts/verify.sh e2e <words>` builds the debug app (3–10 min on a busy Mac; run it in
  the background), launches it with `open -g -n`, runs the five account-setup steps plus every step whose name
  contains one of the words, and quits. Ready = the `[e2e] starting N steps` line. Set `COURIER_E2E_SKIP_BUILD=1`
  to reuse the last build when only the runner's own expectations changed — never after editing app code.
- **browser preview:** `preview_start` with name `courier-preview` (`.claude/launch.json`), or `cd app && npm run dev`.
  Ready = Vite's `Local: http://localhost:1430/`. Open `/browser-preview.html`.
- **recon build:** `cd app && scripts/verify.sh recon` (add `seed` to insert the invented test mail, `probe 3` to
  measure listing consistency). Needs the recon Chrome profile signed in (`~/.courier-recon-chrome`). First run:
  the user signs it in (Add account ▸ Google) and may be asked to let it read Courier's Keychain item (it copies
  only the Google sign-in client).

## Doctor

`cd app && scripts/verify.sh doctor` — read-only. It prints the repo revision and changed files, the debug build
and when it was built, whether the user's installed Courier is running (leave it alone), any e2e or recon
instance, the preview port and the recon Chrome. If the debug build is older than your last edit to `app/src` or
`app/src-tauri/src`, rebuild before trusting a run.

## Drive

- **e2e:** write or extend a `step("…", async () => { … })` in `app/src/e2e/run.ts`. Handles are `data-testid`s
  (`thread-row` with `data-thread`, `hover-delete`, `hover-archive`, `row-checkbox`, `tb-delete`, `conv-delete`,
  `conv-back`, `tab-<category>`, `nav-<LABEL_ID>`, `nav-more`, `settings-gear`, `see-all-settings`,
  `settings-tab-<name>`, `sys-<ID>-<show|hide|show-if-unread>`, `search-input`, `compose`, `compose-to`,
  `compose-subject`, `compose-body`, `compose-send`, `toast`, `toast-action`). Server-side setup and checks go
  through `api.e2eControl(action, args)`: `deliver-gmail`, `deliver-imap`, `seed-gmail-old`, `sync`, `state`
  (the fake server's messages and labels), `offline`, `gmail-behaviour` (per-route `latency`, read `tail`
  latency, `searchLag`, `labelLag`, `failRoutes`, `preconditionNext`, `imapMoveLatency`), `big-accounts` (extra
  accounts with thousands of conversations, syncing), `traffic` (mail arriving), `extra-labels`.
- **Flashes:** wrap the action in `recordFrames()` / `flashes(rec.stop(), goneIds, {conversationOpen})` from
  `app/src/e2e/frames.ts`. A failure names the listing that put a row back and what happened just before; the
  run's `app.log` has `[trace]` lines for every cache write that moved a message into or out of the Inbox, with
  the code location.
- **Preview:** Browser pane tools (`read_page`, `find`, `computer`, `resize_window`), same `data-testid`s.
- **Recon:** observe only through its log (`api … ms` lines, `probe …` lines) and the recon Chrome over CDP
  (`research/tools/cdp-eval.mjs`, `cdp-do.mjs`; REA's `capture_web_screenshot`, `inspect_web_page`). Its window
  is the user's to click.

## Evidence

- e2e: `~/Library/Caches/courier-verify/<run>/` holds `summary.txt`, `report.json` (every step, its time, failure
  text and a UI snapshot), `app.log` (the app's log and `[trace]` lines) and `build.log`. The run's last line must
  say the app was never active and the frontmost-app watch never saw it in front.
- Proof standard: drive the user's path (a click on `hover-delete`, the `#` key), not a store setter; check the
  result on screen **and** on the server (`state`, `extra-labels`); for anything timing-related, the frame
  recorder's verdict, not a final-state check.
- Captures of the web client go to `research/goldens/` (gitignored) only after redaction (`research/tools/redact*`).
  Never capture the user's mailbox.

## Cleanup

`cd app && scripts/verify.sh cleanup` stops only the instances this script started (pids in
`~/Library/Caches/courier-verify/started.pids`). The e2e runner quits by itself. Evidence stays.

## Rules that bite

- Never take focus: launch with `open -g -n`; the e2e run fails if macOS ever activates the app.
- Never run `cargo fmt` over the crate (the Rust code is hand-formatted); `rustfmt` only new files.
- Use a separate `CARGO_TARGET_DIR` (e.g. `~/Library/Caches/courier-test-target`) for `cargo test`/`check`, so they
  don't invalidate the e2e build's artifacts and force a full rebuild.
- Don't edit `app/src` while an e2e build is bundling the frontend, or `app/src-tauri/src` while it compiles the
  `courier` crate: the build picks up half an edit.

## Features

See `features/README.md` for the verification map, one file per user-facing feature.
