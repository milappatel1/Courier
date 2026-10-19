// Threading and conversation display: reference-based threading (JWZ-style, for local/IMAP mail and the
// browser preview), subject normalisation, participant summaries and which messages start expanded.
import { displayName, normalizeEmail, shortName, type Address } from "./addresses";

const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|r|ynt|odp|res|enc)(\[\d+\])?\s*:\s*|\[[^\]]{1,40}\]\s*)+/i;

/** "Re: [list] Fwd: Lunch" → "Lunch" (for grouping only; display keeps the original). */
export function normalizeSubject(s: string): string {
  let prev = "";
  let cur = s.trim();
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(PREFIX, "").trim();
  }
  return cur.toLowerCase().replace(/\s+/g, " ");
}

export interface ThreadInput {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  date: number;
}

/** Group messages into threads. Returns message id → thread key (the root Message-ID, or a subject key). */
export function threadMessages(msgs: ThreadInput[], opts: { subjectWindowDays?: number } = {}): Map<string, string> {
  const window = (opts.subjectWindowDays ?? 30) * 86400000;
  const parent = new Map<string, string>(); // union-find over message-ids
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    // path compression
    let c = x;
    while (parent.has(c) && parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const keyOf = (m: ThreadInput) => m.messageId ?? `local:${m.id}`;
  const sorted = [...msgs].sort((a, b) => a.date - b.date);
  for (const m of sorted) {
    const k = keyOf(m);
    if (!parent.has(k)) parent.set(k, k);
    const refs = [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])];
    for (const r of refs) union(r, k);
  }
  // Subject fallback: messages with no references whose normalised subject matches a recent thread.
  const bySubject = new Map<string, { root: string; last: number }>();
  for (const m of sorted) {
    const k = keyOf(m);
    const subj = normalizeSubject(m.subject);
    const hasRefs = m.references.length > 0 || !!m.inReplyTo;
    const isReply = PREFIX.test(m.subject);
    const prev = subj ? bySubject.get(subj) : undefined;
    if (prev && !hasRefs && isReply && m.date - prev.last <= window) union(prev.root, k);
    if (subj) bySubject.set(subj, { root: find(k), last: m.date });
  }
  const out = new Map<string, string>();
  for (const m of msgs) out.set(m.id, find(keyOf(m)));
  return out;
}

export interface ConversationMessage {
  id: string;
  unread: boolean;
  isDraft?: boolean;
  date: number;
}

export type ConversationItem = { kind: "message"; id: string; expanded: boolean } | { kind: "collapsed"; ids: string[] };

/**
 * Which messages start expanded: every unread one, any draft, and the last; the rest collapse to a one-line
 * summary. A run of more than three collapsed messages in the middle folds into a single "N more" pill.
 */
/** `unfold`: the fold was opened, so every message is listed (still collapsed unless it would be expanded). */
export function conversationLayout(
  messages: ConversationMessage[],
  opts: { expandAll?: boolean; focusId?: string; unfold?: boolean } = {},
): ConversationItem[] {
  if (!messages.length) return [];
  const last = messages[messages.length - 1].id;
  const items: ConversationItem[] = messages.map((m) => ({
    kind: "message",
    id: m.id,
    expanded: !!opts.expandAll || m.unread || !!m.isDraft || m.id === last || m.id === opts.focusId,
  }));
  if (opts.expandAll || opts.unfold) return items;
  const out: ConversationItem[] = [];
  let run: string[] = [];
  const flushRun = (atStart: boolean) => {
    if (run.length > 3 && !atStart) {
      // Keep the first collapsed one visible, fold the rest.
      out.push({ kind: "message", id: run[0], expanded: false });
      out.push({ kind: "collapsed", ids: run.slice(1) });
    } else for (const id of run) out.push({ kind: "message", id, expanded: false });
    run = [];
  };
  items.forEach((it, i) => {
    if (it.kind === "message" && !it.expanded && i !== 0) run.push(it.id);
    else {
      flushRun(false);
      out.push(it);
    }
  });
  flushRun(false);
  return out;
}

export interface ParticipantMessage {
  from: Address;
  unread: boolean;
  isDraft?: boolean;
}

export interface ParticipantPart {
  text: string;
  bold: boolean;
  draft?: boolean;
}

/**
 * The sender column of a conversation row: "me", one name, or "Alice, Bob, me" with first names, unread
 * participants in bold, plus the message count shown separately. Drafts appear as a red "Draft".
 */
export function participants(messages: ParticipantMessage[], self: string[], max = 3): { parts: ParticipantPart[]; count: number } {
  const selfSet = new Set(self.map(normalizeEmail));
  const seen = new Map<string, ParticipantPart & { order: number }>();
  let order = 0;
  let draft = false;
  for (const m of messages) {
    if (m.isDraft) {
      draft = true;
      continue;
    }
    const k = normalizeEmail(m.from.email);
    const isSelf = selfSet.has(k);
    const label = isSelf ? "me" : messages.length > 1 ? shortName(m.from) : displayName(m.from);
    const existing = seen.get(k);
    if (existing) {
      existing.bold ||= m.unread;
      // Most recent position wins so the latest senders sort last.
      existing.order = order++;
    } else seen.set(k, { text: label, bold: m.unread, order: order++ });
  }
  let list = [...seen.values()].sort((a, b) => a.order - b.order);
  if (list.length > max) list = [list[0], { text: "..", bold: false, order: -1 }, ...list.slice(-(max - 1))];
  const parts: ParticipantPart[] = list.map(({ text, bold }) => ({ text, bold }));
  if (draft) parts.push({ text: "Draft", bold: false, draft: true });
  const count = messages.filter((m) => !m.isDraft).length;
  return { parts, count: count > 1 ? count : 0 };
}

/** Plain-text form of participants (accessibility labels, notifications). */
export const participantsText = (p: { parts: ParticipantPart[]; count: number }) => p.parts.map((x) => x.text).join(", ") + (p.count ? ` ${p.count}` : "");
