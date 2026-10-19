// Computed text styles for elements whose own text equals each given label (first visible match,
// optionally inside a container selector). Facts only.
// usage: node measure-text.mjs <targetId> '<container selector or "">' 'Label 1' 'Label 2' ...
const [targetId, container, ...labels] = process.argv.slice(2);
const expression = `(() => {
  const root = ${JSON.stringify(container)} ? document.querySelector(${JSON.stringify(container)}) : document.body;
  const out = {};
  for (const label of ${JSON.stringify(labels)}) {
    const el = [...root.querySelectorAll("*")].find((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("").trim();
      return own === label;
    });
    if (!el) { out[label] = null; continue; }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    out[label] = { box: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10), font: cs.fontFamily.split(",")[0], size: cs.fontSize, weight: cs.fontWeight, lh: cs.lineHeight, color: cs.color, ls: cs.letterSpacing, bg: cs.backgroundColor };
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
if (exceptionDetails) console.error(exceptionDetails.exception?.description);
for (const [k, v] of Object.entries(result.value ?? {})) console.log(k.padEnd(20), v ? JSON.stringify(v) : "—");
ws.close();
