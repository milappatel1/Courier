// The script interpreter both sides share (research/tools/cdp-do.mjs runs it against the web client, app/src/e2e/diff.ts
// against Courier), so a step means the same thing on both: it turns each step into the same calls on an `env`, and each
// side implements those calls on its own page. After the start and after every step it takes an observation:
//
//   { rows: [subject | "(other)"], rowState: {subject: {unread, starred, selected, chips}}, counts: {nav: {name: n}, tabs: {name: n}},
//     selection: n, banner: null | {kind: "page" | "all", n, offer}, toolbar: [button labels], toast: {text, hasUndo, shownMs?} | null,
//     focus: {cursor?: subject | null, active}, labels?: {subject: {chips, where...}} }
//
// Script format (research/tools/diff/scripts/<name>.json):
//   { "name", "about", "keyboard"?: true (needs Gmail's keyboard shortcuts; skipped on a side that has them off),
//     "steps": [step...], "cleanup"?: [step...] (always run, errors ignored) }
// A step is { "do": verb, ... }. Targets name seeded mail by subject, or a unique prefix of it: {"subject": "Primary a:"},
// {"subjects": [..]}, {"all": true} (the select-all box), {"allMatching": true} ("Select all N conversations").
//   open {label, tab?}       search {q}              undo                    wait {ms}
//   archive | inbox | delete | spam | not-spam | mark-read | mark-unread | star | unstar | important | not-important | mute
//       {target, via: "toolbar" (default) | "hover" | "conversation" | "row" (the star) | "key"}
//   move {target, to}        label {target, name, on: true | false}           snooze {target, until, via?}
//   select {target}          select-all   select-all-matching   clear-selection
//   open-conversation {target}   back     labels {subjects}      compose {to, subject, body}   discard-draft
// Any step may carry "measureToast": true (waits for the toast to go and records how long it was up) and "expectToast".

export const KEYS = {
  archive: "e",
  delete: "#",
  spam: "!",
  "mark-read": "Shift+I",
  "mark-unread": "Shift+U",
  star: "s",
  mute: "m",
  important: "+",
  "not-important": "-",
  snooze: "b",
  move: "v",
  label: "l",
};

/** The button each verb uses (hover buttons and the toolbar share these names), or the More-menu item that stands in. */
const BUTTON = {
  archive: "Archive",
  inbox: "Move to Inbox",
  delete: "Delete",
  spam: "Report spam",
  "not-spam": "Not spam",
  "mark-read": "Mark as read",
  "mark-unread": "Mark as unread",
  snooze: "Snooze",
  move: "Move to",
  label: "Labels",
};
const MORE_ITEM = { star: "Add star", unstar: "Remove star", important: "Mark as important", "not-important": "Mark as not important", mute: "Mute" };

export function resolveSubject(known, s) {
  if (known.includes(s)) return s;
  const hit = known.filter((k) => k.startsWith(s));
  if (hit.length !== 1) throw new Error(`"${s}" names ${hit.length} seeded subjects`);
  return hit[0];
}

export function describe(st) {
  const t = st.target ? (st.target.subject ?? st.target.subjects?.join(" + ") ?? (st.target.all ? "all" : st.target.allMatching ? "all matching" : "")) : "";
  const rest = ["label", "tab", "q", "to", "name", "on", "until", "via"].filter((k) => st[k] !== undefined).map((k) => `${k}=${st[k]}`);
  return [st.do, t && `[${t}]`, ...rest].filter(Boolean).join(" ");
}

const subjectsOf = (known, target = {}) => (target.subjects ?? (target.subject ? [target.subject] : [])).map((s) => resolveSubject(known, s));

/** Selects the target's rows the way the step says (checkboxes, or the select-all box). */
async function select(env, known, target, ctx = {}) {
  if (target.all || target.allMatching) {
    await env.selectAll();
    if (target.allMatching) ctx.how = await env.selectAllMatching();
    return;
  }
  for (const s of subjectsOf(known, target)) await env.select(s);
}

