// App state (zustand): accounts, routing, the thread list, the open conversation, compose windows, toasts
// with Undo, settings, and live updates from the Rust side.
import { create } from "zustand";
import type { Address } from "../core/addresses";
import { api, errorText, on } from "../ipc/api";
import type { Account, AppInfo, Label, ThreadDetail, ThreadSummary, ViewQuery, ViewResult } from "../ipc/types";
import { DEFAULTS, mergeSettings, type Settings } from "./settings";
import { applyTheme } from "./themes";

export interface ListRoute {
  label: string | null; // INBOX, STARRED, SNOOZED, IMPORTANT, SENT, SCHEDULED, OUTBOX, DRAFT, ALL, SPAM, TRASH, user label id, or null for search
  category: string | null; // primary | social | promotions | updates | forums (Inbox tabs)
  query: string | null;
  page: number;
}

export interface ThreadRef {
  accountId: string;
  threadId: string;
}

export interface Route {
  list: ListRoute;
  thread: ThreadRef | null;
  settings: string | null; // tab id
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
  sticky?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  data: Uint8Array;
}

export interface ComposeData {
  id: string;
  accountId: string;
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  showCc: boolean;
  showBcc: boolean;
  subject: string;
  html: string;
  plain: boolean;
  attachments: Attachment[];
  inlineImages: Record<string, Attachment>; // blob URL → image (becomes cid: when sent)
  forwarded: { filename: string; raw: Uint8Array }[];
  reply: { kind: "reply" | "reply-all" | "forward"; threadId: string; inReplyTo: string | null; references: string[]; quotedHtml: string } | null;
  draftId: string | null;
  threadId: string | null;
  minimized: boolean;
  fullscreen: boolean;
  placement: "dock" | "inline";
  savedAt: number | null;
  dirty: boolean;
  signatureId: string | null;
  focus?: "to" | "body" | "subject";
  createdAt: number;
}

type Sync = "syncing" | "idle" | "offline" | "error" | "auth" | "busy";

/** How an account's sync state reads in Settings ▸ Accounts. */
export const SYNC_TEXT: Record<Sync, string> = {
  syncing: "syncing…",
  idle: "up to date",
  offline: "offline",
  error: "couldn't sync",
  auth: "needs signing in again",
  busy: "catching up (Gmail is pacing requests)",
};

interface UI {
  quickSettings: boolean;
  shortcutsHelp: boolean;
  advancedSearch: boolean;
  accountMenu: boolean;
  addAccount: null | { kind?: "gmail" | "imap"; reauth?: Account };
  labelDialog: null | { accountId: string; edit?: Label; parent?: string; applyTo?: string[] };
  themePicker: boolean;
  showOriginal: null | { accountId: string; messageId: string };
  snoozePicker: null | { accountId: string; threadIds: string[] };
  confirm: null | { title: string; body: string; ok: string; run: () => void };
  /** A one-line question (the web view has no window.prompt). */
  ask: null | { title: string; label: string; value?: string; ok: string; options?: string[]; run: (value: string) => void };
  searchFocus: number;
}

export interface MailState {
  ready: boolean;
  info: AppInfo | null;
  accounts: Account[];
  accountId: string; // active account id or "all"
  labels: Record<string, Label[]>;
  settings: Settings;
  route: Route;
  list: { key: string; result: ViewResult | null; loading: boolean; error: string | null; tokens: (string | null)[] };
  selected: string[];
  selectAllMatching: boolean;
  cursor: number;
  thread: { detail: ThreadDetail | null; loading: boolean; error: string | null };
  composes: ComposeData[];
  toasts: Toast[];
  undo: { text: string; run: () => Promise<void> } | null;
  ui: UI;
  online: boolean;
  sync: Record<string, Sync>;
  /** The last sync error per account (server text, shown in Settings ▸ Accounts). */
  syncError: Record<string, string>;
  hiddenThreads: string[]; // optimistic removals from the current list
}

