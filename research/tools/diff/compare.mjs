// Compares the web client's observations with Courier's, step by step, and prints every mismatch; exit 1 on any.
// No browser needed.
//
//   node research/tools/diff/compare.mjs <web.json> <courier.json | courier report.json> [--script name,name] [--toast-ms 1500] [--json]
//
// Fields compared per step: error, how (toolbar button or More menu), rows (the seeded ones, in order), per-row unread / starred /
// selected / label chips, nav counts, tab badges, selection, the select-all banner, toolbar buttons, the toast (text, Undo, how long
// it stayed, within --toast-ms), the keyboard cursor, and the labels check. The focused element is printed as a note, not counted.
// A script that one side skipped (the web account has keyboard shortcuts off) is listed, not compared.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (files.length < 2) {
  console.error("usage: node compare.mjs <web.json> <courier.json|report.json> [--script a,b] [--toast-ms 1500]");
  process.exit(2);
}
const only = flag("--script")?.split(",");
const toastTol = Number(flag("--toast-ms", 1500));

function load(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j.scripts) return j;
  if (Array.isArray(j.steps)) return { side: "courier", scripts: j.steps.filter((s) => s.observations).map((s) => s.observations) };
  throw new Error(`${file}: neither observations nor a Courier report`);
}
const web = load(files[0]);
const courier = load(files[1]);

let mismatches = 0;
const out = [];
const bad = (where, field, w, c) => {
  mismatches++;
  out.push(`  ${where} | ${field}: web ${JSON.stringify(w)} / courier ${JSON.stringify(c)}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const seeded = (rows) => rows.filter((r) => r !== "(other)");

function compareObs(where, w, c) {
  if (w.error || c.error) return same(w.error, c.error) || bad(where, "observation error", w.error, c.error);
  const wr = seeded(w.rows);
  const cr = seeded(c.rows);
  if (!same(wr, cr)) {
    const onlyW = wr.filter((r) => !cr.includes(r));
    const onlyC = cr.filter((r) => !wr.includes(r));
    if (onlyW.length || onlyC.length) bad(where, "rows only on one side", { web: onlyW }, { courier: onlyC });
    const both = wr.filter((r) => cr.includes(r));
    const bothC = cr.filter((r) => wr.includes(r));
    if (!same(both, bothC)) {
      const i = both.findIndex((r, k) => r !== bothC[k]);
      bad(where, `row order (first difference at shared row ${i + 1})`, both.slice(Math.max(0, i - 1), i + 3), bothC.slice(Math.max(0, i - 1), i + 3));
    }
  }
  for (const s of wr.filter((r) => cr.includes(r))) {
    const a = w.rowState[s];
    const b = c.rowState[s];
    for (const k of ["unread", "starred", "selected", "chips"]) if (!same(a?.[k], b?.[k])) bad(where, `row "${s}" ${k}`, a?.[k], b?.[k]);
  }
  for (const k of new Set([...Object.keys(w.counts.nav), ...Object.keys(c.counts.nav)])) {
    if (w.counts.nav[k] !== c.counts.nav[k]) bad(where, `nav count ${k}`, w.counts.nav[k] ?? null, c.counts.nav[k] ?? null);
  }
  for (const k of new Set([...Object.keys(w.counts.tabs), ...Object.keys(c.counts.tabs)])) {
    if (w.counts.tabs[k] !== c.counts.tabs[k]) bad(where, `tab badge ${k} (new)`, w.counts.tabs[k] ?? null, c.counts.tabs[k] ?? null);
  }
  if (w.selection !== c.selection) bad(where, "selected rows", w.selection, c.selection);
  if (!same(w.banner, c.banner)) bad(where, "select-all banner", w.banner, c.banner);
  if (!same(w.toolbar, c.toolbar)) bad(where, "toolbar", w.toolbar, c.toolbar);
  if (!same(w.toast, c.toast)) bad(where, "toast", w.toast, c.toast);
  if (w.focus.cursor !== undefined && c.focus.cursor !== undefined && w.focus.cursor !== c.focus.cursor)
    bad(where, "cursor row", w.focus.cursor, c.focus.cursor);
  if (w.focus.active !== c.focus.active)
    out.push(`  ${where} | note: focused element web ${JSON.stringify(w.focus.active)} / courier ${JSON.stringify(c.focus.active)}`);
  if (w.labels || c.labels)
    for (const s of new Set([...Object.keys(w.labels ?? {}), ...Object.keys(c.labels ?? {})]))
      if (!same(w.labels?.[s], c.labels?.[s])) bad(where, `labels of "${s}"`, w.labels?.[s], c.labels?.[s]);
}

const names = [...new Set([...web.scripts.map((s) => s.script), ...courier.scripts.map((s) => s.script)])].filter((n) => !only || only.includes(n));
const skipped = [];
let compared = 0;
for (const name of names) {
  const w = web.scripts.find((s) => s.script === name);
  const c = courier.scripts.find((s) => s.script === name);
  if (!w || !c) {
    skipped.push(`${name}: only ${w ? "web" : "Courier"} ran it`);
    continue;
  }
  if (w.skipped || c.skipped) {
    skipped.push(`${name}: skipped (${w.skipped ?? c.skipped})`);
    continue;
  }
  compared++;
  out.push(`${name}`);
  const before = mismatches;
  const n = Math.max(w.steps.length, c.steps.length);
  for (let i = 0; i < n; i++) {
    const ws = w.steps[i];
    const cs = c.steps[i];
    const where = `step ${i} ${ws?.step ?? cs?.step}`;
    if (!ws || !cs) {
      bad(where, "step ran", ws ? "yes" : "no", cs ? "yes" : "no");
      continue;
    }
    if (ws.step !== cs.step) bad(where, "step", ws.step, cs.step);
    if (!same(ws.error, cs.error)) bad(where, "step error", ws.error ?? null, cs.error ?? null);
    if (!same(ws.how, cs.how)) bad(where, "how the button was reached", ws.how ?? null, cs.how ?? null);
    if (ws.toastMs != null || cs.toastMs != null) {
      if (ws.toastMs == null || cs.toastMs == null || Math.abs(ws.toastMs - cs.toastMs) > toastTol)
        bad(where, `toast stayed (ms, tolerance ${toastTol})`, ws.toastMs, cs.toastMs);
    }
    compareObs(where, ws.obs, cs.obs);
  }
  if (mismatches === before) out.push("  same");
}
console.log(out.join("\n"));
if (skipped.length) console.log(`\nnot compared:\n  ${skipped.join("\n  ")}`);
console.log(`\n${compared} scripts compared, ${mismatches} mismatch${mismatches === 1 ? "" : "es"}`);
process.exit(mismatches ? 1 : 0);
