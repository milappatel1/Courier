// Differential runner, Courier's side (phase P12.2). research/tools/diff/steps.mjs interprets the user-action scripts in
// research/tools/diff/scripts the same way for both clients; this file gives it Courier's hands (the real UI, as run.ts
// drives it) and its eyes (the observation). The web client's side is research/tools/diff/web-env.mjs, run from
// research/tools/cdp-do.mjs; research/tools/diff/compare.mjs lines the two up. Method: research/VERIFY-P12.2.md.
//
// Like perf.ts, the "diff:" steps run only when COURIER_E2E_ONLY names them, after run.ts's account setup, in a signed-in
// account that holds the recon account's seed mailbox. Each step's observations go into its report entry.
import mailbox from "../../../research/tools/diff/mailbox.json";
import { runScript, seededSubjects, type Env, type Mailbox, type Observation, type Script } from "../../../research/tools/diff/steps.mjs";
import { api } from "../ipc/api";
import { getState, setSetting } from "../state/store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => {
  console.info(`[e2e] ${line}`);
  void api.e2eLog(line).catch(() => {});
};
const q = <E extends Element = HTMLElement>(id: string, root: ParentNode = document) => root.querySelector<E>(`[data-testid="${id}"]`);
const qa = <E extends Element = HTMLElement>(id: string, root: ParentNode = document) => [...root.querySelectorAll<E>(`[data-testid="${id}"]`)];
const shown = (e: Element | null | undefined): e is HTMLElement => !!e && (e as HTMLElement).getClientRects().length > 0;
const text = (e: Element | null | undefined) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function click(e: Element) {
  e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  (e as HTMLElement).click();
}

function type(input: Element, value: string) {
  const i = input as HTMLInputElement;
  i.focus();
  const proto = i instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(i, value);
  i.dispatchEvent(new Event("input", { bubbles: true }));
}

const rows = () => qa("thread-row").filter(shown);
const subjectOf = (r: Element) => text(r.querySelector(".subj"));
const row = (subject: string) => rows().find((r) => subjectOf(r) === subject);
const known = seededSubjects(mailbox as unknown as Mailbox);
const mask = (s: string) => (known.includes(s) ? s : "(other)");

/** The visible toolbar: the open conversation's, else the list's. */
const toolbar = () => {
  const bars = [...document.querySelectorAll<HTMLElement>('[role=toolbar][aria-label="Conversation actions"]')].filter(shown);
  return bars.find((b) => b.classList.contains("conv-toolbar")) ?? bars[0];
};
const toolbarButton = (label: string) =>
  [...(toolbar()?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [])].find((b) => b.getAttribute("aria-label") === label && shown(b));
const toast = () => {
  const t = qa("toast").filter(shown).at(-1);
  return t ? { text: text(t.querySelector(".msg-text")), hasUndo: !!q("toast-action", t), el: t } : null;
};
const menuItems = () => [...document.querySelectorAll<HTMLElement>(".menu .menu-item, .menu [role=menuitem]")].filter(shown);
const itemLabel = (b: Element) => text(b.querySelector(":scope > span:not(.ic):not(.menu-check)") ?? b);

function describeActive() {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return "body";
  return [a.tagName.toLowerCase(), a.getAttribute("role"), a.getAttribute("aria-label") || a.getAttribute("name") || ""].filter(Boolean).join(" ");
}

