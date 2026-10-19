// Search-operator parser: from: to: cc: bcc: subject: label: in: is: has: filename: larger: smaller: size:
// before: after: older: newer: older_than: newer_than: category: list: deliveredto: rfc822msgid:, OR / | / { },
// AND, -negation, "quoted phrases", +exact and (parentheses). The Rust side has a twin parser
// (src-tauri/src/search.rs); tests/fixtures/search-cases.json keeps them identical.

export type SearchNode =
  | { type: "and"; children: SearchNode[] }
  | { type: "or"; children: SearchNode[] }
  | { type: "not"; child: SearchNode }
  | { type: "term"; field: string | null; value: string; exact?: boolean };

export const FIELDS = [
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "label",
  "in",
  "is",
  "has",
  "filename",
  "larger",
  "smaller",
  "size",
  "before",
  "after",
  "older",
  "newer",
  "older_than",
  "newer_than",
  "category",
  "list",
  "deliveredto",
  "rfc822msgid",
] as const;
const FIELD_SET = new Set<string>(FIELDS);
const ALIASES: Record<string, string> = { older: "before", newer: "after" };

type Tok =
  | { t: "(" | ")" | "{" | "}" | "-" | "OR" | "AND" }
  | { t: "field"; v: string }
  | { t: "word"; v: string; exact?: boolean }
  | { t: "phrase"; v: string };

export function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = q.length;
  const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\u00a0";
  while (i < n) {
    const c = q[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      out.push({ t: c });
      i++;
      continue;
    }
    if (c === "|") {
      out.push({ t: "OR" });
      i++;
      continue;
    }
    if (c === "-" && i + 1 < n && !isSpace(q[i + 1]) && (out.length === 0 || i === 0 || isSpace(q[i - 1]) || "({".includes(q[i - 1]))) {
      out.push({ t: "-" });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = "";
      while (j < n && q[j] !== '"') v += q[j++];
      out.push({ t: "phrase", v });
      i = j + 1;
      continue;
    }
    // A word runs until whitespace or a bracket; "field:" splits off when the prefix is a known operator.
    let j = i;
    while (j < n && !isSpace(q[j]) && !"(){}\"".includes(q[j])) {
      if (q[j] === ":") break;
      j++;
    }
    const word = q.slice(i, j);
    if (q[j] === ":" && FIELD_SET.has(word.toLowerCase())) {
      out.push({ t: "field", v: word.toLowerCase() });
      i = j + 1;
      continue;
    }
    // Not a field: keep the colon and the rest as part of the word.
    while (j < n && !isSpace(q[j]) && !"(){}\"".includes(q[j])) j++;
    const full = q.slice(i, j);
    if (full === "OR") out.push({ t: "OR" });
    else if (full === "AND") out.push({ t: "AND" });
    else if (full.startsWith("+") && full.length > 1) out.push({ t: "word", v: full.slice(1), exact: true });
    else out.push({ t: "word", v: full });
    i = j;
  }
  return out;
}

function flatten(type: "and" | "or", children: SearchNode[]): SearchNode {
  const flat: SearchNode[] = [];
  for (const c of children) {
    if (c.type === type) flat.push(...c.children);
    else flat.push(c);
  }
  return flat.length === 1 ? flat[0] : { type, children: flat };
}

