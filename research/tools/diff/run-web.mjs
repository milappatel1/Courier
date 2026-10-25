// Runs differential scripts in the web client (called from research/tools/cdp-do.mjs with its CDP session) and writes the
// observations: { side: "web", viewport, scripts: [ { script, steps: [...] } ] }.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript, seededSubjects } from "./steps.mjs";
import { createWebEnv } from "./web-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function runDiff({ s, sleep, observeOnly, scripts, out }) {
  const mailbox = JSON.parse(readFileSync(join(here, "mailbox.json"), "utf8"));
  const known = seededSubjects(mailbox);
  const { result: where } = await s("Runtime.evaluate", { expression: "location.href", returnByValue: true });
  if (!String(where.value).startsWith("https://mail.google.com/")) throw new Error(`the tab is ${where.value}, not the web client`);
  const env = await createWebEnv({ s, known, mailbox });
  if (observeOnly) {
    console.log(JSON.stringify(await env.observe({ cursor: false }), null, 1));
    return;
  }
  const { result: vp } = await s("Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true });
  const report = { side: "web", viewport: vp.value, at: new Date().toISOString(), scripts: [] };
  for (const file of scripts) {
    const script = JSON.parse(readFileSync(file, "utf8"));
    console.log(`web: ${script.name}`);
    const r = await runScript(script, env, known);
    report.scripts.push(r);
    const bad = r.steps.filter((x) => x.error);
    console.log(
      r.skipped
        ? `  skipped: ${r.skipped}`
        : `  ${r.steps.length} observations${bad.length ? `, ${bad.length} failed: ${bad.map((x) => `${x.step}: ${x.error}`).join(" | ")}` : ""}`,
    );
    if (out) writeFileSync(out, JSON.stringify(report, null, 1));
    await sleep(300);
  }
  if (out) console.log(`wrote ${out}`);
}
