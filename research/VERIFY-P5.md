# VERIFY P5 — the Mac side

Scope: menus, Dock badge, notifications (per account and label), `mailto:` handler, Quick Look, drag-out, `.eml`
open, Share menu, sleep/wake, offline mode and the outbox, VoiceOver labels, full keyboard use.

## How it was checked

| What | How | Result |
| --- | --- | --- |
| Notifications: new Primary mail notifies, Promotions doesn't (default "Primary only"); muted threads don't | `tests/engine.rs::snooze_mute_block_filters_and_notifications`; end-to-end "notifications" (the e2e notifier records instead of showing) | pass |
| Dock badge count = unread conversations in Primary (all accounts) | Rust `db::inbox_count_covers_primary_only`; the badge calls the same query | pass |
| Offline: a send fails over, waits in the Outbox (nav shows Outbox), the app shows offline, and goes out as soon as the connection is back | end-to-end "offline" (fake Gmail returns 503 while "offline") | pass after the fixes below |
| App menu → ⌘1/⌘2 account switching | end-to-end (menu events) | pass |
| The end-to-end window never takes focus | `scripts/e2e.sh`: launched with `open -g`, window ordered to the back, App Nap and throttling off; the app counts activations (`NSApplicationDidBecomeActiveNotification`) and reports `NSRunningApplication.isActive` after every step; the script watches the frontmost app | see below |
| Printing never happens in tests | `print_window` is a no-op under `COURIER_E2E` and `COURIER_NO_PRINT` | by construction |

### Focus

The first runs showed that Courier *did* become the active app: tao asks AppKit to activate the app at launch,
and an app started from a process under the active app may be handed activation. The script's frontmost-app watch
didn't notice because it mis-parsed `lsappinfo` output (the app's own `isActive` check did). Fixes:

- the script launches the app with `open -g -n` instead of running the binary;
- in end-to-end mode the window is ordered behind all others, and if macOS activates Courier anyway the app hides
  and unhides itself without activation (handing focus straight back) and counts it, which fails the run;
- the frontmost-app watch now parses `lsappinfo info` correctly.

After these changes the run reports zero activations and the watch never sees Courier in front.

## Fixed in this pass

- Gmail 429/5xx responses that outlast the retries are treated as "no connection", so the outbox keeps the message.
- Reconnecting retries waiting sends at once instead of after their backoff.

## Known gaps

- `mailto:` links, opening `.eml` files, Quick Look, drag-out, the Share menu and sleep/wake are wired up (Info.plist
  associations, deep-link plugin, `qlmanage`, `NSSharingServicePicker`, `NSWorkspaceDidWakeNotification`) but not
  driven by the automated run, since each needs another app or the system UI. Checking them by hand in the
  installed app is part of the final real-account check.
- VoiceOver: controls carry labels (`aria-label`, roles, live toasts); no VoiceOver walk-through was done.
