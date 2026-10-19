// RFC 5322/MIME parser for display, "Show original", .eml files and round-trip tests.
import { parseAddressList, type Address } from "../addresses";
import { base64Decode, binaryString, decodeCharset, latin1, qpDecode } from "../bytes";
import { htmlToText } from "../text";
import { decodeWords, parseHeaderValue, unfold } from "./headers";

export interface Header {
  name: string;
  value: string; // unfolded, still encoded
}

export interface MimePart {
  partId: string; // "1", "1.2", … like IMAP section numbers
  headers: Header[];
  contentType: string; // lower-case type/subtype
  params: Record<string, string>;
  disposition: string | null;
  dispositionParams: Record<string, string>;
  contentId: string | null;
  encoding: string;
  /** Decoded body bytes (leaf parts only). */
  body: Uint8Array | null;
  children: MimePart[];
}

export interface ParsedAttachment {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  data: Uint8Array;
}

export interface ParsedMessage {
  headers: Header[];
  header(name: string): string | null;
  headerAll(name: string): string[];
  from: Address[];
  sender: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  deliveredTo: string[];
  subject: string;
  date: Date | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  html: string | null;
  text: string | null;
  attachments: ParsedAttachment[];
  root: MimePart;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  size: number;
}

function splitHeaderBody(bytes: Uint8Array): { head: string; bodyStart: number } {
  // Find the first empty line (CRLFCRLF or LFLF).
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { head: latin1(bytes.subarray(0, i)), bodyStart: i + 2 };
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return { head: latin1(bytes.subarray(0, i)), bodyStart: i + 4 };
  }
  return { head: latin1(bytes), bodyStart: bytes.length };
}

/** Headers as Latin-1 strings; raw 8-bit UTF-8 header bytes (common in practice) are re-decoded as UTF-8. */
export function parseHeaders(head: string): Header[] {
  const lines = unfold(head.replace(/\r\n/g, "\n")).split("\n");
  const out: Header[] = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    let value = line.slice(i + 1).trim();
    if (/[\x80-\xff]/.test(value)) {
      const utf = decodeCharset(binaryString(value), "utf-8");
      if (!utf.includes("\uFFFD")) value = utf;
    }
    out.push({ name: line.slice(0, i).trim(), value });
  }
  return out;
}

const get = (headers: Header[], name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

function decodeBody(bytes: Uint8Array, encoding: string): Uint8Array {
  const e = encoding.toLowerCase();
  if (e === "base64") return base64Decode(latin1(bytes));
  if (e === "quoted-printable") return qpDecode(latin1(bytes));
  return bytes;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function splitMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const marker = binaryString(`--${boundary}`);
  const parts: Uint8Array[] = [];
  let pos = indexOfBytes(body, marker, 0);
  if (pos < 0) return parts;
  while (pos >= 0) {
    let start = pos + marker.length;
    // Closing delimiter?
    if (body[start] === 45 && body[start + 1] === 45) break;
    // Skip transport padding to end of line.
    while (start < body.length && body[start] !== 10) start++;
    start++;
    let next = indexOfBytes(body, marker, start);
    // A delimiter must start a line.
    while (next > 0 && body[next - 1] !== 10) next = indexOfBytes(body, marker, next + 1);
    const end = next < 0 ? body.length : next;
    let stop = end;
    if (stop > start && body[stop - 1] === 10) stop--;
    if (stop > start && body[stop - 1] === 13) stop--;
    parts.push(body.subarray(start, Math.max(start, stop)));
    pos = next;
  }
  return parts;
}

function parsePart(bytes: Uint8Array, partId: string, defaultType = "text/plain"): MimePart {
  const { head, bodyStart } = splitHeaderBody(bytes);
  const headers = parseHeaders(head);
  const ct = parseHeaderValue(get(headers, "content-type") ?? defaultType);
  const contentType = (ct.value || defaultType).toLowerCase();
  const disp = get(headers, "content-disposition");
  const dp = disp ? parseHeaderValue(disp) : null;
  const cid = get(headers, "content-id");
  const encoding = (get(headers, "content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  const raw = bytes.subarray(bodyStart);
  const part: MimePart = {
    partId,
    headers,
    contentType,
    params: ct.params,
    disposition: dp ? dp.value.toLowerCase() : null,
    dispositionParams: dp?.params ?? {},
    contentId: cid ? cid.replace(/^<|>$/g, "").trim() : null,
    encoding,
    body: null,
    children: [],
  };
  if (contentType.startsWith("multipart/") && ct.params.boundary) {
    const childDefault = contentType === "multipart/digest" ? "message/rfc822" : "text/plain";
    part.children = splitMultipart(raw, ct.params.boundary).map((b, i) => parsePart(b, partId ? `${partId}.${i + 1}` : `${i + 1}`, childDefault));
  } else {
    part.body = decodeBody(raw, encoding);
  }
  return part;
}

function filenameOf(p: MimePart): string | null {
  const n = p.dispositionParams.filename ?? p.params.name ?? null;
  return n ? decodeWords(n) : null;
}

function walk(p: MimePart, visit: (p: MimePart) => void) {
  visit(p);
  p.children.forEach((c) => walk(c, visit));
}

export function partText(p: MimePart): string {
  return decodeCharset(p.body ?? new Uint8Array(), p.params.charset ?? "utf-8");
}

/** Choose the best body parts: html preferred, text kept as an alternative; attachments are everything else. */
function collect(root: MimePart) {
  let html: string | null = null;
  let text: string | null = null;
  const attachments: ParsedAttachment[] = [];
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  const visit = (p: MimePart, inAlternative: boolean) => {
    if (p.children.length) {
      if (p.contentType === "multipart/alternative") {
        // Pick the richest renderable alternative, but keep a text version too.
        const kids = p.children;
        const htmlKid = [...kids].reverse().find((k) => k.contentType === "text/html" || k.contentType.startsWith("multipart/"));
        const textKid = kids.find((k) => k.contentType === "text/plain");
        if (htmlKid) visit(htmlKid, true);
        if (textKid && textKid !== htmlKid) {
          if (!htmlKid) visit(textKid, true);
          else textParts.push(partText(textKid));
        }
        for (const k of kids) if (k !== htmlKid && k !== textKid && !k.contentType.startsWith("text/")) visit(k, inAlternative);
        return;
      }
      p.children.forEach((c) => visit(c, inAlternative));
      return;
    }
    const name = filenameOf(p);
    const isAttachment =
      p.disposition === "attachment" || (!!name && p.disposition !== "inline" && !p.contentType.startsWith("text/")) || p.contentType === "message/rfc822";
    const inlineImage = p.contentType.startsWith("image/") && (p.disposition === "inline" || !!p.contentId) && !isAttachmentDisposition(p);
    if (!isAttachment && !inlineImage && p.contentType === "text/html") {
      htmlParts.push(partText(p));
      return;
    }
    if (!isAttachment && !inlineImage && (p.contentType === "text/plain" || p.contentType === "text/enriched")) {
      // Text parts inside a mixed message after an html part are appended as html.
      textParts.push(partText(p));
      if (htmlParts.length && !inAlternative) htmlParts.push(`<pre style="white-space:pre-wrap">${escapeForPre(partText(p))}</pre>`);
      return;
    }
    if (p.body) {
      attachments.push({
        partId: p.partId,
        filename: name ?? (p.contentType === "message/rfc822" ? "message.eml" : `attachment-${p.partId}.${extFor(p.contentType)}`),
        mimeType: p.contentType,
        size: p.body.length,
        contentId: p.contentId,
        inline: inlineImage,
        data: p.body,
      });
    }
  };
  visit(root, false);
  if (htmlParts.length) html = htmlParts.join("\n");
  if (textParts.length) text = textParts.join("\n");
  if (html != null && text == null) text = htmlToText(html);
  return { html, text, attachments };
}

const isAttachmentDisposition = (p: MimePart) => p.disposition === "attachment";
const escapeForPre = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/calendar": "ics",
  "text/plain": "txt",
};
const extFor = (t: string) => EXT[t] ?? "bin";

export function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const cleaned = s.replace(/\([^)]*\)/g, "").trim();
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d;
  // "18 Oct 2026 20:06:00 +0000" without weekday sometimes fails on odd zones; retry without the zone name.
  const d2 = new Date(cleaned.replace(/\s+[A-Z]{2,5}$/, ""));
  return isNaN(d2.getTime()) ? null : d2;
}

