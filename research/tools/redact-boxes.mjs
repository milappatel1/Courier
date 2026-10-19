// Collect the boxes to redact in the recon tab before a golden is saved: the account avatar and
// account menu, any visible text that contains an email address, and rows/headers from senders
// other than the account itself ("me"). Prints JSON [{x, y, w, h}] in CSS pixels.
// usage: node redact-boxes.mjs <targetId> > boxes.json
const [targetId] = process.argv.slice(2);
const expression = `(() => {
  const out = [];
  const add = (el) => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height }); };
  // Account avatar / account switcher.
  document.querySelectorAll('a[aria-label^="Google Account"], img.gb_Q, img.gbii, [aria-label*="Google Account"] img').forEach(add);
  // Leaf text nodes containing an email address.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const re = /[\\w.+-]+@[\\w-]+\\.[\\w.]+/;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!re.test(n.nodeValue)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.width > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
  }
  // Inputs whose value has an email address.
  document.querySelectorAll('input').forEach((i) => { if (re.test(i.value)) add(i); });
  // Rows from other senders: sender, subject and snippet.
  document.querySelectorAll('tr.zA').forEach((tr) => {
    const who = tr.querySelector('.yX, .yW')?.innerText?.trim() ?? '';
    if (!/^(me|Me)( \\(\\d+\\))?$/.test(who.split(/[,\\n]/)[0].trim()) || who.includes(',')) {
      const parts = who.split(',').map((s) => s.trim());
      if (parts.every((p) => /^me( \\d+)?$|^\\d+$/i.test(p))) return;
      tr.querySelectorAll('.yX, .yW, .y6, .y2, .bog, .xT, .afn').forEach(add);
    }
  });
  // Conversation headers from other senders (name + address) and photos.
  document.querySelectorAll('.gD, .go, .g2, img.ajn, .aCi img, .ajy img').forEach((el) => {
    const t = el.innerText ?? '';
    if (el.tagName === 'IMG' || !/^me$/i.test(t.trim())) add(el);
  });
  return out.map((b) => ({ x: Math.floor(b.x) - 2, y: Math.floor(b.y) - 2, w: Math.ceil(b.w) + 4, h: Math.ceil(b.h) + 4 }));
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
const { result } = await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
console.log(JSON.stringify(result.value ?? []));
ws.close();
