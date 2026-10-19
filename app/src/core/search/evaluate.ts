// Evaluate a parsed query against one message (browser preview, client-side checks, local filters in the UI).
// The app's offline index does the same in SQL (src-tauri/src/search.rs).
import type { Address } from "../addresses";
import { parseQuery, parseRelative, parseSearchDate, parseSize, type SearchNode } from "./parser";

export interface SearchableMessage {
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  deliveredTo?: string[];
  subject: string;
  body: string;
  /** Label ids and display names, any case. */
  labels: string[];
  unread: boolean;
  starred: boolean;
  important: boolean;
  snoozed?: boolean;
  muted?: boolean;
  starType?: string | null;
  attachmentNames: string[];
  hasCalendar?: boolean;
  size: number;
  date: number; // ms
  listId?: string | null;
  messageId?: string | null;
  category?: string | null; // primary | social | promotions | updates | forums
  hasUserLabels?: boolean;
}

const lc = (s: string) => s.toLowerCase();
const addrText = (list: Address[]) => list.map((a) => `${a.name} ${a.email}`.toLowerCase()).join(" ");
const tokensOf = (s: string) => lc(s).split(/[^\p{L}\p{N}@._+-]+/u).filter(Boolean);

function textMatch(hay: string, needle: string, exact: boolean): boolean {
  const h = lc(hay);
  const n = lc(needle).trim();
  if (!n) return true;
  if (exact) return h.includes(n);
  // Word-prefix match like a full-text index: every word of the needle must start some word of the hay.
  const words = tokensOf(h);
  return tokensOf(n).every((w) => words.some((x) => x.startsWith(w)) || h.includes(w));
}

const STAR_NAMES = ["yellow-star", "orange-star", "red-star", "purple-star", "blue-star", "green-star", "red-bang", "orange-guillemet", "yellow-bang", "green-check", "blue-info", "purple-question"];

const labelKey = (s: string) => lc(s).replace(/[\s/_]+/g, "-");

export function matchesNode(node: SearchNode, m: SearchableMessage, now = new Date()): boolean {
  switch (node.type) {
    case "and":
      return node.children.every((c) => matchesNode(c, m, now));
    case "or":
      return node.children.some((c) => matchesNode(c, m, now));
    case "not":
      return !matchesNode(node.child, m, now);
    case "term":
      return term(node.field, node.value, !!node.exact, m, now);
  }
}

function term(field: string | null, value: string, exact: boolean, m: SearchableMessage, now: Date): boolean {
  const v = lc(value);
  const labels = m.labels.map(labelKey);
  switch (field) {
    case null: {
      const hay = [m.subject, m.body, addrText(m.from), addrText(m.to), addrText(m.cc), m.attachmentNames.join(" ")].join(" \n ");
      return textMatch(hay, value, exact);
    }
    case "from":
      return v === "me" ? m.labels.some((l) => lc(l) === "sent") : textMatch(addrText(m.from), value, exact);
    case "to":
      return textMatch(addrText(m.to) + " " + (m.deliveredTo ?? []).join(" "), value, exact);
    case "cc":
      return textMatch(addrText(m.cc), value, exact);
    case "bcc":
      return textMatch(addrText(m.bcc), value, exact);
    case "subject":
      return textMatch(m.subject, value, exact);
    case "deliveredto":
      return (m.deliveredTo ?? []).some((d) => lc(d).includes(v)) || textMatch(addrText(m.to), value, exact);
    case "list":
      return !!m.listId && lc(m.listId).includes(v);
    case "rfc822msgid":
      return !!m.messageId && lc(m.messageId).replace(/[<>]/g, "") === v.replace(/[<>]/g, "");
    case "filename":
      return m.attachmentNames.some((n) => lc(n).includes(v) || lc(n).endsWith(`.${v}`));
    case "label":
      return labels.includes(labelKey(value)) || labels.some((l) => l.startsWith(labelKey(value) + "-"));
    case "category": {
      const c = v === "personal" ? "primary" : v;
      return (m.category ?? "primary") === c;
    }
    case "in":
      switch (v) {
        case "anywhere":
          return true;
        case "inbox":
        case "sent":
        case "drafts":
        case "draft":
        case "spam":
        case "trash":
        case "chats":
          return labels.includes(v === "drafts" ? "draft" : v) || (v === "drafts" && labels.includes("drafts"));
        case "snoozed":
          return !!m.snoozed;
        case "starred":
          return m.starred;
        case "important":
          return m.important;
        default:
          return labels.includes(labelKey(value));
      }
    case "is":
      switch (v) {
        case "unread":
          return m.unread;
        case "read":
          return !m.unread;
        case "starred":
          return m.starred;
        case "important":
          return m.important;
        case "snoozed":
          return !!m.snoozed;
        case "muted":
          return !!m.muted;
        default:
          return false;
      }
    case "has":
      if (v === "attachment") return m.attachmentNames.length > 0;
      if (v === "userlabels") return !!m.hasUserLabels;
      if (v === "nouserlabels") return !m.hasUserLabels;
      if (v === "calendar" || v === "invite") return !!m.hasCalendar;
      if (STAR_NAMES.includes(v)) return m.starred && (m.starType ?? "yellow-star") === v;
      return false;
    case "larger":
    case "size": {
      const n = parseSize(value);
      return n != null && m.size > n;
    }
    case "smaller": {
      const n = parseSize(value);
      return n != null && m.size < n;
    }
    case "before": {
      const d = parseSearchDate(value);
      return d != null && m.date < d.getTime();
    }
    case "after": {
      const d = parseSearchDate(value);
      return d != null && m.date >= d.getTime();
    }
    case "older_than": {
      const d = parseRelative(value, now);
      return d != null && m.date < d.getTime();
    }
    case "newer_than": {
      const d = parseRelative(value, now);
      return d != null && m.date >= d.getTime();
    }
    default:
      return textMatch(m.subject + " " + m.body, `${field}:${value}`, exact);
  }
}

export function matches(query: string, m: SearchableMessage, now = new Date()): boolean {
  const node = parseQuery(query);
  return node ? matchesNode(node, m, now) : true;
}

/** Free-text words of a query (for highlighting matches in the list and conversation). */
export function highlightTerms(node: SearchNode | null): string[] {
  if (!node) return [];
  switch (node.type) {
    case "and":
    case "or":
      return node.children.flatMap(highlightTerms);
    case "not":
      return [];
    case "term":
      return node.field === null || node.field === "subject" ? [node.value] : [];
  }
}
