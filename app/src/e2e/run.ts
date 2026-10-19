// End-to-end runner. Only debug builds started with COURIER_E2E=<report.json> load it (scripts/e2e.sh does
// that): the Rust side then runs the local fake Gmail API, IMAP and SMTP servers (src-tauri/src/testsupport),
// seeds two mailboxes and keeps every real account out of reach. The runner drives the real UI in a window
// that never takes focus, one step at a time with its own timeout, logs progress to the terminal, writes a JSON
// report and quits. The browser preview can also run it (?e2e=1) against dev/tauri-mock.ts.
import { emit } from "@tauri-apps/api/event";
import { parseMessage } from "../core/mime/parse";
import { htmlToText } from "../core/text";
import { api } from "../ipc/api";
import { getState } from "../state/store";

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** Courier was the frontmost app at some point during the step (must never happen). */
  tookFocus?: boolean;
  /** What the UI showed when a step failed. */
  snapshot?: Record<string, unknown>;
}

interface ServerState {
  appActive: boolean;
  activations: number;
  gmailSent: { subject: string; to: { name: string; email: string }[]; raw: string; threadId: string }[];
  gmailDrafts: number;
  filters: { criteria?: Record<string, unknown>; action?: { addLabelIds?: string[]; removeLabelIds?: string[] } }[];
  unsubscribed: string[];
  gmailMessages: { id: string; threadId: string; labels: string[]; subject: string }[];
  smtpSent: { from: string; rcpts: string[]; raw: string }[];
  imapFolders: Record<string, number>;
  notifications: { title: string; body: string; accountId: string; threadId: string }[];
  opened: string[];
}

const STEP_TIMEOUT = 45_000;
const steps: { name: string; run: () => Promise<void>; timeout?: number }[] = [];
const step = (name: string, run: () => Promise<void>, timeout?: number) => steps.push({ name, run, timeout });

// ---- helpers ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => {
  console.info(`[e2e] ${line}`);
  void api.e2eLog(line).catch(() => {});
};

