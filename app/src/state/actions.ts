// Actions on conversations, with the toast + Undo the web client shows.
import { parseListUnsubscribe } from "../core/unsubscribe";
import { api, errorText, on } from "../ipc/api";
import type { ThreadSummary, ViewQuery } from "../ipc/types";
import { nextStar } from "./settings";
import {
  accountById,
  closeThread,
  getState,
  hideThreads,
  labelName,
  loadList,
  setState,
  settleThreads,
  stepThread,
  toast,
  ui,
  visibleThreads,
  withUndo,
  type ThreadRef,
} from "./store";

export type ActionKind =
  | "archive"
  | "inbox"
  | "trash"
  | "restore"
  | "delete-forever"
  | "spam"
  | "not-spam"
  | "phishing"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "important"
  | "not-important"
  | "mute"
  | "unmute"
  | "unsnooze";

interface Target {
  accountId: string;
  threadIds: string[];
}

/** The conversations an action applies to: the selection, else the open conversation, else the cursor row. */
export function currentTargets(): Target[] {
  const s = getState();
  if (s.route.thread && !s.selected.length) return [{ accountId: s.route.thread.accountId, threadIds: [s.route.thread.threadId] }];
  const list = visibleThreads();
  const picked = s.selected.length ? list.filter((t) => s.selected.includes(t.threadId)) : list[s.cursor] ? [list[s.cursor]] : [];
  const byAccount = new Map<string, string[]>();
  for (const t of picked) byAccount.set(t.accountId, [...(byAccount.get(t.accountId) ?? []), t.threadId]);
  return [...byAccount.entries()].map(([accountId, threadIds]) => ({ accountId, threadIds }));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

const RULES: Record<ActionKind, { add: string[]; remove: string[]; text: (n: number) => string; leaves?: (label: string | null) => boolean }> = {
  archive: { add: [], remove: ["INBOX"], text: (n) => `${plural(n, "Conversation", "conversations")} archived.`, leaves: (l) => l === "INBOX" },
  inbox: {
    add: ["INBOX"],
    remove: [],
    text: (n) => `${plural(n, "Conversation", "conversations")} moved to Inbox.`,
    leaves: (l) => l === "ALL" || l === "TRASH" || l === "SPAM",
  },
  trash: { add: ["TRASH"], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} moved to Trash.`, leaves: () => true },
  restore: { add: [], remove: ["TRASH"], text: (n) => `${plural(n, "Conversation", "conversations")} moved to Inbox.`, leaves: (l) => l === "TRASH" },
  "delete-forever": { add: [], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} deleted forever.`, leaves: () => true },
  spam: { add: ["SPAM"], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} marked as spam.`, leaves: () => true },
  "not-spam": {
    add: [],
    remove: ["SPAM"],
    text: (n) => `${plural(n, "Conversation", "conversations")} unmarked as spam and moved to Inbox.`,
    leaves: (l) => l === "SPAM",
  },
  phishing: { add: ["SPAM"], remove: [], text: () => "Reported as phishing and moved to Spam.", leaves: () => true },
  read: { add: [], remove: ["UNREAD"], text: (n) => `${plural(n, "Conversation", "conversations")} marked as read.` },
  unread: { add: ["UNREAD"], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} marked as unread.` },
  star: { add: ["STARRED"], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} starred.` },
  unstar: { add: [], remove: ["STARRED"], text: (n) => `${plural(n, "Conversation", "conversations")} unstarred.`, leaves: (l) => l === "STARRED" },
  important: { add: ["IMPORTANT"], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} marked as important.` },
  "not-important": {
    add: [],
    remove: ["IMPORTANT"],
    text: (n) => `${plural(n, "Conversation", "conversations")} marked as not important.`,
    leaves: (l) => l === "IMPORTANT",
  },
  mute: { add: [], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} muted.`, leaves: (l) => l === "INBOX" },
  unmute: { add: [], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} unmuted.` },
  unsnooze: { add: [], remove: [], text: (n) => `${plural(n, "Conversation", "conversations")} unsnoozed.`, leaves: (l) => l === "SNOOZED" },
};

/** After removing the open conversation from view: next one (auto-advance) or back to the list. */
function advanceAfter(leaving: boolean) {
  const s = getState();
  if (!leaving || !s.route.thread) return;
  const mode = s.settings.autoAdvance;
  if (mode === "list" || !stepThread(mode === "older" ? 1 : -1)) closeThread();
}