function observe(o: { cursor?: boolean }): Observation {
  const rs = rows();
  const sub = rs.map((r) => mask(subjectOf(r)));
  const rowState: Observation["rowState"] = {};
  rs.forEach((r, i) => {
    if (sub[i] === "(other)") return;
    rowState[sub[i]] = {
      unread: r.classList.contains("unread"),
      starred: q("row-star", r)?.getAttribute("aria-pressed") === "true",
      selected: q("row-checkbox", r)?.getAttribute("aria-checked") === "true",
      chips: qa("row-label", r)
        .map((c) => text(c))
        .sort(),
    };
  });
  const nav: Record<string, number> = {};
  for (const n of document.querySelectorAll<HTMLElement>(".nav-item")) {
    const c = n.querySelector(".nav-count");
    if (shown(n) && c) nav[text(n.querySelector(".nav-name"))] = Number(text(c).replace(/,/g, ""));
  }
  const tabs: Record<string, number> = {};
  for (const t of qa("tab-primary").concat(qa("tab-promotions"), qa("tab-social"), qa("tab-updates"), qa("tab-forums")).filter(shown)) {
    const name = text(t.querySelector(".tab-name")).toLowerCase();
    tabs[name] = Number(text(t.querySelector(".new-badge")).match(/\d+/)?.[0] ?? 0);
  }
  const b = text(q("select-all-banner"));
  const banner = b
    ? {
        kind: /on this page/.test(b) ? ("page" as const) : ("all" as const),
        n: Number(b.match(/All ([\d,]+) conversations/)?.[1].replace(/,/g, "") ?? NaN) || null,
        offer: Number(b.match(/Select all ([\d,]+) conversations/)?.[1].replace(/,/g, "") ?? NaN) || null,
      }
    : null;
  const bar = toolbar();
  const buttons = [...(bar?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [])]
    .filter(shown)
    .map((x) => x.getAttribute("aria-label")! + (x.disabled ? " (disabled)" : ""));
  const t = toast();
  const cursorRow = rs.find((r) => r.classList.contains("focused"));
  return {
    rows: sub.slice(0, 50),
    rowState,
    counts: { nav, tabs },
    selection: rs.filter((r) => q("row-checkbox", r)?.getAttribute("aria-checked") === "true").length,
    banner,
    toolbar: buttons,
    toast: t ? { text: t.text, hasUndo: t.hasUndo } : null,
    focus: { ...(o.cursor ? { cursor: cursorRow ? mask(subjectOf(cursorRow)) : null } : {}), active: describeActive() },
  };
}

function press(spec: string) {
  const shift = spec.startsWith("Shift+");
  const k = spec.replace("Shift+", "");
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: shift ? k.toUpperCase() : k, shiftKey: shift, bubbles: true, cancelable: true }));
}

async function openNavItem(label: string) {
  const id =
    label.includes("/") || !["INBOX", "STARRED", "SNOOZED", "SENT", "DRAFT", "SPAM", "TRASH", "ALL", "IMPORTANT"].includes(label)
      ? `nav-label-${label}`
      : `nav-${label}`;
  if (!q(id) && q("nav-more")) click(q("nav-more")!);
  click(await until(`nav ${label}`, () => q(id)));
}

