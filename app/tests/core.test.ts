import { describe, expect, it } from "vitest";
import { avatarColor, dedupeAddresses, formatAddress, initialOf, isValidEmail, parseAddressList, shortName } from "../src/core/addresses";
import { buildReply, forwardSubject, mentionsAttachment, pickFromAlias, replyRecipients, replySubject, type SourceMessage } from "../src/core/compose";
import { fullDate, headerDate, listDate, quoteDate, relativeAgo, schedulePresets, snoozePresets } from "../src/core/dates";
import {
  CATEGORIES,
  chipStyle,
  decodeModifiedUtf7,
  encodeModifiedUtf7,
  folderLabelName,
  folderSystemLabel,
  labelTextColor,
  labelTree,
  LABEL_BG,
  rowChips,
  validateLabelName,
} from "../src/core/labels";
import { keyName, ShortcutMatcher, SHORTCUTS, withCustomKeys } from "../src/core/shortcuts";
import { decodeEntities, htmlToText, snippetOf, textToHtml } from "../src/core/text";
import { conversationLayout, normalizeSubject, participants, participantsText, threadMessages } from "../src/core/threading";
import { parseListUnsubscribe, parseMailto } from "../src/core/unsubscribe";

const NN = "\u202f"; // narrow no-break space before AM/PM

describe("addresses", () => {
  it("parses lists with quotes, commas, comments and groups", () => {
    const l = parseAddressList(`"Doe, Jane" <jane@example.com>, bob@example.com (Bob B), Team: a@x.io, b@x.io;, <c@x.io>`);
    expect(l).toEqual([
      { name: "Doe, Jane", email: "jane@example.com" },
      { name: "Bob B", email: "bob@example.com" },
      { name: "", email: "a@x.io" },
      { name: "", email: "b@x.io" },
      { name: "", email: "c@x.io" },
    ]);
    expect(parseAddressList("")).toEqual([]);
    expect(formatAddress({ name: "Doe, Jane", email: "jane@example.com" })).toBe('"Doe, Jane" <jane@example.com>');
    expect(formatAddress({ name: "", email: "x@y.z" })).toBe("x@y.z");
    expect(shortName({ name: "Doe, Jane", email: "j@x" })).toBe("Jane");
    expect(shortName({ name: "Alice Smith", email: "a@x" })).toBe("Alice");
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(
      dedupeAddresses(
        [
          { name: "", email: "A@x.io" },
          { name: "A", email: "a@x.io" },
          { name: "", email: "me@x.io" },
        ],
        ["ME@x.io"],
      ).map((a) => a.email),
    ).toEqual(["A@x.io"]);
    expect(initialOf({ name: "élan", email: "e@x" })).toBe("É");
    expect(avatarColor("a@x.io")).toBe(avatarColor("A@X.IO"));
  });
});

describe("dates", () => {
  const now = new Date(2026, 9, 18, 20, 15); // Sun Oct 18 2026, 8:15 PM
  it("list dates", () => {
    expect(listDate(new Date(2026, 9, 18, 20, 6).getTime(), now)).toBe(`8:06${NN}PM`);
    expect(listDate(new Date(2026, 9, 18, 0, 5).getTime(), now)).toBe(`12:05${NN}AM`);
    expect(listDate(new Date(2026, 9, 12, 9).getTime(), now)).toBe("Oct 12");
    expect(listDate(new Date(2024, 9, 12).getTime(), now)).toBe("10/12/24");
  });
  it("header dates and relative times", () => {
    expect(headerDate(new Date(2026, 9, 18, 20, 6).getTime(), now)).toBe(`8:06${NN}PM (9 minutes ago)`);
    expect(headerDate(new Date(2026, 9, 16, 15, 4).getTime(), now)).toBe(`Fri, Oct 16, 3:04${NN}PM (2 days ago)`);
    expect(headerDate(new Date(2024, 9, 12, 15, 4).getTime(), now)).toBe(`Oct 12, 2024, 3:04${NN}PM`);
    expect(relativeAgo(now.getTime() - 3600_000, now)).toBe("1 hour ago");
    expect(fullDate(new Date(2026, 9, 18, 20, 6).getTime())).toBe(`Sun, Oct 18, 2026, 8:06${NN}PM`);
    expect(quoteDate(new Date(2026, 9, 18, 20, 6).getTime())).toBe(`Sun, Oct 18, 2026 at 8:06${NN}PM`);
  });
  it("snooze presets match what the web client offers on a Sunday evening", () => {
    const p = snoozePresets(now);
    expect(p.map((x) => [x.label, x.detail])).toEqual([
      ["Tomorrow", `Mon, 8:00${NN}AM`],
      ["Next week", `Tue, 8:00${NN}AM`],
      ["Next weekend", `Sat, 8:00${NN}AM`],
    ]);
    const wed = snoozePresets(new Date(2026, 9, 14, 9));
    expect(wed.map((x) => x.label)).toEqual(["Later today", "Tomorrow", "This weekend", "Next week"]);
    expect(wed[0].when.getHours()).toBe(18);
  });
  it("schedule-send presets", () => {
    expect(schedulePresets(now).map((x) => x.label)).toEqual(["Tomorrow morning", "Tomorrow afternoon"]); // tomorrow is Monday
    expect(schedulePresets(new Date(2026, 9, 14, 9)).map((x) => x.label)).toEqual(["Tomorrow morning", "Tomorrow afternoon", "Monday morning"]);
  });
});

