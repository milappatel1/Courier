// Compose: new mail, replies and forwards, MIME building, draft autosave, send with Undo, schedule send,
// and turning drafts / outbox items / mailto links back into compose windows.
import { formatAddress, parseAddressList, type Address } from "../core/addresses";
import { base64Encode, randomToken } from "../core/bytes";
import { buildReply, mentionsAttachment, pickFromAlias, signatureHtml, type ReplyKind, type SourceMessage } from "../core/compose";
import { scheduledWhen } from "../core/dates";
import { buildMime, encodedSize, SEND_LIMIT_BYTES, type ComposeAttachment } from "../core/mime/build";
import { parseMessage } from "../core/mime/parse";
import { escapeHtml, htmlToText, textToHtml } from "../core/text";
import { parseMailto } from "../core/unsubscribe";
import { mimeFromName } from "../core/files";
import { api, failureText } from "../ipc/api";
import type { Account, MessageRow } from "../ipc/types";
import { act } from "./actions";
import { FONTS, SIZES } from "./settings";
import {
  accountById,
  activeAccount,
  addCompose,
  dismissToast,
  getState,
  go,
  newComposeId,
  onSent,
  openThread,
  registerComposeOpeners,
  removeCompose,
  replaceToast,
  toast,
  ui,
  updateCompose,
  type Attachment,
  type ComposeData,
} from "./store";

const blank = (): Omit<ComposeData, "id" | "accountId" | "from"> => ({
  to: [],
  cc: [],
  bcc: [],
  showCc: false,
  showBcc: false,
  subject: "",
  html: "",
  plain: getState().settings.compose.plainTextDefault,
  attachments: [],
  inlineImages: {},
  forwarded: [],
  reply: null,
  draftId: null,
  threadId: null,
  minimized: false,
  fullscreen: getState().settings.compose.fullScreenDefault,
  placement: "dock",
  savedAt: null,
  dirty: false,
  signatureId: null,
  createdAt: Date.now(),
});

function defaultAccount(): Account | undefined {
  const s = getState();
  return activeAccount() ?? s.accounts[0];
}

async function signatureFor(accountId: string, address: string, reply: boolean): Promise<{ id: string | null; html: string }> {
  const defaults = ((getState().settings as unknown as Record<string, unknown>)[`sigDefaults:${accountId}`] ??
    (await api.settings())[`sigDefaults:${accountId}`]) as Record<string, { newMail?: string | null; replies?: string | null }> | undefined;
  const d = defaults?.[address] ?? defaults?.["*"];
  const id = reply ? d?.replies : d?.newMail;
  if (!id) return { id: null, html: "" };
  const sigs = await api.signatures(accountId).catch(() => []);
  const s = sigs.find((x) => x.id === id);
  return s ? { id: s.id, html: s.html } : { id: null, html: "" };
}

export async function openCompose(init: Partial<ComposeData> = {}) {
  const acct = init.accountId ? accountById(init.accountId) : defaultAccount();
  if (!acct) {
    ui({ addAccount: {} });
    return;
  }
  const from = init.from ?? acct.email;
  const sig = init.html !== undefined ? { id: null, html: "" } : await signatureFor(acct.id, from, false);
  const c: ComposeData = {
    ...blank(),
    id: newComposeId(),
    accountId: acct.id,
    from,
    html: init.html ?? (sig.html ? `<div><br></div>${signatureHtml(sig.html)}` : ""),
    signatureId: sig.id,
    focus: init.to?.length ? "body" : "to",
    ...init,
  };
  addCompose(c);
  return c.id;
}

function sourceOf(m: MessageRow, parsed: ReturnType<typeof parseMessage>): SourceMessage {
  return {
    from: parsed.from.length ? parsed.from : [{ name: m.fromName, email: m.fromEmail }],
    to: parsed.to,
    cc: parsed.cc,
    replyTo: parsed.replyTo,
    subject: parsed.subject || m.subject,
    date: m.internalDate,
    messageId: parsed.messageId ?? (m.messageId || null),
    references: parsed.references,
    html: parsed.html,
    text: parsed.text,
    deliveredTo: parsed.deliveredTo,
  };
}

