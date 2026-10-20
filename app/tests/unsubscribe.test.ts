import { describe, expect, it } from "vitest";
import { parseListUnsubscribe, unsubscribeDialog } from "../src/core/unsubscribe";

const ONE_CLICK = "List-Unsubscribe=One-Click";

describe("which way to unsubscribe", () => {
  it("takes one-click first, then an email, then the sender's website", () => {
    expect(parseListUnsubscribe("<mailto:u@x.example?subject=stop>, <https://x.example/u?id=1>", ONE_CLICK)).toEqual({
      kind: "one-click",
      url: "https://x.example/u?id=1",
    });
    expect(parseListUnsubscribe("<https://x.example/u?id=1>, <mailto:u@x.example?subject=stop>", null)).toEqual({
      kind: "mailto",
      to: "u@x.example",
      subject: "stop",
      body: "",
    });
    expect(parseListUnsubscribe("<https://x.example/u?id=1>", null)).toEqual({ kind: "website", url: "https://x.example/u?id=1" });
    // One-click needs https; a plain-http link is only something to open.
    expect(parseListUnsubscribe("<http://x.example/u>", ONE_CLICK)).toEqual({ kind: "website", url: "http://x.example/u" });
    expect(parseListUnsubscribe("", ONE_CLICK)).toBeNull();
  });

  it("reads a header sent as an encoded word", () => {
    const encoded = "=?us-ascii?Q?=3Cmailto=3Aleave=40list=2Eexample=3E=2C_=3Chttps=3A=2F=2Flist=2Eexample=2Fu=3E?=";
    expect(parseListUnsubscribe(encoded, ONE_CLICK)).toEqual({ kind: "one-click", url: "https://list.example/u" });
  });
});

describe("the Unsubscribe dialog", () => {
  const sender = { name: "Weekly News", email: "hello@news.example" };
  const account = "pat@example.com";

  it("from a message: this mailing list", () => {
    const d = unsubscribeDialog({ kind: "one-click", url: "https://news.example/u" }, { scope: "list", sender, account });
    expect(d).toMatchObject({ title: "Unsubscribe", ok: "Unsubscribe" });
    expect(d.body).toBe("Do you want to stop getting messages from this mailing list (Weekly News)?");
    expect(d.note).toMatch(/other mailing lists/);
  });

  it("from Manage subscriptions: all of the sender's mailing lists", () => {
    const d = unsubscribeDialog({ kind: "one-click", url: "https://news.example/u" }, { scope: "sender", sender, account });
    expect(d.body).toBe("Do you want to stop getting messages from all mailing lists from Weekly News (hello@news.example)?");
  });

  it("an email says it is sent, from which account and to whom", () => {
    const d = unsubscribeDialog({ kind: "mailto", to: "leave@news.example", subject: "", body: "" }, { scope: "list", sender, account });
    expect(d.ok).toBe("Unsubscribe");
    expect(d.body).toBe(
      "Do you want to stop getting messages from this mailing list (Weekly News)? Courier will unsubscribe for you by sending an email from pat@example.com to leave@news.example.",
    );
  });

  it("a website-only list sends you to the website", () => {
    const d = unsubscribeDialog({ kind: "website", url: "https://news.example/u" }, { scope: "list", sender, account });
    expect(d).toMatchObject({ title: "Unsubscribe", ok: "Go to website" });
    expect(d.body).toBe("To stop getting messages from this mailing list (Weekly News), go to their website to unsubscribe.");
    const all = unsubscribeDialog({ kind: "website", url: "https://news.example/u" }, { scope: "sender", sender, account });
    expect(all.body).toBe("To stop getting messages from all mailing lists from Weekly News (hello@news.example), go to their website to unsubscribe.");
  });
});
