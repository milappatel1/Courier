// Compose → RFC 5322/MIME. Produces CRLF bytes ready for the Gmail API (`raw`) or SMTP DATA.
import type { Address } from "../addresses";
import { base64Encode, concatBytes, qpEncode, randomToken, utf8 } from "../bytes";
import { htmlToText } from "../text";
import { encodeAddressHeader, encodeWords, foldHeader, formatParam } from "./headers";

export interface ComposeAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
  /** Set for inline images referenced from the HTML as cid:<contentId>. */
  contentId?: string;
}

export interface ComposeInput {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject: string;
  /** HTML body (rich mode). A text/plain alternative is generated from it. */
  html?: string | null;
  /** Plain-text body (plain-text mode, or an explicit alternative). */
  text?: string | null;
  attachments?: ComposeAttachment[];
  /** An iCalendar part (an invitation or a reply to one), sent as an alternative to the text. */
  calendar?: { method: string; text: string };
  /** A whole message forwarded as an attachment (message/rfc822). */
  forwarded?: { filename: string; raw: Uint8Array }[];
  inReplyTo?: string | null;
  references?: string[];
  messageId?: string;
  date?: Date;
  headers?: Record<string, string>;
}

export interface BuildOptions {
  /** Keep the Bcc header (the Gmail API reads and strips it); SMTP sends drop it and use the envelope. */
  includeBcc?: boolean;
  /** Deterministic boundaries/ids for tests. */
  seed?: string;
}

export interface Built {
  raw: Uint8Array;
  messageId: string;
  /** Envelope recipients (to + cc + bcc), for SMTP. */
  recipients: string[];
}

const CRLF = "\r\n";

export function rfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

export function newMessageId(fromEmail: string, seed?: string): string {
  const domain = fromEmail.split("@")[1] || "courier.invalid";
  return `<${seed ?? `${Date.now().toString(36)}.${randomToken(10)}`}@${domain}>`;
}

interface Part {
  headers: string[];
  body: Uint8Array | Part[];
  boundary?: string;
}

function leaf(contentType: string, body: Uint8Array, encoding: "quoted-printable" | "base64" | "7bit", extra: string[] = []): Part {
  return { headers: [`Content-Type: ${contentType}`, `Content-Transfer-Encoding: ${encoding}`, ...extra], body };
}

function textPart(subtype: "plain" | "html", content: string): Part {
  return leaf(`text/${subtype}; charset="UTF-8"`, utf8(qpEncode(content)), "quoted-printable");
}

function attachmentPart(a: ComposeAttachment): Part {
  const inline = !!a.contentId;
  const extra = [`Content-Disposition: ${inline ? "inline" : "attachment"}; ${formatParam("filename", a.filename)}`];
  if (inline) extra.push(`Content-ID: <${a.contentId}>`, `X-Attachment-Id: ${a.contentId}`);
  return leaf(`${a.mimeType || "application/octet-stream"}; ${formatParam("name", a.filename)}`, utf8(base64Encode(a.data, 76)), "base64", extra);
}

function multipart(subtype: string, parts: Part[], boundary: string): Part {
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body: parts, boundary };
}

function serialize(p: Part): Uint8Array {
  const head = utf8(p.headers.join(CRLF) + CRLF + CRLF);
  if (p.body instanceof Uint8Array) return concatBytes([head, p.body, utf8(CRLF)]);
  const chunks: Uint8Array[] = [head];
  for (const child of p.body) chunks.push(utf8(`--${p.boundary}${CRLF}`), serialize(child));
  chunks.push(utf8(`--${p.boundary}--${CRLF}`));
  return concatBytes(chunks);
}

export function buildMime(input: ComposeInput, opts: BuildOptions = {}): Built {
  let n = 0;
  const boundary = () => `=_courier_${opts.seed ?? randomToken(8)}_${++n}`;
  const messageId = input.messageId ?? newMessageId(input.from.email, opts.seed ? `${opts.seed}` : undefined);
  const attachments = input.attachments ?? [];
  const inline = attachments.filter((a) => a.contentId && input.html?.includes(`cid:${a.contentId}`));
  const regular = attachments.filter((a) => !inline.includes(a));

  let body: Part;
  if (input.html != null) {
    const text = input.text ?? htmlToText(input.html);
    const htmlPart = textPart("html", input.html);
    const htmlWithImages = inline.length ? multipart("related", [htmlPart, ...inline.map(attachmentPart)], boundary()) : htmlPart;
    body = multipart("alternative", [textPart("plain", text), htmlWithImages], boundary());
  } else {
    body = textPart("plain", input.text ?? "");
  }
  if (input.calendar) {
    // Plain ASCII goes as is; anything else (a name with accents) in base64, which every calendar reads.
    const ascii = /^[\x00-\x7f]*$/.test(input.calendar.text);
    const cal: Part = {
      headers: [`Content-Type: text/calendar; method=${input.calendar.method}; charset=UTF-8`, `Content-Transfer-Encoding: ${ascii ? "7bit" : "base64"}`],
      body: ascii ? utf8(input.calendar.text) : utf8(base64Encode(utf8(input.calendar.text), 76)),
    };
    body = multipart("alternative", [body, cal], boundary());
  }
  const forwarded = (input.forwarded ?? []).map((f): Part => ({
    headers: [`Content-Type: message/rfc822; ${formatParam("name", f.filename)}`, `Content-Disposition: attachment; ${formatParam("filename", f.filename)}`],
    body: f.raw,
  }));
  if (regular.length || forwarded.length) body = multipart("mixed", [body, ...regular.map(attachmentPart), ...forwarded], boundary());

  const h: string[] = [];
  h.push(foldHeader("From", encodeAddressHeader([input.from])));
  if (input.to.length) h.push(`To: ${encodeAddressHeader(input.to)}`);
  if (input.cc?.length) h.push(`Cc: ${encodeAddressHeader(input.cc)}`);
  if (opts.includeBcc && input.bcc?.length) h.push(`Bcc: ${encodeAddressHeader(input.bcc)}`);
  if (input.replyTo?.length) h.push(`Reply-To: ${encodeAddressHeader(input.replyTo)}`);
  h.push(foldHeader("Subject", encodeWords(input.subject)));
  h.push(`Date: ${rfc5322Date(input.date ?? new Date())}`);
  h.push(`Message-ID: ${messageId}`);
  if (input.inReplyTo) h.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references?.length) h.push(foldHeader("References", input.references.join(" ")));
  for (const [k, v] of Object.entries(input.headers ?? {})) h.push(foldHeader(k, encodeWords(v)));
  h.push("MIME-Version: 1.0");
  const raw = concatBytes([utf8(h.join(CRLF) + CRLF), serialize(body)]);
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.email);
  return { raw, messageId, recipients };
}

/** Total size of attachments in bytes, as the compose window shows it (base64 adds about a third on the wire). */
export const attachmentsSize = (a: ComposeAttachment[]) => a.reduce((n, x) => n + x.data.length, 0);

/** Gmail's documented message limit is 25 MB including encoding; we warn at that threshold on the encoded size. */
export const SEND_LIMIT_BYTES = 25 * 1024 * 1024;
export const encodedSize = (bytes: number) => Math.ceil(bytes / 3) * 4;
