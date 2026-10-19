// The advanced-search form, search chips and filter criteria, all expressed as query strings.
import { formatSearchDate, joinTerms, parseQuery, parseSearchDate, serialize, topTerms, type SearchNode } from "./parser";

export interface AdvancedFields {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  doesntHave: string;
  sizeOp: "larger" | "smaller";
  size: string; // number as typed
  sizeUnit: "MB" | "KB" | "bytes";
  dateWithin: string; // "" or one of DATE_WITHIN keys
  date: string; // YYYY/MM/DD
  searchIn: string; // "anywhere" | "inbox" | "starred" | label name …
  hasAttachment: boolean;
}

export const EMPTY_ADVANCED: AdvancedFields = {
  from: "",
  to: "",
  subject: "",
  hasWords: "",
  doesntHave: "",
  sizeOp: "larger",
  size: "",
  sizeUnit: "MB",
  dateWithin: "",
  date: "",
  searchIn: "anywhere",
  hasAttachment: false,
};

export const DATE_WITHIN: Record<string, number> = {
  "1 day": 1,
  "3 days": 3,
  "1 week": 7,
  "2 weeks": 14,
  "1 month": 30,
  "2 months": 60,
  "6 months": 182,
  "1 year": 365,
};

const wrap = (field: string, v: string) => {
  const t = v.trim();
  if (!t) return "";
  if (/^\(.*\)$/.test(t) || /^".*"$/.test(t)) return `${field}:${t}`;
  return /\s/.test(t) ? `${field}:(${t})` : `${field}:${t}`;
};

export function fromAdvanced(f: AdvancedFields): string {
  const parts: string[] = [];
  if (f.from.trim()) parts.push(wrap("from", f.from));
  if (f.to.trim()) parts.push(wrap("to", f.to));
  if (f.subject.trim()) parts.push(wrap("subject", f.subject));
  if (f.hasWords.trim()) parts.push(f.hasWords.trim());
  if (f.doesntHave.trim()) {
    const words = f.doesntHave.trim();
    parts.push(/\s/.test(words) ? `-{${words}}` : `-${words}`);
  }
  if (f.size.trim() && Number(f.size) > 0) {
    const unit = f.sizeUnit === "MB" ? "M" : f.sizeUnit === "KB" ? "K" : "";
    parts.push(`${f.sizeOp}:${f.size.trim()}${unit}`);
  }
  if (f.dateWithin && f.date) {
    const d = parseSearchDate(f.date);
    const n = DATE_WITHIN[f.dateWithin];
    if (d && n) {
      const after = new Date(d);
      after.setDate(after.getDate() - n);
      const before = new Date(d);
      before.setDate(before.getDate() + n + 1);
      parts.push(`after:${formatSearchDate(after)}`, `before:${formatSearchDate(before)}`);
    }
  }
  if (f.searchIn && f.searchIn !== "anywhere") {
    const s = f.searchIn;
    const builtIn = ["inbox", "starred", "sent", "drafts", "spam", "trash", "important", "snoozed", "chats"];
    parts.push(builtIn.includes(s.toLowerCase()) ? `in:${s.toLowerCase()}` : `label:${s.replace(/\s+/g, "-")}`);
  }
  if (f.hasAttachment) parts.push("has:attachment");
  return parts.join(" ");
}

function termText(n: SearchNode): string | null {
  if (n.type === "term" && n.field === null) return n.exact ? `"${n.value}"` : n.value;
  return null;
}

function fieldValue(n: SearchNode, field: string): string | null {
  if (n.type === "term" && n.field === field) return n.exact ? `"${n.value}"` : n.value;
  if ((n.type === "and" || n.type === "or") && n.children.every((c) => c.type === "term" && c.field === field)) {
    const vals = n.children.map((c) => (c as { value: string }).value);
    return n.type === "or" ? vals.join(" OR ") : vals.join(" ");
  }
  return null;
}