export function parseQuery(q: string): SearchNode | null {
  const toks = tokenize(q);
  let pos = 0;
  const peek = () => toks[pos];

  const parseOr = (field: string | null, stop: string[]): SearchNode | null => {
    const parts: SearchNode[] = [];
    let cur = parseAnd(field, stop);
    if (cur) parts.push(cur);
    while (peek()?.t === "OR") {
      pos++;
      cur = parseAnd(field, stop);
      if (cur) parts.push(cur);
    }
    if (!parts.length) return null;
    return flatten("or", parts);
  };

  const parseAnd = (field: string | null, stop: string[]): SearchNode | null => {
    const parts: SearchNode[] = [];
    while (pos < toks.length) {
      const t = peek();
      if (stop.includes(t.t) || t.t === "OR") break;
      if (t.t === "AND") {
        pos++;
        continue;
      }
      const u = parseUnary(field, stop);
      if (u) parts.push(u);
    }
    if (!parts.length) return null;
    return flatten("and", parts);
  };

  const parseUnary = (field: string | null, stop: string[]): SearchNode | null => {
    const t = peek();
    if (t.t === "-") {
      pos++;
      if (pos >= toks.length || stop.includes(peek().t)) return field ? null : { type: "term", field: null, value: "-" };
      const inner = parseUnary(field, stop);
      return inner ? { type: "not", child: inner } : null;
    }
    return parsePrimary(field, stop);
  };

  const parsePrimary = (field: string | null, stop: string[]): SearchNode | null => {
    const t = toks[pos++];
    switch (t.t) {
      case "(": {
        const inner = parseOr(field, [")"]);
        if (peek()?.t === ")") pos++;
        return inner;
      }
      case "{": {
        const items: SearchNode[] = [];
        while (pos < toks.length && peek().t !== "}") {
          if (peek().t === "OR" || peek().t === "AND") {
            pos++;
            continue;
          }
          const u = parseUnary(field, ["}"]);
          if (u) items.push(u);
        }
        if (peek()?.t === "}") pos++;
        if (!items.length) return null;
        return flatten("or", items);
      }
      case ")":
      case "}":
        // Stray closer: ignore.
        return null;
      case "field": {
        const f = ALIASES[t.v] ?? t.v;
        const nt = peek();
        if (!nt || stop.includes(nt.t)) return { type: "term", field: f, value: "" };
        if (nt.t === "(" || nt.t === "{") return parsePrimary(f, stop);
        if (nt.t === "phrase") {
          pos++;
          return { type: "term", field: f, value: nt.v, exact: true };
        }
        if (nt.t === "word") {
          pos++;
          return { type: "term", field: f, value: nt.v };
        }
        if (nt.t === "field") {
          // "from:to:x" — treat the inner one as text.
          pos++;
          return { type: "term", field: f, value: `${nt.v}:` };
        }
        return { type: "term", field: f, value: "" };
      }
      case "phrase":
        return { type: "term", field, value: t.v, exact: true };
      case "word":
        return t.exact ? { type: "term", field, value: t.v, exact: true } : { type: "term", field, value: t.v };
      case "OR":
      case "AND":
      case "-":
        return null;
    }
  };

  const root = parseOr(null, []);
  // Anything left over (unbalanced closers) is parsed as further AND terms.
  const rest: SearchNode[] = [];
  while (pos < toks.length) {
    pos++;
    const more = parseOr(null, []);
    if (more) rest.push(more);
  }
  if (rest.length) return flatten("and", [root, ...rest].filter(Boolean) as SearchNode[]);
  return root;
}

const needsQuote = (v: string) => v === "" || /[\s(){}"]/.test(v) || v === "OR" || v === "AND";

export function serialize(node: SearchNode | null, parent: "and" | "or" | "not" | null = null): string {
  if (!node) return "";
  switch (node.type) {
    case "term": {
      const v = node.exact || needsQuote(node.value) ? `"${node.value}"` : node.value;
      return node.field ? `${node.field}:${v}` : v;
    }
    case "not":
      return `-${serialize(node.child, "not")}`;
    case "and": {
      const s = node.children.map((c) => serialize(c, "and")).join(" ");
      return parent === "not" || parent === "or" ? `(${s})` : s;
    }
    case "or": {
      const s = node.children.map((c) => serialize(c, "or")).join(" OR ");
      return parent ? `(${s})` : s;
    }
  }
}

/** Top-level AND terms (for chips and the advanced-search form). */
export function topTerms(node: SearchNode | null): SearchNode[] {
  if (!node) return [];
  return node.type === "and" ? node.children : [node];
}

export function joinTerms(terms: SearchNode[]): SearchNode | null {
  if (!terms.length) return null;
  return terms.length === 1 ? terms[0] : { type: "and", children: terms };
}

// ---- dates and sizes ----

/** "2024/01/31", "2024-1-31", "01/31/2024", unix seconds → local midnight Date (or the exact instant for unix). */
export function parseSearchDate(v: string): Date | null {
  const s = v.trim();
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000);
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

/** older_than/newer_than: "2d", "3m", "1y" (and "4h"), relative to now. */
export function parseRelative(v: string, now: Date): Date | null {
  const m = v.trim().match(/^(\d+)([hdmy])$/i);
  if (!m) return null;
  const n = +m[1];
  const d = new Date(now);
  switch (m[2].toLowerCase()) {
    case "h":
      d.setHours(d.getHours() - n);
      break;
    case "d":
      d.setDate(d.getDate() - n);
      break;
    case "m":
      d.setMonth(d.getMonth() - n);
      break;
    case "y":
      d.setFullYear(d.getFullYear() - n);
      break;
  }
  return d;
}

/** "10M", "500K", "2000", "1.5MB" → bytes. */
export function parseSize(v: string): number | null {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!m) return null;
  const mult = { "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Math.round(parseFloat(m[1]) * mult);
}

export const formatSearchDate = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
