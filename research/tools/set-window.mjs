// Pin the recon Chrome window to a fixed size so goldens are comparable.
// usage: node set-window.mjs <targetId> <width> <height>
const [targetId, width, height] = process.argv.slice(2);
const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(webSocketDebuggerUrl);
let id = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    ws.addEventListener("message", function onMsg(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.id !== myId) return;
      ws.removeEventListener("message", onMsg);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));
const { windowId } = await call("Browser.getWindowForTarget", { targetId });
await call("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
await call("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 25, width: +width, height: +height } });
console.log("window", windowId, (await call("Browser.getWindowBounds", { windowId })).bounds);
ws.close();
