// Orientation snapshot of the recon tab (scratch only; goldens come from REA capture_web_screenshot).
// usage: node snap.mjs <targetId> <out.png> [scale]
import { writeFileSync } from "node:fs";
const [targetId, out, scale] = process.argv.slice(2);
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
const { data } = await call("Page.captureScreenshot", { format: "png", ...(scale ? { clip: { x: 0, y: 0, width: 1280, height: 728, scale: +scale } } : {}) }, sessionId);
writeFileSync(out, Buffer.from(data, "base64"));
ws.close();
