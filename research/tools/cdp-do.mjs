// Run a short interaction script against the recon tab over CDP, for steps REA's scenario
// actions can't express (hover, click at an offset, typing without a page reload).
// REA still does the captures.
//
// usage: node cdp-do.mjs <targetId> '<json ops>'
//   ops: [{"click": [selector, dx?, dy?]}, {"hover": [selector, dx, dy]}, {"text": "..."},
//         {"clickText": "Menu item label"}, {"hoverText": "Menu item label"},
//         {"key": "Tab" | "Enter" | "Escape" | "ArrowDown" ..., "mods": ["Meta","Shift","Alt"]},
//         {"wait": ms}, {"wheel": deltaY}, {"status": selector}, {"dump": selector},
//         {"eval": "read-only expression"}, {"go": url}, {"files": [selector, [paths]]},
//         {"rightClick": [selector, dx?, dy?]}, {"clickContains": [selector, text]}, {"hoverContains": [selector, text]}]
//         ← status/dump/eval print what they read
const [targetId, opsJson] = process.argv.slice(2);
const ops = JSON.parse(opsJson);
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
const s = (m, p) => call(m, p, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function box(selector0) {
  const [selector, nth] = selector0.split("@@");
  const { result } = await s("Runtime.evaluate", {
    expression: `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getBoundingClientRect().width > 0); const r = els[${Number(nth ?? 0)}]?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; })()`,
    returnByValue: true,
  });
  if (!result.value) throw new Error(`no visible element for ${selector}`);
  return result.value;
}
async function boxByText(text) {
  const { result } = await s("Runtime.evaluate", {
    expression: `(() => { const el = [...document.querySelectorAll("[role=menuitem],[role=menuitemcheckbox],[role=option],[role=button],[role=tab],button,label,[role=link],a")].find(e => e.getBoundingClientRect().width > 0 && e.innerText.trim().split("\\n")[0] === ${JSON.stringify(text)}); const r = el?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; })()`,
    returnByValue: true,
  });
  if (!result.value) throw new Error(`no visible control labelled ${text}`);
  return result.value;
}
async function boxContaining(selector, text) {
  const { result } = await s("Runtime.evaluate", {
    expression: `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getBoundingClientRect().width > 0 && e.innerText.includes(${JSON.stringify(text)})); const r = el?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; })()`,
    returnByValue: true,
  });
  if (!result.value) throw new Error(`no visible ${selector} containing ${text}`);
  return result.value;
}
async function mouse(selector, dx, dy, press, byText = false, button = "left", within = null) {
  const [l, t, w, h] = within ? await boxContaining(selector, within) : byText ? await boxByText(selector) : await box(selector);
  const x = l + (dx ?? w / 2);
  const y = t + (dy ?? h / 2);
  await s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(120);
  if (press) {
    await s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    await s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
  }
}
const KEYS = { Tab: 9, Enter: 13, Escape: 27, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
async function key(name, mods = []) {
  const modifiers = mods.reduce((m, k) => m | MOD[k], 0);
  const vk = KEYS[name] ?? name.toUpperCase().charCodeAt(0);
  const code = KEYS[name] ? name : `Key${name.toUpperCase()}`;
  for (const type of ["rawKeyDown", "keyUp"]) {
    await s("Input.dispatchKeyEvent", { type, key: name, code, windowsVirtualKeyCode: vk, modifiers });
  }
}

for (const op of ops) {
  if (op.click) await mouse(op.click[0], op.click[1], op.click[2], true);
  else if (op.rightClick) await mouse(op.rightClick[0], op.rightClick[1], op.rightClick[2], true, false, "right");
  else if (op.clickContains) await mouse(op.clickContains[0], undefined, undefined, true, false, "left", op.clickContains[1]);
  else if (op.hoverContains) await mouse(op.hoverContains[0], undefined, undefined, false, false, "left", op.hoverContains[1]);
  else if (op.clickText) await mouse(op.clickText, undefined, undefined, true, true);
  else if (op.hoverText) await mouse(op.hoverText, undefined, undefined, false, true);
  else if (op.hover) await mouse(op.hover[0], op.hover[1], op.hover[2], false);
  else if (op.text) await s("Input.insertText", { text: op.text });
  else if (op.key) await key(op.key, op.mods);
  else if (op.wait) await sleep(op.wait);
  else if (op.go) {
    await s("Page.navigate", { url: op.go });
    await sleep(op.settle ?? 2500);
  } else if (op.files) {
    // {"files": [selector, [absolute paths]]} — set files on a file input (attachments).
    const { root } = await s("DOM.getDocument", { depth: 0 });
    const { nodeId } = await s("DOM.querySelector", { nodeId: root.nodeId, selector: op.files[0] });
    await s("DOM.setFileInputFiles", { nodeId, files: op.files[1] });
  }
  else if (op.wheel) await s("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: op.wheel });
  else if (op.dump) {
    const { result } = await s("Runtime.evaluate", {
      expression: `[...document.querySelectorAll(${JSON.stringify(op.dump)})].filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText).join(" // ").slice(0, 4000)`,
      returnByValue: true,
    });
    console.log(`--- ${op.dump}\n${result.value}`);
  } else if (op.eval) {
    // Read-only inspection expression; prints the JSON result.
    const { result } = await s("Runtime.evaluate", { expression: op.eval, returnByValue: true });
    console.log(JSON.stringify(result.value));
  } else if (op.status) {
    const { result } = await s("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(op.status)})?.textContent ?? null`,
      returnByValue: true,
    });
    console.log(op.status, "→", result.value);
  }
  await sleep(60);
}
await call("Target.detachFromTarget", { sessionId });
ws.close();
console.log("ok", ops.length, "ops");
