// The parity metric: rows of research/PARITY.md by status, and every row that doesn't match yet.
// usage: node research/tools/parity-count.mjs [--open]      (exit code 1 while any row is "differs", "missing" or "unverified")
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../PARITY.md", import.meta.url));
const rows = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => /^\|\s*[A-Z]+-\d+\s*\|/.test(l))
  .map((l) => l.split("|").map((c) => c.trim()))
  .map((c) => ({ id: c[1], area: c[2], item: c[3], status: c[4], evidence: c[5], test: c[6] }));
const norm = (s) => (s.startsWith("✗") ? "✗" : s.split(/[\s(]/)[0]);
const counts = {};
for (const r of rows) counts[norm(r.status)] = (counts[norm(r.status)] ?? 0) + 1;
const open = rows.filter((r) => ["differs", "missing", "unverified"].includes(norm(r.status)));
const noTest = rows.filter((r) => norm(r.status) === "matches" && (!r.test || r.test === "—"));
console.log(`${rows.length} rows: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
console.log(`open (differs, missing or unverified): ${open.length}; matches without a named test: ${noTest.length}`);
if (process.argv.includes("--open")) for (const r of open) console.log(`  ${r.id} [${r.status}] ${r.area}: ${r.item}`);
process.exit(open.length ? 1 : 0);
