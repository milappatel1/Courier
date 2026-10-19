// Label model shared by both account kinds: system labels, IMAP folder mapping, the nested label tree, the
// label colour palette (the set the mail API accepts) and label-name rules.

export type SystemLabelId =
  | "INBOX"
  | "STARRED"
  | "SNOOZED"
  | "IMPORTANT"
  | "SENT"
  | "SCHEDULED"
  | "OUTBOX"
  | "DRAFT"
  | "ALL"
  | "SPAM"
  | "TRASH"
  | "UNREAD"
  | "CATEGORY_PERSONAL"
  | "CATEGORY_SOCIAL"
  | "CATEGORY_PROMOTIONS"
  | "CATEGORY_UPDATES"
  | "CATEGORY_FORUMS"
  | "CHAT";

export interface SystemLabelDef {
  id: SystemLabelId;
  name: string;
  icon: string;
  /** Nav visibility default: "show" | "hide" | "unread" (show if unread). */
  nav: "show" | "hide" | "unread";
  /** Which count the nav shows: unread conversations, or the total (drafts, scheduled, outbox). */
  count: "unread" | "total" | "none";
  primary: boolean; // above "More"
}

export const SYSTEM_LABELS: SystemLabelDef[] = [
  { id: "INBOX", name: "Inbox", icon: "inbox", nav: "show", count: "unread", primary: true },
  { id: "STARRED", name: "Starred", icon: "star", nav: "show", count: "none", primary: true },
  { id: "SNOOZED", name: "Snoozed", icon: "schedule", nav: "show", count: "none", primary: true },
  { id: "IMPORTANT", name: "Important", icon: "label_important", nav: "show", count: "unread", primary: false },
  { id: "SENT", name: "Sent", icon: "send", nav: "show", count: "none", primary: true },
  { id: "SCHEDULED", name: "Scheduled", icon: "schedule_send", nav: "unread", count: "total", primary: false },
  { id: "OUTBOX", name: "Outbox", icon: "outbox", nav: "unread", count: "total", primary: true },
  { id: "DRAFT", name: "Drafts", icon: "draft", nav: "show", count: "total", primary: true },
  { id: "ALL", name: "All Mail", icon: "stacked_email", nav: "show", count: "none", primary: false },
  { id: "SPAM", name: "Spam", icon: "report", nav: "show", count: "unread", primary: false },
  { id: "TRASH", name: "Trash", icon: "delete", nav: "show", count: "none", primary: false },
];

export const CATEGORIES = [
  { id: "CATEGORY_PERSONAL", key: "primary", name: "Primary", icon: "inbox" },
  { id: "CATEGORY_PROMOTIONS", key: "promotions", name: "Promotions", icon: "sell" },
  { id: "CATEGORY_SOCIAL", key: "social", name: "Social", icon: "group" },
  { id: "CATEGORY_UPDATES", key: "updates", name: "Updates", icon: "info" },
  { id: "CATEGORY_FORUMS", key: "forums", name: "Forums", icon: "forum" },
] as const;
export type CategoryKey = (typeof CATEGORIES)[number]["key"];

const SYSTEM_BY_ID = new Map(SYSTEM_LABELS.map((l) => [l.id, l]));
export const systemLabel = (id: string) => SYSTEM_BY_ID.get(id as SystemLabelId) ?? null;

export const isSystemLabel = (id: string) => SYSTEM_BY_ID.has(id as SystemLabelId) || id.startsWith("CATEGORY_") || id === "UNREAD" || id === "CHAT";

/** Names the mail API reserves (case-insensitive) — user labels can't use them. */
const RESERVED = [
  "inbox",
  "spam",
  "trash",
  "unread",
  "starred",
  "important",
  "sent",
  "drafts",
  "draft",
  "chats",
  "chat",
  "all mail",
  "snoozed",
  "scheduled",
  "outbox",
  "muted",
  "bin",
  "category",
];

export function validateLabelName(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > 225) return "That name is too long.";
  if (/^\/|\/$|\/\//.test(n)) return "Label names can't start or end with “/” or contain “//”.";
  if (RESERVED.includes(n.toLowerCase())) return `“${n}” is reserved. Pick another name.`;
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return `The label “${n}” already exists.`;
  return null;
}

// ---- IMAP folders → labels ----

export interface ImapFolder {
  path: string;
  delimiter: string | null;
  flags: string[]; // e.g. ["\\HasNoChildren", "\\Sent"]
}

const SPECIAL_USE: Record<string, SystemLabelId> = {
  "\\inbox": "INBOX",
  "\\sent": "SENT",
  "\\drafts": "DRAFT",
  "\\trash": "TRASH",
  "\\junk": "SPAM",
  "\\all": "ALL",
  "\\archive": "ALL",
  "\\flagged": "STARRED",
  "\\important": "IMPORTANT",
};

const NAME_HINTS: [RegExp, SystemLabelId][] = [
  [/^inbox$/i, "INBOX"],
  [/^(sent|sent items|sent messages|sent mail|gesendet|envoyés|enviados|inviati)$/i, "SENT"],
  [/^(drafts?|entwürfe|brouillons|borradores|bozze)$/i, "DRAFT"],
  [/^(trash|deleted|deleted items|deleted messages|bin|papierkorb|corbeille|papelera|cestino)$/i, "TRASH"],
  [/^(spam|junk|junk e-?mail|bulk mail|bulk)$/i, "SPAM"],
  [/^(archive|archives|all mail|archiv)$/i, "ALL"],
  [/^(starred|flagged)$/i, "STARRED"],
];