export async function act(kind: ActionKind, targets: Target[] = currentTargets()) {
  const count = targets.reduce((n, t) => n + t.threadIds.length, 0);
  if (!count) return;
  const s = getState();
  const rule = RULES[kind];
  const label = s.route.list.query ? null : s.route.list.label;
  const leaving = !!rule.leaves?.(label);
  if (kind === "delete-forever") {
    ui({
      confirm: {
        title: "Delete forever?",
        body: `${plural(count, "This conversation", "conversations")} will be deleted permanently. This can't be undone.`,
        ok: "Delete forever",
        run: () => void deleteForever(targets, count),
      },
    });
    return;
  }
  const moved = leaving ? targets.flatMap((t) => t.threadIds) : [];
  hideThreads(moved);
  const wasOpen = s.route.thread;
  advanceAfter(leaving && !!wasOpen && targets.some((t) => t.threadIds.includes(wasOpen.threadId)));
  let ok = false;
  try {
    for (const t of targets) {
      if (kind === "mute" || kind === "unmute") await api.mute(t.accountId, t.threadIds, kind === "mute");
      else if (kind === "unsnooze") await api.unsnooze(t.accountId, t.threadIds);
      else await api.modifyThreads(t.accountId, t.threadIds, rule.add, rule.remove);
    }
    // The inverse change; removing TRASH/SPAM brings INBOX back (the engine's label rules).
    const undo = async () => {
      for (const t of targets) {
        if (kind === "mute" || kind === "unmute") await api.mute(t.accountId, t.threadIds, kind !== "mute");
        else if (kind !== "unsnooze") await api.modifyThreads(t.accountId, t.threadIds, rule.remove, rule.add);
      }
    };
    if (["read", "unread", "star", "unstar", "important", "not-important"].includes(kind) && !leaving) {
      toast(rule.text(count));
      setState({ undo: { text: rule.text(count), run: undo } });
    } else withUndo(rule.text(count), undo);
    ok = true;
  } catch (e) {
    toast(`Couldn't do that: ${errorText(e)}`);
  } finally {
    settleThreads(moved, ok);
    void loadList({ quiet: true });
    setState({ selected: [], selectAllMatching: false, keepThreads: [] });
  }
}

async function deleteForever(targets: Target[], count: number) {
  const gone = targets.flatMap((t) => t.threadIds);
  hideThreads(gone);
  advanceAfter(true);
  let ok = false;
  try {
    for (const t of targets) await api.deleteForever(t.accountId, t.threadIds);
    toast(RULES["delete-forever"].text(count));
    ok = true;
  } catch (e) {
    toast(`Couldn't delete: ${errorText(e)}`);
  }
  settleThreads(gone, ok);
  void loadList({ quiet: true });
}

/** Add/remove labels ("Label as"), or move (label added + the current label removed). */
export async function applyLabels(add: string[], remove: string[], opts: { move?: boolean; targets?: Target[] } = {}) {
  const targets = opts.targets ?? currentTargets();
  const count = targets.reduce((n, t) => n + t.threadIds.length, 0);
  if (!count) return;
  const s = getState();
  const here = s.route.list.query ? null : s.route.list.label;
  const removeAll = [...remove];
  if (opts.move && here && here !== add[0] && !["STARRED", "IMPORTANT", "SNOOZED", "ALL", "SENT", "DRAFT"].includes(here)) removeAll.push(here);
  if (opts.move && !here) removeAll.push("INBOX");
  const leaving = !!here && removeAll.includes(here);
  const moved = leaving ? targets.flatMap((t) => t.threadIds) : [];
  hideThreads(moved);
  let ok = false;
  try {
    for (const t of targets) await api.modifyThreads(t.accountId, t.threadIds, add, removeAll);
    const acct = targets[0].accountId;
    const names = add.map((l) => labelName(acct, l));
    const text = opts.move
      ? `${plural(count, "Conversation", "conversations")} moved to "${names[0]}".`
      : add.length
        ? `${plural(count, "Conversation", "conversations")} added to "${names.join('", "')}".`
        : `${plural(count, "Conversation", "conversations")} removed from "${remove.map((l) => labelName(acct, l)).join('", "')}".`;
    withUndo(text, async () => {
      for (const t of targets) await api.modifyThreads(t.accountId, t.threadIds, removeAll, add);
    });
    ok = true;
  } catch (e) {
    toast(`Couldn't change labels: ${errorText(e)}`);
  }
  settleThreads(moved, ok);
  void loadList({ quiet: true });
}