export const SYSTEM_ROUTE_NAMES: Record<string, string> = {
  INBOX: "inbox",
  STARRED: "starred",
  SNOOZED: "snoozed",
  IMPORTANT: "imp",
  SENT: "sent",
  SCHEDULED: "scheduled",
  OUTBOX: "outbox",
  DRAFT: "drafts",
  ALL: "all",
  SPAM: "spam",
  TRASH: "trash",
};
const ROUTE_TO_LABEL = Object.fromEntries(Object.entries(SYSTEM_ROUTE_NAMES).map(([k, v]) => [v, k]));

const INBOX_ROUTE: ListRoute = { label: "INBOX", category: "primary", query: null, page: 0 };

let toastSeq = 1;
let composeSeq = 1;

/** Stable empty list for selectors (a fresh [] on every read would re-render forever). */
export const NO_LABELS: Label[] = [];

export const useMail = create<MailState>(() => ({
  ready: false,
  info: null,
  accounts: [],
  accountId: "",
  labels: {},
  settings: DEFAULTS,
  route: { list: INBOX_ROUTE, thread: null, settings: null },
  list: { key: "", result: null, loading: false, error: null, tokens: [null] },
  selected: [],
  selectAllMatching: false,
  cursor: 0,
  thread: { detail: null, loading: false, error: null },
  composes: [],
  toasts: [],
  undo: null,
  ui: {
    quickSettings: false,
    shortcutsHelp: false,
    advancedSearch: false,
    accountMenu: false,
    addAccount: null,
    labelDialog: null,
    themePicker: false,
    showOriginal: null,
    snoozePicker: null,
    confirm: null,
    ask: null,
    searchFocus: 0,
  },
  online: true,
  sync: {},
  syncError: {},
  hiddenThreads: [],
}));

const set = useMail.setState;
const get = useMail.getState;

export const ui = (patch: Partial<UI>) => set((s) => ({ ui: { ...s.ui, ...patch } }));

export function activeAccount(): Account | undefined {
  const s = get();
  return s.accounts.find((a) => a.id === s.accountId);
}

export function accountById(id: string): Account | undefined {
  return get().accounts.find((a) => a.id === id);
}

export function labelsFor(accountId: string): Label[] {
  return get().labels[accountId] ?? [];
}

export function labelName(accountId: string, id: string): string {
  const l = labelsFor(accountId).find((x) => x.id === id);
  if (!l) return id;
  return l.type === "system" ? (SYSTEM_DISPLAY[l.id] ?? l.name) : l.name;
}

export const SYSTEM_DISPLAY: Record<string, string> = {
  INBOX: "Inbox",
  STARRED: "Starred",
  SNOOZED: "Snoozed",
  IMPORTANT: "Important",
  SENT: "Sent",
  SCHEDULED: "Scheduled",
  OUTBOX: "Outbox",
  DRAFT: "Drafts",
  ALL: "All Mail",
  SPAM: "Spam",
  TRASH: "Trash",
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
  UNREAD: "Unread",
};

/** Whether the active account shows inbox tabs (mail-API accounts with any category enabled). */
export function hasTabs(): boolean {
  const s = get();
  if (s.accountId === "all") return false;
  const a = activeAccount();
  if (!a || a.kind !== "gmail") return false;
  if (s.settings.inboxType !== "default") return false;
  return Object.values(s.settings.categories).some(Boolean);
}

// ---- routing ----

export function routeToHash(r: Route, accountIndex: string): string {
  if (r.settings) return `#u/${accountIndex}/settings/${r.settings}`;
  const l = r.list;
  let base: string;
  if (l.query) base = `search/${encodeURIComponent(l.query)}`;
  else if (l.label && SYSTEM_ROUTE_NAMES[l.label])
    base = SYSTEM_ROUTE_NAMES[l.label] + (l.label === "INBOX" && l.category && l.category !== "primary" ? `/category/${l.category}` : "");
  else if (l.label) base = `label/${encodeURIComponent(l.label)}`;
  else base = "inbox";
  if (l.page > 0) base += `/p${l.page + 1}`;
  if (r.thread) base += `/${encodeURIComponent(r.thread.threadId)}`;
  return `#u/${accountIndex}/${base}`;
}

