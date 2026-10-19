// Byte helpers shared by the MIME builder/parser: UTF-8, base64 (+url), quoted-printable, charsets.
// Pure: no DOM, no Node APIs, so the same code runs in the webview and in the tests.

const enc = new TextEncoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);

export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
  let cs = charset.trim().toLowerCase().replace(/^"|"$/g, "");
  if (cs === "" || cs === "us-ascii" || cs === "ascii" || cs === "ansi_x3.4-1968") cs = "utf-8";
  if (cs === "utf8") cs = "utf-8";
  if (cs === "latin1" || cs === "iso8859-1") cs = "iso-8859-1";
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    // Unknown label: fall back to UTF-8, then to Latin-1 if UTF-8 produced replacement characters.
    const s = new TextDecoder("utf-8").decode(bytes);
    if (!s.includes("\uFFFD")) return s;
    return latin1(bytes);
  }
}

export function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

export function binaryString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // base64url
  t["_".charCodeAt(0)] = 63;
  return t;
})();

export function base64Encode(bytes: Uint8Array, lineLength = 0): string {
  let out = "";
  let line = 0;
  const push = (chunk: string) => {
    if (lineLength) {
      if (line + chunk.length > lineLength) {
        const room = lineLength - line;
        out += chunk.slice(0, room) + "\r\n" + chunk.slice(room);
        line = chunk.length - room;
        return;
      }
      line += chunk.length;
    }
    out += chunk;
  };
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=");
  }
  return out;
}

export function base64Decode(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_LOOKUP[s.charCodeAt(i) & 0xff];
    if (v < 0) continue; // whitespace, '=' and junk
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export const base64UrlEncode = (bytes: Uint8Array) => base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Quoted-printable (RFC 2045 §6.7) for UTF-8 text, CRLF line breaks, 76-char soft-wrapped lines. */
export function qpEncode(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = utf8(line);
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      let tok: string;
      const last = i === bytes.length - 1;
      if ((b === 0x20 || b === 0x09) && last) tok = "=" + b.toString(16).toUpperCase().padStart(2, "0");
      else if ((b >= 33 && b <= 126 && b !== 61) || b === 0x20 || b === 0x09) tok = String.fromCharCode(b);
      else tok = "=" + b.toString(16).toUpperCase().padStart(2, "0");
      if (cur.length + tok.length > 75) {
        out.push(cur + "=");
        cur = "";
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join("\r\n");
}

export function qpDecode(s: string): Uint8Array {
  const src = s.replace(/=\r?\n/g, "");
  const out = new Uint8Array(src.length);
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 61 /* = */ && i + 2 < src.length + 0 && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out[o++] = parseInt(src.slice(i + 1, i + 3), 16);
      i += 2;
    } else out[o++] = c & 0xff;
  }
  return out.subarray(0, o);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function randomToken(bytes = 12): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, "")} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