/** Map an IMAP folder to a system label id (special-use flags first, then well-known names), or null. */
export function folderSystemLabel(f: ImapFolder): SystemLabelId | null {
  for (const flag of f.flags) {
    const s = SPECIAL_USE[flag.toLowerCase()];
    if (s) return s;
  }
  const leaf = f.delimiter ? f.path.split(f.delimiter).pop()! : f.path;
  const parentIsGmail = /^\[(gmail|google mail)\]/i.test(f.path);
  for (const [re, id] of NAME_HINTS) if (re.test(leaf) && (f.path.toUpperCase() === "INBOX" || id !== "INBOX")) return id;
  if (parentIsGmail && /^important$/i.test(leaf)) return "IMPORTANT";
  return null;
}

/** Folder path → label name using "/" for nesting (whatever the server's delimiter). */
export function folderLabelName(f: ImapFolder): string {
  const parts = f.delimiter ? f.path.split(f.delimiter) : [f.path];
  if (parts[0].toUpperCase() === "INBOX" && parts.length > 1) parts.shift(); // INBOX.Receipts → Receipts
  return parts.map(decodeModifiedUtf7).join("/");
}

/** IMAP modified UTF-7 (RFC 3501 §5.1.3) folder names → Unicode. */
export function decodeModifiedUtf7(s: string): string {
  return s.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (b64 === "") return "&";
    const std = b64.replace(/,/g, "/");
    const bin = atob(std + "===".slice((std.length + 3) % 4));
    let out = "";
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return out;
  });
}

export function encodeModifiedUtf7(s: string): string {
  let out = "";
  let buf = "";
  const flush = () => {
    if (!buf) return;
    let bin = "";
    for (const ch of buf) {
      const c = ch.charCodeAt(0);
      bin += String.fromCharCode(c >> 8, c & 0xff);
    }
    out += "&" + btoa(bin).replace(/=+$/, "").replace(/\//g, ",") + "-";
    buf = "";
  };
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === "&" ? "&-" : ch;
    } else buf += ch.length === 2 ? ch : ch; // surrogate pairs stay as two UTF-16 units
  }
  flush();
  return out;
}

// ---- nested tree ----

export interface LabelLike {
  id: string;
  name: string; // "Projects/Alpha"
}

export interface LabelNode<T extends LabelLike> {
  label: T | null; // null for an implied parent that doesn't exist as a label
  name: string; // leaf name
  path: string;
  children: LabelNode<T>[];
}

export function labelTree<T extends LabelLike>(labels: T[]): LabelNode<T>[] {
  const root: LabelNode<T>[] = [];
  const byPath = new Map<string, LabelNode<T>>();
  const sorted = [...labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const ensure = (path: string): LabelNode<T> => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const parts = path.split("/");
    const node: LabelNode<T> = { label: null, name: parts[parts.length - 1], path, children: [] };
    byPath.set(path, node);
    if (parts.length === 1) root.push(node);
    else ensure(parts.slice(0, -1).join("/")).children.push(node);
    return node;
  };
  for (const l of sorted) ensure(l.name).label = l;
  return root;
}

export const leafName = (name: string) => name.split("/").pop() ?? name;
export const parentPath = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : null);

// ---- colours ----

/** Background colours the mail API accepts for labels, laid out as the picker grid (8 per row). */
export const LABEL_BG = [
  "#000000",
  "#434343",
  "#666666",
  "#999999",
  "#cccccc",
  "#efefef",
  "#f3f3f3",
  "#ffffff",
  "#fb4c2f",
  "#ffad47",
  "#fad165",
  "#16a766",
  "#43d692",
  "#4a86e8",
  "#a479e2",
  "#f691b3",
  "#f6c5be",
  "#ffe6c7",
  "#fef1d1",
  "#b9e4d0",
  "#c6f3de",
  "#c9daf8",
  "#e4d7f5",
  "#fcdee8",
  "#efa093",
  "#ffd6a2",
  "#fce8b3",
  "#89d3b2",
  "#a0eac9",
  "#a4c2f4",
  "#d0bcf1",
  "#fbc8d9",
  "#e66550",
  "#ffbc6b",
  "#fcda83",
  "#44b984",
  "#68dfa9",
  "#6d9eeb",
  "#b694e8",
  "#f7a7c0",
  "#cc3a21",
  "#eaa041",
  "#f2c960",
  "#149e60",
  "#3dc789",
  "#3c78d8",
  "#8e63ce",
  "#e07798",
  "#ac2b16",
  "#cf8933",
  "#d5ae49",
  "#0b804b",
  "#2a9c68",
  "#285bac",
  "#653e9b",
  "#b65775",
  "#822111",
  "#a46a21",
  "#aa8831",
  "#076239",
  "#1a764d",
  "#1c4587",
  "#41236d",
  "#83334c",
];

/** Readable text colour for a label background (the API also needs one). */
export function labelTextColor(bg: string): string {
  const m = bg.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? "#000000" : "#ffffff";
}

export interface LabelColor {
  backgroundColor: string;
  textColor: string;
}

export function chipStyle(color: LabelColor | null | undefined): { background: string; color: string } {
  if (!color?.backgroundColor) return { background: "var(--label-chip-bg)", color: "var(--label-chip-text)" };
  return { background: color.backgroundColor, color: color.textColor || labelTextColor(color.backgroundColor) };
}

/** Labels the list shows as chips on a row: user labels plus Inbox when viewing elsewhere. */
export function rowChips<T extends LabelLike & { type?: string }>(labelIds: string[], all: Map<string, T>, viewing: string | null): T[] {
  const out: T[] = [];
  for (const id of labelIds) {
    if (id === viewing) continue;
    const l = all.get(id);
    if (!l) continue;
    if (l.type === "system" && id !== "INBOX") continue;
    if (id === "INBOX" && (viewing === null || viewing === "INBOX")) continue;
    out.push(l);
  }
  return out;
}
