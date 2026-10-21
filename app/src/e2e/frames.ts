// Watches the window while an action runs and reports anything a person would see as a flash: a row that left
// and came back, rows that vanished for a moment, the loading bar or an empty list, a count that went back up,
// a conversation pane that went blank between two conversations, or the page background changing. It samples on
// every animation frame, every 8 ms and on every DOM change (a background window may get few frames, while DOM
// changes are always seen).

import { listTrace, traceList } from "../state/store";

interface Frame {
  t: number;
  rows: string[];
  loading: boolean;
  empty: boolean;
  /** The open conversation's subject, "" when the pane is open but blank, null when no conversation is open. */
  conv: string | null;
  counts: string;
  bg: string;
}

export interface Recording {
  frames: Frame[];
  /** Wall-clock start (ms), to line the recording up with the app log's `[trace]` lines. */
  wall0: number;
  /** What the list did meanwhile (store.ts listTrace), times relative to the start. */
  trace: { t: number; what: string; ids?: string[] }[];
  /** Rows added to or removed from the DOM, by thread id, in order. */
  changes: { t: number; added: string[]; removed: string[] }[];
}

const rowIds = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].map((r) => r.dataset.thread ?? "");

function snapshot(t0: number): Frame {
  const conv = document.querySelector('[data-testid="conversation"]');
  const subj = conv?.querySelector('[data-testid="conv-subject"]')?.textContent?.trim() ?? "";
  const nav = [...document.querySelectorAll(".nav-count")].map((c) => c.textContent?.trim() ?? "").join(",");
  const page = document.querySelector('[data-testid="page-info"]')?.textContent?.trim() ?? "";
  return {
    t: Math.round(performance.now() - t0),
    rows: rowIds(),
    loading: !!document.querySelector('[data-testid="thread-list"]')?.parentElement?.querySelector(".loading-bar"),
    empty: !!document.querySelector('[data-testid="empty-list"]'),
    conv: conv ? subj : null,
    counts: `${nav}|${page}`,
    bg: getComputedStyle(document.body).backgroundColor,
  };
}

export function recordFrames() {
  const t0 = performance.now();
  traceList(true);
  const rec: Recording = { frames: [], changes: [], trace: [], wall0: Date.now() };
  let on = true;
  const take = () => {
    const f = snapshot(t0);
    const last = rec.frames[rec.frames.length - 1];
    if (!last || JSON.stringify({ ...last, t: 0 }) !== JSON.stringify({ ...f, t: 0 })) rec.frames.push(f);
  };
  const raf = () => {
    if (!on) return;
    take();
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const timer = setInterval(take, 8);
  const mo = new MutationObserver((records) => {
    const added: string[] = [];
    const removed: string[] = [];
    for (const r of records) {
      for (const n of r.addedNodes) if (n instanceof HTMLElement) added.push(...(n.dataset.testid === "thread-row" ? [n.dataset.thread ?? ""] : rowIds(n)));
      for (const n of r.removedNodes) if (n instanceof HTMLElement) removed.push(...(n.dataset.testid === "thread-row" ? [n.dataset.thread ?? ""] : rowIds(n)));
    }
    if (added.length || removed.length) rec.changes.push({ t: Math.round(performance.now() - t0), added, removed });
    take();
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  take();
  return {
    stop(): Recording {
      on = false;
      clearInterval(timer);
      mo.disconnect();
      take();
      rec.trace = listTrace.map((e) => ({ ...e, t: Math.round(e.t - t0) }));
      traceList(false);
      return rec;
    },
  };
}

/** Which traced listing put `id` back by time `t`, and what happened just before. */
function cause(rec: Recording, id: string, t: number): string {
  const before = rec.trace.filter((e) => e.t <= t + 2);
  const by = [...before].reverse().find((e) => e.ids?.includes(id) && /^list#/.test(e.what));
  const recent = before
    .slice(-6)
    .map((e) => `${e.what}@${e.t}`)
    .join(", ");
  return `; put back by ${by ? `${by.what}@${by.t}` : "nothing traced"}; just before: ${recent}; wall ${rec.wall0 + t}`;
}

/** Everything that would read as a flash while `gone` (thread ids) left the view. */
export function flashes(rec: Recording, gone: string[], opts: { conversationOpen?: boolean } = {}): string[] {
  const issues: string[] = [];
  const first = rec.frames[0];
  // A thread that left must not come back. While a conversation replaces the list, rows aren't on screen at all, so
  // only frames that show the list count.
  const shown = opts.conversationOpen ? rec.frames.filter((f) => f.conv === null) : rec.frames;
  for (const id of gone) {
    const leftAt = shown.findIndex((f) => !f.rows.includes(id));
    if (leftAt < 0) {
      if (first.rows.includes(id)) issues.push(`row ${id} never left`);
      continue;
    }
    const back = shown.slice(leftAt).find((f) => f.rows.includes(id));
    if (back) issues.push(`row ${id} came back at +${back.t} ms (it had left at +${shown[leftAt].t} ms)${cause(rec, id, back.t)}`);
    const readded = opts.conversationOpen ? [] : rec.changes.filter((c) => c.t >= shown[leftAt].t && c.added.includes(id) && !c.removed.includes(id));
    if (readded.length && !back) issues.push(`row ${id} was put back into the page at +${readded[0].t} ms`);
  }
  // The other rows stay put: none disappears, even for a frame. While a conversation is open in place of the list
  // (no reading pane) the list isn't on screen, so only frames showing the list count.
  const others = first.rows.filter((id) => !gone.includes(id));
  const listFrames = opts.conversationOpen ? rec.frames.filter((f) => f.conv === null) : rec.frames;
  for (const f of listFrames) {
    const missing = others.filter((id) => !f.rows.includes(id));
    if (missing.length && f.rows.length < others.length) {
      issues.push(`${missing.length} other row(s) vanished at +${f.t} ms`);
      break;
    }
  }
  // Every row swapped out for a new copy (a remount through a changed key) also shows as a flash.
  const churn = opts.conversationOpen
    ? undefined
    : rec.changes.find((c) => c.removed.some((id) => others.includes(id)) && c.added.some((id) => others.includes(id)));
  if (churn) issues.push(`other rows were taken out and put back at +${churn.t} ms`);
  const loading = listFrames.find((f) => f.loading && !first.loading);
  if (loading) issues.push(`the loading bar showed at +${loading.t} ms`);
  const empty = listFrames.find((f) => f.empty && others.length > 0);
  if (empty) issues.push(`the list showed as empty at +${empty.t} ms`);
  // Counts move one way: a value seen before never comes back after it changed.
  const seq: string[] = [];
  for (const f of listFrames) if (seq[seq.length - 1] !== f.counts) seq.push(f.counts);
  const revisit = seq.findIndex((c, i) => seq.indexOf(c) < i);
  if (revisit >= 0) issues.push(`the counts went back: ${seq.slice(0, revisit + 1).join(" → ")}`);
  if (opts.conversationOpen) {
    const blank = rec.frames.find((f) => f.conv === "");
    if (blank) issues.push(`the conversation pane was blank at +${blank.t} ms`);
  }
  const bg = rec.frames.find((f) => f.bg !== first.bg);
  if (bg) issues.push(`the background changed at +${bg.t} ms (${first.bg} → ${bg.bg})`);
  return issues;
}