const msgIds = (s: string | null) => (s ? (s.match(/<[^<>\s]+>/g) ?? []) : []);

export function parseMessage(input: Uint8Array | string): ParsedMessage {
  const bytes = typeof input === "string" ? binaryString(input) : input;
  const root = parsePart(bytes, "");
  const headers = root.headers;
  const h = (n: string) => get(headers, n);
  const { html, text, attachments } = collect(root);
  const decodedList = (n: string) => parseAddressList(decodeWords(h(n) ?? "")).map((a) => ({ name: decodeWords(a.name), email: a.email }));
  return {
    headers,
    header: (n) => {
      const v = get(headers, n);
      return v == null ? null : decodeWords(v);
    },
    headerAll: (n) => headers.filter((x) => x.name.toLowerCase() === n.toLowerCase()).map((x) => decodeWords(x.value)),
    from: decodedList("from"),
    sender: decodedList("sender"),
    to: decodedList("to"),
    cc: decodedList("cc"),
    bcc: decodedList("bcc"),
    replyTo: decodedList("reply-to"),
    deliveredTo: headers.filter((x) => x.name.toLowerCase() === "delivered-to").map((x) => x.value.trim()),
    subject: decodeWords(h("subject") ?? ""),
    date: parseDate(h("date")),
    messageId: msgIds(h("message-id"))[0] ?? (h("message-id")?.trim() || null),
    inReplyTo: msgIds(h("in-reply-to"))[0] ?? null,
    references: msgIds(h("references")),
    html,
    text,
    attachments,
    root,
    listUnsubscribe: h("list-unsubscribe"),
    listUnsubscribePost: h("list-unsubscribe-post"),
    size: bytes.length,
  };
}

/** Every leaf part, for "Show original"-style inspection. */
export function leafParts(m: ParsedMessage): MimePart[] {
  const out: MimePart[] = [];
  walk(m.root, (p) => {
    if (!p.children.length) out.push(p);
  });
  return out;
}

/** Authentication-Results summary (SPF/DKIM/DMARC) for "Show original". */
export function authResults(m: ParsedMessage): { spf: string | null; dkim: string | null; dmarc: string | null } {
  const ar = m.headerAll("authentication-results").join("; ");
  const pick = (k: string) => {
    const r = ar.match(new RegExp(`${k}=(\\w+)`, "i"));
    return r ? r[1].toUpperCase() : null;
  };
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") };
}
