# Counts

Every number Courier shows means what the web client's does: the Inbox count is conversations whose Inbox mail is
unread in Primary (starred ones too when Primary includes them); a category or label in the menu counts every
unread conversation in it, archived ones included; an Inbox tab's "N new" counts only unread mail that arrived
since the tab was last opened; the page count is the view's conversations.

## Sub-features

- `count-inbox` the Inbox number (and the Dock badge).
- `count-label` user labels, Spam, Drafts, and categories when Settings ▸ Labels shows them.
- `count-tab-new` "N new" and the senders under each Inbox tab; cleared by opening the tab.
- `count-categories-visibility` categories hidden from the menu by default; Settings ▸ Labels ▸ Categories.
- `count-settle` after any action the numbers equal the server's and never go back.

## How to get to it (user POV)

- Read the menu on the left and the Inbox tabs; Settings ▸ Labels ▸ Categories ▸ show/hide.

## Driving it with the e2e runner

Preconditions:

- `pat@example.com` Inbox, Primary tab.

- **Tab news.** Deliver `deliver-gmail` with `labels: ["INBOX","UNREAD","CATEGORY_PROMOTIONS"]`. `tab-promotions`
  shows `1 new` and the sender's name. Open the tab and come back: the chip is gone.
- **Category in the menu.** Settings (`settings-gear`, `see-all-settings`, `settings-tab-labels`),
  `sys-CATEGORY_UPDATES-show`. `nav-CATEGORY_UPDATES` appears above More with the number of unread Updates
  conversations on the server (count thread ids from `state`, excluding Trash and Spam).
- **Inbox count.** Compare `nav-INBOX`'s `.nav-count` with the server's unread Inbox conversations outside the
  enabled tab categories.
- **Proof.** The step "counts mean what the web client's do" passes.

## Gotchas

- Mail seeded into the real recon account with messages.insert and `CATEGORY_UPDATES` shows in the web client's
  Updates *label* but not its Updates *tab* (it skips the web client's own classifier); use Promotions or Social
  for tab checks against the web client.
- A tab never opened on this Mac starts from "now", so mail that was already there isn't news.
