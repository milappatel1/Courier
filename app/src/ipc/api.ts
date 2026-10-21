// Typed wrappers for the Rust commands and events. The browser preview swaps in dev/tauri-mock.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { base64Decode, base64Encode } from "../core/bytes";
import type {
  Account,
  AppInfo,
  Contact,
  Discovered,
  ImapAccountConfig,
  Label,
  OutboxRow,
  Signature,
  SpellIssue,
  Template,
  ThreadDetail,
  ViewQuery,
  ViewResult,
  Subscription,
  TabNews,
} from "./types";

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);

const bytes = (v: unknown): Uint8Array => {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  if (typeof v === "string") return base64Decode(v);
  return new Uint8Array();
};

/** What the Mac hands Courier: a mailto: link, an .eml file to read, or files to send. */
export type OpenItem = { kind: "mailto" | "eml" | "attach" | "thread"; url?: string; path?: string; paths?: string[]; accountId?: string; threadId?: string };

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  // accounts
  accounts: () => call<Account[]>("accounts_list"),
  googleClientStatus: () => call<{ configured: boolean; clientIdHint: string | null }>("google_client_status"),
  googleClientSet: (a: { jsonText?: string; clientId?: string; clientSecret?: string }) => call<void>("google_client_set", a),
  googleClientClear: () => call<void>("google_client_clear"),
  /** Set when saved sign-ins couldn't be opened from the Keychain this launch. */
  secretsNotice: () => call<string | null>("secrets_notice"),
  addGmail: (loginHint?: string, reauthId?: string) => call<Account>("account_add_gmail", { loginHint: loginHint ?? null, reauthId: reauthId ?? null }),
  discover: (email: string) => call<Discovered[]>("account_discover", { email }),
  testImap: (config: ImapAccountConfig, password: string, smtpPassword?: string) =>
    call<void>("account_test_imap", { config, password, smtpPassword: smtpPassword ?? null }),
  addImap: (a: { email: string; name: string; config: ImapAccountConfig; password: string; smtpPassword?: string; reauthId?: string }) =>
    call<Account>("account_add_imap", { ...a, smtpPassword: a.smtpPassword ?? null, reauthId: a.reauthId ?? null }),
  updateAccount: (id: string, patch: { name?: string; color?: string; position?: number }) => call<Account>("account_update", { id, ...patch }),
  removeAccount: (id: string) => call<void>("account_remove", { id }),
  // labels
  labels: (accountId: string) => call<Label[]>("labels_list", { accountId }),
  tabNews: (accountId: string) => call<TabNews[]>("tab_news", { accountId }),
  tabSeen: (accountId: string, tab: string) => call<void>("tab_seen", { accountId, tab }),
  labelCreate: (accountId: string, name: string, bg?: string | null, fg?: string | null) =>
    call<string>("label_create", { accountId, name, bg: bg ?? null, fg: fg ?? null }),
  labelUpdate: (accountId: string, id: string, patch: Record<string, unknown>) => call<void>("label_update", { accountId, id, patch }),
  labelDelete: (accountId: string, id: string) => call<void>("label_delete", { accountId, id }),
  // listing & reading
  list: (view: ViewQuery) => call<ViewResult>("list_threads", { view }),
  thread: (accountId: string, threadId: string) => call<ThreadDetail>("thread_get", { accountId, threadId }),
  raw: async (accountId: string, messageId: string) => bytes(await call<unknown>("message_raw", { accountId, messageId })),
  // actions
  modifyThreads: (accountId: string, threadIds: string[], add: string[], remove: string[]) =>
    call<Changed>("modify_threads", { accountId, threadIds, add, remove }),
  modifyMessages: (accountId: string, messageIds: string[], add: string[], remove: string[]) =>
    call<Changed>("modify_messages", { accountId, messageIds, add, remove }),
  deleteForever: (accountId: string, threadIds: string[]) => call<void>("delete_forever", { accountId, threadIds }),
  subscriptions: (accountId: string) => call<Subscription[]>("subscriptions", { accountId }),
  markUnsubscribed: (accountId: string, email: string) => call<void>("mark_unsubscribed", { accountId, email }),
  bulkModify: (view: ViewQuery, add: string[], remove: string[], keep: string[]) => call<BulkOutcome>("bulk_modify", { view, add, remove, keep }),
  bulkDeleteForever: (view: ViewQuery, keep: string[]) => call<BulkOutcome>("bulk_delete_forever", { view, keep }),
  emptyLabel: (accountId: string, label: string) => call<number>("empty_label", { accountId, label }),
  snooze: (accountId: string, threadIds: string[], until: number) => call<void>("snooze_threads", { accountId, threadIds, until }),
  unsnooze: (accountId: string, threadIds: string[]) => call<void>("unsnooze_threads", { accountId, threadIds }),
  mute: (accountId: string, threadIds: string[], on: boolean) => call<void>("mute_threads", { accountId, threadIds, on }),
  star: (accountId: string, messageId: string, starType: string | null) => call<Changed>("star_message", { accountId, messageId, starType }),
  block: (accountId: string, email: string) => call<void>("block_sender", { accountId, email }),
  unblock: (accountId: string, email: string) => call<void>("unblock_sender", { accountId, email }),
  blocked: (accountId: string) => call<string[]>("blocked_list", { accountId }),
  // compose
  send: (
    accountId: string,
    raw: Uint8Array,
    opts: { sendAt?: number | null; scheduled?: boolean; threadId?: string | null; draftId?: string | null; undoMs?: number },
  ) => call<number>("send_message", { accountId, raw: base64Encode(raw), opts }),
  outboxCancel: async (id: number) => {
    const r = await call<{ accountId: string; raw: string; threadId: string | null; draftId: string | null } | null>("outbox_cancel", { id });
    return r ? { ...r, raw: base64Decode(r.raw) } : null;
  },
  outbox: () => call<OutboxRow[]>("outbox_list"),
  outboxSendNow: (id: number) => call<void>("outbox_send_now", { id }),
  outboxRaw: async (id: number) => base64Decode(await call<string>("outbox_raw", { id })),
  draftSave: (accountId: string, draftId: string | null, raw: Uint8Array, threadId: string | null) =>
    call<string>("draft_save", { accountId, draftId, raw: base64Encode(raw), threadId }),
  draftDelete: (accountId: string, draftId: string) => call<void>("draft_delete", { accountId, draftId }),
  contacts: (query: string, accountId?: string | null, limit = 8) => call<Contact[]>("contacts_search", { accountId: accountId ?? null, query, limit }),
  templates: () => call<Template[]>("templates_list"),
  templateSave: (t: { id?: string | null; accountId?: string | null; name: string; subject: string; html: string }) =>
    call<string>("template_save", { id: t.id ?? null, accountId: t.accountId ?? null, name: t.name, subject: t.subject, html: t.html }),
  templateDelete: (id: string) => call<void>("template_delete", { id }),
  signatures: (accountId: string) => call<Signature[]>("signatures_list", { accountId }),
  signatureSave: (s: { id?: string | null; accountId: string; name: string; html: string }) =>
    call<string>("signature_save", { id: s.id ?? null, accountId: s.accountId, name: s.name, html: s.html }),
  signatureDelete: (id: string) => call<void>("signature_delete", { id }),
  signatureDefaults: (accountId: string, address: string, newMail: string | null, replies: string | null) =>
    call<void>("signature_defaults_set", { accountId, address, newMail, replies }),
  // settings
  settings: () => call<Record<string, unknown>>("settings_all"),
  setSetting: (key: string, value: unknown) => call<void>("settings_set", { key, value }),
  filters: (accountId: string) => call<{ id: string; criteria: Record<string, unknown>; action: Record<string, unknown> }[]>("filters_list", { accountId }),
  filterCreate: (accountId: string, criteria: Record<string, unknown>, action: Record<string, unknown>, applyExisting = false) =>
    call<unknown>("filter_create", { accountId, criteria, action, applyExisting }),
  filterDelete: (accountId: string, id: string) => call<void>("filter_delete", { accountId, id }),
  serverSettings: <T = Record<string, unknown>>(accountId: string, which: string) => call<T>("server_settings_get", { accountId, which }),
  setServerSettings: (accountId: string, which: string, value: unknown) => call<unknown>("server_settings_set", { accountId, which, value }),
  sendAs: (accountId: string) => call<Record<string, unknown>[]>("sendas_list", { accountId }),
  sendAsSave: (accountId: string, email: string, patch: Record<string, unknown>, create = false) =>
    call<unknown>("sendas_save", { accountId, email, patch, create }),
  sendAsDelete: (accountId: string, email: string) => call<void>("sendas_delete", { accountId, email }),
  forwarding: (accountId: string) => call<{ forwardingEmail: string; verificationStatus: string }[]>("forwarding_list", { accountId }),
  forwardingAdd: (accountId: string, email: string) => call<unknown>("forwarding_add", { accountId, email }),
  forwardingRemove: (accountId: string, email: string) => call<void>("forwarding_remove", { accountId, email }),
  unsubscribeOneClick: (url: string) => call<void>("unsubscribe_one_click", { url }),
  senderLists: (accountId: string, email: string) =>
    call<{ listId: string; listUnsubscribe: string; listUnsubscribePost: string }[]>("sender_lists", { accountId, email }),
  unsubscribedSenders: (accountId: string) => call<string[]>("unsubscribed_senders", { accountId }),
  syncNow: (accountId?: string | null) => call<void>("sync_now", { accountId: accountId ?? null }),
  // files & Mac
  tempFile: (name: string, data: Uint8Array) => call<string>("temp_file", { name, data: base64Encode(data) }),
  writeFile: (path: string, data: Uint8Array) => call<void>("write_file", { path, data: base64Encode(data) }),
  readFile: async (path: string) => bytes(await call<unknown>("read_file", { path })),
  clipboardText: () => call<string | null>("clipboard_text"),
  saveDownload: (name: string, data: Uint8Array) => call<string>("save_download", { name, data: base64Encode(data) }),
  openFile: (name: string, data: Uint8Array) => call<string>("open_file", { name, data: base64Encode(data) }),
  revealFile: (path: string) => call<void>("reveal_file", { path }),
  openExternal: (url: string) => call<void>("open_external", { url }),
  spellCheck: (texts: string[]) => call<SpellIssue[][]>("spell_check", { texts }),
  share: (paths: string[], text: string | null, x: number, y: number) => call<void>("share", { paths, text, x, y }),
  isDefaultMailApp: () => call<boolean>("default_mail_app"),
  setDefaultMailApp: () => call<void>("set_default_mail_app"),
  badgeRefresh: () => call<void>("badge_refresh"),
  windowOpen: (kind: "compose" | "thread" | "print" | "eml", payload: unknown, title?: string) =>
    call<string>("window_open", { kind, payload, title: title ?? null }),
  windowTake: <T>(id: string) => call<T | null>("window_take", { id }),
  pendingOpens: () => call<OpenItem[]>("pending_opens"),
  printWindow: () => call<void>("print_window"),
  // end-to-end
  e2eInfo: () => call<Record<string, unknown>>("e2e_info"),
  e2eControl: <T = Record<string, unknown>>(action: string, args: Record<string, unknown> = {}) => call<T>("e2e_control", { action, args }),
  e2eLog: (line: string) => call<void>("e2e_log", { line }),
  e2eFinish: (report: string, failed: boolean) => call<void>("e2e_finish", { report, failed }),
};