/** Reply / reply all / forward a message (inline under the conversation, or popped out). */
export async function openReply(accountId: string, m: MessageRow, kind: ReplyKind, opts: { inline?: boolean } = {}) {
  const acct = accountById(accountId);
  if (!acct) return;
  const raw = await api.raw(accountId, m.id);
  const parsed = parseMessage(raw);
  const src = sourceOf(m, parsed);
  const self = [acct.email, ...acct.aliases];
  const r = buildReply(src, kind, self);
  const from = pickFromAlias(src, self, acct.email);
  const sig = await signatureFor(accountId, from, true);
  const attachments: Attachment[] =
    kind === "forward"
      ? parsed.attachments.filter((a) => !a.inline).map((a) => ({ id: randomToken(4), name: a.filename, mime: a.mimeType, size: a.size, data: a.data }))
      : [];
  // Forwarded inline images keep working: re-attach them as cid images.
  const inlineImages: Record<string, Attachment> = {};
  let quoted = r.quotedHtml;
  for (const a of parsed.attachments.filter((x) => x.inline && x.contentId)) {
    const url = URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.mimeType }));
    inlineImages[url] = { id: a.contentId!, name: a.filename, mime: a.mimeType, size: a.size, data: a.data };
    quoted = quoted.split(`cid:${a.contentId}`).join(url);
  }
  const forward = kind === "forward";
  const c: ComposeData = {
    ...blank(),
    id: newComposeId(),
    accountId,
    from,
    to: r.to,
    cc: r.cc,
    showCc: r.cc.length > 0,
    subject: r.subject,
    // Forwards show the forwarded message in the editor; replies keep the quote behind "•••".
    html: `<div><br></div>${sig.html ? signatureHtml(sig.html) : ""}${forward ? `<br>${quoted}` : ""}`,
    signatureId: sig.id,
    attachments,
    inlineImages,
    reply: { kind, threadId: m.threadId, inReplyTo: r.inReplyTo, references: r.references, quotedHtml: forward ? "" : quoted },
    threadId: m.threadId,
    placement: opts.inline === false ? "dock" : "inline",
    focus: forward ? "to" : "body",
  };
  addCompose(c);
  return c.id;
}

export async function forwardAsAttachment(accountId: string, messages: MessageRow[]) {
  const acct = accountById(accountId);
  if (!acct || !messages.length) return;
  const forwarded = await Promise.all(
    messages.map(async (m) => ({
      filename: `${(m.subject || "message").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)}.eml`,
      raw: await api.raw(accountId, m.id),
    })),
  );
  await openCompose({ accountId, subject: `Fwd: ${messages[messages.length - 1].subject}`, forwarded, focus: "to" });
}

/** Editor HTML → what's sent: blob: images become cid: parts, the default text style wraps the body. */
function finalHtml(c: ComposeData): { html: string; inline: ComposeAttachment[] } {
  let html = c.html;
  const inline: ComposeAttachment[] = [];
  for (const [url, img] of Object.entries(c.inlineImages)) {
    if (!html.includes(url)) continue;
    const cid = img.id.includes("@") ? img.id : `${img.id}@courier`;
    html = html.split(url).join(`cid:${cid}`);
    inline.push({ filename: img.name, mimeType: img.mime, data: img.data, contentId: cid });
  }
  if (c.reply?.quotedHtml)
    html += `<br>${c.reply.quotedHtml.replace(/blob:[^"']+/g, (u) => (c.inlineImages[u] ? `cid:${c.inlineImages[u].id.includes("@") ? c.inlineImages[u].id : `${c.inlineImages[u].id}@courier`}` : u))}`;
  const f = getState().settings.defaultFont;
  const isDefault = f.family === "sans" && f.size === "normal" && (f.color === "#222222" || !f.color);
  if (!isDefault)
    html = `<div style="font-family:${FONTS[f.family]?.css ?? "Arial"};font-size:${SIZES[f.size]?.css ?? "small"};color:${f.color}">${html}</div>`;
  else html = `<div dir="ltr">${html}</div>`;
  return { html, inline };
}

