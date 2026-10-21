// Actions on conversations, with the toast + Undo the web client shows.
import { parseListUnsubscribe, unsubscribeDialog, type UnsubscribeMethod } from "../core/unsubscribe";
import { api, errorText, failureText, on, type BulkOutcome } from "../ipc/api";
import type { ThreadSummary, ViewQuery } from "../ipc/types";
import { nextStar } from "./settings";
import {
  accountById,
  closeThread,
  getState,
  go,
  noteUnsubscribed,
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

/** Added to an action's toast when the change waits for the connection (Undo still takes it back). */
const WHEN_ONLINE = " It'll sync when you're back online.";

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

/** What an action does, for "Couldn't …" when it fails. */
const DOING: Record<ActionKind, string> = {
  archive: "archive {c}",
  inbox: "move {c} to Inbox",
  trash: "move {c} to Trash",
  restore: "move {c} to Inbox",
  "delete-forever": "delete {c} forever",
  spam: "mark {c} as spam",
  "not-spam": "move {c} out of Spam",
  phishing: "report {c} as phishing",
  read: "mark {c} as read",
  unread: "mark {c} as unread",
  star: "star {c}",
  unstar: "remove the star from {c}",
  important: "mark {c} as important",
  "not-important": "mark {c} as not important",
  mute: "mute {c}",
  unmute: "unmute {c}",
  unsnooze: "unsnooze {c}",
};
const doing = (kind: ActionKind, n: number) => DOING[kind].replace("{c}", n === 1 ? "the conversation" : `${n.toLocaleString()} conversations`);

/** A sender in the conversations being reported, with a way to unsubscribe from them. */
interface SpamOffer {
  accountId: string;
  sender: { name: string; email: string };
  method: UnsubscribeMethod;
}

/**
 * Reporting spam on mailing-list mail asks first, as the web client does, whether to unsubscribe as well.
 * True when it asked (the answer carries on from the dialog).
 */
async function askSpamOrUnsubscribe(targets: Target[], count: number): Promise<boolean> {
  const local = !!getState().info?.e2e;
  const offers: SpamOffer[] = [];
  for (const t of targets) {
    const done = getState().unsubscribed[t.accountId] ?? [];
    const me = accountById(t.accountId)?.email.toLowerCase();
    for (const id of t.threadIds) {
      const d = await api.thread(t.accountId, id).catch(() => null);
      const m = [...(d?.messages ?? [])].reverse().find((x) => x.listUnsubscribe && x.fromEmail.toLowerCase() !== me);
      const method = m && parseListUnsubscribe(m.listUnsubscribe, m.listUnsubscribePost || null, { localOk: local });
      if (!m || !method || done.includes(m.fromEmail.toLowerCase()) || offers.some((o) => o.sender.email === m.fromEmail)) continue;
      offers.push({ accountId: t.accountId, sender: { name: m.fromName, email: m.fromEmail }, method });
    }
  }
  if (!offers.length) return false;
  const who = offers.map((o) => o.sender.name || o.sender.email).join(", ");
  ui({
    confirm: {
      title: "Report spam or unsubscribe?",
      body:
        count === 1 && offers.length === 1
          ? `This message will be marked as spam. Would you also like to stop receiving similar messages from ${who}?`
          : `These messages will be marked as spam. Would you also like to stop receiving similar messages from ${who}?`,
      alt: { label: "Report spam", run: () => void act("spam", targets, { asked: true }) },
      ok: "Unsubscribe",
      run: () => void spamAndUnsubscribe(targets, offers),
    },
  });
  return true;
}

async function spamAndUnsubscribe(targets: Target[], offers: SpamOffer[]) {
  const { sendSimple } = await import("./compose");
  let ok = 0;
  for (const o of offers) {
    try {
      if (o.method.kind === "one-click") await api.unsubscribeOneClick(o.method.url);
      else if (o.method.kind === "mailto") await sendSimple(o.accountId, o.method.to, o.method.subject || "unsubscribe", o.method.body);
      else {
        await api.openExternal(o.method.url);
        continue;
      }
      await api.markUnsubscribed(o.accountId, o.sender.email).catch(() => {});
      noteUnsubscribed(o.accountId, o.sender.email);
      ok++;
    } catch (e) {
      toast(failureText(`unsubscribe from ${o.sender.name || o.sender.email}`, e));
    }
  }
  await act("spam", targets, { asked: true, note: ok ? (ok === 1 ? " Unsubscribed from its mailing list." : " Unsubscribed from their mailing lists.") : "" });
}

/** After removing the open conversation from view: next one (auto-advance) or back to the list. */
function advanceAfter(leaving: boolean) {
  const s = getState();
  if (!leaving || !s.route.thread) return;
  const mode = s.settings.autoAdvance;
  if (mode === "list" || !stepThread(mode === "older" ? 1 : -1)) closeThread();
}

export async function act(kind: ActionKind, targets: Target[] = currentTargets(), opts: { asked?: boolean; note?: string } = {}) {
  const count = targets.reduce((n, t) => n + t.threadIds.length, 0);
  if (!count) return;
  if (kind === "spam" && !opts.asked && (await askSpamOrUnsubscribe(targets, count))) return;
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
  const wasInInbox = new Set([
    ...(s.list.result?.threads ?? []).filter((t) => t.labels.includes("INBOX")).map((t) => t.threadId),
    ...(s.thread.detail?.messages.some((m) => m.labels.includes("INBOX")) ? [s.thread.detail.threadId] : []),
  ]);
  hideThreads(moved);
  const wasOpen = s.route.thread;
  advanceAfter(leaving && !!wasOpen && targets.some((t) => t.threadIds.includes(wasOpen.threadId)));
  let ok = false;
  let queued = false;
  try {
    for (const t of targets) {
      if (kind === "mute" || kind === "unmute") await api.mute(t.accountId, t.threadIds, kind === "mute");
      else if (kind === "unsnooze") await api.unsnooze(t.accountId, t.threadIds);
      else if ((await api.modifyThreads(t.accountId, t.threadIds, rule.add, rule.remove)) === "queued") queued = true;
    }
    // The inverse change; removing TRASH/SPAM brings INBOX back (the engine's label rules). Muting archives what
    // was in the Inbox, so undoing it puts those back.
    const undo = async () => {
      for (const t of targets) {
        if (kind === "mute" || kind === "unmute") {
          await api.mute(t.accountId, t.threadIds, kind !== "mute");
          const back = t.threadIds.filter((id) => wasInInbox.has(id));
          if (kind === "mute" && back.length) await api.modifyThreads(t.accountId, back, ["INBOX"], []);
        } else if (kind !== "unsnooze") await api.modifyThreads(t.accountId, t.threadIds, rule.remove, rule.add);
      }
    };
    withUndo(rule.text(count) + (opts.note ?? "") + (queued ? WHEN_ONLINE : ""), undo);
    ok = true;
  } catch (e) {
    toast(failureText(doing(kind, count), e), { action: { label: "Try again", run: () => void act(kind, targets) } });
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
    toast(failureText(doing("delete-forever", count), e), { action: { label: "Try again", run: () => void deleteForever(targets, count) } });
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
    let queued = false;
    for (const t of targets) if ((await api.modifyThreads(t.accountId, t.threadIds, add, removeAll)) === "queued") queued = true;
    const acct = targets[0].accountId;
    const names = add.map((l) => labelName(acct, l));
    const text = opts.move
      ? `${plural(count, "Conversation", "conversations")} moved to "${names[0]}".`
      : add.length
        ? `${plural(count, "Conversation", "conversations")} added to "${names.join('", "')}".`
        : `${plural(count, "Conversation", "conversations")} removed from "${remove.map((l) => labelName(acct, l)).join('", "')}".`;
    withUndo(text + (queued ? WHEN_ONLINE : ""), async () => {
      for (const t of targets) await api.modifyThreads(t.accountId, t.threadIds, removeAll, add);
    });
    ok = true;
  } catch (e) {
    toast(failureText(`change the labels on ${count === 1 ? "the conversation" : `${count} conversations`}`, e), {
      action: { label: "Try again", run: () => void applyLabels(add, remove, { ...opts, targets }) },
    });
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
    toast(failureText(`snooze ${count === 1 ? "the conversation" : `${count} conversations`}`, e), {
      action: { label: "Try again", run: () => void snooze(until, targets) },
    });
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
    toast(failureText(`star`, e));
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
  const changed = await api.modifyMessages(ref.accountId, ids, ["UNREAD"], []);
  closeThread();
  toast("Marked as unread." + (changed === "queued" ? WHEN_ONLINE : ""));
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

/**
 * Unsubscribe the way the web client does. From a message (scope "list") it's that mailing list; from Manage
 * subscriptions (scope "sender") every list the sender uses in the cached mail. Each list goes by one-click in
 * the background when offered, else an unsubscribe email from the account, else (when no list offers either)
 * the sender's website in the browser.
 */
export async function unsubscribe(o: {
  accountId: string;
  sender: { name: string; email: string };
  scope: "list" | "sender";
  header?: string;
  post?: string;
  sendMail: (to: string, subject: string, body: string) => Promise<void>;
  onDone?: () => void;
}) {
  const local = !!getState().info?.e2e;
  const lists =
    o.scope === "list"
      ? [{ listUnsubscribe: o.header ?? "", listUnsubscribePost: o.post ?? "" }]
      : await api.senderLists(o.accountId, o.sender.email).catch(() => []);
  const methods = lists
    .map((l) => parseListUnsubscribe(l.listUnsubscribe || null, l.listUnsubscribePost || null, { localOk: local }))
    .filter((m) => m !== null);
  if (!methods.length) return void toast("This sender doesn't offer a way to unsubscribe.");
  const direct = methods.filter((m) => m.kind !== "website");
  const shown = direct[0] ?? methods[0];
  const mailTo = direct.flatMap((m) => (m.kind === "mailto" ? [m.to] : []));
  const account = accountById(o.accountId)?.email ?? "";
  const d = unsubscribeDialog(shown, { scope: o.scope, sender: o.sender, account, mailTo });
  const name = o.sender.name || o.sender.email;
  ui({
    confirm: {
      title: d.title,
      body: d.body,
      note: d.note ? { text: d.note, link: { label: "Manage subscriptions", run: () => go({ label: "SUBSCRIPTIONS" }) } } : undefined,
      ok: d.ok,
      run: () => {
        if (!direct.length) return void api.openExternal((shown as { url: string }).url).catch((e) => toast(failureText("open the sender's page", e)));
        void (async () => {
          try {
            for (const m of direct) {
              if (m.kind === "one-click") await api.unsubscribeOneClick(m.url);
              else if (m.kind === "mailto") await o.sendMail(m.to, m.subject || "unsubscribe", m.body);
            }
            await api.markUnsubscribed(o.accountId, o.sender.email).catch(() => {});
            noteUnsubscribed(o.accountId, o.sender.email);
            toast(o.scope === "list" ? "Unsubscribed from this mailing list." : `Unsubscribed from ${name}.`);
            o.onDone?.();
          } catch (e) {
            const page = methods.find((m) => m.kind !== "mailto") as { url: string } | undefined;
            toast(failureText(`unsubscribe from ${name}`, e), page ? { action: { label: "Go to website", run: () => void api.openExternal(page.url) } } : {});
          }
        })();
      },
    },
  });
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
  let done = 0;
  let failed = 0;
  const again = () => void runBulk(kind, keep, currentView, rule, accounts);
  try {
    for (const accountId of accounts) {
      const v = { ...currentView(0), accountId, ...(accounts.length > 1 ? { label: "INBOX", category: null } : {}) };
      const out: BulkOutcome = kind === "delete-forever" ? await api.bulkDeleteForever(v, keep) : await api.bulkModify(v, rule.add, rule.remove, keep);
      if (kind !== "delete-forever") changed.push({ accountId, ids: out.ids });
      done += out.conversations;
      failed += out.failedConversations;
    }
    off();
    dismissToast(progress);
    const what = BULK_TEXT[kind]?.done ?? "changed";
    const text = done === 1 ? `Conversation ${what}.` : `${done.toLocaleString()} conversations ${what}.`;
    const undo = async () => {
      for (const c of changed) await api.modifyMessages(c.accountId, c.ids, rule.remove, rule.add);
    };
    if (failed) {
      const rest = `Couldn't do it for the other ${failed === 1 ? "one" : failed.toLocaleString()}.`;
      toast(`${text} ${rest}`, {
        sticky: true,
        action: { label: "Try again", run: again },
        secondary: kind === "delete-forever" ? undefined : { label: "Undo", run: () => void undo() },
      });
    } else if (kind === "delete-forever") toast(text);
    else withUndo(text, undo);
  } catch (e) {
    off();
    dismissToast(progress);
    toast(failureText(DOING[kind].replace("{c}", "the conversations"), e), { action: { label: "Try again", run: again } });
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
