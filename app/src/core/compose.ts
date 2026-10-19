// Reply / reply all / forward: recipients, subject, quoted body and threading headers.
import { dedupeAddresses, formatAddress, normalizeEmail, type Address } from "./addresses";
import { quoteDate } from "./dates";
import { escapeHtml, textToHtml } from "./text";

export interface SourceMessage {
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  date: number;
  messageId: string | null;
  references: string[];
  html: string | null;
  text: string | null;
  /** Addresses the message was delivered to (to pick the matching send-as alias). */
  deliveredTo?: string[];
}

export type ReplyKind = "reply" | "reply-all" | "forward";

export interface ReplyDraft {
  to: Address[];
  cc: Address[];
  subject: string;
  inReplyTo: string | null;
  references: string[];
  quotedHtml: string;
  quotedText: string;
}

const RE = /^\s*re\s*:/i;
const FWD = /^\s*(fwd?|fw)\s*:/i;

export function replySubject(s: string): string {
  return RE.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(s: string): string {
  return FWD.test(s) ? s : `Fwd: ${s}`;
}

/** Recipients for a reply. `self` = all of the account's addresses (primary + aliases). */
export function replyRecipients(m: SourceMessage, kind: "reply" | "reply-all", self: string[]): { to: Address[]; cc: Address[] } {
  const me = self.map(normalizeEmail);
  const isMe = (a: Address) => me.includes(normalizeEmail(a.email));
  const sentByMe = m.from.some(isMe);
  // Replying to your own message goes back to its original recipients.
  let to: Address[] = sentByMe ? m.to : m.replyTo.length ? m.replyTo : m.from;
  let cc: Address[] = [];
  if (kind === "reply-all") {
    const others = sentByMe ? m.cc : [...m.to, ...m.cc];
    cc = others;
  }
  to = dedupeAddresses(to, sentByMe ? [] : []);
  if (!sentByMe) to = to.filter((a) => !isMe(a) || to.length === 1);
  cc = dedupeAddresses(cc, [...me, ...to.map((a) => a.email)]);
  if (!to.length && cc.length) to = [cc.shift()!];
  return { to, cc };
}

/** Which of the account's send-as addresses the reply should come from (the one the mail was sent to). */
export function pickFromAlias(m: SourceMessage, aliases: string[], fallback: string): string {
  const all = [...m.to, ...m.cc].map((a) => normalizeEmail(a.email)).concat((m.deliveredTo ?? []).map(normalizeEmail));
  return aliases.find((a) => all.includes(normalizeEmail(a))) ?? fallback;
}

function attribution(m: SourceMessage): string {
  const from = m.from[0];
  const who = from ? (from.name ? `${from.name} <${from.email}>` : from.email) : "someone";
  return `On ${quoteDate(m.date)} ${who} wrote:`;
}

export function quoteFor(m: SourceMessage): { html: string; text: string } {
  const bodyHtml = m.html ?? textToHtml(m.text ?? "");
  const html = `<div class="courier_quote_container"><div dir="ltr" class="courier_attr">${escapeHtml(attribution(m))}<br></div><blockquote class="courier_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${bodyHtml}</blockquote></div>`;
  const text = `${attribution(m)}\n\n${(m.text ?? "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}`;
  return { html, text };
}

export function forwardBlock(m: SourceMessage): { html: string; text: string } {
  const line = (label: string, v: string) => `${label}: ${v}`;
  const fields = [
    line("From", m.from.map(formatAddress).join(", ")),
    line("Date", quoteDate(m.date)),
    line("Subject", m.subject),
    line("To", m.to.map(formatAddress).join(", ")),
    ...(m.cc.length ? [line("Cc", m.cc.map(formatAddress).join(", "))] : []),
  ];
  const header = "---------- Forwarded message ---------";
  const html = `<div class="courier_quote_container"><div dir="ltr" class="courier_attr">${escapeHtml(header)}<br>${fields.map((f) => escapeHtml(f)).join("<br>")}<br></div><br><br>${m.html ?? textToHtml(m.text ?? "")}</div>`;
  const text = `${header}\n${fields.join("\n")}\n\n${m.text ?? ""}`;
  return { html, text };
}

export function buildReply(m: SourceMessage, kind: ReplyKind, self: string[]): ReplyDraft {
  const refs = [...m.references];
  if (m.messageId && !refs.includes(m.messageId)) refs.push(m.messageId);
  if (kind === "forward") {
    const q = forwardBlock(m);
    return { to: [], cc: [], subject: forwardSubject(m.subject), inReplyTo: m.messageId, references: refs, quotedHtml: q.html, quotedText: q.text };
  }
  const { to, cc } = replyRecipients(m, kind, self);
  const q = quoteFor(m);
  return { to, cc, subject: replySubject(m.subject), inReplyTo: m.messageId, references: refs, quotedHtml: q.html, quotedText: q.text };
}

/** Signature block appended to a new message or above the quote in a reply. */
export function signatureHtml(sig: string): string {
  if (!sig.trim()) return "";
  return `<br><div class="courier_signature" data-courier-signature="1">-- <br>${sig}</div>`;
}

export function signatureText(sig: string): string {
  if (!sig.trim()) return "";
  return `\n\n-- \n${sig}`;
}

/** Whether the person forgot an attachment they mention ("attached", "enclosed"). */
export function mentionsAttachment(bodyText: string): boolean {
  const own = bodyText.split(/\nOn .{4,200} wrote:|\n-{5,} Forwarded message/)[0];
  return /\b(attach(ed|ment|ments)?|enclosed|I've included|see the file)\b/i.test(own);
}