export async function snooze(until: number, targets: Target[] = currentTargets()) {
  const count = targets.reduce((n, t) => n + t.threadIds.length, 0);
  if (!count) return;
  const moved = targets.flatMap((t) => t.threadIds);
  hideThreads(moved);
  const open = getState().route.thread;
  advanceAfter(!!open && targets.some((t) => t.threadIds.includes(open.threadId)));
  let ok = false;
  try {
    for (const t of targets) await api.snooze(t.accountId, t.threadIds, until);
    const d = new Date(until);
    const when = d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    withUndo(`Snoozed until ${when}`, async () => {
      for (const t of targets) await api.unsnooze(t.accountId, t.threadIds);
    });
    ok = true;
  } catch (e) {
    toast(`Couldn't snooze: ${errorText(e)}`);
  }
  settleThreads(moved, ok);
  void loadList({ quiet: true });
}

/** Star click: rotate through the star types in use (Settings ▸ General ▸ Stars). */
export async function toggleStar(t: ThreadSummary) {
  const s = getState();
  const next = nextStar(t.starred ? (t.starType ?? "yellow-star") : null, s.settings.stars);
  const lastMessage = t.messageIds[t.messageIds.length - 1];
  setState((st) => ({
    list: st.list.result
      ? {
          ...st.list,
          result: {
            ...st.list.result,
            threads: st.list.result.threads.map((x) =>
              x.threadId === t.threadId && x.accountId === t.accountId ? { ...x, starred: !!next, starType: next } : x,
            ),
          },
        }
      : st.list,
  }));
  try {
    if (next) await api.star(t.accountId, lastMessage, next);
    else await api.modifyThreads(t.accountId, [t.threadId], [], ["STARRED"]);
  } catch (e) {
    toast(`Couldn't star: ${errorText(e)}`);
  }
  void loadList({ quiet: true });
}

export async function starMessage(accountId: string, messageId: string, current: string | null) {
  const next = nextStar(current, getState().settings.stars);
  await api.star(accountId, messageId, next).catch((e) => toast(errorText(e)));
}

export async function toggleImportant(t: ThreadSummary) {
  await act(t.important ? "not-important" : "important", [{ accountId: t.accountId, threadIds: [t.threadId] }]);
}

export async function markUnreadFromHere(ref: ThreadRef, fromIndex: number) {
  const d = getState().thread.detail;
  if (!d) return;
  const ids = d.messages.slice(fromIndex).map((m) => m.id);
  await api.modifyMessages(ref.accountId, ids, ["UNREAD"], []);
  closeThread();
  toast("Marked as unread.");
}

export async function blockSender(accountId: string, email: string, name: string) {
  ui({
    confirm: {
      title: `Block ${name || email}?`,
      body: `Future messages from ${email} will go to ${accountById(accountId)?.kind === "gmail" ? "Trash" : "Spam"}. You can unblock them in Settings ▸ Filters and blocked addresses.`,
      ok: "Block",
      run: () =>
        void api
          .block(accountId, email)
          .then(() =>
            toast(`${email} was blocked.`, {
              action: { label: "Undo", run: () => void api.unblock(accountId, email).then(() => toast(`${email} was unblocked.`)) },
            }),
          )
          .catch((e) => toast(errorText(e))),
    },
  });
}

/** Unsubscribe: one-click POST (RFC 8058) when offered, an email when only mailto is, else open the page. */
export async function unsubscribe(
  accountId: string,
  header: string,
  post: string,
  senderName: string,
  sendMail: (to: string, subject: string, body: string) => Promise<void>,
  onDone?: () => void,
) {
  const m = parseListUnsubscribe(header || null, post || null);
  if (!m) return toast("This sender doesn't offer an unsubscribe link.");
  ui({
    confirm: {
      title: `Unsubscribe from ${senderName}?`,
      body:
        m.kind === "link"
          ? "The sender's unsubscribe page will open in your browser."
          : m.kind === "mailto"
            ? `Courier will send an unsubscribe email to ${m.to} for you.`
            : "Courier will ask the sender to stop sending you mail.",
      ok: "Unsubscribe",
      run: () => {
        if (m.kind === "one-click")
          void api
            .unsubscribeOneClick(m.url)
            .then(() => (toast(`Unsubscribed from ${senderName}.`), onDone?.()))
            .catch((e) => toast(`Couldn't unsubscribe: ${errorText(e)}`));
        else if (m.kind === "mailto") void sendMail(m.to, m.subject, m.body).then(() => (toast(`Unsubscribe request sent to ${senderName}.`), onDone?.()));
        else void api.openExternal(m.url).then(() => onDone?.());
      },
    },
  });
  void accountId;
}