async function exec(st, env, known, ctx) {
  const verb = st.do;
  const via = st.via ?? "toolbar";
  const subs = subjectsOf(known, st.target);
  switch (verb) {
    case "open":
      await env.open(st.label, st.tab);
      ctx.where = { label: st.label, tab: st.tab };
      return;
    case "search":
      await env.search(st.q);
      ctx.where = { q: st.q };
      return;
    case "undo":
      return env.undo();
    case "wait":
      return env.sleep(st.ms);
    case "select":
      return select(env, known, st.target, ctx);
    case "select-all":
      return env.selectAll();
    case "select-all-matching":
      await env.selectAll();
      ctx.how = await env.selectAllMatching();
      return;
    case "clear-selection":
      return env.clearSelection();
    case "open-conversation":
      return env.openConversation(subs[0]);
    case "back":
      return env.back();
    case "compose":
      return env.compose(st);
    case "discard-draft":
      return env.discardDraft();
    case "labels":
      ctx.labels = {};
      for (const s of st.subjects) ctx.labels[resolveSubject(known, s)] = await env.labelsOf(resolveSubject(known, s), ctx.where);
      return;
    default:
  }
  const button = BUTTON[verb];
  const more = MORE_ITEM[verb];
  if (!button && !more) throw new Error(`unknown step "${verb}"`);
  if (via === "key") {
    if (subs[0]) await env.cursorTo(subs[0]);
    if (!KEYS[verb]) throw new Error(`no key for ${verb}`);
    await env.keys(KEYS[verb]);
  } else if (via === "hover") {
    await env.hover(subs[0], button);
  } else if (via === "row") {
    await env.rowStar(subs[0], verb === "star");
    return;
  } else {
    if (via === "conversation") await env.openConversation(subs[0]);
    else await select(env, known, st.target, ctx);
    ctx.how = more ? await env.more(more) : await env.toolbar(button, { moreItem: verb === "label" ? "Label as" : verb === "snooze" ? "Snooze" : undefined });
  }
  if (verb === "move") await env.menuItem(st.to);
  if (verb === "snooze" && st.until) await env.menuItem(st.until);
  if (verb === "label") await env.labelChoice(st.name, st.on !== false);
}

/** Runs one script on a side; returns { script, side, steps: [{ i, step, how?, error?, obs }] }. */
export async function runScript(script, env, known, opts = {}) {
  const out = { script: script.name, side: env.side, steps: [] };
  if (script.keyboard && !env.keyboard) return { ...out, skipped: `keyboard shortcuts are off on the ${env.side} side` };
  const o = { cursor: !!script.keyboard };
  const ctx = { where: { label: "INBOX", tab: "primary" } };
  const observe = async (extra) => {
    const obs = await env.observe(o);
    return { ...obs, toolbar: normToolbar(obs.toolbar ?? []), ...extra };
  };
  await env.reset();
  out.steps.push({ i: 0, step: "start", obs: await observe() });
  let failed = false;
  for (const [n, st] of script.steps.entries()) {
    const rec = { i: n + 1, step: describe(st) };
    const began = Date.now();
    ctx.how = undefined;
    ctx.labels = undefined;
    try {
      const t0 = Date.now();
      await exec(st, env, known, ctx);
      if (st.measureToast) rec.toastMs = await env.toastGone(t0);
      await env.settle();
    } catch (e) {
      rec.error = String(e?.message ?? e);
      failed = true;
    }
    rec.how = ctx.how;
    rec.ms = Date.now() - began;
    opts.onStep?.(`${rec.i} ${rec.step} ${rec.ms} ms${rec.error ? ` ERROR ${rec.error}` : ""}`);
    rec.obs = await observe(ctx.labels ? { labels: ctx.labels } : {}).catch((e) => ({ error: String(e?.message ?? e) }));
    out.steps.push(rec);
    if (failed) break;
  }
  for (const st of script.cleanup ?? []) {
    try {
      await exec(st, env, known, ctx);
      await env.settle();
    } catch {
      /* cleanup is best effort */
    }
  }
  if (script.cleanup?.length) out.steps.push({ i: out.steps.length, step: "cleanup", obs: await observe().catch((e) => ({ error: String(e?.message ?? e) })) });
  return out;
}

/**
 * The toolbar as the two sides can be compared: only the mail actions (the web client's toolbar also holds the input-tools
 * buttons and the like), "Back to Inbox" and "Back to list" as one, Courier's "Select options" arrow left to the select box.
 */
export function normToolbar(labels) {
  const known =
    /^(Select|Refresh|Archive|Report spam|Not spam|Delete|Delete forever|Mark as read|Mark as unread|Snooze|Move to|Move to Inbox|Labels|More email options|Newer|Older|Back to .*)( \(disabled\))?$/;
  return labels.filter((l) => known.test(l)).map((l) => l.replace(/^Back to .*?( \(disabled\))?$/, "Back$1"));
}

/** Every subject the seed makes, plus the sample mail the recon account was first seeded with. */
export function seededSubjects(mailbox) {
  const subjects = [];
  for (const [, name] of mailbox.categories) for (const [key, what] of mailbox.cases) subjects.push(`${name} ${key}: ${what}`);
  for (const [, subject] of mailbox.extras) subjects.push(subject);
  return [...subjects, ...mailbox.others];
}