describe("threading", () => {
  it("normalises subjects", () => {
    expect(normalizeSubject("Re: Fwd: [team] RE:  Lunch on  Friday?")).toBe("lunch on friday?");
    expect(normalizeSubject("AW: WG: Bericht")).toBe("bericht");
  });
  it("groups by references, in-reply-to and reply subjects", () => {
    const t = threadMessages([
      { id: "1", messageId: "<a@x>", inReplyTo: null, references: [], subject: "Lunch", date: 1 },
      { id: "2", messageId: "<b@x>", inReplyTo: "<a@x>", references: ["<a@x>"], subject: "Re: Lunch", date: 2 },
      { id: "3", messageId: "<c@x>", inReplyTo: "<b@x>", references: [], subject: "Re: Lunch", date: 3 },
      { id: "4", messageId: "<d@x>", inReplyTo: null, references: [], subject: "Re: Lunch", date: 4 },
      { id: "5", messageId: "<e@x>", inReplyTo: null, references: [], subject: "Lunch", date: 5 }, // new thread, same subject, not a reply
      { id: "6", messageId: null, inReplyTo: null, references: [], subject: "Other", date: 6 },
    ]);
    expect(new Set([t.get("1"), t.get("2"), t.get("3"), t.get("4")]).size).toBe(1);
    expect(t.get("5")).not.toBe(t.get("1"));
    expect(t.get("6")).toBe("local:6");
  });
  it("conversation layout collapses read messages and folds long runs", () => {
    const m = (id: string, unread = false) => ({ id, unread, date: +id });
    expect(conversationLayout([m("1"), m("2"), m("3")])).toEqual([
      { kind: "message", id: "1", expanded: false },
      { kind: "message", id: "2", expanded: false },
      { kind: "message", id: "3", expanded: true },
    ]);
    const long = conversationLayout([m("1"), m("2"), m("3"), m("4"), m("5"), m("6", true), m("7")]);
    expect(long).toEqual([
      { kind: "message", id: "1", expanded: false },
      { kind: "message", id: "2", expanded: false },
      { kind: "collapsed", ids: ["3", "4", "5"] },
      { kind: "message", id: "6", expanded: true },
      { kind: "message", id: "7", expanded: true },
    ]);
    expect(conversationLayout([m("1"), m("2")], { expandAll: true }).every((x) => x.kind === "message" && x.expanded)).toBe(true);
    // Opening the fold lists every message; only the unread and the last stay expanded.
    const unfolded = conversationLayout([m("1"), m("2"), m("3"), m("4"), m("5"), m("6", true), m("7")], { unfold: true });
    expect(unfolded.map((x) => (x.kind === "message" ? `${x.id}${x.expanded ? "+" : ""}` : "fold"))).toEqual(["1", "2", "3", "4", "5", "6+", "7+"]);
  });
  it("participants column", () => {
    const self = ["me@x.io"];
    const p = participants(
      [
        { from: { name: "Ana Lima", email: "ana@x.io" }, unread: false },
        { from: { name: "Me", email: "me@x.io" }, unread: false },
        { from: { name: "Ana Lima", email: "ana@x.io" }, unread: true },
      ],
      self,
    );
    expect(participantsText(p)).toBe("me, Ana 3");
    expect(p.parts.find((x) => x.text === "Ana")?.bold).toBe(true);
    expect(participantsText(participants([{ from: { name: "Me", email: "me@x.io" }, unread: false }], self))).toBe("me");
    const d = participants(
      [
        { from: { name: "Bo", email: "bo@x.io" }, unread: false },
        { from: { name: "Me", email: "me@x.io" }, unread: false, isDraft: true },
      ],
      self,
    );
    expect(d.parts.map((x) => x.text)).toEqual(["Bo", "Draft"]);
  });
});

