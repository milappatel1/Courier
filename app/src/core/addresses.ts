// RFC 5322 address lists: parse "Name <a@b>", quoted names, comments and groups; format them back.

export interface Address {
  name: string;
  email: string;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export const isValidEmail = (s: string) => EMAIL_RE.test(s.trim());

export const normalizeEmail = (s: string) => s.trim().toLowerCase();

/** Tokenise respecting quotes, <angle> addresses, (comments) and \-escapes; split on top-level , or ;. */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && (quote || paren)) {
      cur += c + (input[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"' && !paren) quote = !quote;
    else if (!quote) {
      if (c === "(") paren++;
      else if (c === ")" && paren) paren--;
      else if (!paren && c === "<") angle++;
      else if (!paren && c === ">" && angle) angle--;
      else if (!paren && !angle && (c === "," || c === ";")) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquote(s: string): string {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).replace(/\\(.)/g, "$1");
  return s.trim();
}

function stripComments(s: string): { text: string; comment: string } {
  let comment = "";
  let text = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      (depth ? (comment += s[i + 1]) : (text += c + s[i + 1]), i++);
      continue;
    }
    if (c === '"' && !depth) quote = !quote;
    if (!quote && c === "(") {
      depth++;
      if (depth === 1) continue;
    }
    if (!quote && c === ")" && depth) {
      depth--;
      if (depth === 0) continue;
    }
    if (depth) comment += c;
    else text += c;
  }
  return { text: text.trim(), comment: comment.trim() };
}

export function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt >= 0 && gt > lt) {
    const email = s
      .slice(lt + 1, gt)
      .trim()
      .replace(/^mailto:/i, "");
    const { text, comment } = stripComments(s.slice(0, lt));
    return { name: unquote(text) || comment, email };
  }
  const { text, comment } = stripComments(s);
  const email = unquote(text).replace(/^mailto:/i, "");
  return { name: comment, email };
}

/** Parse an address list. Groups ("Team: a@b, c@d;") are flattened. */
export function parseAddressList(input: string | null | undefined): Address[] {
  if (!input) return [];
  // Flatten groups: "Name: list;" → list
  const flattened = input.replace(/(^|,)\s*(?:"[^"]*"|[^,:"<>@]+):([^;]*);/g, (_m, pre, list) => `${pre}${list}`);
  const out: Address[] = [];
  for (const part of splitTopLevel(flattened)) {
    const a = parseAddress(part);
    if (a && a.email) out.push(a);
  }
  return out;
}

const NEEDS_QUOTE = /[()<>[\]:;@\\,."]/;

export function formatAddress(a: Address): string {
  if (!a.name || a.name === a.email) return a.email;
  const name = NEEDS_QUOTE.test(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : a.name;
  return `${name} <${a.email}>`;
}

export const formatAddressList = (list: Address[]) => list.map(formatAddress).join(", ");

/** Display name for lists/headers: the name, else the local part of the address. */
export function displayName(a: Address | undefined | null): string {
  if (!a) return "";
  if (a.name) return a.name;
  return a.email.split("@")[0];
}

/** First name for compact participant lists ("Alice Smith" → "Alice"). */
export function shortName(a: Address): string {
  const n = displayName(a);
  if (!a.name) return n;
  const comma = n.indexOf(",");
  if (comma > 0)
    return (
      n
        .slice(comma + 1)
        .trim()
        .split(/\s+/)[0] || n
    ); // "Smith, Alice"
  return n.split(/\s+/)[0];
}

export function dedupeAddresses(list: Address[], exclude: string[] = []): Address[] {
  const seen = new Set(exclude.map(normalizeEmail));
  const out: Address[] = [];
  for (const a of list) {
    const k = normalizeEmail(a.email);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** Initial for a letter avatar. */
export function initialOf(a: Address | string): string {
  const s = typeof a === "string" ? a : displayName(a);
  const m = s.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : "?";
}

/** Stable avatar colour for an address (our own palette). */
const AVATAR_COLORS = ["#5c6bc0", "#00897b", "#e53935", "#8e24aa", "#3949ab", "#43a047", "#f4511e", "#6d4c41", "#039be5", "#c0ca33", "#d81b60", "#546e7a"];
export function avatarColor(email: string): string {
  let h = 0;
  for (const c of normalizeEmail(email)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