function makeEnv(): Env {
  let route = { label: "INBOX" as string, tab: "primary" as string | undefined };
  const env: Env = {
    side: "courier",
    keyboard: true,
    sleep,

    async reset() {
      for (let i = 0; i < 3; i++) {
        if (q("settings-close")) click(q("settings-close")!);
        if (q("conv-back")) click(q("conv-back")!);
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(150);
      }
      for (const d of qa("compose-discard")) click(d);
      await env.open("INBOX", "primary");
      // Spam, Trash and the rest show their counts once More is open, as the web client's nav does.
      const more = q("nav-more");
      if (more && /More/.test(text(more))) click(more);
      await env.clearSelection();
      await env.settle();
    },

    async open(label: string, tab?: string) {
      await openNavItem(label);
      if (label === "INBOX" && tab) click(await until(`tab ${tab}`, () => q(`tab-${tab}`)));
      route = { label, tab };
      await until("the list", () => !getState().list.loading && !getState().route.thread);
      await env.settle();
    },

    async search(query: string) {
      const input = await until("the search box", () => q<HTMLInputElement>("search-input"));
      type(input, query);
      input.form!.requestSubmit();
      await until("the results", () => getState().route.list.query === query && !getState().list.loading);
      await sleep(300);
    },

    async select(subject: string) {
      const box = await until(`row ${subject}`, () => q("row-checkbox", row(subject)));
      if (box.getAttribute("aria-checked") !== "true") click(box);
      await sleep(150);
    },

    async selectAll() {
      click(await until("the select box", () => q("select-all")));
      await sleep(250);
    },

    async selectAllMatching() {
      const link = await until("Select all N conversations", () => q("select-all-matching"), 2500).catch(() => null);
      if (!link) return "not offered";
      click(link);
      await sleep(400);
      return "offered";
    },

    async clearSelection() {
      if (getState().selected.length) click(await until("the select box", () => q("select-all")));
      await sleep(200);
    },

    async openConversation(subject: string) {
      click(await until(`row ${subject}`, () => row(subject)?.querySelector(".subj")));
      await until("the conversation", () => q("conv-subject"));
      await sleep(500);
    },

    async back() {
      click(await until("Back to list", () => q("conv-back")));
      await sleep(400);
    },

    async toolbar(label: string, opts: { moreItem?: string } = {}) {
      const b = toolbarButton(label);
      if (b) {
        click(b);
        await sleep(200);
        return "toolbar";
      }
      if (!opts.moreItem) throw new Error(`no ${label} button in the toolbar`);
      await env.more(opts.moreItem);
      return `More > ${opts.moreItem}`;
    },

    async more(item: string) {
      click(await until("More email options", () => toolbarButton("More email options")));
      const it = await until(`More item ${item}`, () => menuItems().find((b) => itemLabel(b) === item), 3000);
      click(it);
      await sleep(250);
      return `More > ${item}`;
    },

    async menuItem(label: string) {
      click(await until(`menu item ${label}`, () => menuItems().find((b) => itemLabel(b) === label)));
      await sleep(200);
    },

    async labelChoice(name: string, on: boolean) {
      const it = await until(`label ${name}`, () => q(`label-as-${name}`));
      if ((it.getAttribute("aria-checked") === "true") !== on) click(it);
      click(await until("Apply", () => q("label-apply")));
      await sleep(250);
    },

    async hover(subject: string, label: string) {
      const r = await until(`row ${subject}`, () => row(subject));
      const b = [...r.querySelectorAll<HTMLButtonElement>(".hover-actions button[aria-label]")].find((x) => x.getAttribute("aria-label") === label);
      if (!b) throw new Error(`no ${label} on the row`);
      click(b);
      await sleep(200);
    },

    async rowStar(subject: string, on: boolean) {
      const star = await until(`star of ${subject}`, () => q("row-star", row(subject)));
      if ((star.getAttribute("aria-pressed") === "true") !== on) click(star);
      await sleep(200);
    },

    async cursorTo(subject: string) {
      for (let i = 0; i < 80; i++) {
        const rs = rows();
        const at = rs.findIndex((r) => r.classList.contains("focused"));
        const want = rs.findIndex((r) => subjectOf(r) === subject);
        if (want < 0) throw new Error(`no row ${subject}`);
        if (at === want) return;
        press(at < want ? "j" : "k");
        await sleep(60);
      }
      throw new Error(`the cursor never reached ${subject}`);
    },

    async keys(spec: string) {
      press(spec);
      await sleep(250);
    },

    async undo() {
      const t = await until("a toast with Undo", () => (toast()?.hasUndo ? toast() : null), 3000);
      click(q("toast-action", t.el)!);
      await sleep(250);
    },

    async toastGone(t0: number) {
      const end = Date.now() + 30000;
      let seen = false;
      while (Date.now() < end) {
        if (toast()) seen = true;
        else if (seen) return Date.now() - t0;
        await sleep(50);
      }
      return null;
    },

    async compose({ to, subject, body }: { to?: string; subject?: string; body?: string }) {
      const before = qa("compose-window").length;
      click(await until("Compose", () => q("compose")));
      const w = await until("the compose window", () => (qa("compose-window").length > before ? qa("compose-window")[0] : null));
      if (to) type(await until("To", () => q("compose-to", w)), `${to},`);
      if (subject) type(await until("Subject", () => q("compose-subject", w)), subject);
      if (body) {
        const ed = await until("Body", () => q("compose-body", w));
        ed.focus();
        ed.innerHTML = `<div>${body}</div>`;
        ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      await sleep(2500);
    },

    async discardDraft() {
      click(await until("Discard draft", () => q("compose-discard")));
      await until("the window closed", () => !qa("compose-window").length);
      await sleep(500);
    },

    async labelsOf(subject: string, from: { label?: string; tab?: string; q?: string } | undefined) {
      await env.search(`in:anywhere "${subject}"`);
      const r = row(subject);
      const out = r
        ? {
            found: true,
            unread: r.classList.contains("unread"),
            starred: q("row-star", r)?.getAttribute("aria-pressed") === "true",
            chips: qa("row-label", r)
              .map((c) => text(c))
              .sort(),
          }
        : { found: false };
      if (from?.q) await env.search(from.q);
      else await env.open(from?.label ?? route.label, from?.tab ?? route.tab);
      return out;
    },

    async signature() {
      return JSON.stringify([rows().map(subjectOf), observe({}).counts, !!toast()]);
    },

    async settle() {
      await sleep(600);
      let last = await env.signature();
      let same = 0;
      let i = 0;
      for (; i < 40 && same < 4; i++) {
        await sleep(150);
        const now = await env.signature();
        same = now === last ? same + 1 : 0;
        if (now !== last && i > 30) log(`diff: still changing: ${last.slice(0, 300)} -> ${now.slice(0, 300)}`);
        last = now;
      }
    },

    async observe(o: { cursor?: boolean }) {
      return observe(o);
    },
  };
  return env;
}

// ---- the steps ----

interface DiffResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  tookFocus?: boolean;
  observations?: unknown;
}