describe("labels", () => {
  it("maps IMAP folders by special-use and name", () => {
    expect(folderSystemLabel({ path: "Sent Items", delimiter: "/", flags: [] })).toBe("SENT");
    expect(folderSystemLabel({ path: "Archive", delimiter: "/", flags: ["\\Archive"] })).toBe("ALL");
    expect(folderSystemLabel({ path: "INBOX", delimiter: ".", flags: [] })).toBe("INBOX");
    expect(folderSystemLabel({ path: "Junk E-mail", delimiter: "/", flags: [] })).toBe("SPAM");
    expect(folderSystemLabel({ path: "[Gmail]/Important", delimiter: "/", flags: [] })).toBe("IMPORTANT");
    expect(folderSystemLabel({ path: "Receipts", delimiter: "/", flags: [] })).toBeNull();
    expect(folderLabelName({ path: "INBOX.Receipts.2026", delimiter: ".", flags: [] })).toBe("Receipts/2026");
    expect(folderLabelName({ path: "Proj&AOk-t", delimiter: "/", flags: [] })).toBe("Projét");
    expect(decodeModifiedUtf7(encodeModifiedUtf7("日本語 & more"))).toBe("日本語 & more");
  });
  it("builds a nested tree with implied parents", () => {
    const t = labelTree([
      { id: "2", name: "Projects/Alpha" },
      { id: "3", name: "Receipts" },
      { id: "4", name: "Travel/2026/Spring" },
      { id: "1", name: "Projects" },
    ]);
    expect(t.map((n) => n.name)).toEqual(["Projects", "Receipts", "Travel"]);
    expect(t[0].children[0].label?.id).toBe("2");
    expect(t[2].label).toBeNull();
    expect(t[2].children[0].children[0].path).toBe("Travel/2026/Spring");
  });
  it("validates names and colours", () => {
    expect(validateLabelName("Inbox", [])).toMatch(/reserved/);
    expect(validateLabelName("projects", ["Projects"])).toMatch(/exists/);
    expect(validateLabelName("a//b", [])).toMatch(/\/\//);
    expect(validateLabelName("Trips", [])).toBeNull();
    expect(LABEL_BG.length).toBe(64);
    expect(labelTextColor("#ffffff")).toBe("#000000");
    expect(labelTextColor("#1c4587")).toBe("#ffffff");
    expect(chipStyle(null).background).toBe("var(--label-chip-bg)");
    expect(CATEGORIES.map((c) => c.name)).toEqual(["Primary", "Promotions", "Social", "Updates", "Forums"]);
    const all = new Map([
      ["INBOX", { id: "INBOX", name: "Inbox", type: "system" }],
      ["L1", { id: "L1", name: "Projects", type: "user" }],
      ["STARRED", { id: "STARRED", name: "Starred", type: "system" }],
    ]);
    expect(rowChips(["INBOX", "L1", "STARRED"], all, "INBOX").map((l) => l.id)).toEqual(["L1"]);
    expect(rowChips(["INBOX", "L1"], all, "L1").map((l) => l.id)).toEqual(["INBOX"]);
  });
});

describe("shortcuts", () => {
  it("single keys, shifted letters and punctuation", () => {
    const m = new ShortcutMatcher();
    expect(m.feed({ key: "c" })).toBe("compose");
    expect(m.feed({ key: "I", shiftKey: true })).toBe("mark-read");
    expect(m.feed({ key: "U", shiftKey: true })).toBe("mark-unread");
    expect(m.feed({ key: "#", shiftKey: true })).toBe("delete");
    expect(m.feed({ key: "!" })).toBe("spam");
    expect(m.feed({ key: "?" })).toBe("help");
    expect(m.feed({ key: "c", metaKey: true })).toBeNull();
    expect(keyName({ key: "Escape" })).toBeNull();
  });
  it("sequences with a timeout", () => {
    const m = new ShortcutMatcher();
    expect(m.feed({ key: "g" }, 0)).toBe("pending");
    expect(m.feed({ key: "i" }, 100)).toBe("go-inbox");
    expect(m.feed({ key: "*" }, 200)).toBe("pending");
    expect(m.feed({ key: "a" }, 300)).toBe("select-all");
    expect(m.feed({ key: "g" }, 400)).toBe("pending");
    expect(m.feed({ key: "s" }, 5000)).toBe("star"); // too late: plain "s"
    expect(new Set(SHORTCUTS.map((s) => s.keys)).size).toBe(SHORTCUTS.length);
  });
  it("custom keys replace an action's default, several per action, sequences included", () => {
    const m = new ShortcutMatcher(withCustomKeys({ archive: "a, y", "go-inbox": "q i" }));
    expect(m.feed({ key: "a" })).toBe("archive");
    expect(m.feed({ key: "y" })).toBe("archive");
    expect(m.feed({ key: "e" })).toBeNull(); // the default no longer archives
    expect(m.feed({ key: "q" }, 0)).toBe("pending");
    expect(m.feed({ key: "i" }, 50)).toBe("go-inbox");
    expect(m.feed({ key: "c" })).toBe("compose"); // untouched actions keep theirs
  });
});

describe("compose helpers", () => {
  const src: SourceMessage = {
    from: [{ name: "Ana", email: "ana@x.io" }],
    to: [
      { name: "Me", email: "me@x.io" },
      { name: "Bo", email: "bo@x.io" },
    ],
    cc: [
      { name: "Cy", email: "cy@x.io" },
      { name: "Me alias", email: "me+work@x.io" },
    ],
    replyTo: [],
    subject: "Lunch",
    date: new Date(2026, 9, 18, 20, 6).getTime(),
    messageId: "<m2@x.io>",
    references: ["<m1@x.io>"],
    html: "<p>Lunch?</p>",
    text: "Lunch?",
  };
  const self = ["me@x.io", "me+work@x.io"];
  it("reply and reply-all recipients", () => {
    expect(replyRecipients(src, "reply", self)).toEqual({ to: [{ name: "Ana", email: "ana@x.io" }], cc: [] });
    const all = replyRecipients(src, "reply-all", self);
    expect(all.to.map((a) => a.email)).toEqual(["ana@x.io"]);
    expect(all.cc.map((a) => a.email)).toEqual(["bo@x.io", "cy@x.io"]);
    const mine = replyRecipients({ ...src, from: [{ name: "Me", email: "me@x.io" }], to: [{ name: "Bo", email: "bo@x.io" }] }, "reply", self);
    expect(mine.to.map((a) => a.email)).toEqual(["bo@x.io"]);
    expect(replyRecipients({ ...src, replyTo: [{ name: "List", email: "list@x.io" }] }, "reply", self).to[0].email).toBe("list@x.io");
    expect(pickFromAlias(src, self, "me@x.io")).toBe("me@x.io");
  });
  it("subjects, quotes, forward block and references", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("RE: Lunch")).toBe("RE: Lunch");
    expect(forwardSubject("Lunch")).toBe("Fwd: Lunch");
    const r = buildReply(src, "reply", self);
    expect(r.references).toEqual(["<m1@x.io>", "<m2@x.io>"]);
    expect(r.inReplyTo).toBe("<m2@x.io>");
    expect(r.quotedHtml).toContain(`On Sun, Oct 18, 2026 at 8:06${NN}PM Ana &lt;ana@x.io&gt; wrote:`);
    expect(r.quotedHtml).toContain("<blockquote");
    expect(r.quotedText).toContain("> Lunch?");
    const f = buildReply(src, "forward", self);
    expect(f.to).toEqual([]);
    expect(f.quotedText).toContain("---------- Forwarded message ---------\nFrom: Ana <ana@x.io>");
    expect(mentionsAttachment("Please see attached.\n\nOn Sun wrote: x")).toBe(true);
    expect(mentionsAttachment("Thanks!\n\nOn Sun, Oct 18, 2026 at 8:06 PM Ana wrote:\n> attached")).toBe(false);
  });
});

