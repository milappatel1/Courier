# VERIFY P6 — snooze, schedule send, multiple inboxes, unsubscribe, print, show original

## How it was checked

| What | How | Result |
| --- | --- | --- |
| Snooze presets as the web client offers them (Later today, Tomorrow, This/Next weekend, Next week, Pick date & time) | Vitest `core.test.ts › dates` | pass |
| Snooze: Gmail loses INBOX on the server, the thread lists under Snoozed, comes back to the top of the Inbox at its time (with a notification) | `tests/engine.rs::snooze_mute_block_filters_and_notifications`; end-to-end "snoozes until tomorrow…" (snooze from the row, unsnooze from the conversation's More) | pass |
| Schedule send: preset → listed under Scheduled with its time, not sent early; sending from there delivers it | `tests/engine.rs::undo_send_scheduled_send_and_offline_outbox`; end-to-end "schedules a send…" | pass |
| Unsubscribe: RFC 8058 one-click POST to an HTTPS link; refuses anything that isn't HTTPS (in release builds the local exception doesn't exist) | `tests/engine.rs::one_click_unsubscribe_posts_and_refuses_plain_http`; Vitest `unsubscribe and mailto` (one-click → mailto → link preference) | pass |
| Unsubscribe by email when the sender only offers one-click over plain HTTP (the fake) or a mailto: | end-to-end "Promotions tab…" (the request goes to the `mailto:` address with its subject) | pass after the test fix below |
| Remote images held back until "Display images", tracking pixel stripped before and after, frame sandboxed without scripts | Vitest `sanitize.test.ts`; end-to-end "Promotions tab…" (reads the frame's `srcdoc` and `sandbox`) | pass |
| Show original / download message: parsing and headers | Vitest `mime.test.ts` | pass |
| Print | the print view is built; printing itself is never triggered in tests (`print_window` is a no-op under `COURIER_E2E`/`COURIER_NO_PRINT`) | not printed, by design |

## Fixed in this pass

- `unsubscribe_one_click` accepted `http://127.0.0.1…` in every build; the exception is now limited to debug/test
  builds (the UI already refused non-HTTPS one-click links).
- The end-to-end check compared the fake's `to` list as a string; it now matches the address.

## Fixed after the release

- Opening the "N older messages" fold in a long conversation did nothing (the flag it set was never read); it now
  lists every message (unit test + end-to-end step with a 12-message thread).

## Known gaps

- Multiple inboxes and Priority Inbox are built on the same list queries but weren't driven end to end or compared
  with a golden (none was captured).
- Snoozed and scheduled mail need Courier running at the time (local feature; the Gmail API has neither).
