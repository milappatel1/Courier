// Medians and ranges over the runs in a scripts/perf.sh folder, checked against src/e2e/perf-budgets.json, written to
// <folder>/summary.json and printed. Exits non-zero when a step failed or a number this script checks (memory and CPU,
// which perf.sh measures from outside) is over its budget; perf.ts already failed the steps over theirs.
//
//   node scripts/perf-summary.mjs <perf run folder>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const { budgets } = JSON.parse(readFileSync(new URL("../src/e2e/perf-budgets.json", import.meta.url), "utf8"));
const values = {};
const failures = [];
const add = (name, v, where) => (values[name] ??= []).push({ v: Math.round(v * 10) / 10, where });

function steps(dir) {
  const file = join(dir, "report.json");
  if (!existsSync(file)) return failures.push(`${dir}: no report`);
  for (const s of JSON.parse(readFileSync(file, "utf8")).steps) {
    if (!s.ok) failures.push(`${dir}: ${s.name}: ${s.error}`);
    for (const [k, v] of Object.entries(s.metrics ?? {})) add(k, v, dir);
  }
}

const runs = readdirSync(root)
  .filter((d) => /^run-\d+$/.test(d))
  .map((d) => join(root, d));
for (const run of runs) {
  steps(run);
  for (const l of readdirSync(run).filter((d) => /^launch-\d+$/.test(d))) steps(join(run, l));
  const outside = join(run, "outside.jsonl");
  if (!existsSync(outside)) continue;
  for (const line of readFileSync(outside, "utf8").split("\n").filter(Boolean)) {
    const m = JSON.parse(line);
    const procs = Object.entries(m).filter(([, p]) => typeof p === "object");
    if (m.kind === "memory") {
      for (const [k, unit] of [
        ["rssKb", "RssMb"],
        ["footprintKb", "FootprintMb"],
      ]) {
        for (const [proc, p] of procs) add(`memory.${m.label}.${proc}${unit}`, p[k] / 1024, run);
        add(`memory.${m.label}.total${unit}`, procs.reduce((s, [, p]) => s + p[k], 0) / 1024, run);
      }
    } else if (m.kind === "cpu") {
      for (const [proc, p] of procs) add(`cpu.${proc}Pct`, p.pct, run);
      add("cpu.totalPct", procs.reduce((s, [, p]) => s + p.pct, 0), run);
      add("cpu.sampledSeconds", m.seconds, run);
    }
  }
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const summary = {};
for (const [name, list] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
  const v = list.map((x) => x.v);
  const budget = budgets[name]?.max;
  summary[name] = { n: v.length, median: Math.round(median(v) * 10) / 10, min: Math.min(...v), max: Math.max(...v), values: v, budget };
  // perf.ts checks what it measured; memory and CPU come from perf.sh and are checked here.
  if (budget != null && /^(memory|cpu)\./.test(name))
    for (const x of list.filter((x) => x.v > budget)) failures.push(`${x.where}: ${name} ${x.v} is over its budget of ${budget}`);
}
writeFileSync(join(root, "summary.json"), JSON.stringify({ runs: runs.length, metrics: summary, failures }, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad("metric", 44)}${pad("n", 4)}${pad("median", 10)}${pad("range", 20)}budget`);
for (const [name, s] of Object.entries(summary))
  console.log(`${pad(name, 44)}${pad(s.n, 4)}${pad(s.median, 10)}${pad(`${s.min} to ${s.max}`, 20)}${s.budget ?? ""}`);
console.log(failures.length ? `\n${failures.length} failure(s):\n  ${failures.join("\n  ")}` : `\nall ${runs.length} run(s) within budget`);
process.exit(failures.length ? 1 : 0);