describe("text", () => {
  it("html → text keeps structure", () => {
    const t = htmlToText(
      `<style>p{}</style><h1>Title</h1><p>Hello <a href="https://x.io/a">link</a>&nbsp;&amp; more</p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><blockquote><p>quoted</p></blockquote><p>a<br>b</p>`,
    );
    expect(t).toBe("Title\nHello link <https://x.io/a> & more\n- one\n- two\n1. first\n> quoted\na\nb");
    expect(decodeEntities("&lt;&#x41;&#66;&hellip;&unknown;")).toBe("<AB…&unknown;");
  });
  it("text → html escapes, links and quotes", () => {
    const h = textToHtml("Hi <b>\nSee https://x.io/a.\n> quoted\nmail me@x.io");
    expect(h).toContain("Hi &lt;b&gt;");
    expect(h).toContain('<a href="https://x.io/a">https://x.io/a</a>.');
    expect(h).toContain('<blockquote class="courier_quote"');
    expect(h).toContain('<a href="mailto:me@x.io">me@x.io</a>');
  });
  it("snippets drop quotes and join blocks like the list does", () => {
    expect(snippetOf("Hi,\nAttached are the notes.\n\nOn Sun, Oct 18, 2026 at 8:06 PM Ana wrote:\n> old", 200, "")).toBe("Hi,Attached are the notes.");
    expect(snippetOf("a ".repeat(150), 20)).toBe("a a a a a a a a a a…");
  });
});

