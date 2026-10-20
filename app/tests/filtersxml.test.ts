import { describe, expect, it } from "vitest";
import { exportFiltersXml, importedAction, importFiltersXml } from "../src/core/filtersxml";

describe("filter files", () => {
  const filters = [
    {
      criteria: { from: "billing@shop.example", hasAttachment: true, size: 5 * 1024 * 1024, sizeComparison: "larger" as const },
      action: { addLabelIds: ["Label_7", "STARRED"], removeLabelIds: ["INBOX", "UNREAD"] },
    },
    { criteria: { query: "unsubscribe & <deals>", negatedQuery: "receipt" }, action: { addLabelIds: ["CATEGORY_PROMOTIONS", "TRASH"], forward: "me@x.io" } },
  ];

  it("exports the web client's format and reads it back the same", () => {
    const xml = exportFiltersXml(
      filters,
      (id) => (id === "Label_7" ? "Bills/Shop" : id),
      { name: "Pat", email: "pat@example.com" },
      new Date("2026-10-20T00:00:00Z"),
    );
    expect(xml).toContain("xmlns:apps='http://schemas.google.com/apps/2006'");
    expect(xml).toContain("<apps:property name='label' value='Bills/Shop'/>");
    expect(xml).toContain("<apps:property name='hasTheWord' value='unsubscribe &amp; &lt;deals&gt;'/>");
    expect(xml).toContain("<apps:property name='sizeUnit' value='s_smb'/>");
    const back = importFiltersXml(xml);
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ labelName: "Bills/Shop", archive: true, markRead: true, star: true });
    expect(back[0].criteria).toEqual({ from: "billing@shop.example", hasAttachment: true, size: 5 * 1024 * 1024, sizeComparison: "larger" });
    expect(back[1].criteria.query).toBe("unsubscribe & <deals>");
    expect(back[1]).toMatchObject({ trash: true, category: "CATEGORY_PROMOTIONS", forward: "me@x.io" });
    expect(importedAction(back[0], "Label_99")).toEqual({ addLabelIds: ["Label_99", "STARRED"], removeLabelIds: ["INBOX", "UNREAD"] });
  });

  it("reads files written by other programs (double quotes, extra properties, entries without criteria)", () => {
    const xml = `<feed><entry><apps:property name="from" value="a@b.c" /><apps:property name="shouldNeverSpam" value="true"/><apps:property name="unknownThing" value="x"/></entry><entry><apps:property name="label" value="Lonely"/></entry></feed>`;
    const f = importFiltersXml(xml);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ criteria: { from: "a@b.c" }, neverSpam: true, labelName: null });
  });
});
