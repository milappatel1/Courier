// Browser preview of Courier's UI (npm run dev, then /browser-preview.html): an in-memory stand-in for the
// Rust side so every screen can be checked in a plain browser. The sample mailbox matches the recon seed
// (research/tools/seed-recon.mjs) so the preview can be compared with the goldens. Not part of the app build.
import { buildMime } from "../src/core/mime/build";
import "../src/e2e/layout";
import { parseMessage } from "../src/core/mime/parse";
import { base64Decode, base64Encode } from "../src/core/bytes";
import { matches, type SearchableMessage } from "../src/core/search/evaluate";
import { parseQuery } from "../src/core/search/parser";
import { snippetOf, htmlToText } from "../src/core/text";
import { normalizeSubject } from "../src/core/threading";
import type { Account, Label, ThreadSummary, ViewQuery } from "../src/ipc/types";

type Args = Record<string, unknown>;
(window as unknown as { __COURIER_PREVIEW__: boolean }).__COURIER_PREVIEW__ = true;

interface Msg {
  accountId: string;
  id: string;
  threadId: string;
  date: number;
  labels: string[];
  raw: Uint8Array;
  starType?: string | null;
}

const ME = { name: "Pat Example", email: "pat@example.com" };
const ME2 = { name: "Pat", email: "pat@example.org" };
const now = new Date();
const at = (daysAgo: number, h: number, m: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const accounts: Account[] = [
  { id: "g1", kind: "gmail", email: ME.email, name: ME.name, color: "#1a73e8", position: 0, photo: null, needsReauth: false, aliases: [ME.email], config: {} },
  {
    id: "i1",
    kind: "imap",
    email: ME2.email,
    name: ME2.name,
    color: "#0b8043",
    position: 1,
    photo: null,
    needsReauth: false,
    aliases: [ME2.email],
    config: {
      imap: { host: "imap.example.org", port: 993, security: "tls", username: ME2.email },
      smtp: { host: "smtp.example.org", port: 465, security: "tls", username: ME2.email },
      saveSent: true,
      initialWindow: 500,
    },
  },
];

const userLabels: Record<string, Label[]> = { g1: [], i1: [] };
const mkLabel = (accountId: string, id: string, name: string, type: "system" | "user", bg: string | null = null): Label => ({
  accountId,
  id,
  name,
  type,
  bg,
  fg: bg ? "#ffffff" : null,
  labelListVisibility: "labelShow",
  messageListVisibility: "show",
  threadsTotal: 0,
  threadsUnread: 0,
  messagesTotal: 0,
  messagesUnread: 0,
  imapPath: null,
  imapDelimiter: "/",
  special: null,
});
const SYSTEM = [
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
userLabels.g1 = [
  mkLabel("g1", "Label_1", "Projects", "user"),
  mkLabel("g1", "Label_2", "Projects/Alpha", "user"),
  mkLabel("g1", "Label_3", "Receipts", "user"),
];
userLabels.i1 = [mkLabel("i1", "F:Club", "Club", "user", "#16a766")];

const msgs: Msg[] = [];
let seq = 1;
const pdf = new TextEncoder().encode("%PDF-1.4\n% Quarterly plan - sample\n");
const png = base64Decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

function add(
  accountId: string,
  o: {
    from: { name: string; email: string };
    to: { name: string; email: string }[];
    subject: string;
    html?: string;
    text?: string;
    date: number;
    labels: string[];
    threadId?: string;
    attachments?: { filename: string; mimeType: string; data: Uint8Array }[];
    star?: string;
    headers?: Record<string, string>;
    inReplyTo?: string;
    calendar?: { method: string; text: string };
  },
) {
  const built = buildMime({
    from: o.from,
    to: o.to,
    subject: o.subject,
    html: o.html ?? null,
    text: o.text ?? null,
    attachments: o.attachments,
    calendar: o.calendar,
    date: new Date(o.date),
    headers: o.headers,
    inReplyTo: o.inReplyTo ?? null,
    references: o.inReplyTo ? [o.inReplyTo] : [],
  });
  const id = `m${seq++}`;
  msgs.push({ accountId, id, threadId: o.threadId ?? `t${id}`, date: o.date, labels: o.labels, raw: built.raw, starType: o.star ?? null });
  return { id, messageId: built.messageId };
}

// The recon seed: self-sent mail, one thread of three, labels and attachments.
const lunch = add("g1", {
  from: ME,
  to: [ME],
  subject: "Lunch on Friday?",
  html: "<div>Are you free for lunch on Friday? The new noodle place on 3rd street opened last week.</div>",
  date: at(0, 20, 6),
  labels: ["INBOX", "SENT", "CATEGORY_PERSONAL", "Label_1"],
  threadId: "tLunch",
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Re: Lunch on Friday?",
  html: "<div>Friday works for me. Noon at the noodle place?</div>",
  date: at(0, 20, 8),
  labels: ["INBOX", "SENT", "CATEGORY_PERSONAL", "Label_1"],
  threadId: "tLunch",
  inReplyTo: lunch.messageId,
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Re: Lunch on Friday?",
  html: "<div>Noon is perfect, see you there. I will book a table for four.</div>",
  date: at(0, 20, 8) + 1000,
  labels: ["INBOX", "SENT", "UNREAD", "CATEGORY_PERSONAL", "Label_1", "STARRED"],
  threadId: "tLunch",
  inReplyTo: lunch.messageId,
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Reading list for next week",
  html: "<div>A few articles worth reading before the workshop: one on caching strategies, one on offline-first apps, and a short one on accessible colour palettes.</div>",
  date: at(0, 20, 6) - 1000,
  labels: ["INBOX", "SENT", "CATEGORY_PERSONAL"],
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Invoice #1042 for October",
  html: "<div>Your invoice #1042 for October is ready. Amount due: $240.00, payable by November 15.</div>",
  date: at(0, 20, 6) - 2000,
  labels: ["INBOX", "SENT", "UNREAD", "CATEGORY_PERSONAL", "Label_3"],
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Weekly status: design review",
  html: "<div>Status for this week:</div><div>- Inbox redesign: review done, two follow-ups</div><div>- Settings page: in progress</div><div>- Accessibility audit: scheduled for Monday</div>",
  date: at(0, 20, 6) - 3000,
  labels: ["INBOX", "SENT", "UNREAD", "CATEGORY_PERSONAL", "Label_1"],
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Photos from the offsite",
  html: '<div>Here\'s the photo from the team offsite by the lake.</div><div>More to come once everyone uploads theirs.</div><div><img src="cid:photo1@courier" alt="offsite"></div>',
  date: at(0, 20, 5),
  labels: ["INBOX", "SENT", "UNREAD", "CATEGORY_PERSONAL", "STARRED"],
  attachments: [],
});
add("g1", {
  from: ME,
  to: [ME],
  subject: "Quarterly planning notes",
  html: "<div>Hi,</div><div>Attached are the planning notes for next quarter. The main themes are onboarding, search speed and the new billing page.</div><div>Let me know what you think before Thursday.</div>",
  date: at(0, 20, 5) - 1000,
  labels: ["INBOX", "SENT", "UNREAD", "CATEGORY_PERSONAL", "Label_2"],
  attachments: [{ filename: "quarterly-plan.pdf", mimeType: "application/pdf", data: pdf }],
});
// Other categories and folders.
add("g1", {
  from: { name: "Daily Deals", email: "news@deals.example" },
  to: [ME],
  subject: "48 hours only: 30% off",
  html: '<h1>Big sale</h1><p>Save on everything.</p><img src="https://cdn.deals.example/banner.png" width="600" height="200"><img src="https://t.deals.example/o.gif" width="1" height="1">',
  date: at(1, 8, 0),
  labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  headers: { "List-Unsubscribe": "<https://deals.example/u/1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
});
add("g1", {
  from: { name: "Social Site", email: "notify@social.example" },
  to: [ME],
  subject: "You have 3 new followers",
  text: "See who's following you.",
  date: at(2, 12, 0),
  labels: ["INBOX", "CATEGORY_SOCIAL"],
});
add("g1", {
  from: { name: "Shop Updates", email: "updates@shop.example" },
  to: [ME],
  subject: "Your order has shipped",
  text: "Order 5531 is on its way.",
  date: at(1, 9, 30),
  labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
});
add("g1", {
  from: ME,
  to: [{ name: "Ana Lima", email: "ana@friends.example" }],
  subject: "Photos from the trip",
  text: "Here are the photos.",
  date: at(4, 18, 0),
  labels: ["SENT"],
});
add("g1", {
  from: { name: "Old Friend", email: "old@friends.example" },
  to: [ME],
  subject: "Catching up",
  text: "Long time no see!",
  date: at(40, 9, 0),
  labels: [],
});
add("g1", {
  from: { name: "Prize Desk", email: "win@spam.example" },
  to: [ME],
  subject: "You won!!!",
  text: "Claim now.",
  date: at(3, 3, 0),
  labels: ["SPAM", "UNREAD"],
});
add("i1", {
  from: { name: "Eli Park", email: "eli@club.example" },
  to: [ME2],
  subject: "Club meeting Thursday",
  text: "Meeting moved to Thursday at 7.",
  date: at(0, 8, 15),
  labels: ["INBOX", "UNREAD"],
});
add("i1", {
  from: { name: "Fay Wong", email: "fay@club.example" },
  to: [ME2],
  subject: "Train tickets",
  text: "Tickets for the trip are booked.",
  date: at(2, 14, 0),
  labels: ["INBOX", "F:Club"],
});
// Layout stress tests (shapes real newsletters use): a full-height page, a fixed-width layout, a long message.
add("g1", {
  from: { name: "Full Height News", email: "news@tall.example" },
  to: [ME],
  subject: "Full-height newsletter",
  html: '<style>html,body{height:100%;margin:0}.wrap{min-height:100vh}</style><table width="100%" height="100%" style="height:100%"><tr><td class="wrap" style="height:100%;vertical-align:top"><h2>Autumn issue</h2><p>Short body in a page that asks for the full window height.</p><p>TALL-END</p></td></tr></table>',
  date: at(0, 7, 30),
  labels: ["INBOX", "CATEGORY_PERSONAL"],
});
add("g1", {
  from: { name: "Wide Layout Co", email: "hello@wide.example" },
  to: [ME],
  subject: "Fixed-width newsletter",
  html: '<table width="760" style="width:760px;border-collapse:collapse"><tr><td style="width:460px;background:#eef">Left column with the main story.</td><td style="width:300px;background:#fee">Right column WIDE-RIGHT-END</td></tr></table>',
  date: at(0, 7, 20),
  labels: ["INBOX", "CATEGORY_PERSONAL"],
});
add("g1", {
  from: { name: "Long Letter", email: "long@letters.example" },
  to: [ME],
  subject: "A very long message",
  html:
    '<img alt="banner" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22600%22 height=%22400%22%3E%3Crect width=%22600%22 height=%22400%22 fill=%22%23cde%22/%3E%3C/svg%3E">' +
    Array.from({ length: 120 }, (_, i) => `<p>Paragraph ${i + 1} of a long letter.</p>`).join("") +
    "<p>LONG-LAST-LINE</p>",
  date: at(0, 7, 10),
  labels: ["INBOX", "CATEGORY_PERSONAL"],
});
// A calendar invitation.
{
  const day = new Date(Date.now() + 2 * 86400000);
  const ymd = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}`;
  add("g1", {
    from: { name: "Ana Lima", email: "ana@cal.example" },
    to: [ME],
    subject: "Invitation: Design review",
    text: "You're invited to the design review.",
    date: at(0, 7, 0),
    labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    calendar: {
      method: "REQUEST",
      text: `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nDTSTART:${ymd}T150000Z\r\nDTEND:${ymd}T160000Z\r\nUID:design-review-1@cal.example\r\nORGANIZER;CN=Ana Lima:mailto:ana@cal.example\r\nATTENDEE;CN=Pat;PARTSTAT=NEEDS-ACTION:mailto:pat@example.com\r\nSUMMARY:Design review\r\nLOCATION:Room 4\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    },
  });
}
// The offsite photo goes in as an inline image.
{
  const m = msgs.find((x) => parseMessage(x.raw).subject === "Photos from the offsite")!;
  const built = buildMime({
    from: ME,
    to: [ME],
    subject: "Photos from the offsite",
    html: '<div>Here\'s the photo from the team offsite by the lake.</div><div>More to come once everyone uploads theirs.</div><div><img src="cid:photo1@courier" alt="offsite"></div>',
    attachments: [{ filename: "offsite-photo.png", mimeType: "image/png", data: png, contentId: "photo1@courier" }],
    date: new Date(m.date),
  });
  m.raw = built.raw;
}