describe("unsubscribe and mailto", () => {
  it("prefers RFC 8058 one-click, then mailto, then the website", () => {
    expect(parseListUnsubscribe("<mailto:u@x.io?subject=stop>, <https://x.io/u>", "List-Unsubscribe=One-Click")).toEqual({
      kind: "one-click",
      url: "https://x.io/u",
    });
    expect(parseListUnsubscribe("<mailto:u@x.io?subject=stop>, <https://x.io/u>", null)).toEqual({ kind: "mailto", to: "u@x.io", subject: "stop", body: "" });
    // A line break or a second address in the sender's header never reaches the email Courier sends.
    expect(parseListUnsubscribe("<mailto:u@x.io%0D%0ABcc:%20evil@x.io>, <https://x.io/u>", null)).toEqual({ kind: "website", url: "https://x.io/u" });
    expect(parseListUnsubscribe("<mailto:u@x.io,evil@x.io>", null)).toBeNull();
    expect(parseListUnsubscribe("<mailto:u@x.io?subject=stop%0D%0ABcc:%20evil@x.io>", null)).toEqual({
      kind: "mailto",
      to: "u@x.io",
      subject: "stop Bcc: evil@x.io",
      body: "",
    });
    expect(parseListUnsubscribe("<https://x.io/u>", null)).toEqual({ kind: "website", url: "https://x.io/u" });
    expect(parseListUnsubscribe(null, null)).toBeNull();
  });
  it("parses mailto URLs", () => {
    expect(parseMailto("mailto:a@x.io,b@x.io?cc=c@x.io&Subject=Hi%20there&body=Line%201")).toEqual({
      to: ["a@x.io", "b@x.io"],
      cc: ["c@x.io"],
      bcc: [],
      subject: "Hi there",
      body: "Line 1",
    });
  });
});

describe("settings after a restart", () => {
  it("keeps the system labels' show/hide choices", async () => {
    const { mergeSettings, SYSTEM_LABEL_DEFAULTS } = await import("../src/state/settings");
    const back = mergeSettings({ systemLabels: { STARRED: "hide", ALL: "show" } });
    expect(back.systemLabels).toEqual({ STARRED: "hide", ALL: "show" });
    expect(SYSTEM_LABEL_DEFAULTS).toMatchObject({ IMPORTANT: "hide", ALL: "hide", SPAM: "hide", TRASH: "hide", SCHEDULED: "show if unread", DRAFT: "show" });
  });
});
