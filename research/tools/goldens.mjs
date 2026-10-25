// Capture redacted screenshots of named UI states, the same way for both sides, so they can be diffed:
//   web:     the web client in the recon profile (CDP 127.0.0.1:9222)
//   courier: Courier's browser preview (/browser-preview.html) in a throwaway Chrome (CDP 127.0.0.1:9224)
// Each state's ops run through cdp-do.mjs; then
// state, the viewport is captured at DPR 2 with content hidden (see HIDE) and written (with a 1x copy) to
// research/goldens/<side>/<name>.png (+ -1x.png and .meta.json). Goldens are gitignored and never edited to make a
// diff pass.
//
// usage: node goldens.mjs <side> <plan.json> [only-name-substring]
//   plan.json: [{ "name": "inbox-default", "width": 1280, "height": 728, "ops": [ ...cdp-do ops... ] }, ...]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [side, planPath, only] = process.argv.slice(2);
const port = side === "web" ? 9222 : side === "courier" ? 9224 : null;
if (!port || !planPath) {
  console.error("usage: node goldens.mjs <web|courier> <plan.json> [only]");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, "utf8")).filter((s) => !only || s.name.includes(only));
const out = join(here, "..", "goldens", side);
mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && (side === "web" ? t.url.includes("mail.google.com") : t.url.includes("browser-preview")));
if (!target) throw new Error(`no ${side} page open on port ${port}`);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    ws.addEventListener("message", function onMsg(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.id !== myId) return;
      ws.removeEventListener("message", onMsg);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
  });
const { sessionId } = await call("Target.attachToTarget", { targetId: target.id, flatten: true });
const s = (m, p) => call(m, p, sessionId);

// What to hide on each side while capturing: the account's picture, every sender, subject, snippet and message body
// (the recon mailbox holds invented test mail plus the account's own notices; captures keep none of it), and any
// text with an email address. Content is made transparent in place, so layout, menus and windows on top stay exact;
// the style is removed after the capture.
const HIDE = {
  web: [
    'a[aria-label^="Google Account"] img', "img.gbii", "tr.zA .yX", "tr.zA .yW", "tr.zA .y6", "tr.zA .y2", "tr.zA .bog", "tr.zA .xT",
    "tr.zA .afn", "tr.zA .bq3", "tr.zA img", ".hP", ".gD", ".go", ".g2", ".a3s", ".ii", "img.ajn", ".aCi img", ".ajy img", ".iw", ".g3",
  ],
  courier: [
    '[data-testid="account-button"] img', '[data-testid="account-button"] .avatar', '[data-testid="thread-row"] .sender > span:not(.count):not(.pli)',
    '[data-testid="thread-row"] .subject-line .text', '[data-testid="thread-row"] .subj', '[data-testid="thread-row"] .snippet', '[data-testid="thread-row"] .avatar',
    '[data-testid="conv-subject"]', ".msg-from", ".msg-email", ".msg-body", '[data-testid="message-frame"]',
  ],
};
const hideExpr = (selectors) => `(() => {
  const st = document.createElement("style");
  st.id = "courier-capture-redact";
  st.textContent = ${JSON.stringify(selectors.join(","))} + "{color:transparent!important;text-shadow:none!important} " +
    ${JSON.stringify(selectors.join(","))}.split(",").filter((x) => / img|avatar|frame/.test(x)).join(",") + "{visibility:hidden!important}";
  document.head.appendChild(st);
  const re = /[\w.+-]+@[\w-]+\.[\w.]+|Find emails from /;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  window.__redacted = [];
  while (w.nextNode()) {
    const el = w.currentNode.parentElement;
    if (el && re.test(w.currentNode.nodeValue)) { window.__redacted.push([el, el.style.color]); el.style.color = "transparent"; }
  }
  document.querySelectorAll("input").forEach((i) => { if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(i.value)) { window.__redacted.push([i, i.style.color]); i.style.color = "transparent"; } });
  return window.__redacted.length;
})()`;
const unhideExpr = `(() => { document.getElementById("courier-capture-redact")?.remove(); for (const [el, c] of window.__redacted ?? []) el.style.color = c; window.__redacted = []; return 1; })()`;

for (const st of plan) {
  const width = st.width ?? 1280;
  const height = st.height ?? 728;
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  try {
    if (st.ops?.length) execFileSync("node", [join(here, "cdp-do.mjs"), target.id, JSON.stringify(st.ops)], { env: { ...process.env, CDP_PORT: String(port) }, stdio: "pipe" });
  } catch (e) {
    const why = String(e.stderr ?? e.message).split("\n").find((l) => /Error:/.test(l)) ?? "failed";
    console.log(`✗ ${side}/${st.name}: ${why.trim()}`);
    continue;
  }
  await new Promise((r) => setTimeout(r, st.settle ?? 600));
  const { result } = await s("Runtime.evaluate", { expression: hideExpr(HIDE[side]), returnByValue: true });
  await new Promise((r) => setTimeout(r, 100));
  const { data } = await s("Page.captureScreenshot", { format: "png" });
  await s("Runtime.evaluate", { expression: unhideExpr, returnByValue: true });
  const raw = join(out, `${st.name}.raw.png`);
  writeFileSync(raw, Buffer.from(data, "base64"));
  execFileSync("python3", ["-I", join(here, "redact.py"), raw, "-", join(out, `${st.name}.png`), String(width)]);
  execFileSync("rm", ["-f", raw]);
  writeFileSync(join(out, `${st.name}.meta.json`), JSON.stringify({ side, name: st.name, width, height, dpr: 2, hidden: result.value, at: new Date().toISOString() }));
  console.log(`${side}/${st.name}.png (${result.value} address text(s) hidden)`);
}
await s("Emulation.clearDeviceMetricsOverride");
ws.close();