const drafts = new Map<string, string>(); // draft id → message id
const outbox: {
  id: number;
  accountId: string;
  raw: Uint8Array;
  sendAt: number;
  scheduled: boolean;
  threadId: string | null;
  draftId: string | null;
  attempts: number;
}[] = [];
const snoozes = new Map<string, number>(); // accountId:threadId → until
const muted = new Set<string>();
const settings: Record<string, unknown> = {};
const templates: Record<string, { id: string; accountId: string | null; name: string; subject: string; html: string }> = {};
const signatures: Record<string, { id: string; accountId: string; name: string; html: string }> = {};
const filters: Record<string, { id: string; criteria: Record<string, unknown>; action: Record<string, unknown> }[]> = { g1: [], i1: [] };
const blocked: Record<string, string[]> = { g1: [], i1: [] };
let vacation = { enableAutoReply: false, responseSubject: "", responseBodyPlainText: "", restrictToContacts: false };
const sendAs = [{ sendAsEmail: ME.email, displayName: ME.name, isPrimary: true, isDefault: true, verificationStatus: "accepted", signature: "" }];
let outboxSeq = 1;

const listeners = new Map<number, { event: string; handler: number }>();
let nextId = 1;
function emit(event: string, payload: unknown) {
  for (const [id, l] of listeners) {
    if (l.event !== event) continue;
    const cb = (window as unknown as Record<string, unknown>)[`_${l.handler}`] as ((e: unknown) => void) | undefined;
    cb?.({ event, id, payload });
  }
}