/** Fill the form from a query (best effort: anything it can't represent goes into "Has the words"). */
export function toAdvanced(query: string): AdvancedFields {
  const f: AdvancedFields = { ...EMPTY_ADVANCED };
  const words: string[] = [];
  let after: Date | null = null;
  let before: Date | null = null;
  for (const t of topTerms(parseQuery(query))) {
    const from = fieldValue(t, "from");
    const to = fieldValue(t, "to");
    const subject = fieldValue(t, "subject");
    const add = (cur: string, v: string) => (cur ? `${cur} ${v}` : v);
    if (from != null) f.from = add(f.from, from);
    else if (to != null) f.to = add(f.to, to);
    else if (subject != null) f.subject = add(f.subject, subject);
    else if (t.type === "term" && (t.field === "larger" || t.field === "smaller" || t.field === "size")) {
      const m = t.value.match(/^(\d+(?:\.\d+)?)([kKmM]?)/);
      if (m) {
        f.sizeOp = t.field === "smaller" ? "smaller" : "larger";
        f.size = m[1];
        f.sizeUnit = m[2].toLowerCase() === "m" ? "MB" : m[2].toLowerCase() === "k" ? "KB" : "bytes";
      }
    } else if (t.type === "term" && t.field === "after") after = parseSearchDate(t.value);
    else if (t.type === "term" && t.field === "before") before = parseSearchDate(t.value);
    else if (t.type === "term" && t.field === "has" && t.value.toLowerCase() === "attachment") f.hasAttachment = true;
    else if (t.type === "term" && t.field === "in") f.searchIn = t.value.toLowerCase();
    else if (t.type === "term" && t.field === "label") f.searchIn = t.value;
    else if (t.type === "not") {
      const inner = t.child;
      if (inner.type === "or" && inner.children.every((c) => termText(c) != null)) f.doesntHave = inner.children.map((c) => termText(c)).join(" ");
      else if (termText(inner) != null) f.doesntHave = termText(inner)!;
      else words.push(serialize(t));
    } else {
      const w = termText(t);
      words.push(w ?? serialize(t));
    }
  }
  if (after && before) {
    const span = Math.round((before.getTime() - after.getTime()) / 86400000);
    const n = Math.floor((span - 1) / 2);
    const key = Object.entries(DATE_WITHIN).find(([, v]) => v === n)?.[0];
    if (key) {
      const mid = new Date(after);
      mid.setDate(mid.getDate() + n);
      f.dateWithin = key;
      f.date = formatSearchDate(mid);
    } else words.push(`after:${formatSearchDate(after)}`, `before:${formatSearchDate(before)}`);
  } else if (after) words.push(`after:${formatSearchDate(after)}`);
  else if (before) words.push(`before:${formatSearchDate(before)}`);
  f.hasWords = words.join(" ");
  return f;
}

// ---- chips under the search box ----

export type ChipKind = "from" | "time" | "attachment" | "to" | "unread";

/** Add, replace or remove one chip's term in a query. */
export function setChip(query: string, kind: ChipKind, value: string | null): string {
  let terms = topTerms(parseQuery(query));
  const isKind = (t: SearchNode) => {
    if (t.type !== "term") return false;
    if (kind === "from") return t.field === "from";
    if (kind === "to") return t.field === "to";
    if (kind === "attachment") return t.field === "has" && t.value === "attachment";
    if (kind === "unread") return t.field === "is" && t.value === "unread";
    return t.field === "newer_than" || t.field === "older_than" || t.field === "after" || t.field === "before";
  };
  terms = terms.filter((t) => !isKind(t));
  if (value != null) {
    const add =
      kind === "attachment"
        ? "has:attachment"
        : kind === "unread"
          ? "is:unread"
          : kind === "time"
            ? value
            : `${kind}:${/\s/.test(value) ? `"${value}"` : value}`;
    const node = parseQuery(add);
    if (node) terms.push(...topTerms(node));
  }
  return serialize(joinTerms(terms));
}

export function chipState(query: string): Record<ChipKind, string | null> {
  const out: Record<ChipKind, string | null> = { from: null, time: null, attachment: null, to: null, unread: null };
  for (const t of topTerms(parseQuery(query))) {
    if (t.type !== "term") continue;
    if (t.field === "from") out.from = t.value;
    else if (t.field === "to") out.to = t.value;
    else if (t.field === "has" && t.value === "attachment") out.attachment = "yes";
    else if (t.field === "is" && t.value === "unread") out.unread = "yes";
    else if (t.field === "newer_than" || t.field === "older_than" || t.field === "after" || t.field === "before") out.time = `${t.field}:${t.value}`;
  }
  return out;
}

