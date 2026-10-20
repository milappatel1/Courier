import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { frameDocument, isTrackerUrl, sanitizeHtml } from "../src/core/sanitize";
import { textToHtml } from "../src/core/text";

const win = new Window();
const parser = new win.DOMParser() as unknown as { parseFromString(s: string, t: "text/html"): Document };
const clean = (html: string, allowRemote = false, cid?: Record<string, string>) => sanitizeHtml(html, { allowRemote, cid }, parser);

describe("sanitiser", () => {
  it("removes scripts, handlers, frames and active content", () => {
    const r = clean(
      `<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://e.vil"></iframe><object data="x"></object><embed src="y"><form action="https://e.vil"><input name="p"><button>go</button>text</form><a href="javascript:alert(1)">bad</a><svg><script>1</script><foreignObject>z</foreignObject></svg><meta http-equiv="refresh" content="0;url=https://e.vil"><base href="https://e.vil/"><link rel="stylesheet" href="https://e.vil/x.css">`,
    );
    expect(r.html).not.toMatch(/script|onclick|iframe|<object|<embed|<input|<button|javascript:|foreignobject|<meta|<base|<link/i);
    expect(r.html).toContain("text"); // form contents kept, form removed
    expect(r.html).toContain(">bad</a>");
  });

  it("blocks remote images until allowed, keeps inline data and maps cid:", () => {
    const html = `<img src="https://cdn.example.com/banner.png" width="600" height="200"><img src="data:image/png;base64,AAAA"><img src="cid:logo@x">`;
    const blocked = clean(html, false, { "logo@x": "blob:courier/1" });
    expect(blocked.remoteBlocked).toBe(1);
    expect(blocked.hasRemote).toBe(true);
    expect(blocked.html).toContain('data-courier-src="https://cdn.example.com/banner.png"');
    expect(blocked.html).not.toContain(' src="https://cdn.example.com');
    expect(blocked.html).toContain('src="data:image/png;base64,AAAA"');
    expect(blocked.html).toContain('src="blob:courier/1"');
    const allowed = clean(html, true);
    expect(allowed.remoteBlocked).toBe(0);
    expect(allowed.html).toContain('src="https://cdn.example.com/banner.png"');
  });

  it("strips tracking pixels even when images are allowed", () => {
    const html = `<img src="https://t.example.com/o.gif?u=1" width="1" height="1"><img src="https://x.list-manage.com/track/open.php?u=2"><img src="https://a.example.com/p.png" style="display:none"><img src="https://a.example.com/hero.jpg" width="300">`;
    const r = clean(html, true);
    expect(r.trackersRemoved).toBe(3);
    expect(r.html).toContain("hero.jpg");
    expect(isTrackerUrl("https://sendgrid.net/wf/open?upn=x")).toBe(true);
    expect(isTrackerUrl("https://example.com/photo.jpg")).toBe(false);
  });

  it("cleans CSS: no @import, expressions or remote url() before allowing", () => {
    const r = clean(
      `<style>@import url(https://e.vil/a.css); .a{background:url(https://e.vil/bg.png)} .b{width:expression(alert(1))} .c{position:fixed}</style><div style="background-image:url('https://e.vil/x.png');color:red" background="https://e.vil/t.png">x</div>`,
    );
    expect(r.html).not.toMatch(/@import|expression\(|e\.vil|position:fixed/);
    expect(r.html).toContain("color:red");
    expect(r.remoteBlocked).toBe(3);
  });

  it("makes links open outside and keeps safe schemes", () => {
    const r = clean(`<a href="https://example.com">a</a><a href="mailto:x@example.com">m</a><a href="#top">t</a><a href="data:text/html,x">d</a>`);
    expect(r.html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(r.html).toContain('href="mailto:x@example.com"');
    expect(r.html).toContain('<a href="#top">t</a>');
    expect(r.html).not.toContain("data:text/html");
  });

  it("folds trailing quoted history but not interleaved quotes", () => {
    const reply = clean(
      `<div>Sounds good.</div><div class="gmail_quote"><div>On Sun, Oct 18, 2026 at 8:06 PM Ana wrote:</div><blockquote>Lunch?</blockquote></div>`,
    );
    expect(reply.quoted).toBe(true);
    expect(reply.html).toMatch(/<div class="courier-quoted"><div class="gmail_quote">/);
    const plain = clean(textToHtml("Yes!\n\nOn Sun, Oct 18, 2026 at 8:06 PM Ana wrote:\n> Lunch?\n> Friday?"));
    expect(plain.quoted).toBe(true);
    const interleaved = clean(`<blockquote type="cite">question 1</blockquote><p>answer 1</p><blockquote type="cite">question 2</blockquote><p>answer 2</p>`);
    expect(interleaved.quoted).toBe(false);
  });

  it("frame document carries a CSP that matches the remote-image choice", () => {
    expect(frameDocument("<p>x</p>", { allowRemote: false })).toContain("img-src data: blob:;");
    expect(frameDocument("<p>x</p>", { allowRemote: true })).toContain("img-src data: blob: https: http:");
    expect(frameDocument("<p>x</p>", { allowRemote: false })).toContain("script-src 'none'");
  });
});

describe("message frame sizing", () => {
  it("turns viewport heights into fixed ones so a page-height layout can't grow with its own frame", () => {
    const r = clean(`<style>.wrap{min-height:100vh;height:50dvh}</style><div class="wrap" style="height:100vh">x</div>`);
    expect(r.html).not.toMatch(/\d(vh|dvh)\b/);
    expect(r.html).toContain("800px");
    expect(r.html).toContain("400px");
  });

  it("lets wide mail scroll sideways and never pins the page height", () => {
    const doc = frameDocument("<table width=1400><tr><td>x</td></tr></table>", { allowRemote: true });
    expect(doc).toMatch(/overflow-x:auto/);
    expect(doc).toMatch(/height:auto!important/);
    expect(doc).not.toMatch(/table\{max-width:100%\}/);
  });
});
