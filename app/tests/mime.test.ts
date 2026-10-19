import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, base64UrlEncode, binaryString, decodeCharset, latin1, qpDecode, qpEncode, utf8 } from "../src/core/bytes";
import { buildMime, encodedSize, rfc5322Date } from "../src/core/mime/build";
import { decodeWords, encodeWords, formatParam, parseHeaderValue } from "../src/core/mime/headers";
import { authResults, leafParts, parseMessage } from "../src/core/mime/parse";

const td = new TextDecoder();
const me = { name: "Pat Example", email: "pat@example.com" };

describe("bytes", () => {
  it("base64 round-trips every length and wraps lines", () => {
    for (let n = 0; n < 40; n++) {
      const a = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect([...base64Decode(base64Encode(a))]).toEqual([...a]);
    }
    const wrapped = base64Encode(new Uint8Array(200), 76);
    expect(wrapped.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(base64UrlEncode(utf8("?>?>"))).toBe("Pz4_Pg");
    expect(td.decode(base64Decode("Pz4_Pg"))).toBe("?>?>");
  });
  it("quoted-printable encodes UTF-8, soft-wraps and decodes", () => {
    const text = "Café — naïve résumé ".repeat(8) + "\nend with space ";
    const qp = qpEncode(text);
    expect(qp.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(qp).toContain("=20"); // trailing space protected
    expect(td.decode(qpDecode(qp)).replace(/\r\n/g, "\n")).toBe(text);
    expect(td.decode(qpDecode("a=3D=\r\nb"))).toBe("a=b");
  });
  it("decodes legacy charsets and unknown labels", () => {
    expect(decodeCharset(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1")).toBe("café");
    expect(decodeCharset(new Uint8Array([0x93, 0x68, 0x69, 0x94]), "windows-1252")).toBe("“hi”");
    expect(decodeCharset(utf8("ok"), "x-unknown-charset")).toBe("ok");
    expect(latin1(binaryString("\xff\x00a"))).toBe("\xff\x00a");
  });
});

describe("headers", () => {
  it("encodes and decodes RFC 2047 words", () => {
    const s = "Réunion du comité — 2026 ✓ with a fairly long subject line that needs several words";
    const e = encodeWords(s);
    expect(e.startsWith("=?UTF-8?B?")).toBe(true);
    expect(e.split("\r\n ").every((w) => w.length <= 76)).toBe(true);
    expect(decodeWords(e.replace(/\r\n /g, " "))).toBe(s);
    expect(encodeWords("plain ascii")).toBe("plain ascii");
    expect(decodeWords("=?ISO-8859-1?Q?Andr=E9?= Pirard")).toBe("André Pirard");
    expect(decodeWords("=?utf-8?q?a_b?= =?utf-8?q?c?=")).toBe("a bc");
  });
  it("parses parameters incl. RFC 2231 continuations", () => {
    const v = parseHeaderValue(`attachment; filename*0*=UTF-8''%E2%82%AC%20rates; filename*1=".pdf"; size=42`);
    expect(v.value).toBe("attachment");
    expect(v.params.filename).toBe("€ rates.pdf");
    expect(v.params.size).toBe("42");
    const q = parseHeaderValue('text/plain; charset="utf-8"; name="a \\"b\\".txt"');
    expect(q.params.charset).toBe("utf-8");
    expect(q.params.name).toBe('a "b".txt');
    expect(formatParam("filename", "naïve.txt")).toBe("filename*=UTF-8''na%C3%AFve.txt");
  });
});

describe("build → parse round trips", () => {
  it("plain text", () => {
    const built = buildMime({ from: me, to: [{ name: "Ana", email: "ana@example.org" }], subject: "Hi there", text: "Line one\nLine two — ünïcode" }, { seed: "t1" });
    const raw = latin1(built.raw);
    expect(raw).toContain("Content-Type: text/plain");
    expect(raw).toMatch(/\r\n\r\n/);
    expect(raw.includes("\n") && !/[^\r]\n/.test(raw)).toBe(true); // CRLF only
    const p = parseMessage(built.raw);
    expect(p.subject).toBe("Hi there");
    expect(p.from).toEqual([me]);
    expect(p.to[0].email).toBe("ana@example.org");
    expect(p.text?.replace(/\r\n/g, "\n").trimEnd()).toBe("Line one\nLine two — ünïcode");
    expect(p.messageId).toBe(built.messageId);
    expect(built.recipients).toEqual(["ana@example.org"]);
  });

  it("html with attachments, inline image and unicode names", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const pdf = utf8("%PDF-1.4 fake");
    const built = buildMime(
      {
        from: { name: "Zoë Ångström", email: "zoe@example.com" },
        to: [{ name: "Team, Design", email: "design@example.com" }],
        cc: [{ name: "", email: "cc@example.com" }],
        bcc: [{ name: "Hidden", email: "bcc@example.com" }],
        subject: "Plan für Q4 ✓",
        html: '<p>Hello <b>team</b></p><p><img src="cid:img1@courier"></p>',
        attachments: [
          { filename: "plan – final.pdf", mimeType: "application/pdf", data: pdf },
          { filename: "photo.png", mimeType: "image/png", data: png, contentId: "img1@courier" },
        ],
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
      },
      { seed: "t2" },
    );
    const raw = latin1(built.raw);
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("multipart/related");
    expect(raw).not.toContain("Bcc:");
    expect(built.recipients).toEqual(["design@example.com", "cc@example.com", "bcc@example.com"]);
    const p = parseMessage(built.raw);
    expect(p.from[0].name).toBe("Zoë Ångström");
    expect(p.to[0].name).toBe("Team, Design");
    expect(p.subject).toBe("Plan für Q4 ✓");
    expect(p.html).toContain("<b>team</b>");
    expect(p.text).toContain("Hello team");
    expect(p.inReplyTo).toBe("<parent@example.com>");
    expect(p.references).toEqual(["<root@example.com>", "<parent@example.com>"]);
    const att = p.attachments.find((a) => a.mimeType === "application/pdf")!;
    expect(att.filename).toBe("plan – final.pdf");
    expect(td.decode(att.data)).toBe("%PDF-1.4 fake");
    const img = p.attachments.find((a) => a.contentId === "img1@courier")!;
    expect(img.inline).toBe(true);
    expect([...img.data]).toEqual([...png]);
  });

  it("keeps Bcc when asked (Gmail API sends) and forwards a message as an attachment", () => {
    const inner = buildMime({ from: me, to: [me], subject: "Inner", text: "inside" }, { seed: "in" });
    const built = buildMime({ from: me, to: [me], bcc: [{ name: "", email: "b@example.com" }], subject: "Fwd: Inner", text: "see attached", forwarded: [{ filename: "Inner.eml", raw: inner.raw }] }, { includeBcc: true, seed: "t3" });
    const p = parseMessage(built.raw);
    expect(p.bcc[0].email).toBe("b@example.com");
    const eml = p.attachments.find((a) => a.mimeType === "message/rfc822")!;
    expect(eml.filename).toBe("Inner.eml");
    expect(parseMessage(eml.data).subject).toBe("Inner");
  });

  it("formats RFC 5322 dates with the local offset", () => {
    const d = new Date(2026, 9, 18, 20, 6, 0);
    expect(rfc5322Date(d)).toBe("Sun, 18 Oct 2026 20:06:00 -0400");
    expect(encodedSize(3)).toBe(4);
  });
});

describe("parsing real-world shapes", () => {
  const sample = [
    "Delivered-To: me@example.com",
    "Received: from x by y; Sun, 18 Oct 2026 10:00:00 +0000",
    "Authentication-Results: mx.example.com; dkim=pass header.i=@shop.example; spf=pass smtp.mailfrom=shop.example; dmarc=pass",
    "From: =?UTF-8?B?U2hvcCDinJM=?= <news@shop.example>",
    "To: undisclosed-recipients:;",
    "Cc: Team: a@example.com, b@example.com;",
    "Subject: =?iso-8859-1?q?Sold=E9s?= today",
    "Date: Sun, 18 Oct 2026 06:00:00 -0400 (EDT)",
    "Message-ID: <m1@shop.example>",
    "List-Unsubscribe: <mailto:u@shop.example?subject=stop>, <https://shop.example/u/1>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "preamble",
    "--outer",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Sold=E9s! Big =",
    "savings.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Encode(utf8("<p>Soldés! <b>Big</b> savings.</p>"), 76),
    "--alt--",
    "--outer",
    "Content-Type: text/calendar; method=REQUEST; name=invite.ics",
    "Content-Disposition: attachment; filename=invite.ics",
    "",
    "BEGIN:VCALENDAR",
    "--outer--",
    "epilogue",
  ].join("\r\n");

  it("decodes headers, picks html, keeps text and attachments", () => {
    const p = parseMessage(sample);
    expect(p.from[0]).toEqual({ name: "Shop ✓", email: "news@shop.example" });
    expect(p.to).toEqual([]);
    expect(p.cc.map((a) => a.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(p.subject).toBe("Soldés today");
    expect(p.date?.toISOString()).toBe("2026-10-18T10:00:00.000Z");
    expect(p.html).toContain("<b>Big</b>");
    expect(p.text).toBe("Soldés! Big savings.");
    expect(p.attachments.map((a) => a.filename)).toEqual(["invite.ics"]);
    expect(p.listUnsubscribePost).toContain("One-Click");
    expect(p.deliveredTo).toEqual(["me@example.com"]);
    expect(authResults(p)).toEqual({ spf: "PASS", dkim: "PASS", dmarc: "PASS" });
    expect(leafParts(p).map((x) => x.partId)).toEqual(["1.1", "1.2", "2"]);
  });

  it("handles LF-only mail, raw 8-bit UTF-8 headers and missing content types", () => {
    const raw = utf8("From: Jürgen <j@example.de>\nSubject: Grüße\n\nHallo\n");
    const p = parseMessage(raw);
    expect(p.from[0].name).toBe("Jürgen");
    expect(p.subject).toBe("Grüße");
    expect(p.text?.trim()).toBe("Hallo");
    expect(p.html).toBeNull();
  });
});