export function hashToRoute(hash: string): { account: string | null; route: Route } {
  const parts = hash.replace(/^#/, "").split("/");
  let account: string | null = null;
  if (parts[0] === "u") {
    account = parts[1] ?? null;
    parts.splice(0, 2);
  }
  const route: Route = { list: { ...INBOX_ROUTE }, thread: null, settings: null };
  const head = parts.shift() ?? "inbox";
  if (head === "settings") {
    route.settings = parts[0] ?? "general";
    return { account, route };
  }
  if (head === "search") route.list = { label: null, category: null, query: decodeURIComponent(parts.shift() ?? ""), page: 0 };
  else if (head === "label") route.list = { label: decodeURIComponent(parts.shift() ?? ""), category: null, query: null, page: 0 };
  else if (ROUTE_TO_LABEL[head]) {
    route.list = { label: ROUTE_TO_LABEL[head], category: head === "inbox" ? "primary" : null, query: null, page: 0 };
    if (head === "inbox" && parts[0] === "category") {
      parts.shift();
      route.list.category = parts.shift() ?? "primary";
    }
  }
  if (parts[0] && /^p\d+$/.test(parts[0])) route.list.page = Number(parts.shift()!.slice(1)) - 1;
  if (parts[0]) route.thread = { accountId: "", threadId: decodeURIComponent(parts[0]) };
  return { account, route };
}

function accountIndex(): string {
  const s = get();
  if (s.accountId === "all") return "all";
  const i = s.accounts.findIndex((a) => a.id === s.accountId);
  return String(Math.max(0, i));
}

let applyingHash = false;
function pushHash(replace = false) {
  if (applyingHash) return;
  const h = routeToHash(get().route, accountIndex());
  if (location.hash !== h) {
    if (replace) history.replaceState(null, "", h);
    else history.pushState(null, "", h);
  }
}

window.addEventListener("popstate", () => {
  const { account, route } = hashToRoute(location.hash);
  applyingHash = true;
  try {
    const s = get();
    if (account != null) {
      const id = account === "all" ? "all" : s.accounts[Number(account)]?.id;
      if (id && id !== s.accountId) set({ accountId: id });
    }
    if (route.thread) route.thread.accountId = get().accountId;
    set({ route, selected: [], selectAllMatching: false });
    void loadList();
    if (route.thread) void loadThread(route.thread);
  } finally {
    applyingHash = false;
  }
});

export function go(list: Partial<ListRoute>, opts: { keepThread?: boolean } = {}) {
  const prev = get().route;
  const next: ListRoute = { ...prev.list, page: 0, ...list };
  if (list.label !== undefined && list.query === undefined) next.query = null;
  if (list.label !== undefined && list.category === undefined) next.category = list.label === "INBOX" ? (hasTabs() ? "primary" : null) : null;
  set({
    route: { list: next, thread: opts.keepThread ? prev.thread : null, settings: null },
    selected: [],
    selectAllMatching: false,
    cursor: 0,
    hiddenThreads: [],
  });
  set((s) => ({ list: { ...s.list, tokens: [null] } }));
  pushHash();
  void loadList();
}

export function openSettings(tab = "general") {
  set((s) => ({ route: { ...s.route, settings: tab, thread: null }, ui: { ...s.ui, quickSettings: false } }));
  pushHash();
}

export function closeSettings() {
  set((s) => ({ route: { ...s.route, settings: null } }));
  pushHash();
  void loadList();
}

export function search(query: string) {
  const q = query.trim();
  if (!q) return go({ label: "INBOX" });
  go({ label: null, category: null, query: q });
}

export async function setAccount(id: string) {
  if (id === get().accountId) return;
  set({
    accountId: id,
    route: { list: { ...INBOX_ROUTE, category: null }, thread: null, settings: null },
    selected: [],
    hiddenThreads: [],
    thread: { detail: null, loading: false, error: null },
  });
  set((s) => ({ route: { ...s.route, list: { ...s.route.list, category: hasTabs() ? "primary" : null } } }));
  pushHash();
  await Promise.all([loadLabels(id), loadList()]);
}

// ---- loading ----

export function currentView(page?: number): ViewQuery {
  const s = get();
  const l = s.route.list;
  return {
    accountId: s.accountId,
    label: l.query ? null : l.label,
    category: l.query ? null : l.label === "INBOX" && hasTabs() ? l.category : null,
    query: l.query,
    page: page ?? l.page,
    pageSize: s.settings.pageSize,
    conversations: s.settings.conversationView,
  };
}

const viewKey = (v: ViewQuery) => JSON.stringify([v.accountId, v.label, v.category, v.query, v.page, v.pageSize, v.conversations]);

let listSeq = 0;
export async function loadList(opts: { quiet?: boolean } = {}) {
  const s = get();
  if (!s.accountId || s.route.settings) return;
  const view = currentView();
  const key = viewKey(view);
  const seq = ++listSeq;
  if (!opts.quiet || s.list.key !== key) set((st) => ({ list: { ...st.list, key, loading: true, error: null } }));
  try {
    // Fast: the cache. Then the server page for mail-API accounts (authoritative when online).
    const cached = await api.list({ ...view, mode: "cache" });
    if (seq !== listSeq) return;
    set((st) => ({ list: { ...st.list, key, result: cached, loading: false }, hiddenThreads: [] }));
    const acct = accountById(view.accountId);
    if (acct?.kind === "gmail" && get().online) {
      const token = view.page === 0 ? null : (get().list.tokens[view.page] ?? undefined);
      if (token === undefined && view.page > 0) return; // no token for a page we skipped to: keep the cache
      const server = await api.list({ ...view, mode: "server", pageToken: token });
      if (seq !== listSeq) return;
      set((st) => {
        const tokens = [...st.list.tokens];
        tokens[view.page + 1] = server.nextPageToken;
        return { list: { ...st.list, key, result: server, loading: false, tokens }, hiddenThreads: [] };
      });
    }
  } catch (e) {
    if (seq !== listSeq) return;
    set((st) => ({ list: { ...st.list, loading: false, error: errorText(e) } }));
  }
}

export async function loadLabels(accountId?: string) {
  const ids = accountId ? [accountId] : get().accounts.map((a) => a.id);
  const out: Record<string, Label[]> = {};
  await Promise.all(ids.map(async (id) => (out[id] = await api.labels(id).catch(() => []))));
  set((s) => ({ labels: { ...s.labels, ...out } }));
}

export async function loadAccounts() {
  const accounts = await api.accounts();
  set({ accounts });
  const s = get();
  if (!accounts.length) {
    set({ accountId: "" });
  } else if (!s.accountId || (s.accountId !== "all" && !accounts.some((a) => a.id === s.accountId))) {
    // The open account went away (signed out): show the first one, with its own list and labels.
    if (s.ready) await setAccount(accounts[0].id);
    else set({ accountId: accounts[0].id });
  }
  return accounts;
}

let threadSeq = 0;
export async function loadThread(ref: ThreadRef) {
  const seq = ++threadSeq;
  set({ thread: { detail: get().thread.detail?.threadId === ref.threadId ? get().thread.detail : null, loading: true, error: null } });
  try {
    const detail = await api.thread(ref.accountId, ref.threadId);
    if (seq !== threadSeq) return;
    set({ thread: { detail, loading: false, error: null } });
    // Opening marks the conversation read (like the web client).
    const unread = detail.messages.filter((m) => m.labels.includes("UNREAD")).map((m) => m.id);
    if (unread.length) {
      await api.modifyMessages(ref.accountId, unread, [], ["UNREAD"]).catch(() => {});
      if (seq === threadSeq)
        set((s) => ({
          thread: {
            ...s.thread,
            detail: s.thread.detail && {
              ...s.thread.detail,
              messages: s.thread.detail.messages.map((m) => ({ ...m, labels: m.labels.filter((l) => l !== "UNREAD") })),
            },
          },
        }));
    }
  } catch (e) {
    if (seq !== threadSeq) return;
    set({ thread: { detail: null, loading: false, error: errorText(e) } });
  }
}

export function openThread(t: ThreadSummary) {
  if (t.outboxId != null) {
    void openOutboxItem(t.outboxId);
    return;
  }
  if (t.labels.includes("DRAFT") && t.messageCount === 1 && t.draftIds.length) {
    void openDraft(t.accountId, t.draftIds[0], t.threadId);
    return;
  }
  const ref = { accountId: t.accountId, threadId: t.threadId };
  set((s) => ({
    route: { ...s.route, thread: ref },
    cursor: Math.max(
      0,
      (s.list.result?.threads ?? []).findIndex((x) => x.threadId === t.threadId),
    ),
  }));
  pushHash();
  void loadThread(ref);
}

export function closeThread() {
  set((s) => ({ route: { ...s.route, thread: null }, thread: { detail: null, loading: false, error: null } }));
  pushHash();
  void loadList({ quiet: true });
}

/** Next/previous conversation from the open one (auto-advance and j/k). */
export function stepThread(dir: 1 | -1): boolean {
  const s = get();
  const list = visibleThreads();
  const cur = s.route.thread ? list.findIndex((t) => t.threadId === s.route.thread!.threadId) : s.cursor;
  const next = list[cur + dir];
  if (!next) return false;
  openThread(next);
  return true;
}

export function visibleThreads(): ThreadSummary[] {
  const s = get();
  return (s.list.result?.threads ?? []).filter((t) => !s.hiddenThreads.includes(t.threadId));
}

// ---- toasts & undo ----

export function toast(text: string, opts: { action?: Toast["action"]; secondary?: Toast["secondary"]; sticky?: boolean; ms?: number } = {}): number {
  const id = toastSeq++;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, action: opts.action, secondary: opts.secondary, sticky: opts.sticky }] }));
  if (!opts.sticky) setTimeout(() => dismissToast(id), opts.ms ?? 7000);
  return id;
}

