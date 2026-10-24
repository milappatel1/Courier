// Perf suite on a 20,000-conversation mailbox; scripts/perf.sh runs it, research/PERF.md has the method, the numbers
// and how the budgets were set. Its steps run only when COURIER_E2E_ONLY names them ("perf:" names them all): run.ts
// runs the account setup and hands its report to api.e2eFinish, which this file wraps to run the perf steps first and
// add their results, each with the numbers it measured (`metrics`, medians of `samples`). A step fails when a number
// is over its budget in perf-budgets.json. A relaunch with COURIER_E2E_ONLY=perf:launch times the launch on the cache
// the last run left, writes a report with that one step and quits before run.ts's steps get anywhere.
import { api } from "../ipc/api";
import { getState, setSetting, visibleThreads } from "../state/store";
import file from "./perf-budgets.json";

declare global {
  interface Window {
    /** Set by the page's first script in end-to-end runs (FIRST_ROWS_SCRIPT in src-tauri/src/e2e.rs). */
    __firstRows?: { dom: number; painted: number };
  }
}

interface Budget {
  max: number;
  measured: string;
}

interface PerfResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  tookFocus?: boolean;
  /** The median of each series in `samples`, checked against perf-budgets.json. */
  metrics: Record<string, number>;
  samples: Record<string, number[]>;
}

interface PerfInfo {
  pid: number;
  processStartMs: number;
  fakesMs: [number, number];
  webContentPid: number;
  gpuPid: number;
  networkPid: number;
}

interface FakeStats {
  totalMs: number;
  routes: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

const budgets: Record<string, Budget | undefined> = file.budgets;
const { conversations, seed, pageSize } = file.mailbox;
const BIG = "busy0@example.net";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => {
  console.info(`[e2e] ${line}`);
  void api.e2eLog(line).catch(() => {});
};
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')];
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))];

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const el = (id: string, ms?: number) => until(`[${id}]`, () => q(id), ms);

function click(e: Element) {
  e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  (e as HTMLElement).click();
}

class Numbers {
  samples: Record<string, number[]> = {};
  add(name: string, v: number) {
    (this.samples[name] ??= []).push(Math.round(v * 10) / 10);
  }
  metrics() {
    return Object.fromEntries(Object.entries(this.samples).map(([k, v]) => [k, Math.round(median(v) * 10) / 10]));
  }
}

/**
 * When `cond` first held: `dom` after the DOM change that made it true, `painted` once the frame showing it has
 * rendered (`cond` is checked at the start of each frame, and a message posted from that frame is handled after
 * the frame's style, layout and paint). Both are performance.now() times.
 */
function shown(cond: () => boolean, ms = 60_000): Promise<{ dom: number; painted: number }> {
  return new Promise((resolve, reject) => {
    let dom = 0;
    const mo = new MutationObserver(() => {
      if (!dom && cond()) dom = performance.now();
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => {
      mo.disconnect();
      reject(new Error(`timed out waiting for the rows on screen${dom ? " (they reached the page; no frame showed them)" : ""}`));
    }, ms);
    const frame = () => {
      if (!cond()) return void requestAnimationFrame(frame);
      mo.disconnect();
      if (!dom) dom = performance.now();
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        clearTimeout(timer);
        resolve({ dom, painted: performance.now() });
      };
      ch.port2.postMessage(0);
    };
    requestAnimationFrame(frame);
  });
}