export type Api = typeof api;

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/** What a whole-view action did: the messages changed (for Undo), conversations changed and not changed. */
/** Where a label change went: to the server, or (offline) made here and waiting to go out when back online. */
export type Changed = "done" | "queued";

export interface BulkOutcome {
  ids: string[];
  conversations: number;
  failedConversations: number;
}

/**
 * Why something failed, as a sentence to show. Errors come back as strings with a prefix ("offline: …",
 * "server: …"); the text after a prefix is the server's or a library's own and goes to the log, never on
 * screen. Unprefixed errors were written for people and are shown as they are.
 */
export function errorText(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const kind = /^(offline|network|server|auth|imap|smtp|not found|json|io|database): /.exec(s)?.[1];
  switch (kind) {
    case undefined:
      return s;
    case "offline":
      return "You're offline.";
    case "auth":
      return "The account needs you to sign in again (Settings ▸ Accounts).";
    case "not found":
      return "It's no longer on the server.";
    case "server":
      return "The mail server didn't accept the request.";
    case "network":
      return "The connection to the mail server broke off.";
    case "imap":
      return "The mail server didn't accept the request.";
    case "smtp":
      return "The outgoing mail server didn't take the message.";
    default:
      return "Courier couldn't read or save its own data.";
  }
}

/** "Couldn't <what>. <why>" for a toast. */
export const failureText = (what: string, e: unknown) => `Couldn't ${what}. ${errorText(e)}`;

export const isOfflineError = (e: unknown) => String(e).startsWith("offline:");
export const isAuthError = (e: unknown) => String(e).startsWith("auth:");
