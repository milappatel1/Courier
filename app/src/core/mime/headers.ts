// Header helpers: RFC 2047 encoded words, RFC 2231 parameters, folding and unfolding.
import { base64Decode, base64Encode, binaryString, decodeCharset, qpDecode, utf8 } from "../bytes";

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** Encode a header value as RFC 2047 B-words when it isn't plain ASCII (split on UTF-8 boundaries). */
export function encodeWords(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  // ~45 bytes of UTF-8 per word keeps each encoded word under 75 chars.
  for (const ch of value) {
    if (utf8(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64Encode(utf8(w))}?=`).join("\r\n ");
}

/** Encode the display-name part of an address header, keeping the address itself ASCII. */
export function encodeAddressHeader(list: { name: string; email: string }[]): string {
  return list
    .map((a) => {
      if (!a.name || a.name === a.email) return a.email;
      const name = ASCII_PRINTABLE.test(a.name)
        ? /[()<>[\]:;@\\,."]/.test(a.name)
          ? `"${a.name.replace(/(["\\])/g, "\\$1")}"`
          : a.name
        : encodeWords(a.name);
      return `${name} <${a.email}>`;
    })
    .join(",\r\n ");
}

/** Decode RFC 2047 encoded words (B and Q), joining adjacent words separated only by whitespace. */
export function decodeWords(value: string): string {
  if (!value.includes("=?")) return value;
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const between = value.slice(last, m.index);
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    const charset = m[1].split("*")[0];
    const text = m[3];
    let bytes: Uint8Array;
    if (m[2].toLowerCase() === "b") bytes = base64Decode(text);
    else bytes = qpDecode(text.replace(/_/g, " "));
    out += decodeCharset(bytes, charset);
    last = re.lastIndex;
    prevWasWord = true;
  }
  out += value.slice(last);
  return out;
}

export const unfold = (s: string) => s.replace(/\r?\n[ \t]+/g, " ");

export interface ParsedValue {
  value: string;
  params: Record<string, string>;
}

/** Parse `type/sub; a=b; c="d e"; name*=UTF-8''%E2%82%AC; title*0=..; title*1=..` */
export function parseHeaderValue(raw: string): ParsedValue {
  const parts: string[] = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && quote) {
      cur += raw[++i] ?? "";
      continue;
    }
    if (c === '"') quote = !quote;
    if (c === ";" && !quote) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  const value = parts.shift()!.trim();
  const plain: Record<string, string> = {};
  const continued: Record<string, { idx: number; val: string; enc: boolean }[]> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    const m = key.match(/^(.+?)\*(\d+)(\*)?$/);
    if (m) {
      (continued[m[1]] ??= []).push({ idx: +m[2], val, enc: !!m[3] });
      continue;
    }
    if (key.endsWith("*")) {
      key = key.slice(0, -1);
      plain[key] = decode2231(val, true);
      continue;
    }
    plain[key] = decodeWords(val);
  }
  for (const [key, segs] of Object.entries(continued)) {
    segs.sort((a, b) => a.idx - b.idx);
    // The charset prefix only appears on segment 0; later encoded segments are bare percent-encoding.
    const first = segs[0];
    let charset = "utf-8";
    const pieces: Uint8Array[] = [];
    for (const s of segs) {
      let v = s.val;
      if (s === first && s.enc) {
        const q = v.split("'");
        if (q.length >= 3) {
          charset = q[0] || "utf-8";
          v = q.slice(2).join("'");
        }
      }
      pieces.push(s.enc ? percentBytes(v) : utf8(v));
    }
    const total = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of pieces) total.set(p, (o += p.length) - p.length);
    plain[key] = decodeCharset(total, charset);
  }
  return { value, params: plain };
}

function percentBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...utf8(s[i]));
  }
  return new Uint8Array(out);
}

function decode2231(val: string, withCharset: boolean): string {
  if (!withCharset) return decodeCharset(percentBytes(val));
  const q = val.split("'");
  if (q.length < 3) return decodeCharset(percentBytes(val));
  return decodeCharset(percentBytes(q.slice(2).join("'")), q[0] || "utf-8");
}

/** A parameter for Content-Type / Content-Disposition, using RFC 2231 for non-ASCII values. */
export function formatParam(key: string, value: string): string {
  if (ASCII_PRINTABLE.test(value)) return `${key}="${value.replace(/(["\\])/g, "\\$1")}"`;
  const enc = [...utf8(value)].map((b) => (/[A-Za-z0-9.\-_~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0"))).join("");
  return `${key}*=UTF-8''${enc}`;
}

/** Fold a long header line at whitespace to ≤ 78 chars (keeps already-folded parts). */
export function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes("\r\n")) return line;
  const words = line.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > 78) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  lines.push(cur);
  return lines.join("\r\n ");
}

export const asLatin1Bytes = binaryString;
