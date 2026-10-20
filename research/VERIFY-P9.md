# VERIFY P9 — 1.0.5

Scope: another round of parity work and bug hunting after 1.0.4.

## Added

| Feature | How it works | Checked by |
| --- | --- | --- |
| Clicking a notification opens that conversation (in its account; a summary opens the inbox) | Notifications go through `mac-notification-sys` with a click wait on a background thread (at most 16 waiting); a click delivers an `open-item` of kind `thread` | e2e "a clicked notification opens its conversation" (drives the same event; a real click can't be automated) |
| Calendar invitations: an event card with what, when (in your time zone), where and who; Yes / Maybe / No; Add to Calendar | `core/ical.ts` reads iCalendar (folding, escapes, TZID incl. Windows zone names, all-day) and writes an RFC 5546 REPLY sent as a `text/calendar; method=REPLY` alternative; Add to Calendar opens the `.ics` in the Mac's calendar app | Vitest `ical.test.ts` (5), e2e "calendar invitations" (the reply reaches the organizer with PARTSTAT=ACCEPTED and the event's UID) |
| Drag a conversation from the list onto a new message to attach it (as `.eml`) | Compose accepts the list's drag data and adds the latest message of each conversation as `message/rfc822` | e2e "a conversation dragged from the list" |
| Filters: export and import (the web client's XML format), edit, select all, delete several | `core/filtersxml.ts`; imported labels are matched by name or created; editing replaces the filter (the API can't change one) | Vitest `filtersxml.test.ts` (2), e2e "filters: import a filter file, edit one, export and delete them" |
| Links to a spot in the same message (`href="#…"`) scroll the conversation there | The sanitiser rewrites them to a reserved `.invalid` address; the native new-window handler turns it into a scroll | e2e "a link to a spot in the same message" |
| Recent searches in the search box | The last ten searches, newest first, offered on an empty box and while typing | e2e "the search box offers recent searches" |

## Fixed

- The details box ran past the right edge on a phone-width window for a message with many recipients (an old
  `max-width: 560px` later in the same rule overrode the new cap). It now never outgrows the message column.
- The layout check now also flags any popup (menus, cards, compose, details) cut off by the window or by the
  scrolling box it sits in; the e2e run seeds awkward mail (a 300-character subject, a very long sender name, an
  unbroken word, right-to-left text, 60 recipients) and checks it at 1280 and 420 px.
- After a search, the search box's late "lost focus" timer could hide the suggestions when you clicked straight
  back into it.
- The filter page's headings no longer use the web client's wording.

## Known gaps

- The compose window's More ▸ Label (apply labels to the sent conversation) isn't there yet.
- Notification buttons (Archive, Reply in the banner) aren't offered.