export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function replaceToast(id: number, text: string, opts: { action?: Toast["action"]; secondary?: Toast["secondary"]; ms?: number } = {}) {
  set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, text, action: opts.action, secondary: opts.secondary, sticky: false } : t)) }));
  setTimeout(() => dismissToast(id), opts.ms ?? 7000);
}

export async function runUndo() {
  const u = get().undo;
  if (!u) return;
  set({ undo: null });
  const id = toast("Undoing…", { sticky: true });
  try {
    await u.run();
    replaceToast(id, "Action undone.");
  } catch (e) {
    replaceToast(id, `Couldn't undo: ${errorText(e)}`);
  }
  void loadList({ quiet: true });
}

function withUndo(text: string, undo: () => Promise<void>) {
  set({ undo: { text, run: undo } });
  toast(text, { action: { label: "Undo", run: () => void runUndo() } });
}

// ---- settings ----

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  set((s) => ({ settings: { ...s.settings, [key]: value } }));
  if (key === "theme" || key === "customImage") applyTheme(get().settings.theme, get().settings.customImage);
  if (key === "density") document.documentElement.dataset.density = String(value);
  await api.setSetting(key, value).catch(() => {});
  if (key === "conversationView" || key === "pageSize" || key === "inboxType" || key === "categories") void loadList();
}

