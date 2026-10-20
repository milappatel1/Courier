# VERIFY P8 — 1.0.4

Scope: the details box that stayed put while a message scrolled (reported by the user), and a bug hunt over the
rest of the app.

## Fixed

| Problem | Cause | Fix | Checked by |
| --- | --- | --- | --- |
| The "to me ▾" details box stayed where it was drawn while the message scrolled | It was fixed to the screen at the position of the click | It now hangs inside the message header and scrolls with it | e2e "popups stay with what they belong to" (the gap to its link stays the same after scrolling 140 px) |
| Menus attached to buttons inside the conversation (message ⋮, emoji) stayed put while scrolling | Same: drawn at a fixed point | Menus follow their button and close once it scrolls out of sight; right-click menus close when the list scrolls; tooltips hide on scroll; the sender card follows the name | same e2e step |
| After clicking inside a message's text, keyboard shortcuts stopped working | Focus moved into the message frame, and WebKit never hands its key presses to the app | Focus returns to the app once the click is over (unless text is being selected to copy) | e2e "shortcuts keep working after a click inside a message's body" (the frame really takes focus first) |
| Settings ▸ General ▸ Send and Archive did nothing | Not wired | Replies get a Send and archive button | e2e "settings that change the list and replies" |
| Settings ▸ General ▸ Button labels: Text did nothing | Not wired | Toolbar buttons show words instead of icons | same e2e step |
| Settings ▸ General ▸ Personal level indicators did nothing | No data for it | Conversations carry whether they were addressed to you (›) or only to you (»); mailing lists get none | Rust `conversations_say_whether_they_were_sent_to_me_or_only_to_me`, same e2e step |
| Settings ▸ Inbox ▸ Include starred in Primary did nothing | Not wired | Primary includes starred mail from the other tabs, in the cache and on the server (`{category:primary is:starred}`) | Rust `starred_in_primary_and_the_auto_contacts_setting` |
| Settings ▸ General ▸ Create contacts for auto-complete did nothing | Not wired | When off, mail no longer adds new people (existing contacts still update) | same Rust test |
| Menu bar File ▸ Share… and Edit ▸ Paste and Match Style did nothing | Not wired | Share sends the open conversation's latest message to the Share menu; Paste and Match Style pastes the clipboard's plain text (tests use a fixed string, never the real clipboard) | e2e "menu bar" |
| The window always came back at 1280 × 800 | No frame memory | AppKit's frame autosave keeps the size and place between launches (not during tests) | by hand |
| A Rust test could fail when the background sync handled a blocked sender's mail first | The test asserted before the background move finished | It waits for the result | three runs in a row |

Also: Manage subscriptions follows the reference page's proportions (measured in the recon profile: a 48 px
title in 22 px type, a 40 px description line in 12 px, 86 px rows without dividers, a 40 px avatar, three 14 px
lines, a round icon button to unsubscribe). Every settings page is now swept for layout problems at 1280, 800
and 420 px by the e2e run.

## Known gaps

- Clicking a notification brings Courier forward but doesn't open that conversation (the notification plugin
  doesn't report clicks).
- In-message links to an anchor in the same message (`href="#…"`) don't scroll the conversation in WebKit.

Totals: Vitest 86, Rust 44 (+2 opt-in live checks), end to end 50 steps (~2.5 min); the run never takes focus.