/** "Any time" chip presets (label, query term). */
export const TIME_CHIPS: [string, string][] = [
  ["Older than a week", "older_than:7d"],
  ["Older than a month", "older_than:1m"],
  ["Older than 6 months", "older_than:6m"],
  ["Older than a year", "older_than:1y"],
];

// ---- filters (Gmail API users.settings.filters criteria) ----

export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "larger" | "smaller";
}

export interface FilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

export function criteriaFromAdvanced(f: AdvancedFields): FilterCriteria {
  const c: FilterCriteria = {};
  if (f.from.trim()) c.from = f.from.trim();
  if (f.to.trim()) c.to = f.to.trim();
  if (f.subject.trim()) c.subject = f.subject.trim();
  if (f.hasWords.trim()) c.query = f.hasWords.trim();
  if (f.doesntHave.trim()) c.negatedQuery = f.doesntHave.trim();
  if (f.hasAttachment) c.hasAttachment = true;
  if (f.size.trim() && Number(f.size) > 0) {
    const mult = f.sizeUnit === "MB" ? 1024 * 1024 : f.sizeUnit === "KB" ? 1024 : 1;
    c.size = Math.round(Number(f.size) * mult);
    c.sizeComparison = f.sizeOp;
  }
  return c;
}

/** The query a filter's criteria stand for (used to preview matches and to run local filters). */
export function criteriaToQuery(c: FilterCriteria): string {
  const parts: string[] = [];
  if (c.from) parts.push(wrap("from", c.from));
  if (c.to) parts.push(wrap("to", c.to));
  if (c.subject) parts.push(wrap("subject", c.subject));
  if (c.query) parts.push(c.query);
  if (c.negatedQuery) parts.push(/\s/.test(c.negatedQuery) ? `-{${c.negatedQuery}}` : `-${c.negatedQuery}`);
  if (c.hasAttachment) parts.push("has:attachment");
  if (c.size && c.sizeComparison) parts.push(`${c.sizeComparison}:${c.size}`);
  return parts.join(" ");
}

export function describeCriteria(c: FilterCriteria): string {
  const bits: string[] = [];
  if (c.from) bits.push(`from:(${c.from})`);
  if (c.to) bits.push(`to:(${c.to})`);
  if (c.subject) bits.push(`subject:(${c.subject})`);
  if (c.query) bits.push(c.query);
  if (c.negatedQuery) bits.push(`-{${c.negatedQuery}}`);
  if (c.hasAttachment) bits.push("has:attachment");
  if (c.size && c.sizeComparison) bits.push(`${c.sizeComparison}:${c.size}`);
  return bits.join(" ");
}

export function describeActions(a: FilterAction, labelName: (id: string) => string): string[] {
  const out: string[] = [];
  const add = a.addLabelIds ?? [];
  const remove = a.removeLabelIds ?? [];
  if (remove.includes("INBOX")) out.push("Skip Inbox");
  if (remove.includes("UNREAD")) out.push("Mark as read");
  if (add.includes("STARRED")) out.push("Star it");
  if (add.includes("TRASH")) out.push("Delete it");
  if (remove.includes("SPAM")) out.push("Never send it to Spam");
  if (add.includes("IMPORTANT")) out.push("Always mark it as important");
  if (remove.includes("IMPORTANT")) out.push("Never mark it as important");
  for (const id of add) {
    if (id.startsWith("CATEGORY_")) out.push(`Categorize as ${id.slice(9).toLowerCase().replace(/^personal$/, "primary")}`);
    else if (!["STARRED", "TRASH", "IMPORTANT", "INBOX", "UNREAD"].includes(id)) out.push(`Apply label "${labelName(id)}"`);
  }
  if (a.forward) out.push(`Forward to ${a.forward}`);
  return out;
}