export async function emptyLabel(accountId: string, label: "TRASH" | "SPAM") {
  ui({
    confirm: {
      title: label === "TRASH" ? "Empty Trash?" : "Delete all spam messages?",
      body: "All messages here will be deleted permanently. This can't be undone.",
      ok: "OK",
      run: () =>
        void api
          .emptyLabel(accountId, label)
          .then((n) => toast(`${n} ${n === 1 ? "message" : "messages"} deleted forever.`))
          .catch((e) => toast(errorText(e)))
          .finally(() => void loadList()),
    },
  });
}

// ---- selection ----

export function toggleSelect(threadId: string, range = false) {
  setState((s) => {
    if (range && s.selected.length) {
      const list = visibleThreads().map((t) => t.threadId);
      const a = list.indexOf(s.selected[s.selected.length - 1]);
      const b = list.indexOf(threadId);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const add = list.slice(lo, hi + 1);
      return { selected: [...new Set([...s.selected, ...add])] };
    }
    if (s.selectAllMatching) {
      // Everything in the view stays selected; an unticked row is kept out of the action.
      const keep = s.keepThreads.includes(threadId) ? s.keepThreads.filter((x) => x !== threadId) : [...s.keepThreads, threadId];
      const selected = s.selected.includes(threadId) ? s.selected.filter((x) => x !== threadId) : [...s.selected, threadId];
      return { keepThreads: keep, selected };
    }
    return { selected: s.selected.includes(threadId) ? s.selected.filter((x) => x !== threadId) : [...s.selected, threadId], selectAllMatching: false };
  });
}

export function selectWhere(kind: "all" | "none" | "read" | "unread" | "starred" | "unstarred") {
  const list = visibleThreads();
  const pick = (t: ThreadSummary) =>
    kind === "all" ||
    (kind === "read" && !t.unread) ||
    (kind === "unread" && t.unread) ||
    (kind === "starred" && t.starred) ||
    (kind === "unstarred" && !t.starred);
  setState({ selected: kind === "none" ? [] : list.filter(pick).map((t) => t.threadId), selectAllMatching: false, keepThreads: [] });
}

/** "Select all N conversations in this view": the action then applies to every page. */
export async function selectAllMatching() {
  setState({ selectAllMatching: true, keepThreads: [] });
}

/** Actions that can run over a whole view on the server (the rest use the cached listing). */
export const BULK_KINDS: ActionKind[] = [
  "archive",
  "inbox",
  "trash",
  "restore",
  "delete-forever",
  "spam",
  "not-spam",
  "read",
  "unread",
  "star",
  "unstar",
  "important",
  "not-important",
];

/** The question asked before a whole-view action, and what's said after it. */
const BULK_TEXT: Partial<Record<ActionKind, { ask: (what: string) => string; done: string }>> = {
  archive: { ask: (w) => `Archive ${w}?`, done: "archived" },
  inbox: { ask: (w) => `Move ${w} to Inbox?`, done: "moved to Inbox" },
  trash: { ask: (w) => `Move ${w} to Trash?`, done: "moved to Trash" },
  restore: { ask: (w) => `Move ${w} to Inbox?`, done: "moved to Inbox" },
  "delete-forever": { ask: (w) => `Delete ${w} forever?`, done: "deleted forever" },
  spam: { ask: (w) => `Mark ${w} as spam?`, done: "marked as spam" },
  "not-spam": { ask: (w) => `Move ${w} out of Spam?`, done: "moved out of Spam" },
  read: { ask: (w) => `Mark ${w} as read?`, done: "marked as read" },
  unread: { ask: (w) => `Mark ${w} as unread?`, done: "marked as unread" },
  star: { ask: (w) => `Star ${w}?`, done: "starred" },
  unstar: { ask: (w) => `Remove the star from ${w}?`, done: "unstarred" },
  important: { ask: (w) => `Mark ${w} as important?`, done: "marked as important" },
  "not-important": { ask: (w) => `Mark ${w} as not important?`, done: "marked as not important" },
};

/** Name of the current view for confirmations: "Inbox", "Promotions", a label, or "this search". */
function viewName(): string {
  const s = getState();
  const l = s.route.list;
  if (l.query) return "this search";
  if (l.label === "INBOX" && l.category && l.category !== "primary") return l.category[0].toUpperCase() + l.category.slice(1);
  return labelName(s.accountId === "all" ? (s.accounts[0]?.id ?? "") : s.accountId, l.label ?? "INBOX");
}

