# VERIFY P10 — 1.0.6

Scope: three bugs the user hit in daily use of 1.0.5 (a flash when deleting, "400: Precondition check failed"
on mass delete, unsubscribe by email), the follow-ups they reported during the round (mail that seemed to
come back, the label settings, Manage subscriptions and All Mail "popping up and disappearing"), and another
hunt for differences from the web client. Method: pstack's bug-fix playbook (reproduce on the real surface,
find the mechanism with runtime evidence, smallest fix, failing repro committed before the fix) and an
autonomous run for the hunt.

**Exit condition for the hunt** (written before it started): every surface on the list has been exercised
and compared with the web client; each difference is fixed with a test or listed below as a gap with its
reason; `npm test`, `npm run test:rust` and the full end-to-end run pass, including the flash probe and the
raw-error check.

## How it was checked

- **The real surface**: the in-app end-to-end runner in a background WebKit window that never takes focus,
  against the fake mail API and IMAP/SMTP servers. The fakes can now take time per route (a change takes
  ~700 ms on the real API), answer with the API's own `400 failedPrecondition` body (once, or for named
  ids), fail a route on demand, and seed old mail the cache never saw.
- **A frame recorder** (`src/e2e/frames.ts`) samples the list on every animation frame, every 8 ms and every
  DOM change during an action, and reports any row that comes back, rows taken out and put back, the loading
  bar or an empty list, a count that goes back, a blank conversation pane, or a background change.
- **A button sweep** presses every button and menu item (list toolbar, conversation, message, row menu,
  header, help, label menu, compose) and requires each to do something visible, throw nothing and show no
  raw error text; the whole run also fails if any toast ever shows raw error text.
- **The web client** observed with REA/CDP in the recon profile (observe only; dialogs opened and
  cancelled): the Unsubscribe dialogs from a message header and from Manage subscriptions, the Manage
  subscriptions page, the Trash and Spam banners (measured), Settings ▸ Labels defaults, the menu's More
  section, and its own UI strings for states that can't be triggered without changing the account.
- **The user's cache**, aggregate read-only queries only (counts by label, header shapes); nothing read
  from message content.

## Findings