/** Animation frames in a second: WebKit renders no frames for a covered window unless told to (e2e.rs keep_rendering). */
async function frameRate() {
  let frames = 0;
  let on = true;
  const count = () => {
    if (!on) return;
    frames++;
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  await sleep(1000);
  on = false;
  return frames;
}

const fakeStats = (reset = false) => api.e2eControl<FakeStats>("fake-stats", { reset });

/** The rows on screen are the current list's, in order. */
function rowsMatch() {
  const want = visibleThreads();
  const got = rows();
  return (
    got.length > 0 &&
    got.length === want.length &&
    got[0].dataset.thread === want[0].threadId &&
    got[got.length - 1].dataset.thread === want[want.length - 1].threadId
  );
}

/**
 * Times `act` (a click or a search) to the new view's rows on screen: `firstRowsMs` for the first rows (the cache),
 * `settledMs` for the server's page in place. `fakeMs` is what the fake mail API spent answering meanwhile.
 */
async function timeView(n: Numbers, kind: string, act: () => void) {
  await sleep(600);
  const old = getState().list.result;
  await fakeStats(true);
  const t0 = performance.now();
  act();
  const key = getState().list.key;
  const ours = () => getState().list.key === key && !!getState().list.result && getState().list.result !== old;
  const first = await shown(() => ours() && rowsMatch());
  const settled = await shown(
    () => ours() && getState().list.result?.source === "server" && !getState().list.loading && !getState().list.settling && rowsMatch(),
  );
  const fake = await fakeStats();
  const calls = listCalls.splice(0).filter((c) => c.at >= t0);
  n.add(`${kind}.firstRowsMs`, first.painted - t0);
  n.add(`${kind}.settledMs`, settled.painted - t0);
  n.add(`${kind}.settledDomMs`, settled.dom - t0);
  n.add(
    `${kind}.cacheCallMs`,
    calls.filter((c) => c.mode === "cache").reduce((s, c) => s + c.ms, 0),
  );
  n.add(
    `${kind}.serverCallMs`,
    calls.filter((c) => c.mode === "server").reduce((s, c) => s + c.ms, 0),
  );
  n.add(`${kind}.fakeMs`, fake.totalMs);
  n.add(`${kind}.rows`, rows().length);
}

/** Every list call made while the perf steps run: when it started and how long the app's Rust side took to answer. */
const listCalls: { mode: string; at: number; ms: number }[] = [];
function timeListCalls() {
  const list = api.list;
  api.list = async (view) => {
    const at = performance.now();
    try {
      return await list(view);
    } finally {
      listCalls.push({ mode: view.mode ?? "cache", at, ms: performance.now() - at });
    }
  };
}

async function settledList() {
  await until(
    "the list settled",
    () => !getState().route.thread && !getState().route.settings && !getState().list.loading && !getState().list.settling && rowsMatch(),
    60_000,
  );
}

async function switchTo(email: string) {
  if (getState().accounts.find((a) => a.id === getState().accountId)?.email === email) return;
  click(await el("account-button"));
  click(await el(`account-${email}`));
  await until(`${email} active`, () => getState().accounts.find((a) => a.id === getState().accountId)?.email === email && !getState().list.loading, 30_000);
}

async function openNav(id: string) {
  if (!q(`nav-${id}`) && q("nav-more")) click(q("nav-more")!);
  return el(`nav-${id}`);
}

const perfInfo = () => api.e2eControl<PerfInfo>("perf-info");

/** A line scripts/perf.sh acts on: it samples the app's process and WebKit's for its window when it sees one. */
async function mark(what: string) {
  const info = await perfInfo();
  log(`perf:${what} pid=${info.pid} web=${info.webContentPid} gpu=${info.gpuPid} net=${info.networkPid}`);
}

let big: Promise<{ syncMs: number; fakeMs: number }> | null = null;

/** The 20,000-conversation account, signed in, open on its Inbox, first sync done; once per run. */
function bigAccount() {
  big ??= (async () => {
    // As in the app people use: no Inbox tracing, a sync a minute (the e2e default is every 2 s), page size 100.
    await api.e2eControl("trace-inbox", { on: false });
    await api.e2eControl("sync-interval", { seconds: 60 });
    await setSetting("pageSize", pageSize);
    await fakeStats(true);
    const t0 = performance.now();
    await api.e2eControl("big-accounts", { count: 1, conversations, seed });
    await until("the big account", () => getState().accounts.some((a) => a.email === BIG), 30_000);
    await switchTo(BIG);
    const id = getState().accountId;
    await until("its first sync", () => getState().sync[id] === "idle", 600_000);
    const syncMs = performance.now() - t0;
    const fake = await fakeStats();
    await settledList();
    return { syncMs, fakeMs: fake.totalMs };
  })();
  return big;
}

async function inbox() {
  if (getState().route.list.label !== "INBOX" || getState().route.list.query || getState().route.list.category !== "primary") {
    click(await openNav("INBOX"));
    await until("Primary", () => getState().route.list.label === "INBOX" && getState().route.list.category === "primary");
  }
  await settledList();
}

interface PerfStep {
  name: string;
  timeout: number;
  run: (n: Numbers) => Promise<void>;
}

const STEPS: PerfStep[] = [
  {
    name: "perf: a 20,000-conversation account signs in and syncs its first window",
    timeout: 660_000,
    run: async (n) => {
      // This process started with no accounts: how long it took to paint the welcome screen.
      const info = await perfInfo();
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
      if (fcp) n.add("launchEmpty.firstPaintMs", performance.timeOrigin + fcp - info.processStartMs);
      n.add("launchEmpty.toPageMs", performance.timeOrigin - info.processStartMs);
      const fps = await frameRate();
      n.add("frames.perSecond", fps);
      log(`perf: the page is ${document.visibilityState} and renders ${fps} frames a second`);
      const r = await bigAccount();
      n.add("sync.firstMs", r.syncMs);
      n.add("sync.fakeMs", r.fakeMs);
      await mark("mark rss synced");
      await sleep(2500);
    },
  },
  {
    name: "perf: switching labels shows the new label's rows",
    timeout: 300_000,
    run: async (n) => {
      await bigAccount();
      await inbox();
      for (let i = 0; i < 5; i++) {
        const all = await openNav("ALL");
        await timeView(n, "label", () => click(all));
        const box = await openNav("INBOX");
        await timeView(n, "label", () => click(box));
      }
    },
  },
  {
    name: "perf: switching Inbox tabs shows the tab's rows",
    timeout: 300_000,
    run: async (n) => {
      await bigAccount();
      await inbox();
      for (let i = 0; i < 2; i++)
        for (const tab of ["promotions", "social", "updates", "primary"]) {
          const t = await el(`tab-${tab}`);
          await timeView(n, "tab", () => click(t));
        }
    },
  },
  {
    name: "perf: search shows result rows after Enter",
    timeout: 300_000,
    run: async (n) => {
      await bigAccount();
      for (let i = 0; i < 2; i++)
        for (const query of ["receipt", "from:bank", "lakeside is:unread", "conversation 1234"]) {
          await inbox();
          const input = (await el("search-input")) as HTMLInputElement;
          input.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(200);
          // requestSubmit is what Enter does in the search form.
          await timeView(n, "search", () => input.form!.requestSubmit());
          input.blur();
        }
      await inbox();
    },
  },
  {
    name: "perf: scrolling a 100-row page keeps frames short",
    timeout: 120_000,
    run: async (n) => {
      await bigAccount();
      await inbox();
      check(rows().length === pageSize, `the Inbox page shows ${rows().length} rows, not ${pageSize}`);
      let sc: HTMLElement | null = q("thread-list");
      while (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = sc.parentElement;
      check(sc, "no scrolling element around the list");
      const longTasks: number[] = [];
      const supportsLongTasks = PerformanceObserver.supportedEntryTypes.includes("longtask");
      const po = supportsLongTasks ? new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration))) : null;
      po?.observe({ type: "longtask" });
      const intervals: number[] = [];
      const work: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        sc.scrollTop = 0;
        await sleep(300);
        await scrollPass(sc, 40, intervals, work);
      }
      po?.disconnect();
      n.add("scroll.frames", intervals.length);
      n.add("scroll.p50FrameMs", median(intervals));
      n.add("scroll.p95FrameMs", quantile(intervals, 0.95));
      n.add("scroll.maxFrameMs", Math.max(...intervals));
      n.add("scroll.slowFrames", intervals.filter((x) => x > 25).length);
      n.add("scroll.p95WorkMs", quantile(work, 0.95));
      if (po) n.add("scroll.longTasks", longTasks.length);
      await mark("mark rss views");
      await sleep(2500);
    },
  },
  {
    name: "perf: only the 20,000-conversation account stays (for the relaunch)",
    timeout: 120_000,
    run: async () => {
      await bigAccount();
      const info = (await api.e2eInfo()) as Record<string, string>;
      for (const email of [info.imapEmail, info.gmailEmail]) {
        await switchTo(email);
        click(await el("account-button"));
        click(await el("sign-out"));
        click(await el("confirm-ok"));
        await until(`${email} signed out`, () => !getState().accounts.some((a) => a.email === email), 30_000);
      }
      await until("the big account open", () => getState().accounts.find((a) => a.id === getState().accountId)?.email === BIG, 30_000);
      await inbox();
    },
  },
  {
    name: "perf: idle CPU while syncing every 2 s with mail arriving",
    timeout: 120_000,
    run: async (n) => {
      await bigAccount();
      await inbox();
      await api.e2eControl("sync-interval", { seconds: 2 });
      await api.e2eControl("traffic", { everyMs: 2000 });
      try {
        await sleep(8000);
        await fakeStats(true);
        await mark("window cpu start");
        const t0 = performance.now();
        await sleep(30_000);
        const wall = performance.now() - t0;
        const fake = await fakeStats();
        log("perf:window cpu end");
        // The list reloads the UI asked for meanwhile (each new message's mail-changed event), and their time.
        const reloads = listCalls.splice(0).filter((c) => c.at >= t0);
        n.add("cpu.windowMs", wall);
        n.add("cpu.fakePct", (fake.totalMs / wall) * 100);
        n.add("cpu.listCalls", reloads.length);
        n.add("cpu.listCallPct", (reloads.reduce((s, c) => s + c.ms, 0) / wall) * 100);
        for (const [route, r] of Object.entries(fake.routes)) n.add(`cpu.fake.${route}.calls`, r.count);
      } finally {
        await api.e2eControl("traffic", { everyMs: 0 });
      }
      await mark("mark rss idle");
      await sleep(2500);
    },
  },
];

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Scrolls `sc` down to the bottom and back up, `step` px a frame, noting each frame's interval and its own work. */
function scrollPass(sc: HTMLElement, step: number, intervals: number[], work: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`a scroll down and up took over 30 s (${intervals.length} frames)`)), 30_000);
    let last = 0;
    let dir = 1;
    const tick = (t: number) => {
      if (last) intervals.push(t - last);
      last = t;
      const start = performance.now();
      const ch = new MessageChannel();
      ch.port1.onmessage = () => work.push(performance.now() - start);
      ch.port2.postMessage(0);
      const max = sc.scrollHeight - sc.clientHeight;
      if (dir > 0 && sc.scrollTop >= max - 1) dir = -1;
      else if (dir < 0 && sc.scrollTop <= 0) return (clearTimeout(timer), resolve());
      sc.scrollTop += dir * step;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function overBudget(metrics: Record<string, number>) {
  return Object.entries(metrics)
    .filter(([k, v]) => budgets[k] && v > budgets[k]!.max)
    .map(([k, v]) => `${k} ${v} is over its budget of ${budgets[k]!.max}`);
}

async function focusState() {
  return api.e2eControl<{ appActive: boolean; activations: number }>("state");
}

async function runSteps(chosen: PerfStep[]): Promise<PerfResult[]> {
  timeListCalls();
  const errors: string[] = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${(e.reason as Error)?.message ?? String(e.reason)}`));
  let activations = (await focusState()).activations;
  const out: PerfResult[] = [];
  for (const [i, s] of chosen.entries()) {
    log(`(perf ${i + 1}/${chosen.length}) ${s.name}`);
    const n = new Numbers();
    const t = Date.now();
    let error: string | undefined;
    try {
      await Promise.race([s.run(n), sleep(s.timeout).then(() => Promise.reject(new Error(`step timed out after ${s.timeout / 1000}s`)))]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const metrics = n.metrics();
    const over = overBudget(metrics);
    if (over.length) error = [error, ...over].filter(Boolean).join("; ");
    const st = await focusState();
    const tookFocus = st.appActive || st.activations > activations || undefined;
    activations = st.activations;
    out.push({ name: s.name, ok: !error, ms: Date.now() - t, error, tookFocus, metrics, samples: n.samples });
    const shown = Object.entries(metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    log(`${error ? "  FAILED" : "  ok"} (${Date.now() - t} ms) ${shown}${error ? `: ${error}` : ""}`);
  }
  out.push({
    name: "perf: no uncaught errors during the perf steps",
    ok: !errors.length,
    ms: 0,
    error: errors.slice(0, 5).join(" | ") || undefined,
    metrics: {},
    samples: {},
  });
  return out;
}

/** The relaunch (COURIER_E2E_ONLY=perf:launch): process start to the first Inbox rows on screen, from the cache. */
async function launch() {
  const n = new Numbers();
  const t = Date.now();
  let error: string | undefined;
  try {
    const first = await until("the first Inbox rows on screen", () => window.__firstRows?.painted, 60_000).catch(async (e: Error) => {
      throw new Error(`${e.message} (rows reached the page: ${!!window.__firstRows?.dom}; ${await frameRate()} frames a second)`);
    });
    const info = await perfInfo();
    const origin = performance.timeOrigin;
    n.add("launch.rowsMs", origin + first - info.processStartMs);
    n.add("launch.rowsDomMs", origin + window.__firstRows!.dom - info.processStartMs);
    n.add("launch.toPageMs", origin - info.processStartMs);
    n.add("launch.fakesMs", info.fakesMs[1] - info.fakesMs[0]);
    n.add("launch.toFakesMs", info.fakesMs[0] - info.processStartMs);
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
    if (fcp) n.add("launch.firstPaintMs", origin + fcp - info.processStartMs);
    n.add("launch.rows", rows().length);
    const open = getState().accounts.find((a) => a.id === getState().accountId)?.email;
    check(open === BIG, `the relaunch opened ${open ?? "no account"}, not the 20,000-conversation account`);
    check(getState().route.list.label === "INBOX", `the relaunch opened ${getState().route.list.label}`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const metrics = n.metrics();
  const over = overBudget(metrics);
  if (over.length) error = [error, ...over].filter(Boolean).join("; ");
  const st = await focusState().catch(() => ({ appActive: false, activations: 0 }));
  const tookFocus = st.appActive || st.activations > 0;
  const step: PerfResult = {
    name: "perf:launch the Inbox rows of a 20,000-conversation cache after a relaunch",
    ok: !error,
    ms: Date.now() - t,
    error,
    tookFocus,
    metrics,
    samples: n.samples,
  };
  log(
    `${error ? "  FAILED" : "  ok"} ${Object.entries(metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}${error ? `: ${error}` : ""}`,
  );
  const report = {
    app: getState().info?.version ?? "dev",
    startedAt: new Date(t).toISOString(),
    durationMs: Date.now() - t,
    passed: error ? 0 : 1,
    failed: error ? 1 : 0,
    focusTaken: tookFocus,
    steps: [step],
  };
  await finish(JSON.stringify(report, null, 2), !step.ok || tookFocus);
}

const finish = api.e2eFinish;
const words = api
  .e2eInfo()
  .then((i) =>
    String(i.only ?? "")
      .split(",")
      .filter(Boolean),
  )
  .catch(() => [] as string[]);
void words.then((w) => (w.includes("perf:launch") ? launch() : undefined));

api.e2eFinish = async (json, failed) => {
  const w = await words;
  const chosen = STEPS.filter((s) => w.some((x) => s.name.includes(x)));
  if (!chosen.length || w.includes("perf:launch")) return finish(json, failed);
  const report = JSON.parse(json) as { steps: (PerfResult | { ok: boolean })[]; passed: number; failed: number; durationMs: number; focusTaken: boolean };
  const t = Date.now();
  const results: PerfResult[] = report.steps.every((s) => s.ok)
    ? await runSteps(chosen)
    : [{ name: "perf: the steps", ok: false, ms: 0, error: "skipped: the account setup failed", metrics: {}, samples: {} }];
  report.steps.push(...results);
  report.failed += results.filter((r) => !r.ok).length;
  report.passed += results.filter((r) => r.ok).length;
  report.durationMs += Date.now() - t;
  report.focusTaken ||= results.some((r) => r.tookFocus);
  log(`perf done: ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
  return finish(JSON.stringify(report, null, 2), report.failed > 0 || report.focusTaken);
};