const unsubscribed = new Map<string, number>();
const parsedCache = new Map<string, ReturnType<typeof parseMessage>>();
const parsed = (m: Msg) => {
  let p = parsedCache.get(m.id);
  if (!p) {
    p = parseMessage(m.raw);
    parsedCache.set(m.id, p);
  }
  return p;
};
const has = (m: Msg, l: string) => m.labels.includes(l);

function labelsFor(accountId: string): Label[] {
  const own = msgs.filter((m) => m.accountId === accountId);
  const count = (id: string) => {
    const ms = own.filter((m) => has(m, id));
    const threads = new Set(ms.map((m) => m.threadId));
    const unreadThreads = new Set(ms.filter((m) => has(m, "UNREAD")).map((m) => m.threadId));
    return {
      threadsTotal: threads.size,
      threadsUnread: unreadThreads.size,
      messagesTotal: ms.length,
      messagesUnread: ms.filter((m) => has(m, "UNREAD")).length,
    };
  };
  const sys = accountId === "g1" ? SYSTEM : ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "ALL"];
  const out = [
    ...sys.map((id) => ({ ...mkLabel(accountId, id, id, "system"), ...count(id) })),
    ...userLabels[accountId].map((l) => ({ ...l, ...count(l.id) })),
  ];
  // Like the engine: with tabs on, a Gmail account's Inbox count covers Primary only.
  const inbox = out.find((l) => l.id === "INBOX");
  if (inbox && accountId === "g1") {
    const primary = own.filter(
      (m) => has(m, "INBOX") && has(m, "UNREAD") && !snoozes.has(`${accountId}:${m.threadId}`) && searchable(m).category === "primary",
    );
    inbox.threadsUnread = new Set(primary.map((m) => m.threadId)).size;
  }
  return out;
}

