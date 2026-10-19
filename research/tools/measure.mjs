// Measure elements in the recon tab: box + computed styles for each named selector (first visible
// match, or the nth with "selector@@n"). Facts only — no text content is recorded.
// usage: node measure.mjs <targetId> <targets.json | '{"name": "selector"}'> [out.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [targetId, spec, outPath] = process.argv.slice(2);
const TARGETS = JSON.parse(existsSync(spec) ? readFileSync(spec, "utf8") : spec);
const PROPS = ["backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
  "borderRadius", "borderTop", "borderBottom", "borderLeft", "borderRight", "boxShadow", "padding", "margin", "height", "width",
  "opacity", "textTransform", "fill", "gap", "outline"];
const expression = `(() => {
  const T = ${JSON.stringify(TARGETS)}, P = ${JSON.stringify(PROPS)}, out = {};
  for (const [name, sel0] of Object.entries(T)) {
    const [sel, nth] = sel0.split("@@");
    const els = [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const el = els[+(nth ?? 0)];
    if (!el) { out[name] = null; continue; }
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el), st = {};
    for (const p of P) st[p] = cs[p];
    out[name] = { box: [r.x, r.y, r.width, r.height].map(v => Math.round(v * 10) / 10), count: els.length, style: st };
  }
  return out;
})()`;
const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
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
const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
if (exceptionDetails) { console.error(exceptionDetails.exception?.description); process.exit(1); }
const compact = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && { ...v, style: Object.fromEntries(Object.entries(v.style).filter(([, x]) => x && x !== "none" && x !== "normal" && x !== "0px" && x !== "rgba(0, 0, 0, 0)" && !/^0px none/.test(x))) }]));
const res = compact(result.value);
if (outPath) writeFileSync(outPath, JSON.stringify(res, null, 1));
for (const [k, v] of Object.entries(res)) console.log(k.padEnd(22), v ? `${JSON.stringify(v.box)} ×${v.count} ${JSON.stringify(v.style)}` : "—");
ws.close();