const scriptFiles = import.meta.glob<Script>("../../../research/tools/diff/scripts/*.json", { eager: true, import: "default" });
const SCRIPTS = Object.values(scriptFiles).sort((a, b) => a.name.localeCompare(b.name));

/** Expands the seed plan the way recon.rs does: one conversation per case and category, then the extras. */
function threads() {
  const mb = mailbox as unknown as Mailbox;
  const out: { messages: { subject: string; from: string; hoursAgo: number; category: string; flags: string }[] }[] = [];
  mb.categories.forEach(([category, name, from], ci) => {
    for (const [key, what, msgs] of mb.cases) {
      out.push({ messages: msgs.map(([h, flags]) => ({ subject: `${name} ${key}: ${what}`, from, hoursAgo: h + ci, category, flags })) });
    }
  });
  for (const [, subject, from, msgs] of mb.extras)
    out.push({ messages: msgs.map(([h, flags, category]) => ({ subject, from, hoursAgo: h, category, flags })) });
  return out;
}

async function signInRecon() {
  const made = await api.e2eControl<{ email: string; messages: number }>("recon-account", { threads: threads() });
  log(`diff: the recon mailbox has ${made.messages} messages`);
  await until("the recon account", () => getState().accounts.some((a) => a.email === made.email), 30_000);
  click(await until("the account button", () => q("account-button")));
  click(await until("the recon account in the menu", () => q(`account-${made.email}`)));
  await until("the recon inbox", () => getState().accounts.find((a) => a.id === getState().accountId)?.email === made.email && rows().length > 5, 30_000);
  // The recon account's web client shows 100 conversations per page (Settings ▸ General); the banner and select-all depend on it.
  await setSetting("pageSize", 100);
  await sleep(1500);
}

/** The recon fake's own labels per conversation after a script (Courier's side only; the web client has no such window). */
async function serverLabels() {
  const s = await api.e2eControl<{ messages: { subject: string; labels: string[] }[] }>("recon-state");
  const by: Record<string, string[]> = {};
  for (const m of s.messages) if (known.includes(m.subject)) by[m.subject] = [...new Set([...(by[m.subject] ?? []), ...m.labels])].sort();
  return by;
}

const words = api
  .e2eInfo()
  .then((i) =>
    String(i.only ?? "")
      .split(",")
      .filter(Boolean),
  )
  .catch(() => [] as string[]);

const finish = api.e2eFinish;
api.e2eFinish = async (json, failed) => {
  const w = await words;
  const chosen = SCRIPTS.filter((s) => w.some((x) => `diff: ${s.name}`.includes(x) || x === "diff:"));
  if (!chosen.length) return finish(json, failed);
  const report = JSON.parse(json) as { steps: DiffResult[]; passed: number; failed: number; durationMs: number; focusTaken: boolean };
  const t = Date.now();
  const results: DiffResult[] = [];
  if (!report.steps.every((s) => s.ok)) {
    results.push({ name: "diff: the steps", ok: false, ms: 0, error: "skipped: the account setup failed" });
  } else {
    const env = makeEnv();
    try {
      await signInRecon();
    } catch (e) {
      results.push({ name: "diff: sign in the recon mailbox", ok: false, ms: 0, error: String((e as Error).message ?? e) });
    }
    if (!results.length) {
      for (const [i, script] of chosen.entries()) {
        log(`(diff ${i + 1}/${chosen.length}) ${script.name}`);
        const t0 = Date.now();
        let error: string | undefined;
        let observations: unknown;
        try {
          const run = await runScript(script, env, known, { onStep: (s: string) => log(`diff:   ${s}`) });
          const failedStep = run.steps.find((x) => x.error);
          if (failedStep) error = `step ${failedStep.i} (${failedStep.step}): ${failedStep.error}`;
          observations = { ...run, serverLabels: await serverLabels().catch(() => ({})) };
        } catch (e) {
          error = String((e as Error).message ?? e);
        }
        results.push({ name: `diff: ${script.name}`, ok: !error, ms: Date.now() - t0, error, observations });
        log(`${error ? "  FAILED" : "  ok"} (${Date.now() - t0} ms)${error ? `: ${error}` : ""}`);
        await env.reset().catch(() => {});
      }
    }
  }
  report.steps.push(...results);
  report.failed += results.filter((r) => !r.ok).length;
  report.passed += results.filter((r) => r.ok).length;
  report.durationMs += Date.now() - t;
  return finish(JSON.stringify(report, null, 2), report.failed > 0 || report.focusTaken);
};