export function buildRaw(c: ComposeData, opts: { forSending?: boolean } = {}): { raw: Uint8Array; messageId: string; size: number } {
  const acct = accountById(c.accountId);
  const name = acct?.name ?? "";
  const from: Address = { name, email: c.from };
  const attachments: ComposeAttachment[] = c.attachments.map((a) => ({ filename: a.name, mimeType: a.mime, data: a.data }));
  let html: string | null = null;
  let text: string | null = null;
  if (c.plain) {
    text = htmlToText(c.html) + (c.reply?.quotedHtml ? `\n\n${htmlToText(c.reply.quotedHtml)}` : "");
  } else {
    const f = finalHtml(c);
    html = f.html;
    attachments.push(...f.inline);
  }
  const built = buildMime(
    {
      from,
      to: c.to,
      cc: c.cc,
      bcc: c.bcc,
      subject: c.subject,
      html,
      text,
      attachments,
      forwarded: c.forwarded,
      inReplyTo: c.reply?.inReplyTo ?? null,
      references: c.reply?.references ?? [],
      // The labels header is read and removed by the engine before the message leaves (never in drafts).
      headers: { "X-Mailer": "Courier 1.0", ...(opts.forSending && c.labels?.length ? { "X-Courier-Labels": c.labels.join(",") } : {}) },
    },
    { includeBcc: true },
  );
  const size = c.attachments.reduce((n, a) => n + a.data.length, 0) + c.forwarded.reduce((n, f) => n + f.raw.length, 0);
  return { raw: built.raw, messageId: built.messageId, size };
}

const hasContent = (c: ComposeData) =>
  c.to.length + c.cc.length + c.bcc.length > 0 || c.subject.trim() !== "" || htmlToText(c.html).trim() !== "" || c.attachments.length > 0;

// ---- draft autosave ----

const timers = new Map<string, number>();
const saving = new Map<string, Promise<void>>();

export function scheduleSave(id: string) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      void saveDraft(id);
    }, 2000),
  );
}

export async function saveDraft(id: string): Promise<void> {
  const prev = saving.get(id);
  if (prev) await prev;
  const c = getState().composes.find((x) => x.id === id);
  if (!c || !c.dirty || !hasContent(c)) return;
  const p = (async () => {
    try {
      const { raw } = buildRaw(c);
      const draftId = await api.draftSave(c.accountId, c.draftId, raw, c.threadId);
      const latest = getState().composes.find((x) => x.id === id);
      if (latest) updateCompose(id, { draftId, savedAt: Date.now(), dirty: latest === c ? false : latest.dirty });
    } catch (e) {
      // Offline: keep the draft in memory; it's saved again on the next change.
      void e;
    }
  })();
  saving.set(id, p);
  await p;
  saving.delete(id);
}

export function changeCompose(id: string, patch: Partial<ComposeData>) {
  updateCompose(id, { ...patch, dirty: true });
  scheduleSave(id);
}

export async function discardCompose(id: string) {
  const c = getState().composes.find((x) => x.id === id);
  removeCompose(id);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  if (!c) return;
  await saving.get(id);
  const latest = c.draftId ?? null;
  if (latest) {
    await api.draftDelete(c.accountId, latest).catch(() => {});
    toast("Draft discarded.", {
      action: {
        label: "Undo",
        run: () => {
          addCompose({ ...c, draftId: null, dirty: true, minimized: false });
          scheduleSave(c.id);
        },
      },
    });
  }
}

/** Close the window, keeping the draft (the X button). */
export async function closeCompose(id: string) {
  const c = getState().composes.find((x) => x.id === id);
  removeCompose(id);
  if (!c) return;
  const t = timers.get(id);
  if (t) clearTimeout(t);
  if (c.dirty && hasContent(c)) {
    try {
      const { raw } = buildRaw(c);
      await api.draftSave(c.accountId, c.draftId, raw, c.threadId);
      toast("Draft saved.");
    } catch (e) {
      toast(failureText(`save the draft`, e));
    }
  }
}

// ---- send ----

const undoCopies = new Map<number, ComposeData>();

export interface SendCheck {
  ok: boolean;
  error?: string;
  confirm?: string;
}

export function checkBeforeSend(c: ComposeData): SendCheck {
  if (!c.to.length && !c.cc.length && !c.bcc.length) return { ok: false, error: "Please specify at least one recipient." };
  const bad = [...c.to, ...c.cc, ...c.bcc].find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email));
  if (bad)
    return { ok: false, error: `The address "${bad.email}" in the "To" field was not recognized. Please make sure that all addresses are properly formed.` };
  const bytes = encodedSize(c.attachments.reduce((n, a) => n + a.data.length, 0));
  if (bytes > SEND_LIMIT_BYTES) return { ok: false, error: "The attachments are larger than the 25 MB limit. Remove some, or share them another way." };
  if (!c.attachments.length && !c.forwarded.length && mentionsAttachment(htmlToText(c.html)))
    return {
      ok: true,
      confirm: 'It seems like you forgot to attach a file. You wrote "attached" in your message, but there are no files attached. Send anyway?',
    };
  if (!c.subject.trim() && !htmlToText(c.html).trim()) return { ok: true, confirm: "Send without a subject or any text?" };
  return { ok: true };
}

