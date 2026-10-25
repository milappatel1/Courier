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
let scriptName = "";
let cur = [];
const startDiffs = new Map();
const startNotes = new Set();
let atStart = false;
let prev = new Set();
let persisted = 0;
const notes = args.includes("--notes");
// A difference is printed at the step where it first shows and again only if its values change, so one difference in the starting
// state (the web account's categories, say) doesn't repeat under every step.
const bad = (where, field, w, c) => cur.push({ where, field, w, c });
const note = (text) => notes && out.push(`  ${text}`);
const flush = () => {
  const keys = new Set();
  for (const m of cur) {
    const key = JSON.stringify([m.field, m.w, m.c]);
    keys.add(key);
    if (atStart) {
      const s = startDiffs.get(key) ?? { ...m, scripts: [] };
      s.scripts.push(scriptName);
      startDiffs.set(key, s);
      continue;
    }
    if (prev.has(key)) {
      persisted++;
      continue;
    }
    mismatches++;
    out.push(`  ${m.where} | ${m.field}: web ${JSON.stringify(m.w)} / courier ${JSON.stringify(m.c)}`);
  }
  prev = keys;
  cur = [];
};
// How old each seeded conversation's newest message is (hours), so two rows of the same age count as in either order: the
// seed stamps each message with the time it ran, to the second, and the two clients break such ties differently.
const mailbox = JSON.parse(readFileSync(new URL("./mailbox.json", import.meta.url), "utf8"));
const age = new Map();
mailbox.categories.forEach(([, name], ci) => {
  for (const [key, what, msgs] of mailbox.cases) age.set(`${name} ${key}: ${what}`, Math.min(...msgs.map(([h]) => h + ci)));
});
for (const [, subject, , msgs] of mailbox.extras) age.set(subject, Math.min(...msgs.map(([h]) => h)));
const ordered = (rows) => rows.every((r, i) => i === 0 || !age.has(r) || !age.has(rows[i - 1]) || age.get(rows[i - 1]) <= age.get(r));
const firstOutOfOrder = (rows) => rows.findIndex((r, i) => i > 0 && age.has(r) && age.has(rows[i - 1]) && age.get(rows[i - 1]) > age.get(r));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const seeded = (rows) => rows.filter((r) => r !== "(other)");

let offsets = { nav: {}, tabs: {} };
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
    for (const [side, rows] of [
      ["web", both],
      ["courier", bothC],
    ]) {
      if (!ordered(rows)) {
        const i = firstOutOfOrder(rows);
        bad(
          where,
          `row order on the ${side} side: not newest first (shared rows)`,
          side === "web" ? rows.slice(i - 1, i + 2) : null,
          side === "courier" ? rows.slice(i - 1, i + 2) : null,
        );
      }
    }
    if (ordered(both) && ordered(bothC) && !same(both, bothC)) {
      // Both newest first. Only rows of different ages can disagree.
      const cmpAge = (a, b) => (age.get(a) ?? 0) - (age.get(b) ?? 0);
      const groups = (rows) => rows.map((r) => age.get(r) ?? r).join();
      if (groups(both) !== groups(bothC) && both.slice().sort(cmpAge).join() === both.join()) {
        const i = both.findIndex((r, k) => age.get(r) !== age.get(bothC[k]));
        if (i >= 0)
          bad(where, `row order (first difference at shared row ${i + 1})`, both.slice(Math.max(0, i - 1), i + 3), bothC.slice(Math.max(0, i - 1), i + 3));
      }
    }
  }
  for (const s of wr.filter((r) => cr.includes(r))) {
    const a = w.rowState[s];
    const b = c.rowState[s];
    for (const k of ["unread", "starred", "selected", "chips"]) if (!same(a?.[k], b?.[k])) bad(where, `row "${s}" ${k}`, a?.[k], b?.[k]);
  }
  // The web account holds mail that isn't the seed (Google's own notices), so a count is compared as its change since the start
  // of the script; where the two differ at the start, that difference is noted once.
  for (const [group, label] of [
    ["nav", "nav count"],
    ["tabs", "tab badge (new)"],
  ]) {
    for (const k of new Set([...Object.keys(w.counts[group]), ...Object.keys(c.counts[group])])) {
      const a = w.counts[group][k] ?? 0;
      const b = c.counts[group][k] ?? 0;
      if (offsets[group][k] === undefined) {
        offsets[group][k] = a - b;
        if (a !== b) startNotes.add(`${label} ${k}: web ${a} / courier ${b}`);
      } else if (a - b !== offsets[group][k]) bad(where, `${label} ${k} (change since start)`, a, b + offsets[group][k]);
    }
  }
  if (w.selection !== c.selection) bad(where, "selected rows", w.selection, c.selection);
  if (!same(w.banner, c.banner)) bad(where, "select-all banner", w.banner, c.banner);
  if (!same(w.toolbar, c.toolbar)) bad(where, "toolbar", w.toolbar, c.toolbar);
  if (!/^cleanup$/.test(where.replace(/^step \d+ /, "")) && !same(w.toast, c.toast)) bad(where, "toast", w.toast, c.toast);
  if (w.focus.cursor !== undefined && c.focus.cursor !== undefined && w.focus.cursor !== c.focus.cursor)
    bad(where, "cursor row", w.focus.cursor, c.focus.cursor);
  if (w.focus.active !== c.focus.active)
    note(`${where} | note: focused element web ${JSON.stringify(w.focus.active)} / courier ${JSON.stringify(c.focus.active)}`);
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
  offsets = { nav: {}, tabs: {} };
  out.push(`${name}`);
  scriptName = name;
  const before = mismatches;
  prev = new Set();
  persisted = 0;
  const n = Math.max(w.steps.length, c.steps.length);
  for (let i = 0; i < n; i++) {
    const ws = w.steps[i];
    const cs = c.steps[i];
    const where = `step ${i} ${ws?.step ?? cs?.step}`;
    if (!ws || !cs) {
      bad(where, "step ran", ws ? "yes" : "no", cs ? "yes" : "no");
      flush();
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
    atStart = i === 0;
    flush();
    atStart = false;
  }
  if (mismatches === before) out.push("  same");
  if (persisted) out.push(`  (${persisted} earlier difference${persisted === 1 ? "" : "s"} carried on unchanged through later steps, not repeated)`);
}
if (startNotes.size) {
  console.log(
    `counts at the start differ by the other mail on the web account, so later steps compare the change from there:\n  ${[...startNotes].join("\n  ")}\n`,
  );
}
if (startDiffs.size) {
  out.unshift("starting state (the first observation of each script: the web account as it is now against the seed)");
  let k = 1;
  for (const m of startDiffs.values()) {
    mismatches++;
    out.splice(
      k++,
      0,
      `  ${m.field}: web ${JSON.stringify(m.w)} / courier ${JSON.stringify(m.c)}  [${m.scripts.length} script${m.scripts.length === 1 ? "" : "s"}]`,
    );
  }
  out.splice(k, 0, "");
}
console.log(out.join("\n"));
if (skipped.length) console.log(`\nnot compared:\n  ${skipped.join("\n  ")}`);
console.log(`\n${compared} scripts compared, ${mismatches} mismatch${mismatches === 1 ? "" : "es"}`);
process.exit(mismatches ? 1 : 0);