function searchable(m: Msg): SearchableMessage {
  const p = parsed(m);
  const names = userLabels[m.accountId].filter((l) => m.labels.includes(l.id)).map((l) => l.name);
  return {
    from: p.from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    body: p.text ?? "",
    labels: [...m.labels, ...names],
    unread: has(m, "UNREAD"),
    starred: has(m, "STARRED"),
    important: has(m, "IMPORTANT"),
    snoozed: snoozes.has(`${m.accountId}:${m.threadId}`),
    muted: muted.has(`${m.accountId}:${m.threadId}`),
    starType: m.starType,
    attachmentNames: p.attachments.filter((a) => !a.inline).map((a) => a.filename),
    size: m.raw.length,
    date: m.date,
    category: has(m, "CATEGORY_SOCIAL")
      ? "social"
      : has(m, "CATEGORY_PROMOTIONS")
        ? "promotions"
        : has(m, "CATEGORY_UPDATES")
          ? "updates"
          : has(m, "CATEGORY_FORUMS")
            ? "forums"
            : "primary",
    hasUserLabels: m.labels.some((l) => l.startsWith("Label_") || l.startsWith("F:")),
  };
}

function summary(accountId: string, threadId: string, inTrash: boolean): ThreadSummary | null {
  let ms = msgs.filter((m) => m.accountId === accountId && m.threadId === threadId).sort((a, b) => a.date - b.date);
  const visible = ms.filter((m) => inTrash || !(has(m, "TRASH") || has(m, "SPAM")));
  if (visible.length) ms = visible;
  if (!ms.length) return null;
  const last = ms.filter((m) => !has(m, "DRAFT")).at(-1) ?? ms[ms.length - 1];
  const p0 = parsed(ms[0]);
  const lp = parsed(last);
  const atts = ms.flatMap((m) =>
    parsed(m)
      .attachments.filter((a) => !a.inline)
      .map((a) => ({ name: a.filename, mime: a.mimeType, size: a.size })),
  );
  const key = `${accountId}:${threadId}`;
  return {
    accountId,
    threadId,
    subject: p0.subject,
    snippet: snippetOf(htmlToText(lp.html ?? lp.text ?? ""), 200, ""),
    lastDate: last.date,
    messageCount: ms.length,
    unread: ms.some((m) => has(m, "UNREAD")),
    starred: ms.some((m) => has(m, "STARRED")),
    starType: ms.find((m) => m.starType)?.starType ?? null,
    important: ms.some((m) => has(m, "IMPORTANT")),
    labels: [...new Set(ms.flatMap((m) => m.labels))],
    participants: ms.map((m) => ({
      name: parsed(m).from[0]?.name ?? "",
      email: parsed(m).from[0]?.email ?? "",
      unread: has(m, "UNREAD"),
      draft: has(m, "DRAFT"),
    })),
    hasAttachments: atts.length > 0,
    attachments: atts.slice(0, 4),
    snoozedUntil: snoozes.get(key) ?? null,
    muted: muted.has(key),
    messageIds: ms.map((m) => m.id),
    draftIds: [...drafts.entries()].filter(([, mid]) => ms.some((m) => m.id === mid)).map(([d]) => d),
    outboxId: null,
    scheduledAt: null,
    listUnsubscribe: !!lp.listUnsubscribe,
    toMe: lp.to.some((a) => a.email.startsWith("pat@")) ? (lp.to.length + lp.cc.length === 1 ? 2 : 1) : 0,
  };
}

function list(v: ViewQuery) {
  const ids = v.accountId === "all" ? accounts.map((a) => a.id) : [v.accountId];
  let threads: ThreadSummary[] = [];
  for (const accountId of ids) {
    if (v.label === "SCHEDULED" || v.label === "OUTBOX") {
      for (const o of outbox.filter((x) => x.accountId === accountId && x.scheduled === (v.label === "SCHEDULED"))) {
        const p = parseMessage(o.raw);
        threads.push({
          ...(summary(accountId, "__none", false) ?? ({} as ThreadSummary)),
          accountId,
          threadId: `outbox:${o.id}`,
          subject: p.subject,
          snippet: snippetOf(p.text ?? ""),
          lastDate: o.sendAt,
          messageCount: 1,
          unread: false,
          starred: false,
          starType: null,
          important: false,
          labels: [v.label],
          participants: p.to.map((a) => ({ name: a.name, email: a.email, unread: false, draft: false })),
          hasAttachments: false,
          attachments: [],
          snoozedUntil: null,
          muted: false,
          messageIds: [],
          draftIds: [],
          outboxId: o.id,
          scheduledAt: o.scheduled ? o.sendAt : null,
          listUnsubscribe: false,
          toMe: 0,
        });
      }
      continue;
    }
    const node = v.query ? parseQuery(v.query) : null;
    const mentionsSpamTrash = !!v.query && /\bin:(spam|trash|anywhere)\b/.test(v.query);
    const trash = v.label === "TRASH" || v.label === "SPAM" || mentionsSpamTrash;
    const pick = msgs.filter((m) => {
      if (m.accountId !== accountId) return false;
      if (!trash && (has(m, "TRASH") || has(m, "SPAM"))) return false;
      if (v.label === "SNOOZED") return snoozes.has(`${accountId}:${m.threadId}`);
      if (v.label === "ALL") return !has(m, "DRAFT") || has(m, "SENT");
      if (v.label && !has(m, v.label)) return false;
      if (v.label === "INBOX" && snoozes.has(`${accountId}:${m.threadId}`)) return false;
      if (v.category) {
        const c = searchable(m).category;
        const enabled = (settings.categories as Record<string, boolean> | undefined) ?? { social: true, promotions: true, updates: true, forums: false };
        const eff = c !== "primary" && enabled[c as "social"] ? c : "primary";
        if (eff !== v.category) return false;
      }
      if (node && !matches(v.query!, searchable(m))) return false;
      return true;
    });
    const tids = [...new Set(pick.map((m) => (v.conversations ? m.threadId : m.id)))];
    for (const t of tids) {
      if (!v.conversations) {
        const m = msgs.find((x) => x.id === t)!;
        const s = summary(accountId, m.threadId, trash)!;
        threads.push({ ...s, subject: parsed(m).subject, lastDate: m.date, messageCount: 1, messageIds: [m.id], unread: has(m, "UNREAD"), labels: m.labels });
      } else {
        const s = summary(accountId, t, trash);
        if (s) threads.push(s);
      }
    }
  }
  threads.sort((a, b) => b.lastDate - a.lastDate);
  const total = threads.length;
  const start = v.page * v.pageSize;
  return {
    threads: threads.slice(start, start + v.pageSize),
    total,
    estimate: false,
    hasMore: start + v.pageSize < total,
    nextPageToken: null,
    source: "cache" as const,
  };
}