// ---- init & events ----

export async function init() {
  const [info, stored] = await Promise.all([api.appInfo(), api.settings()]);
  const settings = mergeSettings(stored);
  applyTheme(settings.theme, settings.customImage);
  document.documentElement.dataset.density = settings.density;
  set({ info, settings, online: info.online });
  const accounts = await loadAccounts();
  // If macOS refused Courier its saved sign-ins, say so once (the accounts then ask to sign in again).
  void api
    .secretsNotice()
    .then((n) => n && toast(n, { sticky: true }))
    .catch(() => {});
  const { account, route } = hashToRoute(location.hash || "#inbox");
  if (account != null) {
    const id = account === "all" ? "all" : accounts[Number(account)]?.id;
    if (id) set({ accountId: id });
  }
  if (route.thread) route.thread.accountId = get().accountId;
  set({ route });
  if (route.list.label === "INBOX" && !route.list.query)
    set((s) => ({ route: { ...s.route, list: { ...s.route.list, category: hasTabs() ? (route.list.category ?? "primary") : null } } }));
  pushHash(true);
  await loadLabels();
  set({ ready: true });
  await loadList();
  if (route.thread) void loadThread(route.thread);

  let refreshTimer: number | null = null;
  const refreshSoon = (accountId?: string) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      const s = get();
      if (!accountId || accountId === s.accountId || s.accountId === "all") void loadList({ quiet: true });
      void loadLabels(accountId);
      const t = s.route.thread;
      if (t && (!accountId || t.accountId === accountId) && !get().thread.loading)
        void api
          .thread(t.accountId, t.threadId)
          .then((detail) => set({ thread: { detail, loading: false, error: null } }))
          .catch(() => {});
    }, 250);
  };
  void on<{ accountId: string }>("mail-changed", (p) => refreshSoon(p.accountId));
  void on<{ accountId: string; state: Sync; error?: string }>("sync-status", (p) =>
    set((s) => ({
      sync: { ...s.sync, [p.accountId]: p.state },
      // Keep the error through the next "syncing" so it stays readable; clear it once a sync succeeds.
      syncError: p.error ? { ...s.syncError, [p.accountId]: p.error } : p.state === "idle" ? { ...s.syncError, [p.accountId]: "" } : s.syncError,
    })),
  );
  void on<{ online: boolean }>("online", (p) => set({ online: p.online }));
  void on("accounts-changed", () => void loadAccounts().then(() => loadLabels()));
  void on<{ accountId: string; outboxId: number; scheduled: boolean }>("message-sent", (p) => onMessageSent(p));
  void on("outbox-changed", () => refreshSoon());
}

