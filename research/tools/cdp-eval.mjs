// Evaluate one read-only expression in the recon tab over CDP and print the JSON result.
// Used only for measuring (computed styles, boxes); it never changes the page.
// usage: node cdp-eval.mjs <targetId> '<expression>'
const [targetId, expression] = process.argv.slice(2);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/version`)).json();
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
const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
if (exceptionDetails) console.error(exceptionDetails.exception?.description ?? exceptionDetails.text);
else console.log(JSON.stringify(result.value, null, 1));
ws.close();
