# Compose and send

A user writes a new message, a reply or a forward (inline or in a window), with attachments, formatting and a
signature; drafts save as they type; Send waits for the Undo-send delay and can be undone.

## Sub-features

- `compose-new` the Compose button and `c`.
- `compose-reply` reply, reply all, forward (inline and as attachment).
- `compose-draft` autosave to the server's drafts.
- `compose-send` send with Undo; scheduled send.

## How to get to it (user POV)

- Compose button; Reply/Forward in an open conversation; `r`, `a`, `f`.

## Driving it with the e2e runner

Preconditions:

- `pat@example.com` Inbox; nothing goes beyond the fake SMTP and mail-API servers.

- **New message.** `const w = await newCompose(); await fill(w, "ana@friends.example", "Hello", "<p>Hi</p>")`,
  `click(await el("compose-send", w))`. The fake server's `gmailSent` has the subject; the parsed MIME has the body.
- **Proof.** The compose steps in `run.ts` pass (they parse what was sent with Courier's MIME parser).

## Gotchas

- Real sends never happen in verification; a send to a real address needs the user's say-so and goes only to
  their own address.
