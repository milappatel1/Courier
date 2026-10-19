// Click each colour theme thumbnail in the open theme picker (the page previews it live) and record
// the resulting surface colours. usage: node theme-probe.mjs <targetId> > themes.json
import { execFileSync } from "node:child_process";
const [targetId] = process.argv.slice(2);
const names = ["Default", "Dark", "Blue", "Soft Gray", "Lavender", "Rose", "Mustard", "Wasabi", "Spearmint", "Cherry Blossom", "Seafoam", "Dusk", "Mahogany", "Eggplant", "High Contrast"];
const probe = `(() => {
  const cs = (s, p = "backgroundColor") => { const e = document.querySelector(s); return e ? getComputedStyle(e)[p] : null; };
  return {
    body: cs("body"), bodyImage: cs("body", "backgroundImage").slice(0, 80),
    appBg: cs(".bkK > .nH, .aeF"), header: cs("header[role=banner]"), search: cs("form[role=search]"),
    searchText: cs("input[aria-label='Search mail']", "color"),
    compose: cs(".T-I.T-I-KE.L3"), composeText: cs(".T-I.T-I-KE.L3", "color"),
    navActive: cs(".aim.ain .TO"), navActiveText: cs(".aim.ain .nU a", "color"), navText: cs(".aim:not(.ain) .nU a", "color"),
    navIcon: cs(".aim:not(.ain) .qj", "color"), rowRead: cs("tr.zA.yO"), rowUnread: cs("tr.zA.zE"), rowText: cs("tr.zA .bog", "color"),
    snippet: cs("tr.zA .y2", "color"), tabActiveText: cs("[role=tab][aria-selected=true] .aKz", "color"), tabText: cs("[role=tab][aria-selected=false] .aKz", "color"),
    toolbarIcon: cs("[aria-label=Refresh]", "color"), pageText: cs(".Dj", "color"),
  };
})()`;
const out = {};
for (const name of names) {
  try {
    execFileSync("node", ["cdp-eval.mjs", targetId, `[...document.querySelectorAll('[role=dialog] [aria-label="${name}"]')].find(e => e.getBoundingClientRect().width > 20)?.scrollIntoView({ block: "center" })`], { encoding: "utf8" });
    execFileSync("node", ["cdp-do.mjs", targetId, JSON.stringify([{ wait: 300 }, { click: [`[role=dialog] [aria-label="${name}"]`] }, { wait: 1800 }])], { encoding: "utf8" });
    out[name] = JSON.parse(execFileSync("node", ["cdp-eval.mjs", targetId, probe], { encoding: "utf8" }));
  } catch (e) {
    out[name] = { error: String(e.message).slice(0, 200) };
  }
}
console.log(JSON.stringify(out, null, 1));
