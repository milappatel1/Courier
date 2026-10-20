# VERIFY P7 — the real-use round (1.0.3)

Scope: everything the user hit after using 1.0.2 with real accounts, plus the feature checklist in
`research/GMAIL-PARITY.md`.

## What was wrong, and the fix

| Complaint | Cause | Fix | Checked by |
| --- | --- | --- | --- |
| Had to ask to display images every time | Images defaulted to "ask" | Default is "always" (trackers are still stripped); "ask" stays in Settings ▸ General | e2e "real-world mail" (images shown, pixel gone, no banner), "Promotions" (ask mode still works) |
| Some mail cut off, some grew forever | Newsletters sized to `100%`/`100vh` grew with their own frame; wide tables were clipped | viewport units become fixed sizes, `:root` heights forced to auto, an exact height measurement with a growth guard, sideways scrolling inside the frame | e2e "message frames" (page-height mail settles under 1500 px; the last line of a 150-paragraph mail is inside the frame; a 1400 px table scrolls sideways and the window doesn't), Vitest sanitiser tests |
| Links didn't open | WebKit doesn't run the app's click listener inside a script-free frame, so link clicks did nothing | Frames may open pop-ups; the native new-window and navigation handlers send every outside link to the default browser (`mailto:` opens Courier's compose) | e2e "links" — in WebKit the click goes through the native new-window path; opened exactly once; the message stays |
| PDFs opened in `qlmanage` | Attachment click ran Quick Look's debugging tool | Click opens the file in the app the Mac uses for it (`open_path`); `qlmanage` is gone | e2e "attachments" |
| Downloads asked where to save | A save dialog | Straight into ~/Downloads, browser-style names (`plan (1).pdf`), "Show in Finder" | e2e "attachments", Rust `tests/files.rs` |
| No trackpad swipes | Tauri doesn't expose WebKit's back/forward gesture | Turned on natively (`allowsBackForwardNavigationGestures`); two-finger swipe across a row archives it (configurable) | e2e "two-finger swipes" (the web view setting read back; a swipe archives on the server; Undo; history back/forward) |
| Label counts stale after deleting until restart | After an action the app overwrote every count with numbers from its partial cache, and only re-read real counts if the next sync noticed | Counts move at once (from before/after snapshots of the conversations touched), then the server's counts for exactly those labels are read; every history change refreshes the labels it touched, cached mail or not; a failed read keeps the old numbers instead of zeros; the full list is re-read every 10 minutes | Rust `label_counts_follow_actions_and_changes_made_elsewhere`, e2e "select all" (nav count 60 → 2 without a restart) |
| No mass delete | "Select all N conversations" only covered cached mail (about 30 days) | Whole-view actions run on the server: every page, Gmail `messages.list` + `batchModify` in 1000s, IMAP `UID SEARCH ALL` per folder; untick rows to keep them; "Delete all except selected"; confirmation, progress and Undo | Rust `select_all_in_a_view_reaches_uncached_mail_and_keeps_the_unticked`, e2e "select all" (58 of 60 trashed, including mail older than the cache) and "delete all except selected" |
| No way to unsubscribe in bulk | — | Manage subscriptions page: senders with an unsubscribe option, mail counts, one-click/mailto/link unsubscribe, "move all their mail to Trash" | Rust `manage_subscriptions_lists_senders_with_an_unsubscribe_option`, e2e "manage subscriptions" |
| Overlapping parts when the window is resized | One fixed desktop layout down to 760 px; tabs, badges and the sender column collided | Three sizes: wide, rail (700–1023 px) and the phone app's layout (< 700 px, down to 380 px); WebKit-specific grid fix | e2e "fits every window size" (1440, 1280, 1024, 900, 760, 600 and 420 px × inbox, conversation, subscriptions, settings: no overlaps, nothing past the edge, no sideways page scroll) and "phone width" |
| Scribe's "Email this file" went to Mail | Scribe used the system Mail sharing service | Scribe hands the file to the default mail app; Courier turns files it's given into a new message with them attached, and offers once to be the default mail app | e2e "files handed to Courier"; Rust `open_tests` |

Found during the bug hunt and fixed: with a photo or colour theme (Plum), the slide-out menu used the light
default background behind light text; it now uses the theme's backdrop. Added: a people picker behind the To /
Cc / Bcc labels, a sender card on hover, the rail sliding out on hover, WebKit's own downloads saving to
Downloads, and compose windows folding when the window is too narrow for them (each with an e2e step).

Also: a right-click menu on every row (reply, forward, archive, delete, read, snooze, move, label, mute, find
mail from the sender or with the subject, open in a new window), category counts in the nav, and several
sentences reworded where they matched the web client's text.

Also caught by the run's focus check and fixed: when another app handed Courier a file, Courier brought its
window forward even during tests (it now does that only for real use). The run itself never takes focus: the app
reported it was never the active app, and the frontmost-app watch never saw it in front.

Totals: Vitest 86, Rust 42 (+2 opt-in live checks), end to end 45 steps (~90 s).

## Disk space

Google Drive backs up ~/Downloads, where the project lives; every Rust build rewrote thousands of files, which
Drive staged in ~/Downloads/.tmp.driveupload (67 GB at the time). Cargo now builds into
~/Library/Caches/rea-cargo-target (a `.cargo/config.toml` outside the repository); the scripts ask `cargo
metadata` where the build is.

## Known gaps

- A real trackpad swipe and a real mouse click can't be sent by the automated run (it never takes focus); the
  run drives the same paths (wheel events, the web view's setting, synthetic clicks that WebKit routes through the
  native new-window handler).
- Opening files in their apps, Finder and the default-mail-app prompt are recorded, not performed, during tests.