export async function sendCompose(id: string, opts: { sendAt?: number; archiveThread?: boolean } = {}) {
  const c = getState().composes.find((x) => x.id === id);
  if (!c) return;
  const t = timers.get(id);
  if (t) clearTimeout(t);
  await saving.get(id);
  const latest = getState().composes.find((x) => x.id === id) ?? c;
  const { raw } = buildRaw(latest, { forSending: true });
  const scheduled = opts.sendAt != null;
  const undoMs = getState().settings.undoSendSeconds * 1000;
  let outboxId: number;
  try {
    outboxId = await api.send(latest.accountId, raw, { sendAt: opts.sendAt ?? null, scheduled, threadId: latest.threadId, draftId: latest.draftId, undoMs });
  } catch (e) {
    toast(failureText(`send`, e));
    return;
  }
  removeCompose(id);
  undoCopies.set(outboxId, latest);
  if (opts.archiveThread && latest.reply?.threadId) void act("archive", [{ accountId: latest.accountId, threadIds: [latest.reply.threadId] }]);
  const view = () => {
    go({ label: scheduled ? "SCHEDULED" : "SENT" });
  };
  const undo = async () => {
    const back = await api.outboxCancel(outboxId);
    if (!back) {
      toast(scheduled ? "That message was already sent." : "Too late to undo: the message was sent.");
      return;
    }
    const copy = undoCopies.get(outboxId);
    undoCopies.delete(outboxId);
    if (copy) addCompose({ ...copy, id: newComposeId(), minimized: false, placement: copy.placement === "inline" ? "dock" : copy.placement, dirty: true });
    toast(scheduled ? "No longer scheduled." : "Not sent. You can keep editing.");
  };
  if (scheduled) {
    toast(`Send scheduled for ${scheduledWhen(opts.sendAt!)}`, {
      action: { label: "Undo", run: () => void undo() },
      secondary: { label: "View message", run: view },
    });
    return;
  }
  const tid = toast("Message sent", { action: { label: "Undo", run: () => void undo() }, secondary: { label: "View message", run: view }, sticky: true });
  onSent(outboxId, () => {
    undoCopies.delete(outboxId);
    replaceToast(tid, "Message sent", { secondary: { label: "View message", run: view } });
  });
  // If the app is offline the message waits in the Outbox; say so once the undo window has passed.
  setTimeout(() => {
    if (!getState().online && getState().toasts.some((x) => x.id === tid)) {
      dismissToast(tid);
      toast("You're offline. The message is in the Outbox and will be sent when you're back online.", {
        secondary: { label: "View Outbox", run: () => go({ label: "OUTBOX" }) },
      });
    }
  }, undoMs + 1500);
}

// ---- reopening ----

function composeFromRaw(accountId: string, raw: Uint8Array, extra: Partial<ComposeData> = {}): ComposeData {
  const p = parseMessage(raw);
  const acct = accountById(accountId);
  const inlineImages: Record<string, Attachment> = {};
  let html = p.html ?? textToHtml(p.text ?? "");
  // Strip our wrapper div so editing doesn't nest it again.
  html = html.replace(/^<div dir="ltr">([\s\S]*)<\/div>$/, "$1");
  for (const a of p.attachments.filter((x) => x.inline && x.contentId)) {
    const url = URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.mimeType }));
    inlineImages[url] = { id: a.contentId!, name: a.filename, mime: a.mimeType, size: a.size, data: a.data };
    html = html.split(`cid:${a.contentId}`).join(url);
  }
  const forwarded = p.attachments.filter((a) => a.mimeType === "message/rfc822").map((a) => ({ filename: a.filename, raw: a.data }));
  return {
    ...blank(),
    id: newComposeId(),
    accountId,
    from: p.from[0]?.email ?? acct?.email ?? "",
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    showCc: p.cc.length > 0,
    showBcc: p.bcc.length > 0,
    subject: p.subject,
    html,
    attachments: p.attachments
      .filter((a) => !a.inline && a.mimeType !== "message/rfc822")
      .map((a) => ({ id: randomToken(4), name: a.filename, mime: a.mimeType, size: a.size, data: a.data })),
    inlineImages,
    forwarded,
    reply: p.inReplyTo ? { kind: "reply", threadId: extra.threadId ?? "", inReplyTo: p.inReplyTo, references: p.references, quotedHtml: "" } : null,
    ...extra,
  };
}