/** Polls until `fn` returns something truthy (or a promise of it). */
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ""}`);
    await sleep(120);
  }
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Action trace in the app log ("[e2e:trace]", not shown in the summary) to place anything unexpected, like an activation. */
const trace = (what: string, e?: Element) => {
  const id = e ? ((e as HTMLElement).dataset?.testid ?? `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`.slice(0, 40)) : "";
  void api.e2eLog(`:trace ${new Date().toISOString().slice(11, 23)} ${what} ${id}`).catch(() => {});
};

const q = <E extends Element = HTMLElement>(id: string, root: ParentNode = document) => root.querySelector<E>(`[data-testid="${id}"]`);
const qa = <E extends Element = HTMLElement>(id: string, root: ParentNode = document) => [...root.querySelectorAll<E>(`[data-testid="${id}"]`)];
const el = (id: string, root?: ParentNode, ms?: number) => until(`[${id}]`, () => q(id, root), ms);

function click(e: Element) {
  trace("click", e);
  e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  (e as HTMLElement).click();
}

/** Types into a React-controlled input the way a user would (value setter, then an input event). */
function type(input: Element, text: string) {
  const i = input as HTMLInputElement;
  trace("type", i);
  i.focus();
  const proto = i instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(i, text);
  i.dispatchEvent(new Event("input", { bubbles: true }));
}

function choose(select: Element, value: string) {
  const s = select as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, value);
  s.dispatchEvent(new Event("change", { bubbles: true }));
}

function key(target: Element, k: string, mods: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
}

function setHtml(editor: Element, html: string) {
  trace("set html", editor);
  (editor as HTMLElement).focus();
  editor.innerHTML = html;
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

/** Types above what the editor already holds (a forward's quoted message), as a user would. */
function prependHtml(editor: Element, html: string) {
  setHtml(editor, html + editor.innerHTML);
}

function setFiles(input: Element, files: File[]) {
  trace("set files", input);
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  (input as HTMLInputElement).files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const rows = () => qa("thread-row");
const row = (subject: string) => rows().find((r) => r.textContent?.includes(subject));
const toastWith = (re: RegExp) => qa("toast").find((t) => re.test(t.textContent ?? ""));
/** A menu item by its label (the label's own span, so icons and submenu arrows don't get in the way). */
const menuItem = (label: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>(".menu .menu-item")].find((b) =>
    [...b.querySelectorAll(":scope > span:not(.ic)")].some((sp) =>
      typeof label === "string" ? sp.textContent?.trim() === label : label.test(sp.textContent ?? ""),
    ),
  );
let activeSeen = false;
let activations = 0;
const server = async () => {
  const s = await api.e2eControl<ServerState>("state");
  if (s.appActive || s.activations > activations) activeSeen = true;
  activations = s.activations;
  return s;
};
/** A sent message's text with quoted-printable soft line breaks joined and `=3D` decoded, for simple checks. */
const flat = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
const sentWith = async (subject: string) => {
  const m = (await server()).gmailSent.find((x) => x.subject === subject);
  return m && { ...m, raw: flat(m.raw) };
};
/** A sent message parsed back with Courier's own MIME parser: body text and parts, whatever the encoding. */
const parsedSent = (raw: string) => {
  const p = parseMessage(new TextEncoder().encode(raw));
  return { p, text: `${p.text ?? ""}\n${htmlToText(p.html ?? "")}`, files: p.attachments.map((a) => a.filename) };
};
const msgsWith = async (subject: string) => (await server()).gmailMessages.filter((m) => m.subject === subject || m.subject === `Re: ${subject}`);

async function openList(label: string) {
  click(await el(`nav-${label}`));
  await until(`${label} list`, () => getState().route.list.label === label && !getState().route.thread && !getState().list.loading);
}

async function backToInbox() {
  if (getState().route.settings) click(await el("settings-close"));
  if (q("conv-back")) click(q("conv-back")!);
  await openList("INBOX");
}

async function newCompose() {
  const before = qa("compose-window").length;
  click(await el("compose"));
  const all = await until("a new compose window", () => (qa("compose-window").length > before ? qa("compose-window") : null));
  return all[0];
}

async function fill(w: Element, to: string, subject: string, html: string) {
  if (to) type(await el("compose-to", w), `${to},`);
  if (subject) type(await el("compose-subject", w), subject);
  if (html) setHtml(await el("compose-body", w), html);
  await sleep(100);
}

async function switchTo(email: string) {
  click(await el("account-button"));
  click(await el(`account-${email}`));
  await until(`${email} active`, () => getState().accounts.find((a) => a.id === getState().accountId)?.email === email && !getState().list.loading);
}

const PDF = new TextEncoder().encode("%PDF-1.4\n% Courier end-to-end test file\n%%EOF\n");
// A 2×2 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPj/n4GBgYGJAQoAAI3OAgV+3JDrAAAAAElFTkSuQmCC"), (c) =>
  c.charCodeAt(0),
);

// ---- the run ----

let info: Record<string, string> = {};

step("starts in end-to-end mode with no accounts", async () => {
  info = (await api.e2eInfo()) as Record<string, string>;
  check(info.gmailEmail && info.imapEmail, "no fake servers");
  await el("welcome");
  check(!(await server()).appActive, "Courier is the frontmost app (it must stay in the background)");
});

step("first run: Google sign-in setup inside the Add Gmail dialog", async () => {
  // With no account yet, Settings can't open, so the dialog itself takes the client (test values for the fake).
  click(await el("welcome-gmail"));
  await el("client-setup");
  check((q<HTMLButtonElement>("gmail-signin")?.disabled ?? false) === true, "sign-in enabled without a client");
  type(await el("add-client-id"), info.clientId);
  type(await el("add-client-secret"), info.clientSecret);
  click(await el("add-client-save"));
  await until("client stored", async () => (await api.googleClientStatus()).configured && !q("client-setup"));
});

step("adds the Gmail account (OAuth with PKCE through the fake server)", async () => {
  click(await until("sign-in enabled", () => (q<HTMLButtonElement>("gmail-signin")?.disabled ? null : q("gmail-signin"))));
  await until("the Gmail account", () => getState().accounts.length === 1, 30_000);
  check(getState().accounts[0].kind === "gmail" && getState().accounts[0].email === info.gmailEmail, "wrong account");
  await until("seeded Gmail inbox", () => row("Lunch on Friday?"), 30_000);
  const opened = (await server()).opened;
  check(
    opened.some((u) => u.includes("code_challenge_method=S256")),
    "authorization URL without PKCE",
  );
});

step("adds the IMAP account (discovery, app password, test login)", async () => {
  click(await el("account-button"));
  click(await el("add-account"));
  click(await el("choose-imap"));
  type(await el("imap-email"), info.imapEmail);
  type(await el("imap-name"), "Pat");
  click(await el("imap-next"));
  type(await el("imap-password"), info.imapPassword);
  click(await el("imap-add"));
  await until("two accounts", () => getState().accounts.length === 2, 30_000);
  await until("seeded IMAP inbox", () => row("Club meeting Thursday"), 30_000);
});

step("switches accounts (avatar menu, ⌘1/⌘2 and All inboxes)", async () => {
  const [g, i] = getState().accounts;
  await emit("menu", { id: "account-1" });
  await until("⌘1 → Gmail", () => getState().accountId === g.id && row("Lunch on Friday?"));
  await emit("menu", { id: "account-2" });
  await until("⌘2 → IMAP", () => getState().accountId === i.id && row("Club meeting Thursday"));
  await switchTo(info.gmailEmail);
  click(await el("account-button"));
  click(await el("all-inboxes"));
  await until("both inboxes together", () => getState().accountId === "all" && row("Club meeting Thursday") && row("Lunch on Friday?"));
  await switchTo(info.gmailEmail);
});

step("reads a conversation (and the server marks it read)", async () => {
  click(await until("lunch row", () => row("Lunch on Friday?")));
  await until("conversation", () => q("conv-subject")?.textContent?.includes("Lunch on Friday?"));
  await until("both messages", () => qa("message").length + qa("message-collapsed").length === 2);
  await until("read on the server", async () => (await msgsWith("Lunch on Friday?")).every((m) => !m.labels.includes("UNREAD")));
});

step("replies inline (threaded, after the undo-send delay)", async () => {
  click(await el("reply"));
  const box = await el("inline-compose");
  setHtml(await el("compose-body", box), "<div>Sounds great, see you there.</div>");
  click(await el("compose-send", box));
  await until("Undo toast", () => toastWith(/sending|sent/i));
  const sent = await until("the reply on the server", () => sentWith("Re: Lunch on Friday?"), 30_000);
  const thread = (await msgsWith("Lunch on Friday?"))[0]?.threadId;
  check(sent.threadId === thread, "reply not in the same thread");
  check(/In-Reply-To: <.+>/i.test(sent.raw) && /References: <.+>/i.test(sent.raw), "missing In-Reply-To/References");
  check(sent.raw.includes("bo@work.example"), "reply not addressed to the last sender");
});

step("forwards with the original attachment", async () => {
  await backToInbox();
  click(await until("planning row", () => row("Quarterly planning notes")));
  await el("conversation");
  click(await el("forward"));
  const box = await el("inline-compose");
  type(await el("compose-to", box), "ana@friends.example,");
  const body = await el("compose-body", box);
  await until("the forwarded message in the editor", () => body.textContent?.includes("Forwarded message"));
  prependHtml(body, "<div>See the attached plan.</div>");
  click(await el("compose-send", box));
  const sent = await until("the forward on the server", () => sentWith("Fwd: Quarterly planning notes"), 30_000);
  const fwd = parsedSent(sent.raw);
  check(fwd.files.includes("quarterly-plan.pdf"), "attachment not forwarded");
  check(fwd.text.includes("Forwarded message") && fwd.text.includes("cara@work.example"), "no forwarded header block");
});

step("archives from the list, then undoes it", async () => {
  await backToInbox();
  const r = await until("lunch row", () => row("Lunch on Friday?"));
  click(await el("hover-archive", r));
  await until("row leaves the inbox", () => !row("Lunch on Friday?"));
  await until("archived on the server", async () => (await msgsWith("Lunch on Friday?")).every((m) => !m.labels.includes("INBOX")));
  click(await el("toast-action", await until("Undo toast", () => toastWith(/archived/i))));
  await until("row is back", () => row("Lunch on Friday?"));
  await until("back in the inbox on the server", async () => (await msgsWith("Lunch on Friday?")).some((m) => m.labels.includes("INBOX")));
});

step("labels (simplified toolbar ▸ More ▸ Label as) and stars", async () => {
  const r = await until("lunch row", () => row("Lunch on Friday?"));
  click(await el("row-checkbox", r));
  await until("selection", () => getState().selected.length === 1);
  click(await el("tb-more"));
  click(await el("more-label"));
  click(await el("label-as-Projects"));
  click(await el("label-apply"));
  await until("Projects label on the server", async () => (await msgsWith("Lunch on Friday?")).some((m) => m.labels.includes("Label_1")));
  await until("chip on the row", () =>
    [...(row("Lunch on Friday?")?.querySelectorAll('[data-testid="row-label"]') ?? [])].some((c) => c.textContent === "Projects"),
  );
  click(await el("select-all")); // clears the selection
  click(await el("row-star", await until("lunch row", () => row("Lunch on Friday?"))));
  await until("starred on the server", async () => (await msgsWith("Lunch on Friday?")).some((m) => m.labels.includes("STARRED")));
});

step("snoozes until tomorrow, finds it under Snoozed, unsnoozes", async () => {
  const r = await until("planning row", () => row("Quarterly planning notes"));
  click(await el("hover-snooze", r));
  const choice = await until("snooze choices", () =>
    [...document.querySelectorAll<HTMLElement>(".snooze-menu .menu-item")].find((b) => b.dataset.testid !== "snooze-pick"),
  );
  click(choice);
  await until("row leaves the inbox", () => !row("Quarterly planning notes"));
  await until("out of the inbox on the server", async () => (await msgsWith("Quarterly planning notes")).every((m) => !m.labels.includes("INBOX")));
  await openList("SNOOZED");
  click(await until("snoozed row", () => row("Quarterly planning notes")));
  click(await el("conv-more"));
  click(await until("Unsnooze", () => menuItem("Unsnooze")));
  await until("back in the inbox on the server", async () => (await msgsWith("Quarterly planning notes")).some((m) => m.labels.includes("INBOX")));
  await backToInbox();
  await until("row is back", () => row("Quarterly planning notes"));
});

step("schedules a send, lists it under Scheduled, sends it from there", async () => {
  const w = await newCompose();
  await fill(w, "ana@friends.example", "Agenda for Monday", "<div>Here is the agenda for Monday.</div>");
  click(await el("send-options", w));
  click(await el("schedule-send"));
  const dlg = await el("schedule-dialog");
  click(await until("a schedule preset", () => [...dlg.querySelectorAll<HTMLElement>(".menu-item")].find((b) => b.dataset.testid !== "schedule-pick")));
  const item = await until("scheduled in the outbox", async () => (await api.outbox()).find((o) => o.scheduled && o.subject === "Agenda for Monday"));
  check(item.sendAt > Date.now() + 60 * 60 * 1000, "scheduled time is not in the future");
  await openList("SCHEDULED");
  await until("scheduled row", () => row("Agenda for Monday"));
  check(!(await sentWith("Agenda for Monday")), "sent before its time");
  await api.outboxSendNow(item.id); // the "Send now" action on a scheduled message
  await until("sent on the server", () => sentWith("Agenda for Monday"), 30_000);
  await until("Scheduled is empty", () => !row("Agenda for Monday"));
  await backToInbox();
});

step("searches with operators, filter chips and advanced search", async () => {
  const input = await el("search-input");
  type(input, "from:cara has:attachment");
  (input as HTMLInputElement).form!.requestSubmit();
  await until("one result", () => getState().route.list.query === "from:cara has:attachment" && rows().length === 1 && row("Quarterly planning notes"));
  click(await el("chip-unread"));
  await until("is:unread added", () => /is:unread/.test(getState().route.list.query ?? "") && rows().length === 0);
  click(await el("chip-unread"));
  await until("is:unread removed", () => !/is:unread/.test(getState().route.list.query ?? "") && rows().length === 1);
  type(input, "label:projects is:starred");
  (input as HTMLInputElement).form!.requestSubmit();
  await until("labelled + starred result", () => rows().length === 1 && row("Lunch on Friday?"));
  click(await el("search-options"));
  type(await el("adv-from"), "bo@work.example");
  click(await el("adv-search"));
  await until("advanced search query", () => /from:\(?bo@work\.example/.test(getState().route.list.query ?? "") && row("Lunch on Friday?"));
  await backToInbox();
});

step("creates a filter from the search options (on the server)", async () => {
  click(await el("search-options"));
  type(await el("adv-from"), "news@deals.example");
  click(await el("adv-create-filter"));
  await el("filter-dialog");
  click(await el("filter-next"));
  click(await el("filter-action-star"));
  click(await el("filter-create"));
  await until("filter on the server", async () =>
    (await server()).filters.find((f) => String(f.criteria?.from ?? "").includes("news@deals.example") && f.action?.addLabelIds?.includes("STARRED")),
  );
  if (q("advanced-search")) key(document.body, "Escape");
});

step("composes with an attachment and an inline image", async () => {
  const w = await newCompose();
  await fill(w, "bo@work.example", "Site photos", "<div>Notes attached, photo below.</div>");
  setFiles(await el("compose-file-input", w), [new File([PDF], "site-notes.pdf", { type: "application/pdf" })]);
  await until("attachment chip", () => q("compose-attachments", w)?.textContent?.includes("site-notes.pdf"));
  setFiles(await el("compose-photo-input", w), [new File([PNG], "site.png", { type: "image/png" })]);
  await until("inline image in the body", () => q("compose-body", w)?.querySelector("img"));
  click(await el("compose-send", w));
  const sent = await until("sent on the server", () => sentWith("Site photos"), 30_000);
  const { p } = parsedSent(sent.raw);
  const img = p.attachments.find((a) => a.mimeType === "image/png");
  check(/multipart\/related/i.test(sent.raw) && img?.contentId, "inline image not sent as a related part");
  check((p.html ?? "").includes(`cid:${img!.contentId}`), "body doesn't point at the inline image");
  check(
    p.attachments.some((a) => a.filename === "site-notes.pdf" && !a.inline),
    "attachment missing",
  );
});

step("signatures: create one, make it the default, new mail uses it", async () => {
  click(await el("settings-gear"));
  click(await el("see-all-settings"));
  click(await el("sig-new"));
  type(await el("sig-name"), "Work");
  setHtml(await el("sig-editor"), "<div>Pat Example · Courier tests</div>");
  click(await el("sig-save"));
  const sel = await until("signature in the defaults", () => {
    const s = q<HTMLSelectElement>("sig-default-new");
    return s && [...s.options].some((o) => o.text === "Work") ? s : null;
  });
  choose(sel, [...sel.options].find((o) => o.text === "Work")!.value);
  await sleep(300);
  click(await el("settings-close"));
  const w = await newCompose();
  await until("signature in the new message", () => q("compose-body", w)?.textContent?.includes("Courier tests"));
  click(await el("compose-discard", w));
  await until("compose closed", () => !qa("compose-window").includes(w));
});

step("settings and themes: density, theme picker, settings page", async () => {
  click(await el("settings-gear"));
  click(await el("qs-density-compact"));
  await until(
    "compact rows",
    () => document.documentElement.dataset.density === "compact" && Math.round(rows()[0]?.getBoundingClientRect().height ?? 0) === 28,
  );
  click(await el("qs-density-default"));
  await until("default rows", () => document.documentElement.dataset.density === "default");
  click(await el("qs-theme-current"));
  await el("theme-picker");
  click(await until("Dark theme tile", () => document.querySelector('[aria-label="Dark theme"]')));
  await until("dark colours", () => document.documentElement.dataset.family === "dark");
  click(await el("theme-save"));
  await until("theme saved", async () => (await api.settings()).theme === "dark");
  click(await el("qs-theme-current"));
  click(await until("Default theme tile", () => document.querySelector('[aria-label="Default theme"]')));
  click(await el("theme-save"));
  await until("default colours", () => document.documentElement.dataset.family === "default");
  click(await el("see-all-settings"));
  choose(await el("page-size"), "25");
  click(await el("settings-save"));
  await until("page size saved", async () => (await api.settings()).pageSize === 25);
  choose(await el("page-size"), "50");
  click(await el("settings-save"));
  await until("page size restored", async () => (await api.settings()).pageSize === 50);
  await backToInbox();
});

step("keyboard: g then l asks for a label and opens it", async () => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  key(document.body, "g");
  key(document.body, "l");
  type(await el("ask-input"), "Projects");
  click(await el("ask-ok"));
  await until("Projects label open", () => getState().route.list.label === "Label_1" && row("Lunch on Friday?"));
  await backToInbox();
});

step("keyboard: c composes, / searches, j/k move, s stars, e archives, z undoes", async () => {
  await backToInbox();
  const blur = () => (document.activeElement as HTMLElement | null)?.blur?.();
  blur();
  const before = qa("compose-window").length;
  key(document.body, "c");
  const w = await until("compose from c", () => (qa("compose-window").length > before ? qa("compose-window")[0] : null));
  click(await el("compose-discard", w));
  await until("compose closed", () => qa("compose-window").length === before);
  blur();
  key(document.body, "/");
  await until("search focused by /", () => document.activeElement === q("search-input"));
  blur();
  const focused = () => document.querySelector<HTMLElement>(".row.focused");
  const start = getState().cursor;
  key(document.body, "j");
  await until("cursor moved down by j", () => getState().cursor === start + 1 && focused() === rows()[start + 1]);
  key(document.body, "j");
  await until("cursor moved down again", () => getState().cursor === start + 2 && focused() === rows()[start + 2]);
  key(document.body, "k");
  await until("cursor moved back up by k", () => getState().cursor === start + 1 && focused() === rows()[start + 1]);
  const subject = focused()!.querySelector(".subj")!.textContent!;
  key(document.body, "s");
  await until("starred by s", async () => (await server()).gmailMessages.some((m) => m.subject.endsWith(subject) && m.labels.includes("STARRED")));
  key(document.body, "s");
  await until("unstarred by s", async () => !(await server()).gmailMessages.some((m) => m.subject.endsWith(subject) && m.labels.includes("STARRED")));
  key(document.body, "e");
  await until("archived by e", () => !rows().some((r) => r.querySelector(".subj")?.textContent === subject));
  key(document.body, "z");
  await until("undone by z", () => rows().some((r) => r.querySelector(".subj")?.textContent === subject));
});

step("reading pane: right of inbox shows the conversation beside the list", async () => {
  click(await el("settings-gear"));
  click(await el("qs-pane-right"));
  click(await el("settings-gear"));
  click(await until("a row", () => row("Lunch on Friday?")));
  await until("list and conversation side by side", () => document.querySelector(".split") && q("thread-list") && q("conversation"));
  const list = q("thread-list")!.getBoundingClientRect();
  const conv = q("conversation")!.getBoundingClientRect();
  check(conv.left >= list.right - 2, "conversation isn't to the right of the list");
  click(await el("settings-gear"));
  click(await el("qs-pane-none"));
  click(await el("settings-gear"));
  await until("back to no split", () => !document.querySelector(".split"));
  await backToInbox();
});

step("inbox type: unread first shows its sections", async () => {
  click(await el("settings-gear"));
  click(await el("qs-inbox-unread"));
  click(await el("settings-gear"));
  await until("Unread and Everything else sections", () => {
    const t = [...document.querySelectorAll(".list-section-title")].map((x) => x.textContent ?? "");
    return t.some((x) => x.includes("Unread")) && t.some((x) => x.includes("Everything else"));
  });
  click(await el("settings-gear"));
  click(await el("qs-inbox-default"));
  click(await el("settings-gear"));
  await until("default inbox again", () => !document.querySelector(".list-section-title") && q("thread-list"));
});

step("templates: save a draft as a template and insert it into a new message", async () => {
  // Off by default, as on the web: Settings ▸ Advanced ▸ Templates ▸ Enable, then Save Changes.
  click(await el("settings-gear"));
  click(await el("see-all-settings"));
  click(await el("settings-tab-advanced"));
  click(await el("templates-on"));
  click(await el("settings-save"));
  await until("templates enabled", async () => (await api.settings()).templates === true);
  click(await el("settings-close"));
  const w = await newCompose();
  await fill(w, "", "Weekly update", "<div>Template body text for the week.</div>");
  click(await el("compose-more", w));
  click(await until("Templates", () => menuItem("Templates")));
  click(await until("Save draft as template", () => menuItem("Save draft as template")));
  click(await until("Save as new template", () => menuItem("Save as new template")));
  const name = await el("ask-input");
  check((name as HTMLInputElement).value === "Weekly update", "template name not prefilled from the subject");
  click(await el("ask-ok"));
  await until("template saved", async () => (await api.templates()).some((t) => t.name === "Weekly update"));
  click(await el("compose-discard", w));
  await until("compose closed", () => !qa("compose-window").includes(w));
  const w2 = await newCompose();
  click(await el("compose-more", w2));
  click(await until("Templates", () => menuItem("Templates")));
  click(await until("the saved template", () => menuItem("Weekly update")));
  await until("template inserted", () => q("compose-body", w2)?.textContent?.includes("Template body text for the week."));
  click(await el("compose-discard", w2));
  await until("compose closed", () => !qa("compose-window").includes(w2));
});

step("plain text mode sends text only", async () => {
  const w = await newCompose();
  await fill(w, "bo@work.example", "Plain and simple", "<div>Just <b>words</b> here.</div>");
  click(await el("compose-more", w));
  click(await until("Plain text mode", () => menuItem("Plain text mode")));
  click(await el("compose-send", w));
  const sent = await until("sent on the server", () => sentWith("Plain and simple"), 30_000);
  const { p } = parsedSent(sent.raw);
  check(!p.html, "an HTML part was sent in plain text mode");
  check((p.text ?? "").includes("Just words here."), "text part missing the body");
});

step("compose: minimise and full screen", async () => {
  const w = await newCompose();
  click(await el("compose-minimize", w));
  await until("minimised", () => q("compose-window")?.closest(".compose")?.classList.contains("min") || w.classList.contains("min"));
  click(await el("compose-minimize", w));
  await until("restored", () => !(w.classList.contains("min") || w.closest(".compose")?.classList.contains("min")));
  click(await el("compose-fullscreen", w));
  await until("full screen", () => w.classList.contains("full") || w.closest(".compose")?.classList.contains("full"));
  click(await el("compose-fullscreen", w));
  await until("out of full screen", () => !(w.classList.contains("full") || w.closest(".compose")?.classList.contains("full")));
  click(await el("compose-discard", w));
  await until("compose closed", () => !qa("compose-window").includes(w));
});

step("real-world mail: encoded names, no subject, long threads, newsletters, accented file names", async () => {
  await backToInbox();
  const frameText = () => q<HTMLIFrameElement>("message-frame")?.srcdoc ?? "";
  // RFC 2047 subject and sender, quoted-printable UTF-8 body.
  const r1 = await until("encoded subject decoded", () => row("Café ☕ meeting — résumé"));
  check(r1.textContent?.includes("José Ñúñez"), "sender name not decoded");
  click(r1);
  await until("decoded body", () => q("conv-subject")?.textContent?.includes("Café ☕ meeting") && frameText().includes("On se voit à 10h au café ?"));
  await backToInbox();
  // No subject.
  click(await until("no-subject row", () => rows().find((r) => r.textContent?.includes("Quiet Person") && r.textContent.includes("(no subject)"))));
  await until("no-subject conversation", () => q("conv-subject")?.textContent?.startsWith("(no subject)"));
  await backToInbox();
  // A 12-message thread folds the older read messages; the fold opens them all.
  click(await until("long thread", () => row("Planning the offsite")));
  await el("conversation");
  const shown = () => qa("message").length + qa("message-collapsed").length;
  const fold = await until("folded older messages", () => document.querySelector<HTMLElement>(".collapsed-group button"));
  check(shown() < 12, "nothing folded in a 12-message thread");
  click(fold);
  await until("all 12 messages after opening the fold", () => shown() === 12);
  await backToInbox();
  // Styled newsletter: scripts, handlers and the tracking pixel never reach the frame; remote images wait.
  click(await until("newsletter", () => row("This week in gardening")));
  await until("newsletter body", () => frameText().includes("Spring planting"));
  const doc = frameText();
  check(!/<script/i.test(doc) && !/onclick/i.test(doc), "script or handler kept");
  check(!doc.includes("px.news.example/open.gif"), "tracking pixel kept");
  check(!/\ssrc="https:\/\/img\.news\.example/.test(doc), "remote image loaded without asking");
  await el("images-banner");
  await backToInbox();
  // RFC 2231 file name.
  click(await until("attachment mail", () => row("Your application")));
  await until("accented file name", () => qa("attachment-card").some((c) => c.textContent?.includes("Résumé 2026.pdf")));
  await backToInbox();
});

step("notifications: new Primary mail notifies, Promotions doesn't", async () => {
  await api.e2eControl("deliver-gmail", {
    from: "Promo Shop <hello@promo.example>",
    subject: "Flash sale today",
    body: "Everything 20% off.",
    labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  });
  await api.e2eControl("deliver-gmail", { from: "Gil Moss <gil@friends.example>", subject: "Dinner tonight?", body: "Are you around at 7?" });
  await until("the new mail in the inbox", () => row("Dinner tonight?"), 30_000);
  const notes = await until("a notification", async () => {
    const n = (await server()).notifications;
    return n.some((x) => `${x.title} ${x.body}`.includes("Dinner tonight?")) ? n : null;
  });
  check(!notes.some((x) => `${x.title} ${x.body}`.includes("Flash sale")), "notified about Promotions mail");
});

step("Promotions tab: remote images held back, tracker stripped, unsubscribe", async () => {
  click(await until("Promotions tab", () => [...document.querySelectorAll<HTMLElement>(".tab")].find((t) => t.textContent?.includes("Promotions"))));
  click(await until("promo row", () => row("48 hours only: 30% off")));
  await el("images-banner");
  const frame = await until("message frame", () => q<HTMLIFrameElement>("message-frame"));
  check(frame.sandbox.contains("allow-same-origin") && !frame.sandbox.contains("allow-scripts"), "message frame may run scripts");
  check(!/\ssrc="https:\/\/cdn\.deals\.example/.test(frame.srcdoc), "remote image loaded before Display images");
  check(!frame.srcdoc.includes("t.deals.example/o.gif"), "tracking pixel kept");
  click(await el("display-images"));
  await until("remote image shown", () => /\ssrc="https:\/\/cdn\.deals\.example\/banner\.png"/.test(q<HTMLIFrameElement>("message-frame")?.srcdoc ?? ""));
  check(!q<HTMLIFrameElement>("message-frame")!.srcdoc.includes("t.deals.example/o.gif"), "tracking pixel came back with images on");
  // The sender offers one-click only over plain HTTP here (the fake), which RFC 8058 doesn't allow, so Courier
  // falls back to the mailto: address in the header. (The one-click POST itself is covered by the Rust tests.)
  click(await el("unsubscribe"));
  click(await el("confirm-ok"));
  const req = await until(
    "unsubscribe request sent",
    async () => (await server()).gmailSent.find((m) => m.to.some((a) => a.email === "unsub@deals.example")),
    30_000,
  );
  check(req.subject === "stop", "unsubscribe mail without the subject from the header");
  check(!(await server()).unsubscribed.length, "one-click used over plain HTTP");
  await backToInbox();
  click(await until("Primary tab", () => [...document.querySelectorAll<HTMLElement>(".tab")].find((t) => t.textContent?.includes("Primary"))));
});

step(
  "offline: a send waits in the Outbox, then goes out when back online",
  async () => {
    await api.e2eControl("offline", { on: true });
    const w = await newCompose();
    await fill(w, "ana@friends.example", "Sent while offline", "<div>Queued until the connection is back.</div>");
    click(await el("compose-send", w));
    await until("queued after a failed try", async () => (await api.outbox()).find((o) => o.subject === "Sent while offline" && o.attempts > 0), 40_000);
    await until("offline shown", () => getState().online === false);
    await until("Outbox in the nav", () => q("nav-OUTBOX"));
    check(!(await sentWith("Sent while offline")), "sent while offline");
    await api.e2eControl("offline", { on: false });
    await api.e2eControl("sync");
    await until("sent once back online", () => sentWith("Sent while offline"), 40_000);
    await until("online again", () => getState().online === true);
  },
  90_000,
);

step("IMAP: reply goes out over SMTP and is saved to Sent", async () => {
  const before = (await server()).imapFolders.Sent ?? 0;
  await switchTo(info.imapEmail);
  click(await until("club row", () => row("Club meeting Thursday")));
  await el("conversation");
  click(await el("reply"));
  const box = await el("inline-compose");
  setHtml(await el("compose-body", box), "<div>Thursday works.</div>");
  click(await el("compose-send", box));
  const sent = await until("SMTP delivery", async () => (await server()).smtpSent.find((m) => flat(m.raw).includes("Re: Club meeting Thursday")), 30_000);
  check(sent.rcpts.includes("eli@club.example"), "wrong SMTP recipients");
  check(!/^Bcc:/im.test(sent.raw), "Bcc header sent over SMTP");
  await until("copy in Sent", async () => ((await server()).imapFolders.Sent ?? 0) > before);
});

step("IMAP: delete moves the message to Trash", async () => {
  if (q("conv-back")) click(q("conv-back")!);
  await openList("INBOX");
  const before = (await server()).imapFolders.Trash ?? 0;
  click(await el("hover-delete", await until("tickets row", () => row("Train tickets"))));
  await until("moved to Trash", async () => ((await server()).imapFolders.Trash ?? 0) > before);
});

step("signs out of the IMAP account (removes it and its cache)", async () => {
  click(await el("account-button"));
  click(await el("sign-out"));
  click(await el("confirm-ok"));
  await until("one account left", () => getState().accounts.length === 1 && getState().accounts[0].email === info.gmailEmail);
  await until("Gmail inbox", () => row("Dinner tonight?"));
});

// ---- runner ----

/** Uncaught errors and unhandled promise rejections anywhere in the app during the run (each one fails it). */
const appErrors: string[] = [];

let started = false;
export async function runE2E() {
  if (started) return;
  started = true;
  window.addEventListener("error", (e) => appErrors.push(`${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string } | string | undefined;
    appErrors.push(`unhandled rejection: ${typeof r === "string" ? r : (r?.message ?? JSON.stringify(r))}`);
  });
  const t0 = Date.now();
  const results: StepResult[] = [];
  log(`starting ${steps.length} steps`);
  for (const [n, s] of steps.entries()) {
    const t = Date.now();
    log(`(${n + 1}/${steps.length}) ${s.name}`);
    let error: string | undefined;
    try {
      await Promise.race([
        s.run(),
        sleep(s.timeout ?? STEP_TIMEOUT).then(() => Promise.reject(new Error(`step timed out after ${(s.timeout ?? STEP_TIMEOUT) / 1000}s`))),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await server().catch(() => {});
    const r: StepResult = { name: s.name, ok: !error, ms: Date.now() - t, error, tookFocus: activeSeen || undefined };
    activeSeen = false;
    if (error) {
      const st = getState();
      r.snapshot = {
        account: st.accounts.find((a) => a.id === st.accountId)?.email ?? st.accountId,
        route: st.route,
        rows: rows()
          .slice(0, 8)
          .map((x) => x.textContent?.slice(0, 80)),
        toasts: qa("toast").map((x) => x.textContent),
        dialogs: [...document.querySelectorAll(".dialog h2, [role=dialog] h2")].map((x) => x.textContent),
      };
    }
    results.push(r);
    log(`${r.ok ? "  ok" : "  FAILED"} (${r.ms} ms)${error ? `: ${error}` : ""}`);
    if (!r.ok) {
      // Leave the UI in a known state for the next step: menus and dialogs closed, back on the Inbox list.
      key(document.body, "Escape");
      await sleep(200);
      if (q("conv-back")) click(q("conv-back")!);
      if (q("settings-close")) click(q("settings-close")!);
      await openList("INBOX").catch(() => {});
    }
  }
  // The app itself must not have thrown anywhere along the way.
  results.push({
    name: "no uncaught errors or unhandled rejections in the app",
    ok: appErrors.length === 0,
    ms: 0,
    error: appErrors.length ? appErrors.slice(0, 10).join(" | ") : undefined,
  });
  log(
    `${appErrors.length ? "  FAILED" : "  ok"} no uncaught errors or unhandled rejections${appErrors.length ? `: ${appErrors.slice(0, 5).join(" | ")}` : ""}`,
  );
  const failed = results.filter((r) => !r.ok).length;
  const report = {
    app: getState().info?.version ?? "dev",
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    passed: results.length - failed,
    failed,
    focusTaken: results.some((r) => r.tookFocus),
    steps: results,
  };
  log(`done: ${report.passed} passed, ${failed} failed in ${Math.round(report.durationMs / 1000)} s`);
  await api.e2eFinish(JSON.stringify(report, null, 2), failed > 0 || report.focusTaken);
}