/**
 * An action over every conversation in the view — all pages, on the server — except `keep`. Asks first,
 * shows progress, then offers Undo. `estimate` is the count shown in the confirmation (null when unknown).
 */
export async function bulkAct(kind: ActionKind, keep: string[], estimate: number | null) {
  const s = getState();
  const { currentView } = await import("./store");
  const rule = RULES[kind];
  const where = viewName();
  const n = estimate != null ? Math.max(0, estimate - keep.length) : null;
  const what = `${n != null ? `${n.toLocaleString()} conversation${n === 1 ? "" : "s"}` : "every conversation"} in ${where}`;
  const kept = keep.length
    ? ` The ${keep.length === 1 ? "one" : keep.length} you kept ${keep.length === 1 ? "stays" : "stay"} as ${keep.length === 1 ? "it is" : "they are"}.`
    : "";
  const forever = kind === "delete-forever";
  ui({
    confirm: {
      title: BULK_TEXT[kind]?.ask(what) ?? `Change ${what}?`,
      body: `This applies to every page of ${where}, not just the one you see.${kept}${forever ? " Deleted conversations can't be recovered." : ""}`,
      ok: forever ? "Delete forever" : "OK",
      run: () => void runBulk(kind, keep, currentView, rule, s.accountId === "all" ? s.accounts.map((a) => a.id) : [s.accountId]),
    },
  });
}

async function runBulk(kind: ActionKind, keep: string[], currentView: (page?: number) => ViewQuery, rule: (typeof RULES)[ActionKind], accounts: string[]) {
  const { replaceToast, dismissToast } = await import("./store");
  const progress = toast("Finding conversations…", { sticky: true });
  const off = await on<{ phase: string; found?: number; done?: number; total?: number }>("bulk-progress", (p) => {
    if (p.phase === "finding") replaceToast(progress, `Finding conversations… ${(p.found ?? 0).toLocaleString()} messages so far`, { ms: 600000 });
    else if (p.phase === "working" && p.total)
      replaceToast(progress, `Working… ${(p.done ?? 0).toLocaleString()} of ${p.total.toLocaleString()} messages`, { ms: 600000 });
  });
  const changed: { accountId: string; ids: string[] }[] = [];
  let count = 0;
  try {
    for (const accountId of accounts) {
      const v = { ...currentView(0), accountId, ...(accounts.length > 1 ? { label: "INBOX", category: null } : {}) };
      if (kind === "delete-forever") count += await api.bulkDeleteForever(v, keep);
      else {
        const ids = await api.bulkModify(v, rule.add, rule.remove, keep);
        changed.push({ accountId, ids });
        count += ids.length;
      }
    }
    off();
    dismissToast(progress);
    const text = `${count.toLocaleString()} message${count === 1 ? "" : "s"} ${BULK_TEXT[kind]?.done ?? "changed"}.`;
    if (kind === "delete-forever") toast(text);
    else
      withUndo(text, async () => {
        for (const c of changed) await api.modifyMessages(c.accountId, c.ids, rule.remove, rule.add);
      });
  } catch (e) {
    off();
    dismissToast(progress);
    toast(`Couldn't finish: ${errorText(e)}`);
  } finally {
    setState({ selected: [], selectAllMatching: false, keepThreads: [], hiddenThreads: [] });
    void loadList({ quiet: true });
  }
}

/** "Delete all except selected" (and archive): the ticked conversations stay, the rest of the view goes. */
export function allExceptSelected(kind: "trash" | "archive" | "delete-forever", total: number | null) {
  const keep = getState().selected;
  void bulkAct(kind, keep, total);
}

/** Expand a select-all-matching selection to every thread id in the view (page through it). */
export async function allMatchingTargets(): Promise<Target[]> {
  const s = getState();
  const { currentView } = await import("./store");
  const out = new Map<string, string[]>();
  let page = 0;
  for (;;) {
    const v = { ...currentView(page), pageSize: 200, mode: "cache" as const };
    const r = await api.list(v);
    for (const t of r.threads) out.set(t.accountId, [...(out.get(t.accountId) ?? []), t.threadId]);
    if (!r.hasMore || page > 100) break;
    page++;
  }
  void s;
  return [...out.entries()].map(([accountId, threadIds]) => ({ accountId, threadIds }));
}
