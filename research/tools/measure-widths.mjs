// Measure how the reference web client lays out at several widths, by emulating the width on the recon tab
// (no window moves, no focus change). Prints numbers and booleans only — never page text — so nothing personal
// leaves the tab. usage: node measure-widths.mjs <targetId> [w1,w2,…]
const [targetId, list = "1440,1280,1100,1024,960,900,820,760,700,640,600,520,420"] = process.argv.slice(2);
const widths = list.split(",").map(Number);
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
const probe = `(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return (b.width && b.height && cs.visibility !== "hidden" && cs.display !== "none") ? { x: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) } : null; };
  const nav = document.querySelector('[role="navigation"]');
  const search = document.querySelector('form[role="search"]');
  const main = document.querySelector('[role="main"]');
  const tabs = document.querySelector('[role="tablist"]');
  const tabEls = tabs ? [...tabs.querySelectorAll('[role="tab"]')] : [];
  const firstRow = document.querySelector('[role="main"] tr[role="row"]');
  const cells = firstRow ? [...firstRow.children].map((c) => Math.round(c.getBoundingClientRect().width)) : [];
  const compose = [...document.querySelectorAll('[role="button"]')].find((b) => /compose/i.test(b.getAttribute("aria-label") || "") || /^compose$/i.test((b.textContent || "").trim()));
  const navLabels = nav ? [...nav.querySelectorAll('a[href*="#"]')].filter((a) => r(a)).map((a) => Math.round(a.getBoundingClientRect().width)) : [];
  return {
    width: innerWidth,
    pageScroll: document.documentElement.scrollWidth - innerWidth,
    nav: r(nav), navLinkWidths: navLabels.slice(0, 3),
    compose: r(compose), composeHasText: !!compose && (compose.textContent || "").trim().length > 0 && (compose.getBoundingClientRect().width > 80),
    search: r(search),
    main: r(main),
    tabs: tabEls.map((t) => ({ w: Math.round(t.getBoundingClientRect().width), lines: [...t.querySelectorAll("div,span")].filter((e) => !e.children.length && (e.textContent || "").trim() && r(e)).length })),
    rowCells: cells,
  };
})()`;
const out = [];
for (const w of widths) {
  await call("Emulation.setDeviceMetricsOverride", { width: w, height: 820, deviceScaleFactor: 0, mobile: false }, sessionId);
  await new Promise((r) => setTimeout(r, 1200));
  const { result } = await call("Runtime.evaluate", { expression: probe, returnByValue: true }, sessionId);
  out.push(result.value);
}
await call("Emulation.clearDeviceMetricsOverride", {}, sessionId);
console.log(JSON.stringify(out, null, 1));
ws.close();