const sentHandlers = new Map<number, () => void>();
export function onSent(outboxId: number, f: () => void) {
  sentHandlers.set(outboxId, f);
}
function onMessageSent(p: { accountId: string; outboxId: number; scheduled: boolean }) {
  const f = sentHandlers.get(p.outboxId);
  if (f) {
    sentHandlers.delete(p.outboxId);
    f();
  }
}

// ---- outbox / drafts opening (implemented in compose.ts, registered to avoid an import cycle) ----

let openOutboxItemImpl: (id: number) => Promise<void> = async () => {};
let openDraftImpl: (accountId: string, draftId: string, threadId: string) => Promise<void> = async () => {};
export const registerComposeOpeners = (a: typeof openOutboxItemImpl, b: typeof openDraftImpl) => {
  openOutboxItemImpl = a;
  openDraftImpl = b;
};
export const openOutboxItem = (id: number) => openOutboxItemImpl(id);
export const openDraft = (accountId: string, draftId: string, threadId: string) => openDraftImpl(accountId, draftId, threadId);

// ---- compose windows ----

export function newComposeId() {
  return `c${composeSeq++}`;
}

export function addCompose(c: ComposeData) {
  set((s) => {
    // Inline replies are one per conversation; dock windows stack (max 3 expanded, older ones minimise).
    let list = s.composes;
    if (c.placement === "inline") list = list.filter((x) => !(x.placement === "inline" && x.reply?.threadId === c.reply?.threadId));
    const docked = list.filter((x) => x.placement === "dock" && !x.minimized);
    if (c.placement === "dock" && docked.length >= 3) {
      const oldest = docked[0].id;
      list = list.map((x) => (x.id === oldest ? { ...x, minimized: true } : x));
    }
    return { composes: [...list, c] };
  });
}

export function updateCompose(id: string, patch: Partial<ComposeData>) {
  set((s) => ({ composes: s.composes.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

export function removeCompose(id: string) {
  set((s) => ({ composes: s.composes.filter((c) => c.id !== id) }));
}

export const getState = get;
export const setState = set;
export { withUndo };
