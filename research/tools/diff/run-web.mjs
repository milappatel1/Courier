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
  // A fresh load of the Inbox: the tab may be showing a dialog (the Themes picker covers the right of the tab bar) or a conversation.
  if (!observeOnly) {
    await s("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await s("Page.navigate", { url: "https://mail.google.com/mail/u/0/#inbox" });
    await sleep(6000);
  }
  const env = await createWebEnv({ s, known, mailbox });
  if (observeOnly) {
    console.log(JSON.stringify(await env.observe({ cursor: false }), null, 1));
    return;
  }
  const before = await snapshot(env);
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
  const after = await snapshot(env);
  const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  report.restored = changed.length === 0 ? true : changed;
  console.log(
    changed.length
      ? `NOT PUT BACK: ${changed.join(", ")} differ from before the run`
      : "everything the scripts touched is back as it was (checked in the Inbox tabs, Spam, Trash, Snoozed and Recon/Counts)",
  );
  if (out) {
    writeFileSync(out, JSON.stringify(report, null, 1));
    console.log(`wrote ${out}`);
  }
  if (changed.length) process.exitCode = 1;
}

/** The seeded rows (with unread/starred/label chips) and the nav counts in every view a script could leave something in. */
async function snapshot(env) {
  const views = [
    ["INBOX", "primary"],
    ["INBOX", "promotions"],
    ["INBOX", "social"],
    ["INBOX", "updates"],
    ["SPAM"],
    ["TRASH"],
    ["SNOOZED"],
    ["Recon/Counts"],
    ["INBOX", "primary"],
  ];
  const out = {};
  for (const [label, tab] of views.slice(0, -1)) {
    await env.open(label, tab);
    const o = await env.observe({ cursor: false });
    out[`${label}${tab ? `/${tab}` : ""}`] = { rows: o.rows.filter((r) => r !== "(other)"), rowState: Object.fromEntries(Object.entries(o.rowState).map(([s, r]) => [s, { ...r, selected: undefined }])), nav: o.counts.nav };
  }
  await env.reset();
  return out;
}