| # | Issue | Evidence | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | Deleting flashed the row back (all four ways on Gmail; from the open conversation on IMAP too) | Frame recorder: 18 flashes, e.g. "row came back at +451 ms", "1–20 of 20 → 1–19 of 19 → 1–20 of 20". Mechanisms: list results fetched before the change landed cleared the optimistic hide (a server listing during the 700 ms batchModify; closing the conversation reloaded the cache before the change reached it) | Rows an action hides stay hidden until a listing fetched after the action finished; the page count leaves them out (`4226b1c`) | e2e "deleting never flashes…" (16 deletes, failing → passing) |
| 2 | A sync during a pending change put the old labels back (deleted mail back in the Inbox for a moment) | e2e: row back at +804 ms from the open conversation; Rust: labels `["INBOX","UNREAD","STARRED"]` after the sync | The cache remembers pending label changes and applies them on top of anything read from the server; server counts for those labels wait (`d82e7a6`) | Rust `a_sync_while_a_change_is_on_its_way_keeps_the_change` |
| 3 | A refused change rolled back to labels the mail never had (a failed delete of labelled mail showed it in Inbox *and* Spam) | Rust: `["Label_1","INBOX","SPAM"]` after the rollback | A refused change undoes only what it did (`d82e7a6`) | Rust `a_refused_change_rolls_back_to_exactly_what_was_there` |
| 4 | Mass delete said "400: Precondition check failed." and stopped | The toast text is `Error::Server("{status}: {msg}")`. The log had no record (actions weren't logged). Gmail answers `400 failedPrecondition` intermittently (upstream reports at ~1–2 % of requests; a production Gmail client retries it with short backoff); one refused batch failed the whole bulk delete | Retry `failedPrecondition` three times with backoff; whole-view actions keep going past a refused batch and count conversations done and not done; Delete forever drops from the cache what the server deleted batch by batch (`e6baf6f`) | Rust `a_passing_precondition_failure_is_retried_not_shown`, `bulk_delete_goes_on_past_a_refused_batch`, `delete_forever_in_bulk_goes_on_past_a_refused_batch`; e2e "deleting when the server refuses…" |
| 5 | Raw API/library text on screen (toasts, Settings ▸ Accounts sync error, adding an account, opening an .eml) | e2e: Settings showed "server: 400: Bad Request"; every `Couldn't …: ${errorText(e)}` passed the server's words through | `errorText` turns kinds into sentences; every failure says what failed ("Couldn't move the conversation to Trash. The mail server didn't accept the request.") with Try again where safe; add-account explains a refused password or unreachable server (`e6baf6f`, `9eff09b`, `7449428`) | Vitest `errors.test.ts`; e2e "a sync that fails says why…", wrong-password check, run-wide "no toast showed a raw error" |
| 6 | Unsubscribe mailed senders that offer one-click, with vague wording | Recon: the web client's dialogs ("Do you want to stop getting messages from this mailing list (X)?"; "…from all mailing lists from X (address)?"; the mailto branch names the address; website-only → Go to website) and its toast "Unsubscribed from this mailing list." | One-click (RFC 8058) POST from its own client (no cookies, 15 s, ≤5 https-only redirects, never to this Mac or the LAN, 2xx only), else an email from the account, else the website; list vs sender scope; sender scope covers each of the sender's lists; "Unsubscribed" state in the message and the page; encoded-word headers read (`fc24d1d`) | Rust one-click tests (body, headers, no cookies, redirect, failure wording, timeout, private hosts), `unsubscribing_from_a_sender_covers_each_of_their_mailing_lists`; Vitest `unsubscribe.test.ts`; e2e "unsubscribe as the web client does…" |
| 7 | Opening a cached conversation waited for the server | e2e: 846 ms to show with an 800 ms server | A fully cached conversation shows at once; the server is asked in the background; the row's subject holds the place for the few ms until the messages arrive (`9ac9653`) | e2e "opening a conversation that's on this Mac shows it at once…" |
| 8 | Auto-advance (newer/older) jumped to the top of the list | e2e: the next conversation never opened; the action hid the open conversation before stepping | Step from the conversation's own place, skipping hidden rows; the keyboard cursor counts shown rows (`9eff09b`) | e2e "archiving with e moves on to the next conversation…" |
| 9 | Report spam on list mail didn't offer to unsubscribe | Recon strings: "Report spam or unsubscribe?" / Report spam / Unsubscribe | Same dialog and choices (`7449428`) | e2e "reporting list mail as spam asks whether to unsubscribe as well" |
| 10 | No Trash/Spam banner | Recon (measured): "Messages that have been in Trash more than 30 days will be automatically deleted. Empty Trash now", 48 px, grey band | Same banner (30-day line for mail-API accounts only) (`7449428`) | e2e "Trash and Spam say what happens to their mail…" |
| 11 | "A strange 100 emails" / rows that come and go after a cleanup | Gmail web shows the recon account completely empty (Inbox, tabs, All Mail, Sent, Drafts, chats, Spam, Trash, `in:anywhere`); the phone app's stragglers are its own stale copy. In Courier: a full resync (history too old) only added mail, never removed what the server had deleted or refreshed what moved; the cached page could list conversations the server no longer did | A full resync asks the server about every cached message; a server page that no longer lists a cached conversation triggers a check of it; a short cached page isn't called empty until the server answers (`650dca8`, `72a49ed`) | Rust `a_full_resync_drops_mail_deleted_on_the_server_and_refreshes_what_moved`, `a_server_listing_corrects_cached_conversations_it_no_longer_shows`; e2e "a label whose mail is older than this Mac keeps…" |
| 12 | Actions weren't logged, so the reported trouble couldn't be traced | `courier.log` from 1.0.5 had only startup and sync lines | Every action logs what, how many, label ids and the outcome; refused API requests log status and reason; never subjects, addresses or text (`650dca8`) | Rust build; seen in e2e app logs |
| 13 | Settings ▸ Labels (show / hide / show if unread) did nothing and wasn't remembered | The menu read fixed lists; `mergeSettings` dropped the unknown `systemLabels` key on restart | The menu follows the setting with the web client's defaults (Important, All Mail, Spam, Trash under More; Scheduled shows while something is scheduled); Manage subscriptions under More as in the web client (`72a49ed`) | e2e "Settings ▸ Labels: show, hide and show if unread…"; Vitest round trip |
| 14 | Manage subscriptions rows came and went while open | The page reloaded and re-sorted on every background change | Reads once when opened, like the web client's page (`72a49ed`) | e2e "manage subscriptions…" (rows hold still while mail arrives) |
| 15 | A dark theme started light (every launch and pop-out window) | Browser preview: first render `rgb(248, 250, 253)`, after init `rgb(17, 17, 17)` | The last theme goes on in `index.html` before the first frame (`fce38cb`) | Preview measurement: first render `dark rgb(17, 17, 17)` |
| 16 | Undo after Mute left the conversation archived | Button sweep: the target never came back to the Inbox | Undo puts back what Mute took out of the Inbox (`7265541`) | e2e button sweep |

## Known gaps and limitations

- **Phone app stragglers**: the web client and the API agree the recon account is empty; what a phone shows
  from its own cache is outside Courier.
- **Gmail's Purchases category**: the API exposes no `CATEGORY_PURCHASES` label, so Courier can't show it.
- **Queued actions offline**: label changes made offline fail with "You're offline." and Try again; they
  aren't queued like sends are.
- **The Unsubscribe follow-up states** (toast, the message's state) follow the web client's own strings;
  the account wasn't actually unsubscribed from anything to watch them, per the observe-only rule.
- **The real API's `failedPrecondition`**: the exact request that failed in the user's run couldn't be
  observed (no logging in 1.0.5, and tests never touch a real mailbox). The retry and partial-failure
  handling cover it whatever the cause; the log now records it if it happens again.
- **e2e focus**: two runs this round saw macOS activate the background test app while someone was using the
  Mac (once right after the recon Chrome jumped to the front). Runs with nobody at the Mac never saw it.