async function openOutboxItem(id: number) {
  const row = (await api.outbox()).find((r) => r.id === id);
  if (!row) return;
  if (row.scheduled) {
    ui({
      confirm: {
        title: "Scheduled message",
        body: `Scheduled for ${scheduledWhen(row.sendAt)}. Cancel the scheduled send to edit it?`,
        ok: "Cancel send",
        run: () =>
          void api.outboxCancel(id).then((back) => {
            if (back) addCompose(composeFromRaw(back.accountId, back.raw, { threadId: back.threadId, draftId: back.draftId }));
            toast("No longer scheduled. It's back in Drafts.");
          }),
      },
    });
    return;
  }
  const raw = await api.outboxRaw(id);
  addCompose(composeFromRaw(row.accountId, raw, { threadId: row.threadId }));
}

async function openDraft(accountId: string, draftId: string, threadId: string) {
  const d = await api.thread(accountId, threadId);
  const m = d.messages.find((x) => x.draftId === draftId) ?? d.messages.find((x) => x.labels.includes("DRAFT"));
  if (!m) return;
  const raw = await api.raw(accountId, m.id);
  addCompose(composeFromRaw(accountId, raw, { draftId, threadId: d.messages.length > 1 ? threadId : null }));
}

registerComposeOpeners(openOutboxItem, openDraft);

export async function openMailto(url: string) {
  const m = parseMailto(url);
  await openCompose({
    to: m.to.flatMap((x) => parseAddressList(x)),
    cc: m.cc.flatMap((x) => parseAddressList(x)),
    bcc: m.bcc.flatMap((x) => parseAddressList(x)),
    showCc: m.cc.length > 0,
    showBcc: m.bcc.length > 0,
    subject: m.subject,
    html: m.body ? textToHtml(m.body) : undefined,
  });
}

/** Unsubscribe by email: sent straight away (with the user's confirmation in the dialog). */
export async function sendSimple(accountId: string, to: string, subject: string, body: string) {
  const acct = accountById(accountId);
  if (!acct) return;
  const built = buildMime(
    { from: { name: acct.name, email: acct.email }, to: [{ name: "", email: to }], subject, text: body || "unsubscribe" },
    { includeBcc: true },
  );
  await api.send(accountId, built.raw, { undoMs: 0 });
}

export function viewSentThread(threadId: string, accountId: string) {
  openThread({
    accountId,
    threadId,
    subject: "",
    snippet: "",
    lastDate: 0,
    messageCount: 1,
    unread: false,
    starred: false,
    starType: null,
    important: false,
    labels: [],
    participants: [],
    hasAttachments: false,
    attachments: [],
    snoozedUntil: null,
    muted: false,
    messageIds: [],
    draftIds: [],
    outboxId: null,
    scheduledAt: null,
    listUnsubscribe: false,
    toMe: 0,
  });
}

/** Insert a template: its subject when the subject is empty, its body at the start. */
export function templateInto(c: ComposeData, t: { subject: string; html: string }): Partial<ComposeData> {
  return { subject: c.subject.trim() ? c.subject : t.subject, html: t.html + c.html };
}

export { mimeFromName };

/** Files handed to Courier (Open With, or another app's "Email this file"): a new message with them attached. */
export async function composeWithFiles(paths: string[]) {
  const attachments: Attachment[] = [];
  for (const p of paths) {
    const path = p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p;
    const data = await api.readFile(path);
    const name = path.split("/").pop() || "attachment";
    attachments.push({ id: randomToken(4), name, mime: mimeFromName(name), size: data.length, data });
  }
  if (!attachments.length) return;
  await openCompose({ attachments, subject: attachments.length === 1 ? attachments[0].name.replace(/\.[^.]+$/, "") : "" });
}

export const attachmentFromFile = async (f: File): Promise<Attachment> => ({
  id: randomToken(4),
  name: f.name,
  mime: f.type || "application/octet-stream",
  size: f.size,
  data: new Uint8Array(await f.arrayBuffer()),
});

export const recipientsText = (list: Address[]) => list.map(formatAddress).join(", ");

export const plainToggle = (c: ComposeData, plain: boolean): Partial<ComposeData> => (plain ? { plain, html: textToHtml(htmlToText(c.html)) } : { plain });

export const quoteLine = (s: string) => escapeHtml(s);
export const b64 = base64Encode;