function modify(accountId: string, ids: string[], add: string[], remove: string[]) {
  const r = [...remove];
  const a = [...add];
  if (a.includes("TRASH")) r.push("INBOX", "SPAM");
  if (a.includes("SPAM")) r.push("INBOX", "TRASH");
  if ((r.includes("TRASH") || r.includes("SPAM")) && !a.includes("INBOX") && !r.includes("INBOX")) a.push("INBOX");
  for (const m of msgs) {
    if (m.accountId !== accountId || !ids.includes(m.id)) continue;
    m.labels = [...new Set([...m.labels.filter((l) => !r.includes(l)), ...a.filter((l) => !r.includes(l))])];
  }
  emit("mail-changed", { accountId, reason: "modify" });
}

const threadMsgIds = (accountId: string, tids: string[]) => msgs.filter((m) => m.accountId === accountId && tids.includes(m.threadId)).map((m) => m.id);

function contacts(q: string) {
  const seen = new Map<string, { name: string; email: string; times: number; lastUsed: number }>();
  for (const m of msgs) {
    const p = parsed(m);
    for (const a of [...p.from, ...p.to, ...p.cc]) {
      const k = a.email.toLowerCase();
      const c = seen.get(k) ?? { name: a.name, email: a.email, times: 0, lastUsed: 0 };
      c.times++;
      c.lastUsed = Math.max(c.lastUsed, m.date);
      if (a.name) c.name = a.name;
      seen.set(k, c);
    }
  }
  const ql = q.toLowerCase();
  return [...seen.values()].filter((c) => c.email.toLowerCase().includes(ql) || c.name.toLowerCase().includes(ql)).sort((a, b) => b.times - a.times);
}

function processOutbox() {
  const due = outbox.filter((o) => o.sendAt <= Date.now());
  for (const o of due) {
    outbox.splice(outbox.indexOf(o), 1);
    const p = parseMessage(o.raw);
    const self = accounts.find((a) => a.id === o.accountId)!.email;
    const toSelf = [...p.to, ...p.cc, ...p.bcc].some((a) => a.email === self);
    const id = `m${seq++}`;
    const thread = o.threadId ?? (p.inReplyTo ? msgs.find((m) => parsed(m).messageId === p.inReplyTo)?.threadId : undefined) ?? `t${id}`;
    msgs.push({
      accountId: o.accountId,
      id,
      threadId: thread,
      date: Date.now(),
      labels: ["SENT", ...(toSelf ? ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] : [])],
      raw: o.raw,
    });
    if (o.draftId) {
      const mid = drafts.get(o.draftId);
      drafts.delete(o.draftId);
      const i = msgs.findIndex((m) => m.id === mid);
      if (i >= 0) msgs.splice(i, 1);
    }
    emit("outbox-changed", { accountId: o.accountId, sent: o.id });
    emit("message-sent", { accountId: o.accountId, outboxId: o.id, scheduled: o.scheduled });
    emit("mail-changed", { accountId: o.accountId, reason: "sent" });
  }
  for (const [k, until] of snoozes) {
    if (until > Date.now()) continue;
    snoozes.delete(k);
    const [accountId, threadId] = k.split(":");
    modify(accountId, threadMsgIds(accountId, [threadId]), ["INBOX"], []);
  }
}
setInterval(processOutbox, 400);

