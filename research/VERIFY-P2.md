# VERIFY P2 — compose

Scope: compose windows (stacked, minimise, pop-out, full screen), rich text, attachments and inline images,
Cc/Bcc and autocomplete, aliases, signatures, templates, plain-text mode, spell check, drafts autosave, send, undo
send, reply / reply all / forward (inline and as attachment).

## How it was checked

| What | How | Result |
| --- | --- | --- |
| MIME: plain, HTML + attachments + inline image (multipart/related with Content-ID), Unicode names (RFC 2047/2231), quoted-printable/base64, Bcc kept only for the Gmail API, forward as `message/rfc822`, RFC 5322 dates | Vitest `mime.test.ts` (build → parse round trips, real-world shapes) | pass |
| Reply / reply-all recipients, `Re:`/`Fwd:` subjects, quote and forward blocks, References chain | Vitest `core.test.ts › compose helpers` | pass |
| Compose window geometry: 559 × 525 at (660, 187), header 40, To row 37, Subject 40, body at y 317, Send 72 × 36 + 33 px menu at (676, 663), toolbar icons 32 apart, discard at 1183 | browser preview, measured against `raw/compose.json` and `goldens/compose-new` | all 0 px |
| Inline reply, threaded on the server with In-Reply-To/References, sent after the 5 s undo window | end-to-end "replies inline" | pass |
| Forward keeps the original attachment and the forwarded-message block | end-to-end "forwards with the original attachment" | pass after the fix below |
| Attachment + inline image from the file pickers, sent as related part with a `cid:` reference | end-to-end "composes with an attachment and an inline image" | pass |
| Signature created in Settings, made the default for new mail, inserted in a new message | end-to-end "signatures" | pass |
| Drafts on both account kinds (server drafts on Gmail, APPEND to Drafts on IMAP) | `tests/engine.rs::drafts_on_both_kinds` | pass |
| Undo send, scheduled send, offline outbox | `tests/engine.rs::undo_send_scheduled_send_and_offline_outbox` and the end-to-end steps | pass |
| IMAP reply over SMTP, Bcc removed from the data, copy appended to Sent | end-to-end "IMAP: reply goes out over SMTP", unit `bcc_is_stripped_and_rules_expand` | pass |

## Fixed in this pass

- Compose was 540 wide (the reference window is 559), fields 3 px high, Send 3 px high, toolbar icons 36 px apart.
- The end-to-end test itself replaced the editor contents and so deleted the forwarded block; it now types above it,
  as a person does.

## Known gaps

- Spell check uses the macOS checker (`NSSpellChecker`) through a dialog; WebKit's own underline-as-you-type is on
  in the editor. Neither is exercised by the automated run.
- Pop-out windows, full-screen compose, templates, plain-text mode and aliases are built and typecheck but aren't
  exercised by the automated run or measured against a golden.
