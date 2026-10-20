// Filter files: the XML (an Atom feed of apps:property entries) that the web client exports and imports, so
// filters move between it and Courier. Pure: filters in, text out, and back.

export interface FilterCriteriaLike {
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

export interface FilterActionLike {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

/** A filter read from a file, with its label by name (ids differ between accounts). */
export interface ImportedFilter {
  criteria: FilterCriteriaLike;
  labelName: string | null;
  archive: boolean;
  markRead: boolean;
  star: boolean;
  trash: boolean;
  neverSpam: boolean;
  important: "" | "always" | "never";
  category: string | null;
  forward: string | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const CATEGORY_TO_SMART: Record<string, string> = {
  CATEGORY_PERSONAL: "^smartlabel_personal",
  CATEGORY_SOCIAL: "^smartlabel_social",
  CATEGORY_PROMOTIONS: "^smartlabel_promo",
  CATEGORY_UPDATES: "^smartlabel_notification",
  CATEGORY_FORUMS: "^smartlabel_group",
};
const SMART_TO_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_TO_SMART).map(([k, v]) => [v, k]));
const SYSTEM = new Set(["INBOX", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "SENT", "DRAFT"]);

/** Bytes as the file's size + unit pair (MB when it divides evenly, then KB, else bytes). */
function sizeUnit(bytes: number): [number, string] {
  if (bytes % (1024 * 1024) === 0) return [bytes / (1024 * 1024), "s_smb"];
  if (bytes % 1024 === 0) return [bytes / 1024, "s_skb"];
  return [bytes, "s_sb"];
}

export function exportFiltersXml(
  filters: { criteria: FilterCriteriaLike; action: FilterActionLike }[],
  labelName: (id: string) => string,
  author: { name: string; email: string },
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const base = `${now.getTime()}`;
  const prop = (name: string, value: string | number | boolean) => `\t\t<apps:property name='${name}' value='${esc(String(value))}'/>`;
  const entries = filters.map((f, i) => {
    const c = f.criteria;
    const add = f.action.addLabelIds ?? [];
    const remove = f.action.removeLabelIds ?? [];
    const props: string[] = [];
    if (c.from) props.push(prop("from", c.from));
    if (c.to) props.push(prop("to", c.to));
    if (c.subject) props.push(prop("subject", c.subject));
    if (c.query) props.push(prop("hasTheWord", c.query));
    if (c.negatedQuery) props.push(prop("doesNotHaveTheWord", c.negatedQuery));
    if (c.hasAttachment) props.push(prop("hasAttachment", true));
    if (c.excludeChats) props.push(prop("excludeChats", true));
    if (c.size) {
      const [n, unit] = sizeUnit(c.size);
      props.push(prop("size", n), prop("sizeOperator", c.sizeComparison === "smaller" ? "s_ss" : "s_sl"), prop("sizeUnit", unit));
    }
    const user = add.find((l) => !SYSTEM.has(l) && !l.startsWith("CATEGORY_"));
    if (user) props.push(prop("label", labelName(user)));
    if (remove.includes("INBOX")) props.push(prop("shouldArchive", true));
    if (remove.includes("UNREAD")) props.push(prop("shouldMarkAsRead", true));
    if (add.includes("STARRED")) props.push(prop("shouldStar", true));
    if (add.includes("TRASH")) props.push(prop("shouldTrash", true));
    if (remove.includes("SPAM")) props.push(prop("shouldNeverSpam", true));
    if (add.includes("IMPORTANT")) props.push(prop("shouldAlwaysMarkAsImportant", true));
    if (remove.includes("IMPORTANT")) props.push(prop("shouldNeverMarkAsImportant", true));
    const cat = add.find((l) => CATEGORY_TO_SMART[l]);
    if (cat) props.push(prop("smartLabelToApply", CATEGORY_TO_SMART[cat]));
    if (f.action.forward) props.push(prop("forwardTo", f.action.forward));
    return [
      "\t<entry>",
      "\t\t<category term='filter'></category>",
      "\t\t<title>Mail Filter</title>",
      `\t\t<id>tag:courier,2026:filter:${base}${i}</id>`,
      `\t\t<updated>${stamp}</updated>`,
      "\t\t<content></content>",
      ...props,
      "\t</entry>",
    ].join("\n");
  });
  return [
    "<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    "\t<title>Mail Filters</title>",
    `\t<id>tag:courier,2026:filters:${base}</id>`,
    `\t<updated>${stamp}</updated>`,
    `\t<author>\n\t\t<name>${esc(author.name)}</name>\n\t\t<email>${esc(author.email)}</email>\n\t</author>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n");
}

const SIZE_UNIT: Record<string, number> = { s_sb: 1, s_skb: 1024, s_smb: 1024 * 1024 };

/** Filters from a filter file (unknown properties are ignored). */
export function importFiltersXml(xml: string): ImportedFilter[] {
  const out: ImportedFilter[] = [];
  for (const entry of xml.match(/<entry\b[\s\S]*?<\/entry>/g) ?? []) {
    const p: Record<string, string> = {};
    for (const m of entry.matchAll(/<apps:property\s+name\s*=\s*(['"])(.*?)\1\s+value\s*=\s*(['"])([\s\S]*?)\3\s*\/?>/g)) p[m[2]] = unesc(m[4]);
    const yes = (k: string) => p[k] === "true";
    const criteria: FilterCriteriaLike = {};
    if (p.from) criteria.from = p.from;
    if (p.to) criteria.to = p.to;
    if (p.subject) criteria.subject = p.subject;
    if (p.hasTheWord) criteria.query = p.hasTheWord;
    if (p.doesNotHaveTheWord) criteria.negatedQuery = p.doesNotHaveTheWord;
    if (yes("hasAttachment")) criteria.hasAttachment = true;
    if (yes("excludeChats")) criteria.excludeChats = true;
    if (p.size && Number(p.size) > 0) {
      criteria.size = Number(p.size) * (SIZE_UNIT[p.sizeUnit] ?? 1);
      criteria.sizeComparison = p.sizeOperator === "s_ss" ? "smaller" : "larger";
    }
    if (!Object.keys(criteria).length) continue;
    out.push({
      criteria,
      labelName: p.label || null,
      archive: yes("shouldArchive"),
      markRead: yes("shouldMarkAsRead"),
      star: yes("shouldStar"),
      trash: yes("shouldTrash"),
      neverSpam: yes("shouldNeverSpam"),
      important: yes("shouldAlwaysMarkAsImportant") ? "always" : yes("shouldNeverMarkAsImportant") ? "never" : "",
      category: p.smartLabelToApply ? (SMART_TO_CATEGORY[p.smartLabelToApply] ?? null) : null,
      forward: p.forwardTo || null,
    });
  }
  return out;
}

/** An imported filter as an API action, once its label (if any) has an id in this account. */
export function importedAction(f: ImportedFilter, labelId: string | null): FilterActionLike {
  const add: string[] = [];
  const remove: string[] = [];
  if (labelId) add.push(labelId);
  if (f.archive) remove.push("INBOX");
  if (f.markRead) remove.push("UNREAD");
  if (f.star) add.push("STARRED");
  if (f.trash) add.push("TRASH");
  if (f.neverSpam) remove.push("SPAM");
  if (f.important === "always") add.push("IMPORTANT");
  if (f.important === "never") remove.push("IMPORTANT");
  if (f.category) add.push(f.category);
  return { addLabelIds: add, removeLabelIds: remove, ...(f.forward ? { forward: f.forward } : {}) };
}
