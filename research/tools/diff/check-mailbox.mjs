// Fails when mailbox.json (what the Courier side seeds) no longer matches the recon seed plan in app/src-tauri/src/recon.rs.
// usage: node research/tools/diff/check-mailbox.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../../../app/src-tauri/src/recon.rs"), "utf8");
const mine = JSON.parse(readFileSync(join(here, "mailbox.json"), "utf8"));
const hours = (h) => h.split("*").reduce((p, x) => p * Number(x), 1);
const block = (name) => src.match(new RegExp(`const ${name}[^=]*= \\[(.*?)\\n\\];`, "s"))[1];

const categories = [...src.matchAll(/\("(CATEGORY_\w+)", "(\w+)", "([^"]+)"\),/g)].map((m) => [m[1], m[2], m[3]]);
const cases = [...block("CASES").matchAll(/\("(\w)", "([^"]+)", &\[(.*?)\]\),/g)].map((m) => [
  m[1],
  m[2],
  [...m[3].matchAll(/\(([\d \*]+), "(\w*)"\)/g)].map((x) => [hours(x[1]), x[2]]),
]);
const extras = [...block("EXTRAS").matchAll(/\(\s*"(\w+)",\s*"([^"]+)",\s*"([^"]+)",\s*&\[(.*?)\],?\s*\),/gs)].map((m) => [
  m[1],
  m[2],
  m[3],
  [...m[4].matchAll(/\(([\d \*]+), "(\w*)", "(\w+)"\)/g)].map((x) => [hours(x[1]), x[2], x[3]]),
]);

let bad = 0;
for (const [name, theirs] of Object.entries({ categories, cases, extras })) {
  if (JSON.stringify(theirs) !== JSON.stringify(mine[name])) {
    console.log(`mailbox.json "${name}" differs from recon.rs`);
    bad++;
  }
}
if (!categories.length || !cases.length || !extras.length) {
  console.log("could not read the plan out of recon.rs");
  bad++;
}
console.log(bad ? "DRIFT" : `ok: ${categories.length} categories, ${cases.length} cases, ${extras.length} extras match recon.rs`);
process.exit(bad ? 1 : 0);
