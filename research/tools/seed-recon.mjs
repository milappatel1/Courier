// Seed the throwaway recon account with sample mail sent to itself (approved by the user on
// 2026-10-18 for the recon account only). Content is invented sample text; no real people.
// usage: node seed-recon.mjs <targetId> <attachmentsDir>
import { execFileSync } from "node:child_process";
const [targetId, dir] = process.argv.slice(2);
const title = JSON.parse(execFileSync("node", ["cdp-eval.mjs", targetId, "document.title"], { encoding: "utf8" }));
const self = title.match(/[\w.+-]+@[\w-]+\.[\w.]+/)[0];
const messages = [
  { subject: "Quarterly planning notes", body: ["Hi,", "Attached are the planning notes for next quarter. The main themes are onboarding, search speed and the new billing page.", "Let me know what you think before Thursday."], files: [`${dir}/quarterly-plan.pdf`] },
  { subject: "Photos from the offsite", body: ["Here's the photo from the team offsite by the lake.", "More to come once everyone uploads theirs."], files: [`${dir}/offsite-photo.png`] },
  { subject: "Lunch on Friday?", body: ["Are you free for lunch on Friday? The new noodle place on 3rd street opened last week."] },
  { subject: "Weekly status: design review", body: ["Status for this week:", "- Inbox redesign: review done, two follow-ups", "- Settings page: in progress", "- Accessibility audit: scheduled for Monday"] },
  { subject: "Invoice #1042 for October", body: ["Your invoice #1042 for October is ready. Amount due: $240.00, payable by November 15."] },
  { subject: "Reading list for next week", body: ["A few articles worth reading before the workshop: one on caching strategies, one on offline-first apps, and a short one on accessible colour palettes."] },
];
const run = (ops) => execFileSync("node", ["cdp-do.mjs", targetId, JSON.stringify(ops)], { encoding: "utf8" });
for (const m of messages) {
  const ops = [
    { eval: "document.querySelector('input[aria-label=\"To recipients\"]') ? 'open' : 'closed'" },
  ];
  const state = run(ops);
  const openOps = state.includes('"open"') ? [] : [{ clickText: "Compose" }, { wait: 1500 }];
  const bodyOps = m.body.flatMap((line, i) => (i ? [{ key: "Enter" }, { text: line }] : [{ text: line }]));
  run([
    ...openOps,
    { click: ['input[aria-label="To recipients"]'] }, { text: self }, { key: "Enter" }, { wait: 300 },
    { click: ["input[name=subjectbox]"] }, { text: m.subject },
    { click: ['div[aria-label="Message Body"]'] }, ...bodyOps,
    ...(m.files ? [{ files: ["input[name=Filedata]", m.files] }, { wait: 3500 }] : []),
    { key: "Enter", mods: ["Meta"] }, { wait: 3500 },
  ]);
  console.log("sent:", m.subject);
}