const preview = new URLSearchParams(location.search);
const handlers: Record<string, (a: Args) => unknown> = {
  app_info: () => ({ version: "1.0.0", e2e: false, dataDir: "/preview", online: true, platform: "macos" }),
  accounts_list: () => (preview.get("empty") === "1" ? [] : accounts),
  google_client_status: () => ({ configured: !!settings.__client, clientIdHint: settings.__client ? "preview…" : null }),
  google_client_set: () => ((settings.__client = true), null),
  google_client_clear: () => (delete settings.__client, null),
  secrets_notice: () =>
    preview.get("keychain") === "refused"
      ? "Courier couldn't open its saved sign-ins in your Keychain (denied). Accounts that need them will ask you to sign in again."
      : null,
  account_add_gmail: () => accounts[0],
  account_discover: (a) => [
    { kind: String(a.email).endsWith("gmail.com") ? "gmail" : "imap", provider: "Example", config: accounts[1].config, source: "preview", help: null },
  ],
  account_test_imap: () => null,
  account_add_imap: () => accounts[1],
  account_update: (a) => {
    const acc = accounts.find((x) => x.id === a.id)!;
    if (a.name !== undefined && a.name !== null) acc.name = String(a.name);
    if (a.color) acc.color = String(a.color);
    emit("accounts-changed", {});
    return acc;
  },
  account_remove: (a) => {
    const i = accounts.findIndex((x) => x.id === a.id);
    if (i >= 0) accounts.splice(i, 1);
    return null;
  },
  labels_list: (a) => labelsFor(String(a.accountId)),
  label_create: (a) => {
    const acc = String(a.accountId);
    const id = acc === "g1" ? `Label_${seq++}` : `F:${a.name}`;
    userLabels[acc].push(mkLabel(acc, id, String(a.name), "user", (a.bg as string) ?? null));
    return id;
  },
  label_update: (a) => {
    const l = userLabels[String(a.accountId)].find((x) => x.id === a.id);
    const p = a.patch as Record<string, unknown>;
    if (l) {
      if (p.name) l.name = String(p.name);
      if (p.color) l.bg = ((p.color as Record<string, string>).backgroundColor || null) as string | null;
      if (p.labelListVisibility) l.labelListVisibility = String(p.labelListVisibility);
      if (p.messageListVisibility) l.messageListVisibility = String(p.messageListVisibility);
    }
    return null;
  },
  label_delete: (a) => {
    userLabels[String(a.accountId)] = userLabels[String(a.accountId)].filter((l) => l.id !== a.id);
    return null;
  },
  list_threads: (a) => list(a.view as ViewQuery),
  thread_get: (a) => {
    const ms = msgs.filter((m) => m.accountId === a.accountId && m.threadId === a.threadId).sort((x, y) => x.date - y.date);
    return {
      accountId: a.accountId,
      threadId: a.threadId,
      snoozedUntil: snoozes.get(`${a.accountId}:${a.threadId}`) ?? null,
      muted: muted.has(`${a.accountId}:${a.threadId}`),
      messages: ms.map((m) => {
        const p = parsed(m);
        return {
          accountId: m.accountId,
          id: m.id,
          threadId: m.threadId,
          internalDate: m.date,
          fromName: p.from[0]?.name ?? "",
          fromEmail: p.from[0]?.email ?? "",
          to: p.to,
          cc: p.cc,
          bcc: p.bcc,
          replyTo: p.replyTo,
          deliveredTo: "",
          subject: p.subject,
          snippet: snippetOf(htmlToText(p.html ?? p.text ?? ""), 200, ""),
          size: m.raw.length,
          attachments: p.attachments.filter((x) => !x.inline).map((x) => ({ name: x.filename, mime: x.mimeType, size: x.size })),
          messageId: p.messageId ?? "",
          inReplyTo: p.inReplyTo ?? "",
          references: p.references,
          listUnsubscribe: p.listUnsubscribe ?? "",
          listUnsubscribePost: p.listUnsubscribePost ?? "",
          listId: "",
          labels: m.labels,
          imapFolder: null,
          hasRaw: true,
          starType: m.starType ?? null,
          draftId: [...drafts.entries()].find(([, mid]) => mid === m.id)?.[0] ?? null,
        };
      }),
    };
  },
  message_raw: (a) => msgs.find((m) => m.id === a.messageId)?.raw.slice().buffer ?? new ArrayBuffer(0),
  modify_threads: (a) => modify(String(a.accountId), threadMsgIds(String(a.accountId), a.threadIds as string[]), a.add as string[], a.remove as string[]),
  modify_messages: (a) => modify(String(a.accountId), a.messageIds as string[], a.add as string[], a.remove as string[]),
  bulk_modify: (a) => {
    const v = { ...(a.view as ViewQuery), page: 0, pageSize: 100000 };
    const keep = new Set(a.keep as string[]);
    const threads = list(v).threads.filter((t) => !keep.has(t.threadId));
    const ids = threads.flatMap((t) => threadMsgIds(t.accountId, [t.threadId]));
    emit("bulk-progress", { accountId: v.accountId, phase: "working", done: 0, total: ids.length });
    modify(String(v.accountId), ids, a.add as string[], a.remove as string[]);
    emit("bulk-progress", { accountId: v.accountId, phase: "done", done: ids.length, total: ids.length });
    return { ids, conversations: threads.length, failedConversations: 0 };
  },
  bulk_delete_forever: (a) => {
    const v = { ...(a.view as ViewQuery), page: 0, pageSize: 100000 };
    const keep = new Set(a.keep as string[]);
    const threads = list(v).threads.filter((t) => !keep.has(t.threadId));
    const ids = new Set(threads.flatMap((t) => threadMsgIds(t.accountId, [t.threadId])));
    for (let i = msgs.length - 1; i >= 0; i--) if (ids.has(msgs[i].id)) msgs.splice(i, 1);
    emit("mail-changed", { accountId: v.accountId });
    return { ids: [...ids], conversations: threads.length, failedConversations: 0 };
  },
  delete_forever: (a) => {
    const ids = new Set(threadMsgIds(String(a.accountId), a.threadIds as string[]));
    for (let i = msgs.length - 1; i >= 0; i--) if (ids.has(msgs[i].id)) msgs.splice(i, 1);
    emit("mail-changed", { accountId: a.accountId });
    return null;
  },
  empty_label: (a) => {
    let n = 0;
    for (let i = msgs.length - 1; i >= 0; i--)
      if (msgs[i].accountId === a.accountId && has(msgs[i], String(a.label))) {
        msgs.splice(i, 1);
        n++;
      }
    emit("mail-changed", { accountId: a.accountId });
    return n;
  },
  snooze_threads: (a) => {
    for (const t of a.threadIds as string[]) snoozes.set(`${a.accountId}:${t}`, Number(a.until));
    modify(String(a.accountId), threadMsgIds(String(a.accountId), a.threadIds as string[]), [], ["INBOX"]);
    return null;
  },
  unsnooze_threads: (a) => {
    for (const t of a.threadIds as string[]) snoozes.delete(`${a.accountId}:${t}`);
    modify(String(a.accountId), threadMsgIds(String(a.accountId), a.threadIds as string[]), ["INBOX"], []);
    return null;
  },
  mute_threads: (a) => {
    for (const t of a.threadIds as string[]) a.on ? muted.add(`${a.accountId}:${t}`) : muted.delete(`${a.accountId}:${t}`);
    if (a.on) modify(String(a.accountId), threadMsgIds(String(a.accountId), a.threadIds as string[]), [], ["INBOX"]);
    return null;
  },
  star_message: (a) => {
    const m = msgs.find((x) => x.id === a.messageId);
    if (m) m.starType = (a.starType as string) ?? null;
    modify(String(a.accountId), [String(a.messageId)], a.starType ? ["STARRED"] : [], a.starType ? [] : ["STARRED"]);
    return null;
  },
  block_sender: (a) => (blocked[String(a.accountId)].push(String(a.email)), null),
  unblock_sender: (a) => ((blocked[String(a.accountId)] = blocked[String(a.accountId)].filter((x) => x !== a.email)), null),
  blocked_list: (a) => blocked[String(a.accountId)] ?? [],
  send_message: (a) => {
    const o = a.opts as { sendAt?: number | null; scheduled?: boolean; threadId?: string | null; draftId?: string | null; undoMs?: number };
    const id = outboxSeq++;
    outbox.push({
      id,
      accountId: String(a.accountId),
      raw: base64Decode(String(a.raw)),
      sendAt: o.sendAt ?? Date.now() + (o.undoMs ?? 5000),
      scheduled: !!o.scheduled,
      threadId: o.threadId ?? null,
      draftId: o.draftId ?? null,
      attempts: 0,
    });
    emit("outbox-changed", {});
    return id;
  },
  outbox_cancel: (a) => {
    const i = outbox.findIndex((o) => o.id === a.id);
    if (i < 0) return null;
    const [o] = outbox.splice(i, 1);
    emit("outbox-changed", {});
    return { accountId: o.accountId, raw: base64Encode(o.raw), threadId: o.threadId, draftId: o.draftId };
  },
  outbox_list: () =>
    outbox.map((o) => ({
      id: o.id,
      accountId: o.accountId,
      sendAt: o.sendAt,
      status: "pending",
      attempts: o.attempts,
      error: null,
      threadId: o.threadId,
      draftId: o.draftId,
      scheduled: o.scheduled,
      subject: parseMessage(o.raw).subject,
      recipients: [],
      fromEmail: "",
      createdAt: 0,
      snippet: "",
    })),
  outbox_send_now: (a) => {
    const o = outbox.find((x) => x.id === a.id);
    if (o) o.sendAt = Date.now();
    return null;
  },
  outbox_raw: (a) => base64Encode(outbox.find((o) => o.id === a.id)?.raw ?? new Uint8Array()),
  draft_save: (a) => {
    const raw = base64Decode(String(a.raw));
    const p = parseMessage(raw);
    const did = (a.draftId as string) ?? `d${seq++}`;
    const old = drafts.get(did);
    const oi = msgs.findIndex((m) => m.id === old);
    if (oi >= 0) msgs.splice(oi, 1);
    const id = `m${seq++}`;
    msgs.push({ accountId: String(a.accountId), id, threadId: (a.threadId as string) ?? `t${id}`, date: Date.now(), labels: ["DRAFT"], raw });
    drafts.set(did, id);
    parsedCache.delete(id);
    void p;
    emit("mail-changed", { accountId: a.accountId, reason: "draft" });
    return did;
  },
  draft_delete: (a) => {
    const mid = drafts.get(String(a.draftId));
    drafts.delete(String(a.draftId));
    const i = msgs.findIndex((m) => m.id === mid);
    if (i >= 0) msgs.splice(i, 1);
    emit("mail-changed", { accountId: a.accountId, reason: "draft" });
    return null;
  },
  contacts_search: (a) => contacts(String(a.query)).slice(0, Number(a.limit ?? 8)),
  templates_list: () => Object.values(templates),
  template_save: (a) => {
    const id = (a.id as string) ?? `tpl${seq++}`;
    templates[id] = { id, accountId: (a.accountId as string) ?? null, name: String(a.name), subject: String(a.subject), html: String(a.html) };
    return id;
  },
  template_delete: (a) => (delete templates[String(a.id)], null),
  signatures_list: (a) => Object.values(signatures).filter((s) => s.accountId === a.accountId),
  signature_save: (a) => {
    const id = (a.id as string) ?? `sig${seq++}`;
    signatures[id] = { id, accountId: String(a.accountId), name: String(a.name), html: String(a.html) };
    return id;
  },
  signature_delete: (a) => (delete signatures[String(a.id)], null),
  signature_defaults_set: (a) => {
    const key = `sigDefaults:${a.accountId}`;
    settings[key] = { ...((settings[key] as object) ?? {}), [String(a.address)]: { newMail: a.newMail, replies: a.replies } };
    return null;
  },
  settings_all: () => {
    const out: Record<string, unknown> = { ...settings };
    if (preview.get("theme")) out.theme = preview.get("theme");
    if (preview.get("density")) out.density = preview.get("density");
    if (preview.get("pane")) out.readingPane = preview.get("pane");
    return out;
  },
  settings_set: (a) => ((settings[String(a.key)] = a.value), null),
  filters_list: (a) => filters[String(a.accountId)] ?? [],
  filter_create: (a) => {
    const f = { id: `f${seq++}`, criteria: a.criteria as Record<string, unknown>, action: a.action as Record<string, unknown> };
    filters[String(a.accountId)].push(f);
    return f;
  },
  filter_delete: (a) => ((filters[String(a.accountId)] = filters[String(a.accountId)].filter((f) => f.id !== a.id)), null),
  server_settings_get: (a) =>
    a.which === "vacation"
      ? vacation
      : a.which === "imap"
        ? { enabled: true, autoExpunge: true, expungeBehavior: "archive", maxFolderSize: 0 }
        : a.which === "pop"
          ? { accessWindow: "disabled", disposition: "leaveInInbox" }
          : a.which === "autoForwarding"
            ? { enabled: false }
            : {},
  server_settings_set: (a) => (a.which === "vacation" ? (vacation = a.value as typeof vacation) : null),
  sendas_list: () => sendAs,
  sendas_save: () => null,
  sendas_delete: () => null,
  forwarding_list: () => [],
  forwarding_add: () => null,
  forwarding_remove: () => null,
  unsubscribe_one_click: () => null,
  subscriptions: (a) => {
    const by = new Map<string, Record<string, unknown>>();
    const since = Date.now() - 30 * 86400000;
    for (const m of msgs.filter((x) => (a.accountId === "all" || x.accountId === a.accountId) && !has(x, "SENT"))) {
      const p = parsed(m);
      const from = p.from[0];
      if (!p.listUnsubscribe || !from) continue;
      const key = `${m.accountId}:${from.email.toLowerCase()}`;
      const cur = by.get(key) ?? {
        accountId: m.accountId,
        email: from.email.toLowerCase(),
        name: from.name,
        lastDate: 0,
        total: 0,
        recent: 0,
        listId: "",
        unsubscribed: unsubscribed.get(key) ?? null,
      };
      cur.total = (cur.total as number) + 1;
      if (m.date >= since) cur.recent = (cur.recent as number) + 1;
      if (m.date > (cur.lastDate as number))
        Object.assign(cur, { lastDate: m.date, listUnsubscribe: p.listUnsubscribe, listUnsubscribePost: p.listUnsubscribePost ?? "", name: from.name });
      by.set(key, cur);
    }
    return [...by.values()].sort((x, y) => (y.recent as number) - (x.recent as number));
  },
  mark_unsubscribed: (a) => (unsubscribed.set(`${a.accountId}:${String(a.email).toLowerCase()}`, Date.now()), null),
  unsubscribed_senders: (a) => [...unsubscribed.keys()].filter((k) => k.startsWith(`${a.accountId}:`)).map((k) => k.slice(String(a.accountId).length + 1)),
  sender_lists: (a) => {
    const seen = new Map<string, Record<string, unknown>>();
    for (const m of [...msgs].sort((x, y) => y.date - x.date)) {
      const p = parsed(m);
      if (m.accountId !== a.accountId || !p.listUnsubscribe || p.from[0]?.email.toLowerCase() !== String(a.email).toLowerCase()) continue;
      if (!seen.has(p.listUnsubscribe))
        seen.set(p.listUnsubscribe, { listId: "", listUnsubscribe: p.listUnsubscribe, listUnsubscribePost: p.listUnsubscribePost ?? "" });
    }
    return [...seen.values()];
  },
  sync_now: () => null,
  temp_file: (a) => `/tmp/preview/${a.name}`,
  write_file: () => null,
  read_file: () => msgs[0].raw.slice().buffer,
  save_download: (a) => (console.info("[preview] download", a.name), `/Users/you/Downloads/${a.name}`),
  open_file: (a) => (console.info("[preview] open file", a.name), `/tmp/preview/${a.name}`),
  reveal_file: () => null,
  open_external: (a) => (console.info("[preview] open", a.url), null),
  spell_check: (a) =>
    (a.texts as string[]).map((t) =>
      [...t.matchAll(/\b(teh|recieve|speling)\b/g)].map((m) => ({
        start: m.index ?? 0,
        len: m[0].length,
        suggestions: [m[0] === "teh" ? "the" : m[0] === "recieve" ? "receive" : "spelling"],
      })),
    ),
  share: () => null,
  default_mail_app: () => false,
  set_default_mail_app: () => null,
  badge_refresh: () => null,
  window_open: (a) => (console.info("[preview] new window:", a.kind), "w1"),
  window_take: () => null,
  pending_opens: () => [],
  print_window: () => null,
  e2e_info: () => ({ preview: true }),
  e2e_control: () => ({}),
  e2e_log: (a) => (console.info("[e2e]", a.line), null),
  e2e_finish: (a) => {
    sessionStorage.setItem("courier.e2e", String(a.report));
    console.info("[preview] end-to-end report:", JSON.parse(String(a.report)));
    return null;
  },
  "plugin:dialog|open": () => null,
  "plugin:dialog|save": () => null,
  "plugin:event|listen": (a) => {
    const id = nextId++;
    listeners.set(id, { event: String(a.event), handler: Number(a.handler) });
    return id;
  },
  "plugin:event|unlisten": (a) => (listeners.delete(Number(a.eventId)), null),
  "plugin:event|emit": () => null,
  "plugin:window|is_fullscreen": () => false,
};

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  invoke: async (cmd: string, args: Args = {}) => {
    const h = handlers[cmd];
    if (!h) {
      console.debug("[preview] native call ignored:", cmd, args);
      return null;
    }
    return h(args);
  },
  transformCallback: (cb: (e: unknown) => void) => {
    const id = nextId++;
    (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
    return id;
  },
  unregisterCallback: () => {},
  convertFileSrc: (p: string) => p,
};
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

export const previewState = { msgs, accounts, outbox, snoozes, normalizeSubject };
