// For each colour theme: click it in the open picker, then report the first painted background
// behind a nav-area point (walking up from elementFromPoint), including image layers.
import { execFileSync } from "node:child_process";
const [targetId] = process.argv.slice(2);
const names = ["Default", "Dark", "Blue", "Soft Gray", "Lavender", "Rose", "Mustard", "Wasabi", "Spearmint", "Cherry Blossom", "Seafoam", "Dusk", "Mahogany", "Eggplant", "High Contrast"];
const probe = `(() => {
  const layers = [];
  for (const el of document.querySelectorAll("body > div, body > div > div, .yL, .wl, [class*=theme]")) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.width >= 1200 && r.height >= 600 && (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none"))
      layers.push({ cls: String(el.className).slice(0, 30), bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 120), z: cs.zIndex, pos: cs.position });
  }
  return layers.slice(0, 6);
})()`;
const out = {};
for (const name of names) {
  execFileSync("node", ["cdp-eval.mjs", targetId, `[...document.querySelectorAll('[role=dialog] [aria-label="${name}"]')].find(e => e.getBoundingClientRect().width > 20)?.scrollIntoView({ block: "center" })`], { encoding: "utf8" });
  execFileSync("node", ["cdp-do.mjs", targetId, JSON.stringify([{ wait: 300 }, { click: [`[role=dialog] [aria-label="${name}"]`] }, { wait: 1500 }])], { encoding: "utf8" });
  out[name] = JSON.parse(execFileSync("node", ["cdp-eval.mjs", targetId, probe], { encoding: "utf8" }));
}
console.log(JSON.stringify(out, null, 1));
