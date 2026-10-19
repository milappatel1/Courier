import { describe, expect, it } from "vitest";
import cases from "./fixtures/search-cases.json";
import { chipState, criteriaFromAdvanced, criteriaToQuery, describeActions, EMPTY_ADVANCED, fromAdvanced, setChip, toAdvanced } from "../src/core/search/advanced";
import { highlightTerms, matches, type SearchableMessage } from "../src/core/search/evaluate";
import { parseQuery, parseRelative, parseSearchDate, parseSize, serialize } from "../src/core/search/parser";

describe("parser (shared fixture with the Rust twin)", () => {
  for (const c of cases as { q: string; ast: unknown }[]) {
    it(JSON.stringify(c.q), () => {
      expect(parseQuery(c.q)).toEqual(c.ast);
    });
  }
  it("serialises back to an equivalent query", () => {
    for (const c of cases as { q: string; ast: unknown }[]) {
      const ast = parseQuery(c.q);
      expect(parseQuery(serialize(ast))).toEqual(ast);
    }
  });
});

describe("values", () => {
  it("dates, relative times and sizes", () => {
    expect(parseSearchDate("2026/01/31")?.getTime()).toBe(new Date(2026, 0, 31).getTime());
    expect(parseSearchDate("01/31/2026")?.getTime()).toBe(new Date(2026, 0, 31).getTime());
    expect(parseSearchDate("1767225600")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseSearchDate("soon")).toBeNull();
    const now = new Date(2026, 9, 18, 12);
    expect(parseRelative("2d", now)?.getDate()).toBe(16);
    expect(parseRelative("1y", now)?.getFullYear()).toBe(2025);
    expect(parseSize("10M")).toBe(10 * 1024 * 1024);
    expect(parseSize("500k")).toBe(512000);
    expect(parseSize("2000")).toBe(2000);
  });
});

const now = new Date(2026, 9, 18, 21, 0);
const msg = (o: Partial<SearchableMessage>): SearchableMessage => ({
  from: [{ name: "Alice Doe", email: "alice@example.com" }],
  to: [{ name: "Pat", email: "pat@example.com" }],
  cc: [],
  bcc: [],
  subject: "Quarterly planning notes",
  body: "Attached are the planning notes for next quarter.",
  labels: ["INBOX", "Projects/Alpha", "UNREAD"],
  unread: true,
  starred: false,
  important: false,
  attachmentNames: ["quarterly-plan.pdf"],
  size: 120_000,
  date: new Date(2026, 9, 18, 20, 5).getTime(),
  category: "primary",
  ...o,
});

describe("evaluate", () => {
  const m = msg({});
  const t = (q: string, x = m) => matches(q, x, now);
  it("fields", () => {
    expect(t("from:alice")).toBe(true);
    expect(t("from:bob")).toBe(false);
    expect(t("to:pat@example.com")).toBe(true);
    expect(t("subject:quarterly")).toBe(true);
    expect(t('subject:"planning notes"')).toBe(true);
    expect(t('subject:"notes planning"')).toBe(false);
    expect(t("label:projects-alpha")).toBe(true);
    expect(t("label:projects")).toBe(true);
    expect(t("in:inbox is:unread")).toBe(true);
    expect(t("is:read")).toBe(false);
    expect(t("has:attachment filename:pdf")).toBe(true);
    expect(t("filename:docx")).toBe(false);
    expect(t("larger:100K smaller:1M")).toBe(true);
    expect(t("after:2026/10/18 before:2026/10/19")).toBe(true);
    expect(t("newer_than:1d")).toBe(true);
    expect(t("older_than:1d")).toBe(false);
    expect(t("category:primary")).toBe(true);
    expect(t("category:social")).toBe(false);
  });
  it("boolean structure and free text", () => {
    expect(t("planning")).toBe(true);
    expect(t("plan")).toBe(true); // word prefix
    expect(t("planning -quarter")).toBe(false);
    expect(t("from:bob OR from:alice")).toBe(true);
    expect(t("{from:bob from:carol}")).toBe(false);
    expect(t("-(from:bob OR is:starred)")).toBe(true);
    expect(t("in:anywhere")).toBe(true);
  });
  it("stars", () => {
    const s = msg({ starred: true, starType: "red-bang" });
    expect(t("is:starred has:red-bang", s)).toBe(true);
    expect(t("has:yellow-star", s)).toBe(false);
  });
  it("highlight terms", () => {
    expect(highlightTerms(parseQuery("from:x lunch subject:friday -noon"))).toEqual(["lunch", "friday"]);
  });
});

describe("advanced search form", () => {
  it("builds the query from the form", () => {
    const q = fromAdvanced({ ...EMPTY_ADVANCED, from: "alice", to: "bob carol", subject: "plan", hasWords: "budget", doesntHave: "draft memo", size: "5", sizeUnit: "MB", hasAttachment: true, searchIn: "Projects" });
    expect(q).toBe("from:alice to:(bob carol) subject:plan budget -{draft memo} larger:5M label:Projects has:attachment");
  });
  it("date within expands around the date and maps back", () => {
    const q = fromAdvanced({ ...EMPTY_ADVANCED, dateWithin: "1 week", date: "2026/10/18" });
    expect(q).toBe("after:2026/10/11 before:2026/10/26");
    const f = toAdvanced(q);
    expect(f.dateWithin).toBe("1 week");
    expect(f.date).toBe("2026/10/18");
  });
  it("fills the form from a query", () => {
    const f = toAdvanced("from:alice subject:(plan q4) larger:2M has:attachment in:inbox -spam lunch");
    expect(f.from).toBe("alice");
    expect(f.subject).toBe("plan q4");
    expect(f.size).toBe("2");
    expect(f.sizeUnit).toBe("MB");
    expect(f.hasAttachment).toBe(true);
    expect(f.searchIn).toBe("inbox");
    expect(f.doesntHave).toBe("spam");
    expect(f.hasWords).toBe("lunch");
  });
});

describe("chips and filters", () => {
  it("adds, replaces and removes chip terms", () => {
    let q = "lunch";
    q = setChip(q, "from", "alice");
    expect(q).toBe("lunch from:alice");
    q = setChip(q, "from", "bob");
    expect(q).toBe("lunch from:bob");
    q = setChip(q, "attachment", "yes");
    q = setChip(q, "time", "older_than:7d");
    expect(chipState(q)).toEqual({ from: "bob", time: "older_than:7d", attachment: "yes", to: null, unread: null });
    q = setChip(q, "from", null);
    expect(q).toBe("lunch has:attachment older_than:7d");
  });
  it("filter criteria ⇄ query and action descriptions", () => {
    const c = criteriaFromAdvanced({ ...EMPTY_ADVANCED, from: "news@shop.example", hasWords: "sale", size: "1", sizeUnit: "MB", hasAttachment: true });
    expect(c).toEqual({ from: "news@shop.example", query: "sale", hasAttachment: true, size: 1048576, sizeComparison: "larger" });
    expect(criteriaToQuery(c)).toBe("from:news@shop.example sale has:attachment larger:1048576");
    expect(describeActions({ addLabelIds: ["Label_1", "STARRED"], removeLabelIds: ["INBOX", "UNREAD"] }, () => "Receipts")).toEqual(["Skip Inbox", "Mark as read", "Star it", 'Apply label "Receipts"']);
  });
});
