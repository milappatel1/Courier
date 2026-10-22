// End-to-end runner. Only debug builds started with COURIER_E2E=<report.json> load it (scripts/e2e.sh does
// that): the Rust side then runs the local fake Gmail API, IMAP and SMTP servers (src-tauri/src/testsupport),
// seeds two mailboxes and keeps every real account out of reach. The runner drives the real UI in a window
// that never takes focus, one step at a time with its own timeout, logs progress to the terminal, writes a JSON
// report and quits. The browser preview can also run it (?e2e=1) against dev/tauri-mock.ts.
import { emit } from "@tauri-apps/api/event";
import { parseMessage } from "../core/mime/parse";
import { htmlToText } from "../core/text";
import { api } from "../ipc/api";
import { applyViewportSize, getState, loadLabels, setSetting, setState, visibleThreads } from "../state/store";
import { flashes, recordFrames } from "./frames";
import { layoutIssues } from "./layout";

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
  unsubscribeRequests: { method: string; path: string; body: string; contentType: string; cookie: boolean }[];
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
  // Trash, Spam and the rest wait under More until it's opened.
  if (!q(`nav-${label}`) && label !== "INBOX" && q("nav-more")) click(q("nav-more")!);
  // At phone width the menu lists the inbox tabs in place of Inbox.
  click(await until(`nav ${label}`, () => q(`nav-${label}`) ?? (label === "INBOX" ? q("nav-tab-primary") : null)));
  await until(`${label} list`, () => getState().route.list.label === label && !getState().route.thread && !getState().list.loading);
}

/** Click a menu item, opening More first when it waits under there. */
async function openNav(id: string) {
  if (!q(`nav-${id}`) && q("nav-more")) click(q("nav-more")!);
  click(await el(`nav-${id}`));
}

/** Whether a menu item sits above More (in the label list) rather than under it. */
const aboveMore = (id: string) => {
  const item = q(`nav-${id}`);
  const more = q("nav-more");
  return !!item && !!more && !!(item.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING);
};

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
  // A wrong password gets a sentence about the password, not the server's reply.
  type(await el("imap-password"), "not-the-password");
  click(await el("imap-add"));
  const wrong = await until("the error", () => document.querySelector<HTMLElement>(".error-box"), 20_000);
  check(
    /didn't accept that email address and password/.test(wrong.textContent ?? "") && !RAW_ERROR.test(wrong.textContent ?? ""),
    `said: ${wrong.textContent}`,
  );
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

step(
  "deleting never flashes: hover, toolbar, open conversation and #, in the Inbox and a label, Gmail and IMAP",
  async () => {
    // Real servers take a while to make a change; the list must not show the old state meanwhile.
    await api.e2eControl("gmail-behaviour", { latency: { batchModify: 700, modify: 700, "threads.list": 150, labels: 60 }, imapMoveLatency: 300 });
    const issues: string[] = [];
    try {
      for (const acct of ["gmail", "imap"] as const) {
        await switchTo(acct === "gmail" ? info.gmailEmail : info.imapEmail);
        for (let i = 1; i <= 4; i++) {
          const from = "Flash Test <flash@test.example>";
          if (acct === "gmail") {
            await api.e2eControl("deliver-gmail", { from, subject: `Flash ${acct} inbox ${i}`, body: "One." });
            await api.e2eControl("deliver-gmail", { from, subject: `Flash ${acct} label ${i}`, body: "Two.", labels: ["Label_1"] });
          } else {
            await api.e2eControl("deliver-imap", { from, subject: `Flash ${acct} inbox ${i}`, body: "One." });
            await api.e2eControl("deliver-imap", { from, subject: `Flash ${acct} label ${i}`, body: "Two.", folder: "Work" });
          }
        }
        await api.e2eControl("sync");
        for (const where of ["inbox", "label"] as const) {
          if (where === "inbox") await openList("INBOX");
          else {
            click(await el(acct === "gmail" ? "nav-label-Projects" : "nav-label-Work", undefined, 30_000));
            await until("the label's list", () => !getState().route.list.label?.startsWith("INBOX") && !getState().list.loading);
          }
          await until(`the ${where} test rows`, () => [1, 2, 3, 4].every((i) => row(`Flash ${acct} ${where} ${i}`)), 30_000);
          const hows = ["hover", "toolbar", "conversation", "shortcut"] as const;
          for (const [n, how] of hows.entries()) {
            const subject = `Flash ${acct} ${where} ${n + 1}`;
            const trashBefore = (await server()).imapFolders.Trash ?? 0;
            let r = await until(subject, () => row(subject));
            const id = r.dataset.thread!;
            if (how === "conversation") {
              click(r);
              await until("the conversation", () => q("conv-subject")?.textContent?.includes(subject));
            }
            await sleep(400);
            r = row(subject) ?? r;
            const rec = recordFrames();
            if (how === "hover") click(await el("hover-delete", r));
            else if (how === "toolbar") {
              click(await el("row-checkbox", r));
              await until("selected", () => getState().selected.length === 1);
              click(await el("tb-delete"));
            } else if (how === "conversation") click(await el("conv-delete"));
            else {
              (document.activeElement as HTMLElement | null)?.blur?.();
              setState({ cursor: visibleThreads().findIndex((t) => t.threadId === id) });
              key(document.body, "#");
            }
            await until(
              "in Trash on the server",
              async () =>
                acct === "gmail"
                  ? (await msgsWith(subject)).every((m) => m.labels.includes("TRASH")) || null
                  : ((await server()).imapFolders.Trash ?? 0) > trashBefore || null,
              20_000,
            );
            await sleep(2500);
            issues.push(...flashes(rec.stop(), [id], { conversationOpen: how === "conversation" }).map((x) => `${acct} ${where} ${how}: ${x}`));
            if (q("conv-back")) click(q("conv-back")!);
          }
        }
      }
    } finally {
      await api.e2eControl("gmail-behaviour", { latency: {}, imapMoveLatency: 0 });
      await switchTo(info.gmailEmail);
    }
    check(!issues.length, issues.join("\n    "));
  },
  200_000,
);

step(
  "deleting the top row two or three times in a row never flashes, with several busy accounts syncing (the user's conditions)",
  async () => {
    // Shaped like the user's Macs: several mail-API accounts with thousands of conversations over the five
    // categories, all syncing, mail arriving, the real API's timings, deletes about 4 a second.
    if (!getState().accounts.some((a) => a.email === "busy0@example.net")) {
      await api.e2eControl("big-accounts", { count: 3, conversations: 3000, seed: 7 });
      await until("the busy accounts", () => getState().accounts.filter((a) => a.email.startsWith("busy")).length === 3, 30_000);
    }
    // Measured on the real API (recon account): a change ≈ 330–380 ms, a listing ≈ 200 ms. Reads are answered from the
    // mailbox as it was when they arrived and delivered later, so a change can land in between, as on the real server.
    await api.e2eControl("gmail-behaviour", {
      latency: { batchModify: 360, modify: 360, "threads.list": 120, "threads.get": 90, "messages.list": 100, labels: 90, history: 100 },
      tail: { "threads.list": 100, "threads.get": 400, "messages.list": 100, labels: 90, history: 400 },
    });
    await api.e2eControl("traffic", { everyMs: 1500, accounts: [1, 2] });
    const issues: string[] = [];
    try {
      await switchTo("busy0@example.net");
      await until("the busy Inbox", () => getState().route.list.label === "INBOX" && !getState().list.loading && rows().length >= 20, 60_000);
      // Let the first sync finish so the list is the steady one the user sees.
      await sleep(4000);
      const extraLabels = async (threads: string[]) => (await api.e2eControl<Record<string, string[]>>("extra-labels", { account: 0, threads })) ?? {};
      const hows = ["hover", "toolbar", "shortcut", "conversation"] as const;
      for (const how of hows) {
        for (const burst of [2, 3]) {
          await until("the Inbox list", () => getState().route.list.label === "INBOX" && !getState().route.thread && !getState().list.loading, 20_000);
          await sleep(1500);
          const gone: string[] = [];
          const rec = recordFrames();
          for (let k = 0; k < burst; k++) {
            const top = rows()[0];
            if (!top) break;
            const id = top.dataset.thread!;
            gone.push(id);
            if (how === "hover") click(await el("hover-delete", top));
            else if (how === "toolbar") {
              click(await el("row-checkbox", top));
              await until("selected", () => getState().selected.length === 1, 3000);
              click(await el("tb-delete"));
            } else if (how === "shortcut") {
              (document.activeElement as HTMLElement | null)?.blur?.();
              setState({ cursor: 0 });
              key(document.body, "#");
            } else {
              click(top);
              await until("the conversation", () => !!getState().route.thread && !!q("conv-delete"), 5000);
              click(await el("conv-delete"));
            }
            await sleep(250);
          }
          await until(
            "the deletes on the server",
            async () => {
              const labels = await extraLabels(gone);
              return gone.every((t) => (labels[t] ?? []).includes("TRASH") && !(labels[t] ?? []).includes("INBOX")) || null;
            },
            20_000,
          ).catch((e) => issues.push(`${how} ×${burst}: ${e instanceof Error ? e.message : e}`));
          await sleep(3000);
          issues.push(...flashes(rec.stop(), gone, { conversationOpen: how === "conversation" }).map((x) => `${how} ×${burst}: ${x}`));
          if (q("conv-back")) click(q("conv-back")!);
        }
      }
    } finally {
      await api.e2eControl("traffic", { everyMs: 0 });
      await api.e2eControl("gmail-behaviour", { latency: {}, tail: {} });
      await switchTo(info.gmailEmail);
    }
    check(!issues.length, issues.join("\n    "));
  },
  300_000,
);

step("opening a conversation that's on this Mac shows it at once, even when the server is slow", async () => {
  await backToInbox();
  await api.e2eControl("gmail-behaviour", { latency: { "threads.get": 800 } });
  try {
    for (const subject of ["Quarterly planning notes", "Your application"]) {
      const r = await until(subject, () => row(subject));
      const rec = recordFrames();
      const t0 = performance.now();
      click(r);
      await until("the conversation", () => q("conv-subject")?.textContent?.includes(subject));
      const ms = performance.now() - t0;
      await sleep(1200);
      const frames = rec.stop().frames;
      const blank = frames.find((f) => f.conv === "");
      check(ms < 250, `${subject}: took ${Math.round(ms)} ms to show`);
      check(!blank, `${subject}: the pane was blank at +${blank?.t} ms`);
      await backToInbox();
    }
  } finally {
    await api.e2eControl("gmail-behaviour", { latency: {} });
  }
});

step("archiving with e moves on to the next conversation at once (auto-advance), with nothing coming back", async () => {
  await backToInbox();
  await setSetting("autoAdvance", "older");
  await api.e2eControl("gmail-behaviour", { latency: { batchModify: 700, "threads.list": 150, "threads.get": 600 } });
  try {
    for (const n of [1, 2, 3]) await api.e2eControl("deliver-gmail", { from: "Advance Test <advance@test.example>", subject: `Advance ${n}`, body: "x" });
    await until("the rows", () => row("Advance 1") && row("Advance 2") && row("Advance 3"), 30_000);
    const list = visibleThreads();
    const at = list.findIndex((t) => t.subject === "Advance 3");
    const [gone, next] = [list[at].threadId, list[at + 1].subject];
    click(row("Advance 3")!);
    await until("Advance 3 open", () => q("conv-subject")?.textContent?.includes("Advance 3"));
    await sleep(800);
    const recStart = performance.now();
    const rec = recordFrames();
    (document.activeElement as HTMLElement | null)?.blur?.();
    key(document.body, "e");
    const keyAt = performance.now() - recStart;
    await until("the next one open", () => q("conv-subject")?.textContent?.includes(next), 5000);
    await until("archived on the server", async () => (await msgsWith("Advance 3")).every((m) => !m.labels.includes("INBOX")) || null, 20_000);
    await sleep(2000);
    const stopped = rec.stop();
    // When the pane showed the next conversation, from the recorder's own frames: the test's polling can be slowed by
    // WebKit's timer throttling in a background window, the app's frames can't.
    const shown = stopped.frames.find((f) => f.t >= keyAt - 1 && f.conv?.includes(next));
    const ms = shown ? shown.t - keyAt : Infinity;
    const issues = flashes(stopped, [gone], { conversationOpen: true });
    check(
      ms < 250,
      `the next conversation took ${Math.round(ms)} ms; longest stall ${stopped.stall.ms} ms ending at +${stopped.stall.at}; pane: ${stopped.frames
        .filter((f, i, all) => i === 0 || f.conv !== all[i - 1].conv)
        .map((f) => `${f.conv === null ? "list" : f.conv.includes(next) ? "next" : f.conv === "" ? "blank" : `other(${f.conv.length})`}@${f.t}`)
        .join(" ")}; ${stopped.trace
        .slice(0, 12)
        .map((e) => `${e.what}@${e.t}`)
        .join(", ")}`,
    );
    check(!issues.length, issues.join("\n    "));
    click(await el("conv-back"));
    await until("the list without it", () => !row("Advance 3"));
  } finally {
    await setSetting("autoAdvance", "list");
    await api.e2eControl("gmail-behaviour", { latency: {} });
  }
});

step("a label whose mail is older than this Mac keeps shows its mail without a flash of 'Nothing here'", async () => {
  await backToInbox();
  // Projects/Alpha has nothing on this Mac; the server has one message in it from last year.
  await api.e2eControl("seed-gmail-old", { from: "Archive <old@archive.example>", subject: "From last year", body: "x", labels: ["Label_2"], daysAgo: 400 });
  await api.e2eControl("gmail-behaviour", { latency: { "threads.list": 400 } });
  try {
    const nav = await until("the label", () => q("nav-label-Projects/Alpha"), 30_000);
    const rec = recordFrames();
    click(nav);
    await until("the old mail", () => row("From last year"), 10_000);
    await sleep(600);
    const frames = rec.stop().frames;
    const empty = frames.find((f) => f.empty);
    check(!empty, `"Nothing here" showed at +${empty?.t} ms before the mail arrived`);
  } finally {
    await api.e2eControl("gmail-behaviour", { latency: {} });
    await backToInbox();
  }
});

step("deleting when the server refuses: a passing refusal is retried, a lasting one says so plainly and can be tried again", async () => {
  await backToInbox();
  for (const n of [1, 2]) await api.e2eControl("deliver-gmail", { from: "Refusal Test <refuse@test.example>", subject: `Refused ${n}`, body: "x" });
  await until("the test rows", () => row("Refused 1") && row("Refused 2"), 30_000);
  // Once: the engine waits and sends the same request again.
  await api.e2eControl("gmail-behaviour", { preconditionNext: 1 });
  click(await el("hover-delete", row("Refused 1")!));
  await until("in Trash on the server", async () => (await msgsWith("Refused 1")).every((m) => m.labels.includes("TRASH")) || null, 20_000);
  await until("the usual toast", () => toastWith(/^Conversation moved to Trash/));
  // Every time: the row comes back and the toast says what failed, in words.
  const id = (await msgsWith("Refused 2"))[0].id;
  await api.e2eControl("gmail-behaviour", { preconditionIds: [id] });
  click(await el("row-checkbox", row("Refused 2")!));
  click(await el("tb-delete"));
  const t = await until("the failure toast", () => toastWith(/Couldn't move the conversation to Trash/), 20_000);
  check(t.textContent?.includes("The mail server didn't accept the request."), `toast: ${t.textContent}`);
  await until("the row is back", () => row("Refused 2"));
  check(!getState().hiddenThreads.length, "a row is still hidden");
  await api.e2eControl("gmail-behaviour", { preconditionIds: [] });
  click(await el("toast-action", t));
  await until("Try again moved it", async () => (await msgsWith("Refused 2")).every((m) => m.labels.includes("TRASH")) || null, 20_000);
  await until("the row leaves", () => !row("Refused 2"));
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

step("the search box offers recent searches", async () => {
  await backToInbox();
  const box = (await el("search-input")) as HTMLInputElement;
  box.focus();
  type(box, "subject:invoice");
  box.form!.requestSubmit();
  await until("searched", () => getState().route.list.query === "subject:invoice");
  await backToInbox();
  box.focus();
  type(box, "");
  // A covered background window may not deliver focus events; React listens for focusin.
  box.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  const recent = await until("recent searches shown", () => qa("sugg-recent").find((x) => x.textContent?.includes("subject:invoice")), 5_000).catch((e) => {
    throw new Error(
      `${e} [form ${box.form?.className}; focused element ${document.activeElement === box ? "the box" : document.activeElement?.tagName}; value "${box.value}"; saved ${JSON.stringify(getState().settings.recentSearches)}]`,
    );
  });
  recent.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await until("ran it again", () => getState().route.list.query === "subject:invoice");
  box.blur();
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
  // Styled newsletter: scripts, handlers and the tracking pixel never reach the frame; images show (the default).
  click(await until("newsletter", () => row("This week in gardening")));
  await until("newsletter body", () => frameText().includes("Spring planting"));
  const doc = frameText();
  check(!/<script/i.test(doc) && !/onclick/i.test(doc), "script or handler kept");
  check(!doc.includes("px.news.example/open.gif"), "tracking pixel kept");
  check(/\ssrc="https:\/\/img\.news\.example\/herbs\.jpg"/.test(doc), "images aren't shown by default");
  check(!q("images-banner"), "asks to display images although they're on by default");
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

step("compose ▸ More ▸ Label puts the label on the sent conversation (and the header never goes out)", async () => {
  await backToInbox();
  const w = await newCompose();
  await fill(w, "ana@friends.example", "Filed under Projects", "<div>For the project folder.</div>");
  click(await el("compose-more", w));
  const lbl = await el("compose-label");
  lbl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  lbl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  click(lbl);
  click(await el("compose-label-Projects"));
  key(document.body, "Escape");
  click(await el("compose-send", w));
  const sent = await until("sent", () => sentWith("Filed under Projects"), 30_000);
  check(!/X-Courier-Labels/i.test(sent.raw), "the private labels header went out");
  await until("labelled on the server", async () =>
    (await server()).gmailMessages.find((m) => m.subject === "Filed under Projects")?.labels.includes("Label_1") ? true : null,
  );
});

step("a conversation dragged from the list onto a new message is attached to it", async () => {
  await backToInbox();
  const t = getState().list.result?.threads.find((x) => x.subject === "Quarterly planning notes");
  check(t, "no conversation to drag");
  const w = await newCompose();
  await fill(w, "bo@work.example", "Have a look", "<div>See the attached.</div>");
  const dt = new DataTransfer();
  dt.setData("application/x-courier-threads", JSON.stringify({ accountId: t!.accountId, threadIds: [t!.threadId] }));
  w.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  q("compose-body", w)!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  await until("attached as a message", () => w.textContent?.includes("Quarterly planning notes.eml"));
  click(await el("compose-send", w));
  const sent = await until("sent", () => sentWith("Have a look"), 30_000);
  check(/message\/rfc822/i.test(sent.raw) && sent.raw.includes("Quarterly planning notes.eml"), "the conversation wasn't attached as a message");
});

step("filters: import a filter file, edit one, export and delete them", async () => {
  await backToInbox();
  click(await el("settings-gear"));
  click(await el("see-all-settings"));
  click(await el("settings-tab-filters"));
  const filtersOnServer = async () => (await server()).filters;
  const before = (await filtersOnServer()).length;
  const xml = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'><entry><apps:property name='from' value='news@imported.example'/><apps:property name='label' value='Imported/News'/><apps:property name='shouldArchive' value='true'/></entry><entry><apps:property name='subject' value='weekly report'/><apps:property name='shouldStar' value='true'/></entry></feed>`;
  setFiles(await el("filters-import-file"), [new File([xml], "mailFilters.xml", { type: "text/xml" })]);
  await el("filters-import-box");
  click(await el("filters-import-create"));
  await until("both filters on the server", async () => ((await filtersOnServer()).length === before + 2 ? true : null), 20_000);
  const imported = (await filtersOnServer()).find((f) => f.criteria?.from === "news@imported.example")!;
  check(imported.action?.removeLabelIds?.includes("INBOX"), "the archive action didn't come across");
  await until("the label made for it", () => getState().labels[getState().accountId]?.some((l) => l.name === "Imported/News"));
  // Edit: star it too (replaces the filter).
  const row = await until("its row", () => qa("filter-row").find((r) => r.textContent?.includes("news@imported.example")));
  click(await el("filter-edit", row));
  click(await el("filter-next"));
  click(await el("filter-action-star"));
  click(await el("filter-create"));
  await until("edited on the server", async () =>
    (await filtersOnServer()).some((f) => f.criteria?.from === "news@imported.example" && f.action?.addLabelIds?.includes("STARRED")) ? true : null,
  );
  check((await filtersOnServer()).filter((f) => f.criteria?.from === "news@imported.example").length === 1, "the old filter wasn't replaced");
  // Export all, then delete the two imported ones.
  click(await el("filter-pick-all"));
  click(await el("filters-export"));
  await until("exported to Downloads", async () => (await downloads()).includes("mailFilters.xml"));
  click(await el("filter-pick-all"));
  for (const r of qa("filter-row").filter((x) => /imported\.example|weekly report/.test(x.textContent ?? ""))) click(await el("filter-pick", r));
  click(await el("filters-delete"));
  await until("deleted", async () => ((await filtersOnServer()).length === before ? true : null), 20_000);
  click(await el("settings-close"));
});

step("warnings: an unverified sender gets a caution banner; mail in Spam offers Not spam", async () => {
  await backToInbox();
  click(await until("the spoof", () => row("Confirm your account now")));
  const banner = await el("auth-banner");
  check(banner.textContent?.includes("bank.example"), "the banner doesn't name the sender's domain");
  click(await el("banner-looks-safe"));
  await until("dismissed", () => !q("auth-banner"));
  await backToInbox();
  check(!((await until("a trusted message", () => row("Lunch on Friday?"))) && q("auth-banner")), "a normal message has a warning");
  await openList("SPAM").catch(async () => (click(await el("nav-more")), openList("SPAM")));
  click(await until("the spam message", () => row("You won a cruise")));
  click(await el("banner-not-spam", await el("spam-banner")));
  await until("moved out of Spam on the server", async () =>
    (await server()).gmailMessages.find((m) => m.subject === "You won a cruise")?.labels.includes("INBOX") ? true : null,
  );
  await backToInbox();
});

step("calendar invitations: the event card answers the organizer and adds to Calendar", async () => {
  await backToInbox();
  click(await until("the invitation", () => row("Invitation: Design review")));
  const card = await el("event-card");
  check(q("event-title", card)?.textContent === "Design review", "the event's title is missing");
  check(/\d/.test(q("event-when", card)?.textContent ?? ""), "the event's time is missing");
  check(card.textContent?.includes("Room 4") && card.textContent.includes("Invited by Ana Lima"), "where / who is missing");
  click(await el("rsvp-accepted", card));
  const reply = await until("the reply to the organizer", () => sentWith("Accepted: Design review"), 30_000);
  check(
    reply.to.some((a) => a.email === "ana@cal.example"),
    "the reply didn't go to the organizer",
  );
  check(
    /text\/calendar; method=REPLY/i.test(reply.raw) && reply.raw.includes("PARTSTAT=ACCEPTED") && reply.raw.includes("UID:design-review-1@cal.example"),
    "not an iCalendar REPLY",
  );
  await until("Yes shown as chosen", () => q("rsvp-accepted", card)?.getAttribute("aria-pressed") === "true");
  const n0 = (await server()).opened.length;
  click(await el("event-add", card));
  await until("opened in the calendar app (recorded)", async () => (await server()).opened.slice(n0).some((u) => u.startsWith("file:") && u.endsWith(".ics")));
  await backToInbox();
});

step("a clicked notification opens its conversation (in its account)", async () => {
  await backToInbox();
  const note = await until("a recorded notification with a conversation", async () =>
    (await server()).notifications.find((n) => n.threadId && n.title.includes("Gil")),
  );
  // What a click on the notification delivers.
  await emit("open-item", { kind: "thread", accountId: note.accountId, threadId: note.threadId });
  await until(
    "that conversation open",
    () => getState().route.thread?.threadId === note.threadId && q("conv-subject")?.textContent?.includes("Dinner tonight?"),
  );
  await backToInbox();
});

step("a notification's Archive button archives that conversation", async () => {
  const note = await until("a recorded notification", async () => (await server()).notifications.find((n) => n.threadId && n.title.includes("Gil")));
  await api.e2eControl("notification-action", { accountId: note.accountId, threadId: note.threadId, action: "archive" });
  await until("archived on the server", async () =>
    (await server()).gmailMessages.find((m) => m.subject === "Dinner tonight?")?.labels.includes("INBOX") === false ? true : null,
  );
  await until("gone from the inbox", () => !row("Dinner tonight?"), 20_000);
  // Put it back for the steps after this one.
  const id = (await server()).gmailMessages.find((m) => m.subject === "Dinner tonight?")!.threadId;
  await api.modifyThreads(note.accountId, [id], ["INBOX"], []);
  await until("back in the inbox", () => row("Dinner tonight?"), 20_000);
});

step("Promotions tab: with images set to ask, remote images held back; tracker stripped", async () => {
  await setSetting("images", "ask");
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
  await setSetting("images", "always");
  await backToInbox();
  click(await until("Primary tab", () => [...document.querySelectorAll<HTMLElement>(".tab")].find((t) => t.textContent?.includes("Primary"))));
});

step("unsubscribe as the web client does: one-click in the background, else an email from the account, else the website", async () => {
  await backToInbox();
  const base = info.fakeBase;
  const deliver = (subject: string, from: string, headers: string) => api.e2eControl("deliver-gmail", { from, subject, body: "This week's news.", headers });
  await deliver(
    "Weekly issue 12",
    "Weekly News <hello@weekly.example>",
    `List-Unsubscribe: <mailto:leave@weekly.example>, <${base}/unsubscribe/weekly>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`,
  );
  await deliver("Club bulletin", "Club Bulletin <bulletin@club.example>", "List-Unsubscribe: <mailto:leave@club.example?subject=unsubscribe>\r\n");
  await deliver("Store news", "Corner Store <news@store.example>", "List-Unsubscribe: <https://store.example/unsubscribe?u=1>\r\n");
  const ask = async (subject: string) => {
    await backToInbox();
    click(await until(subject, () => row(subject), 30_000));
    click(await el("unsubscribe"));
    const d = await el("confirm-dialog");
    return { text: d.textContent ?? "", ok: q("confirm-ok", d)?.textContent ?? "" };
  };
  // One-click (RFC 8058): Courier posts to the sender's link; no mail goes out.
  let d = await ask("Weekly issue 12");
  check(d.text.startsWith("Unsubscribe") && d.text.includes("Do you want to stop getting messages from this mailing list (Weekly News)?"), d.text);
  check(d.ok === "Unsubscribe", d.ok);
  const sent = (await server()).gmailSent.length;
  click(await el("confirm-ok"));
  const post = await until("the one-click POST", async () => (await server()).unsubscribeRequests.find((r) => r.path === "weekly"), 20_000);
  check(post.method === "POST" && post.body === "List-Unsubscribe=One-Click" && !post.cookie, JSON.stringify(post));
  await until("the toast", () => toastWith(/^Unsubscribed from this mailing list\./));
  await until("the message says it's done", () => q("unsubscribed"));
  check(!q("unsubscribe"), "the Unsubscribe link is still offered");
  check((await server()).gmailSent.length === sent, "mail was sent to a list that offers one-click");
  // Only an address: an unsubscribe email from this account, and the dialog says so.
  d = await ask("Club bulletin");
  check(
    d.text.includes(`Courier will unsubscribe for you by sending an email from ${info.gmailEmail} to leave@club.example.`) && d.ok === "Unsubscribe",
    d.text,
  );
  click(await el("confirm-ok"));
  const mail = await until(
    "the unsubscribe email",
    async () => (await server()).gmailSent.find((m) => m.to.some((a) => a.email === "leave@club.example")),
    30_000,
  );
  check(mail.subject === "unsubscribe", `subject: ${mail.subject}`);
  await until("the toast", () => toastWith(/^Unsubscribed from this mailing list\./));
  // Only a web page: Go to website opens it in the browser.
  d = await ask("Store news");
  check(
    d.text.includes("To stop getting messages from this mailing list (Corner Store), go to their website to unsubscribe.") && d.ok === "Go to website",
    d.text,
  );
  click(await el("confirm-ok"));
  await until("the page opened", async () => (await server()).opened.includes("https://store.example/unsubscribe?u=1") || null);
  await backToInbox();
});

step("Trash and Spam say what happens to their mail and offer to empty them", async () => {
  await api.e2eControl("deliver-gmail", { from: "Old Note <old@test.example>", subject: "Already in Trash", body: "x", labels: ["TRASH"] });
  await openList("TRASH");
  await until("the trashed message", () => row("Already in Trash"), 30_000);
  const b = await until("the banner with its link", () => (q("bin-empty") ? q("bin-banner") : null));
  check(
    b.textContent?.startsWith("Messages that have been in Trash more than 30 days will be automatically deleted.") &&
      q("bin-empty", b)?.textContent === "Empty Trash now",
    b.textContent ?? "",
  );
  click(q("bin-empty", b)!);
  check((await el("confirm-dialog")).textContent?.includes("Empty Trash?"), "no confirmation before emptying");
  click(await el("confirm-cancel"));
  await openList("SPAM");
  check((await el("bin-banner")).textContent?.startsWith("Messages that have been in Spam more than 30 days will be automatically deleted."), "no Spam banner");
  await backToInbox();
});

step("reporting list mail as spam asks whether to unsubscribe as well", async () => {
  await backToInbox();
  const h = (p: string) => `List-Unsubscribe: <${info.fakeBase}/unsubscribe/${p}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`;
  await api.e2eControl("deliver-gmail", { from: "Promo Blast <blast@promo.example>", subject: "Promo blast", body: "x", headers: h("blast") });
  await api.e2eControl("deliver-gmail", { from: "Other Promo <other@promo2.example>", subject: "Other promo", body: "x", headers: h("other") });
  const inSpam = async (subject: string) => (await msgsWith(subject)).every((m) => m.labels.includes("SPAM")) || null;
  click(await until("the blast", () => row("Promo blast"), 30_000));
  click(await el("conv-spam"));
  const d = await el("confirm-dialog");
  check(
    (d.textContent ?? "").includes("Report spam or unsubscribe?") &&
      (d.textContent ?? "").includes("This message will be marked as spam. Would you also like to stop receiving similar messages from Promo Blast?"),
    d.textContent ?? "",
  );
  click(await el("confirm-ok"));
  await until("unsubscribed", async () => (await server()).unsubscribeRequests.find((r) => r.path === "blast" && r.method === "POST"), 20_000);
  await until("in Spam", () => inSpam("Promo blast"), 20_000);
  await until("the toast", () => toastWith(/marked as spam\. Unsubscribed from its mailing list\./));
  await backToInbox();
  click(await until("the other", () => row("Other promo"), 30_000));
  click(await el("conv-spam"));
  click(await el("confirm-alt", await el("confirm-dialog")));
  await until("in Spam", () => inSpam("Other promo"), 20_000);
  check(!(await server()).unsubscribeRequests.some((r) => r.path === "other"), "unsubscribed when only Report spam was chosen");
  await backToInbox();
});

// ---- the complaints from the real-account round ----

const frameEl = () => q<HTMLIFrameElement>("message-frame");
const frameDoc = () => frameEl()?.contentDocument ?? null;
const navCount = (path: string) => q(`nav-label-${path}`)?.querySelector(".nav-count")?.textContent?.trim() ?? "0";
const downloads = async () => (await api.e2eControl<{ names: string[] }>("downloads")).names;

/** A link in a message, clicked: first as is (target=_blank), then as a plain link if WebKit kept that to itself. */
async function clickLink(a: HTMLAnchorElement, done: () => Promise<unknown>) {
  click(a);
  const end = Date.now() + 2500;
  while (Date.now() < end) {
    if (await done()) return "new window";
    await sleep(150);
  }
  a.removeAttribute("target");
  click(a);
  await until("the link handled", done);
  return "navigation";
}

step("message frames: never cut off, never growing, wide mail scrolls sideways", async () => {
  await backToInbox();
  // A page-height layout settles at its content's height instead of growing forever.
  click(await until("full-height row", () => row("Full-height newsletter")));
  await until("full-height body", () => frameDoc()?.body?.textContent?.includes("TALL-END"));
  await sleep(1200);
  const h1 = frameEl()!.getBoundingClientRect().height;
  await sleep(1500);
  const h2 = frameEl()!.getBoundingClientRect().height;
  check(Math.abs(h2 - h1) < 2, `the frame keeps growing (${h1} → ${h2})`);
  check(h2 < 1500, `a short page-height newsletter is ${Math.round(h2)}px tall`);
  await backToInbox();
  // A very long message: every line fits inside the frame.
  click(await until("long row", () => row("A very long message")));
  const last = await until("its last line", () => frameDoc()?.getElementById("last"));
  await sleep(800);
  check(last.getBoundingClientRect().bottom <= frameEl()!.getBoundingClientRect().height + 1, "the end of a long message is cut off");
  await backToInbox();
  // Wider than the window: it scrolls sideways inside its frame, and the window doesn't.
  click(await until("wide row", () => row("Fixed-width newsletter")));
  const body = await until("wide body", () => (frameDoc()?.body?.textContent?.includes("WIDE-RIGHT-END") ? frameDoc()!.body : null));
  await sleep(400);
  check(body.scrollWidth > body.clientWidth + 100, "wide mail doesn't scroll sideways");
  check(getComputedStyle(body).overflowX === "auto", "wide mail can't be scrolled sideways");
  check(frameEl()!.getBoundingClientRect().right <= window.innerWidth + 1, "the message frame sticks out of the window");
  check(document.documentElement.scrollWidth <= window.innerWidth, "the window scrolls sideways");
  await backToInbox();
});

step("links open in the default browser; mail links start a message in Courier", async () => {
  await backToInbox();
  click(await until("links row", () => row("Links to open")));
  const doc = await until("the links", () => (frameDoc()?.querySelector("a[href='https://example.org/e2e-target']") ? frameDoc() : null));
  const before = (await server()).opened.filter((u) => u.includes("e2e-target")).length;
  const how = await clickLink(doc!.querySelector<HTMLAnchorElement>("a[href='https://example.org/e2e-target']")!, async () =>
    (await server()).opened.filter((u) => u.includes("e2e-target")).length > before ? true : null,
  );
  log(`  link opened by ${how}`);
  await sleep(500);
  check((await server()).opened.filter((u) => u.includes("e2e-target")).length === before + 1, "the link opened more than once");
  check(frameDoc()?.body?.textContent?.includes("Open the page"), "the link replaced the message inside Courier");
  check(!getState().route.settings && getState().route.thread, "the link navigated Courier away");
  // mailto: opens Courier's own compose, addressed.
  const composes = qa("compose-window").length;
  await clickLink(frameDoc()!.querySelector<HTMLAnchorElement>("a[href^='mailto:']")!, async () => (qa("compose-window").length > composes ? true : null));
  const w = qa("compose-window")[0];
  await until("addressed to the link", () => w.textContent?.includes("links@example.org"));
  check((q<HTMLInputElement>("compose-subject", w)?.value ?? "") === "Hello", "the subject from the link is missing");
  click(await el("compose-discard", w));
  await backToInbox();
});

step("attachments open in their own app; downloads go straight to Downloads", async () => {
  await backToInbox();
  click(await until("planning row", () => row("Quarterly planning notes")));
  const card = await until("the attachment", () => qa("attachment-card").find((c) => c.textContent?.includes("quarterly-plan.pdf")));
  const n0 = (await server()).opened.length;
  click(card);
  await until("opened in its own app", async () => (await server()).opened.slice(n0).some((u) => u.startsWith("file:") && u.endsWith("/quarterly-plan.pdf")));
  check(!(await server()).opened.some((u) => u.includes("qlmanage")), "Quick Look's qlmanage used");
  click(await el("att-download", card));
  await until("saved to Downloads", async () => (await downloads()).includes("quarterly-plan.pdf"));
  click(await el("att-download", card));
  await until("a second copy named like a browser does", async () => (await downloads()).includes("quarterly-plan (1).pdf"));
  const t = await until("the saved toast", () => toastWith(/saved to Downloads/));
  click(await el("toast-action", t));
  await until("shown in Finder (recorded)", async () => (await server()).opened.some((u) => u.startsWith("reveal:") && u.includes("quarterly-plan")));
  // WebKit's own downloads (a message's Download Image / Download Linked File) land in Downloads too.
  const link = document.createElement("a");
  link.href = "data:text/plain;charset=utf-8,saved%20by%20WebKit";
  link.download = "webkit-download.txt";
  document.body.appendChild(link);
  click(link);
  link.remove();
  await until("WebKit's download saved", async () => (await downloads()).includes("webkit-download.txt"), 20_000);
  await until("its toast", () => toastWith(/webkit-download\.txt saved to Downloads/));
  await backToInbox();
});

step("files handed to Courier (another app's Email this file) start a message with them attached", async () => {
  await backToInbox();
  const before = qa("compose-window").length;
  await api.e2eControl("open-files", { files: [{ name: "Trip notes.docx", text: "notes for the trip" }] });
  const w = await until("a new message", () => (qa("compose-window").length > before ? qa("compose-window")[0] : null));
  await until("the file attached", () => w.textContent?.includes("Trip notes.docx"));
  check((q<HTMLInputElement>("compose-subject", w)?.value ?? "") === "Trip notes", "the subject isn't the file's name");
  click(await el("compose-discard", w));
});

step(
  "select all in a label: every page on the server, the unticked kept, counts updated at once",
  async () => {
    await backToInbox();
    click(await el("nav-label-Bulk"));
    await until("the Bulk label", () => getState().route.list.label === "Label_3" && rows().length >= 50 && !getState().list.loading, 30_000);
    await until("60 unread in the nav", () => navCount("Bulk") === "60");
    click(await el("select-all"));
    click(await el("select-all-matching"));
    await until("the whole view selected", () => getState().selectAllMatching);
    for (const subject of ["Bulk note 59", "Bulk note 58"]) click(await el("row-checkbox", await until(subject, () => row(subject))));
    await until("two kept", () => getState().keepThreads.length === 2);
    check(q("select-all-banner")?.textContent?.includes("except"), "the banner doesn't mention the kept ones");
    click(await el("tb-delete"));
    click(await el("confirm-ok"));
    const inTrash = async () => (await server()).gmailMessages.filter((m) => m.subject.startsWith("Bulk note") && m.labels.includes("TRASH"));
    await until("58 in Trash on the server", async () => ((await inTrash()).length === 58 ? true : null), 40_000);
    const s = await server();
    check(
      s.gmailMessages.filter((m) => m.subject === "Bulk note 59" || m.subject === "Bulk note 58").every((m) => !m.labels.includes("TRASH")),
      "a kept conversation was deleted",
    );
    check(
      s.gmailMessages.some((m) => m.subject === "Bulk note 0" && m.labels.includes("TRASH")),
      "mail older than the offline window was left behind",
    );
    await until("the nav count follows without a restart", () => navCount("Bulk") === "2", 20_000);
    await until("the list shows the two kept", () => rows().length === 2);
    check(toastWith(/moved to Trash/), "no result toast");
  },
  90_000,
);

step("delete all except selected: tick the keepers, the rest of the label goes", async () => {
  click(await el("nav-label-Keep"));
  await until("the Keep label", () => getState().route.list.label === "Label_4" && rows().length === 8 && !getState().list.loading, 30_000);
  for (const subject of ["Keep or not 1", "Keep or not 4", "Keep or not 6"]) click(await el("row-checkbox", await until(subject, () => row(subject))));
  click(await el("tb-more"));
  click(await el("except-delete"));
  const dialog = await el("confirm-dialog");
  check(
    /\b3\b/.test(dialog.textContent ?? "") && /\b5\b/.test(dialog.textContent ?? ""),
    `the confirmation doesn't say how many go and stay: ${dialog.textContent}`,
  );
  click(await el("confirm-ok"));
  const msgs = async () => (await server()).gmailMessages.filter((m) => m.subject.startsWith("Keep or not"));
  await until("five in Trash", async () => ((await msgs()).filter((m) => m.labels.includes("TRASH")).length === 5 ? true : null), 30_000);
  const kept = (await msgs())
    .filter((m) => !m.labels.includes("TRASH"))
    .map((m) => m.subject)
    .sort();
  check(kept.join() === "Keep or not 1,Keep or not 4,Keep or not 6", `kept: ${kept.join()}`);
  await until("the nav count is 3", () => navCount("Keep") === "3", 20_000);
});

step(
  "manage subscriptions: senders listed, unsubscribe, clear their mail",
  async () => {
    await backToInbox();
    await openNav("SUBSCRIPTIONS");
    await el("subscriptions");
    const deals = () => qa("sub-row").find((x) => x.textContent?.includes("news@deals.example"));
    await until("Daily Deals listed", deals);
    const posted = async () => (await server()).unsubscribeRequests.filter((r) => r.path === "deals" && r.method === "POST").length;
    const before = await posted();
    click(await el("sub-unsubscribe", deals()!));
    const text = (await el("confirm-dialog")).textContent ?? "";
    check(text.includes("Do you want to stop getting messages from all mailing lists from Daily Deals (news@deals.example)?"), text);
    click(await el("confirm-ok"));
    await until("the one-click request", async () => ((await posted()) > before ? true : null), 30_000);
    check(!(await server()).gmailSent.some((m) => m.to.some((a) => a.email === "unsub@deals.example")), "mailed a sender that offers one-click");
    await until("shown as unsubscribed", () => deals()?.querySelector('[data-testid="sub-done"]'));
    click(await el("sub-clear", deals()!));
    click(await el("confirm-ok"));
    await until(
      "their mail in Trash",
      async () => (await server()).gmailMessages.filter((m) => m.subject === "48 hours only: 30% off").every((m) => m.labels.includes("TRASH")),
      30_000,
    );
    // The page holds still while mail comes in.
    const shown = qa("sub-row")
      .map((r) => r.textContent)
      .join("|");
    await api.e2eControl("deliver-gmail", {
      from: "New List <hello@newlist.example>",
      subject: "First issue",
      body: "x",
      headers: "List-Unsubscribe: <mailto:leave@newlist.example>\r\n",
    });
    await sleep(2500);
    check(
      qa("sub-row")
        .map((r) => r.textContent)
        .join("|") === shown,
      "rows changed under the pointer while the page was open",
    );
    // Remembered.
    await openList("INBOX");
    await openNav("SUBSCRIPTIONS");
    await until("still unsubscribed", () => deals()?.querySelector('[data-testid="sub-done"]'));
    await backToInbox();
  },
  60_000,
);

step("two-finger swipes: across a row archives it; between screens goes back and forward", async () => {
  await backToInbox();
  check((await api.e2eControl<{ enabled: boolean }>("swipe-nav")).enabled, "back/forward swipes are off in the web view");
  const r = await until("a row", () => row("Links to open"));
  // Fingers moving right is "back": the row leaves it to the web view (not consumed).
  check(r.dispatchEvent(new WheelEvent("wheel", { deltaX: -30, deltaY: 0, bubbles: true, cancelable: true })), "a back swipe over a row was swallowed");
  await sleep(400);
  // Fingers moving left across a row archives it (the default).
  for (let i = 0; i < 14; i++) {
    r.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 0, bubbles: true, cancelable: true }));
    await sleep(16);
  }
  const inInbox = async () => (await server()).gmailMessages.find((m) => m.subject === "Links to open")?.labels.includes("INBOX");
  await until("archived on the server", async () => ((await inInbox()) === false ? true : null), 20_000);
  click(await el("toast-action", await until("Undo", () => toastWith(/archived/))));
  await until("back in the inbox", async () => ((await inInbox()) === true ? true : null), 20_000);
  // The swipe itself is the web view's back/forward through Courier's screens.
  click(await until("a conversation", () => row("Your application")));
  await until("open", () => getState().route.thread);
  history.back();
  await until("back to the list", () => !getState().route.thread);
  history.forward();
  await until("forward to the conversation", () => getState().route.thread);
  await backToInbox();
});

step("right-click a row: the menu acts on that conversation", async () => {
  await backToInbox();
  const r = await until("a read row", () => row("Your application"));
  const box = r.getBoundingClientRect();
  r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 400, clientY: box.top + 10 }));
  click(await el("ctx-unread"));
  await until("marked unread on the server", async () =>
    (await server()).gmailMessages.find((m) => m.subject === "Your application")?.labels.includes("UNREAD") ? true : null,
  );
  const r2 = await until("the row again", () => row("Your application"));
  r2.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 400, clientY: box.top + 10 }));
  click(await el("ctx-find-from"));
  await until("mail from the sender", () => getState().route.list.query === "from:jobs@example.net" && row("Your application"));
  await backToInbox();
});

/** Scrolls a box as a person would (and fires the event a covered background window holds back). */
async function scrollBy(box: Element, dy: number) {
  box.scrollTop += dy;
  box.dispatchEvent(new Event("scroll"));
  await sleep(150);
}

step("popups stay with what they belong to when the conversation scrolls", async () => {
  await backToInbox();
  click(await until("the long message", () => row("A very long message")));
  const conv = await until("the conversation", () => document.querySelector<HTMLElement>(".conv"));
  await until("its frame", () => frameDoc()?.getElementById("last"));
  // The details under "to me": inside the message, so it moves with it.
  const to = qa("msg-details").pop()!;
  click(to);
  const pop = await el("details-popup");
  const gap = () => Math.round(pop.getBoundingClientRect().top - to.getBoundingClientRect().bottom);
  const g0 = gap();
  await scrollBy(conv, 140);
  check(Math.abs(gap() - g0) <= 1, `the details box stayed put while the message scrolled (${g0} → ${gap()})`);
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await until("details closed", () => !q("details-popup"));
  conv.scrollTop = 0;
  // A menu follows its button, and closes once the button scrolls out of sight.
  const more = qa("msg-more").pop()!;
  click(more);
  const menu = await until("the message menu", () => document.querySelector<HTMLElement>(".menu"));
  const icon = more.querySelector(".ic") ?? more;
  const m0 = Math.round(menu.getBoundingClientRect().top - icon.getBoundingClientRect().bottom);
  await scrollBy(conv, 40);
  check(Math.abs(Math.round(menu.getBoundingClientRect().top - icon.getBoundingClientRect().bottom) - m0) <= 1, "the menu didn't follow its button");
  await scrollBy(conv, 3000);
  await until("the menu closed once its button left the view", () => !document.querySelector(".menu"));
  await backToInbox();
  // A right-click menu closes when the list scrolls.
  const r = await until("a row", () => row("Your application"));
  r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: r.getBoundingClientRect().top + 10 }));
  await el("ctx-reply");
  await scrollBy(await until("the list", () => document.querySelector(".list")), 20);
  await until("the right-click menu closed", () => !q("ctx-reply"));
});

step("people: the To label picks recipients from a list; a sender's name shows their card", async () => {
  await backToInbox();
  const w = await newCompose();
  click(await el("pick-to", w));
  const picker = await el("contact-picker");
  // Dana comes from the account's contacts (the People API on the fake server).
  type(await el("contact-picker-filter", picker), "dana");
  const dana = await until("Dana in the list", () => qa("contact-picker-row", picker).find((r) => r.textContent?.includes("dana@contacts.example")));
  click(dana.querySelector("input")!);
  click(await el("contact-picker-add", picker));
  await until("Dana added", () => qa("rcpt-to", w).some((r) => r.getAttribute("title") === "dana@contacts.example"));
  click(await el("compose-discard", w));
  // The card.
  click(await until("a conversation", () => row("Your application")));
  const who = await el("sender-name");
  who.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  who.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  const card = await el("sender-card");
  check(card.textContent?.includes("jobs@example.net"), "the card doesn't show the address");
  click(await el("sender-find", card));
  await until("their mail", () => getState().route.list.query === "from:jobs@example.net");
  await backToInbox();
});

async function setWindowSize(w: number, h: number) {
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setSize(new LogicalSize(w, h));
  await until(`the window at ${w}px`, () => Math.abs(window.innerWidth - w) <= 2);
  // WebKit holds resize events back while the (background) window is covered; do what the event would.
  applyViewportSize();
  await sleep(400);
}

step(
  "fits every window size: nothing overlaps or sticks out, from 1440 px down to phone width",
  async () => {
    const problems: string[] = [];
    try {
      for (const [w, h] of [
        [1440, 900],
        [1280, 800],
        [1024, 768],
        [900, 700],
        [760, 640],
        [600, 760],
        [420, 820],
      ]) {
        await setWindowSize(w, h);
        const look = (where: string) => problems.push(...layoutIssues().map((p) => `${w}px ${where}: ${p}`));
        await backToInbox();
        look("inbox");
        click(await until("a conversation", () => row("Planning the offsite")));
        await el("conversation");
        await sleep(300);
        look("conversation");
        await backToInbox();
        if (getState().size === "phone") click(await el("main-menu-phone"));
        await openNav("SUBSCRIPTIONS");
        await el("subscriptions");
        look("subscriptions");
        getState().drawer && click(await el("drawer-scrim"));
        click(await el("settings-gear"));
        click(await el("see-all-settings"));
        await el("settings");
        look("settings");
        click(await el("settings-close"));
      }
    } finally {
      await setWindowSize(1280, 800);
    }
    check(!problems.length, problems.slice(0, 12).join("\n"));
  },
  120_000,
);

step("two compose windows in a narrow window: the older folds to its title bar, both stay on screen", async () => {
  try {
    await setWindowSize(900, 700);
    await backToInbox();
    const a = await newCompose();
    type(await el("compose-subject", a), "First draft here");
    const b = await newCompose();
    type(await el("compose-subject", b), "Second draft here");
    await sleep(300);
    const wins = () => qa("compose-window");
    const byTitle = (t: string) => wins().find((w) => q<HTMLInputElement>("compose-subject", w)?.value === t)!;
    check(byTitle("First draft here").classList.contains("min") && !byTitle("Second draft here").classList.contains("min"), "the newest isn't the open one");
    for (const w of wins()) {
      const r = w.getBoundingClientRect();
      check(r.left >= 0 && r.right <= window.innerWidth + 1, "a compose window is off screen");
    }
    click(await el("compose-head", byTitle("First draft here")));
    await until(
      "the older one open, the newer folded",
      () => !byTitle("First draft here").classList.contains("min") && byTitle("Second draft here").classList.contains("min"),
    );
    for (const w of wins()) click(await el("compose-discard", w));
    await until("closed", () => !wins().length);
  } finally {
    await setWindowSize(1280, 800);
  }
});

step("awkward mail still fits: very long subjects and names, right-to-left text, 60 recipients", async () => {
  const problems: string[] = [];
  try {
    for (const [w, h] of [
      [1280, 800],
      [420, 820],
    ]) {
      await setWindowSize(w, h);
      await backToInbox();
      await until("the awkward rows", () => row("Awkward subject") && row("Party for everyone"));
      problems.push(...layoutIssues().map((p) => `${w}px inbox: ${p}`));
      for (const subject of ["Awkward subject", "سلام", "Party for everyone"]) {
        click(await until(subject, () => row(subject)));
        await el("conversation");
        await sleep(300);
        problems.push(...layoutIssues().map((p) => `${w}px "${subject.slice(0, 16)}": ${p}`));
        if (subject === "Party for everyone") {
          click(qa("msg-details").pop()!);
          await el("details-popup");
          problems.push(...layoutIssues().map((p) => `${w}px details of 60 recipients: ${p}`));
          const pop = q("details-popup")!.getBoundingClientRect();
          if (pop.right > window.innerWidth + 1) {
            const main = q("details-popup")!.closest(".msg-main")?.getBoundingClientRect();
            const conv = document.querySelector(".conv")!.getBoundingClientRect();
            problems.push(
              `${w}px: the details box runs off the window (box ${Math.round(pop.left)}–${Math.round(pop.right)}, column ${Math.round(main?.left ?? -1)}–${Math.round(main?.right ?? -1)}, conversation ${Math.round(conv.left)}–${Math.round(conv.right)}, maxWidth ${getComputedStyle(q("details-popup")!).maxWidth})`,
            );
          }
          document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        }
        await backToInbox();
      }
    }
  } finally {
    await setWindowSize(1280, 800);
  }
  check(!problems.length, problems.slice(0, 10).join("\n"));
});

step("a sync that fails says why in words in Settings ▸ Accounts", async () => {
  await backToInbox();
  await api.e2eControl("gmail-behaviour", { failRoutes: { history: 400 } });
  try {
    await api.e2eControl("deliver-gmail", { from: "Sync Test <sync@test.example>", subject: "Sync check", body: "x" });
    const id = getState().accounts.find((a) => a.kind === "gmail")!.id;
    await until("the sync error", () => getState().sync[id] === "error", 30_000);
    click(await el("settings-gear"));
    click(await el("see-all-settings"));
    click(await el("settings-tab-accounts"));
    const hint = await el("sync-error");
    check(!RAW_ERROR.test(hint.innerText) && /didn't accept|broke off/.test(hint.innerText), `the account says: ${hint.innerText}`);
    click(await el("settings-close"));
  } finally {
    await api.e2eControl("gmail-behaviour", { failRoutes: {} });
    await api.e2eControl("sync");
  }
});

step(
  "counts mean what the web client's do: tabs say only what's new since they were opened; categories stay out of the menu until shown, then count every unread conversation in them",
  async () => {
    await backToInbox();
    const chip = (tab: string) => q(`tab-${tab}`)?.querySelector(".new-badge")?.textContent?.trim() ?? "";
    // Unread mail the Promotions tab already had isn't news: the web client shows no number for it.
    await until("the tabs", () => q("tab-promotions"));
    await sleep(800);
    check(chip("promotions") === "", `Promotions shows "${chip("promotions")}" for mail it already had`);
    await api.e2eControl("deliver-gmail", {
      from: "Lakeside Outfitters <deals@lakeside.example>",
      subject: "Autumn sale starts",
      body: "x",
      labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    });
    await until("1 new on Promotions", () => chip("promotions") === "1 new", 30_000);
    check(/Lakeside/.test(q("tab-promotions")?.textContent ?? ""), "the new sender isn't named under the tab");
    click(await el("tab-promotions"));
    await until("Promotions open", () => getState().route.list.category === "promotions" && !getState().list.loading);
    click(await el("tab-primary"));
    await until("Primary open", () => (getState().route.list.category ?? "primary") === "primary" && !getState().list.loading);
    await sleep(500);
    check(chip("promotions") === "", `Promotions still shows "${chip("promotions")}" after it was opened`);
    // Categories: hidden from the menu by default, even under More.
    if (q("nav-more") && !q("nav-IMPORTANT")) click(q("nav-more")!);
    await sleep(300);
    check(!q("nav-CATEGORY_UPDATES"), "Updates is in the menu although Settings ▸ Labels hides categories by default");
    await api.e2eControl("deliver-gmail", {
      from: "Billing <billing@shop.example>",
      subject: "Archived unread receipt",
      body: "x",
      labels: ["UNREAD", "CATEGORY_UPDATES"],
    });
    click(await el("settings-gear"));
    click(await el("see-all-settings"));
    click(await el("settings-tab-labels"));
    click(await el("sys-CATEGORY_UPDATES-show"));
    click(await el("settings-close"));
    const truth = async () => {
      const msgs = (await server()).gmailMessages.filter(
        (m) => m.labels.includes("CATEGORY_UPDATES") && m.labels.includes("UNREAD") && !m.labels.includes("TRASH") && !m.labels.includes("SPAM"),
      );
      return new Set(msgs.map((m) => m.threadId)).size;
    };
    const want = await truth();
    check(want > 0, "the seed has no unread Updates mail");
    await until(
      `Updates above More with ${want}`,
      () => aboveMore("CATEGORY_UPDATES") && q("nav-CATEGORY_UPDATES")?.querySelector(".nav-count")?.textContent?.trim() === String(want),
      30_000,
    );
    await setSetting("systemLabels", {});
    await until("Updates gone again", () => !q("nav-CATEGORY_UPDATES"));
  },
);

step("Settings ▸ Labels: show, hide and show if unread move system labels in and out of the menu", async () => {
  await backToInbox();
  click(await el("settings-gear"));
  click(await el("see-all-settings"));
  click(await el("settings-tab-labels"));
  const pressed = (id: string, v: string) => q(`sys-${id}-${v}`)?.getAttribute("aria-pressed") === "true";
  await until(
    "the web client's defaults",
    () =>
      pressed("STARRED", "show") &&
      pressed("IMPORTANT", "hide") &&
      pressed("SCHEDULED", "show-if-unread") &&
      pressed("ALL", "hide") &&
      pressed("TRASH", "hide"),
    5000,
  );
  click(await el("sys-STARRED-hide"));
  click(await el("sys-ALL-show"));
  click(await el("sys-SPAM-show-if-unread"));
  click(await el("settings-close"));
  if (!q("nav-STARRED")) click(await el("nav-more"));
  await until("Starred under More, All Mail above it", () => !aboveMore("STARRED") && aboveMore("ALL"));
  const spamUnread = () => getState().labels[getState().accountId]?.find((l) => l.id === "SPAM")?.threadsUnread ?? 0;
  check(aboveMore("SPAM") === spamUnread() > 0, `Spam ${aboveMore("SPAM") ? "shows" : "hides"} with ${spamUnread()} unread`);
  await api.e2eControl("deliver-gmail", { from: "Junk <junk@spam.example>", subject: "Unread spam", body: "x", labels: ["SPAM", "UNREAD"] });
  await until("Spam above More while it has unread mail", () => aboveMore("SPAM"), 30_000);
  // Remembered after a restart: the settings come back from storage.
  check(((await api.settings()) as Record<string, Record<string, string>>).systemLabels?.STARRED === "hide", "the choice wasn't saved");
  await setSetting("systemLabels", {});
  await until("defaults back", () => aboveMore("STARRED") && !aboveMore("ALL"));
});

step("every settings page opens cleanly at desktop, rail and phone widths", async () => {
  const problems: string[] = [];
  try {
    for (const [w, h] of [
      [1280, 800],
      [800, 700],
      [420, 820],
    ]) {
      await setWindowSize(w, h);
      await backToInbox();
      click(await el("settings-gear"));
      click(await el("see-all-settings"));
      await el("settings");
      const tabs = qa("settings-tab-general")[0]?.parentElement;
      for (const tab of [...(tabs?.querySelectorAll<HTMLElement>("[data-testid^='settings-tab-']") ?? [])]) {
        click(tab);
        await sleep(250);
        problems.push(...layoutIssues().map((p) => `${w}px ${tab.dataset.testid}: ${p}`));
        const raw = [...(q("settings")?.querySelectorAll<HTMLElement>(".hint, .desc, .error, .empty") ?? [])]
          .map((x) => x.innerText)
          .find((x) => RAW_ERROR.test(x));
        if (raw) problems.push(`${tab.dataset.testid} shows raw error text: ${raw}`);
      }
      click(await el("settings-close"));
    }
  } finally {
    await setWindowSize(1280, 800);
  }
  check(!problems.length, problems.slice(0, 10).join("\n"));
});

step("phone width: menu drawer with the inbox tabs, rows with pictures, floating Compose", async () => {
  try {
    await setWindowSize(420, 820);
    await backToInbox();
    check(getState().size === "phone", "not in the phone layout at 420 px");
    const fab = await el("compose-fab");
    check(getComputedStyle(fab).position === "fixed", "Compose isn't floating");
    check(getComputedStyle(q("row-avatar")!).display !== "none", "rows have no pictures");
    check(!document.querySelector<HTMLElement>(".tabs") || getComputedStyle(document.querySelector(".tabs")!).display === "none", "tabs still across the top");
    click(await el("main-menu-phone"));
    await until("the drawer", () => getState().drawer);
    click(await el("nav-tab-promotions"));
    await until("Promotions open, drawer closed", () => getState().route.list.category === "promotions" && !getState().drawer);
    click(await el("main-menu-phone"));
    click(await el("nav-tab-primary"));
    await until("Primary", () => (getState().route.list.category ?? "primary") === "primary" && !getState().drawer);
    // Ticking a row with its picture, as in the phone app.
    click(await el("row-avatar", await until("a row", () => row("Planning the offsite"))));
    await until("selected", () => getState().selected.length === 1);
    click(await el("select-all"));
    await until("cleared", () => getState().selected.length === 0);
    // Compose fills the window (the button was redrawn when the drawer closed, so find it again).
    click(await el("compose-fab"));
    const w = await until("compose", () => qa("compose-window")[0]);
    await sleep(200);
    const r = w.getBoundingClientRect();
    check(r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2, "compose doesn't fill the window at phone width");
    click(await el("compose-discard", w));
  } finally {
    await setWindowSize(1280, 800);
  }
  await backToInbox();
});

step("a link to a spot in the same message scrolls the conversation there", async () => {
  await backToInbox();
  click(await until("the long message", () => row("A very long message")));
  const conv = await until("the conversation", () => document.querySelector<HTMLElement>(".conv"));
  const jump = await until("the jump link", () => frameDoc()?.getElementById("jump") as HTMLAnchorElement | null);
  conv.scrollTop = 0;
  click(jump);
  await until("scrolled to the end of the message", () => {
    const last = frameDoc()?.getElementById("last");
    if (!last) return false;
    const y = frameEl()!.getBoundingClientRect().top + last.getBoundingClientRect().top;
    const box = conv.getBoundingClientRect();
    return conv.scrollTop > 500 && y >= box.top && y <= box.bottom;
  });
  check(getState().route.thread, "the link left the conversation");
  await backToInbox();
});

step("shortcuts keep working after a click inside a message's body", async () => {
  await backToInbox();
  click(await until("a conversation", () => row("Quarterly planning notes")));
  await el("conversation");
  const frame = await until("the message frame", () => frameEl());
  frame.focus();
  check(document.activeElement === frame, "the message frame didn't take focus (nothing to test)");
  window.dispatchEvent(new Event("blur"));
  await until("focus back in the app", () => document.activeElement !== frame, 5_000);
  // u goes back to the list, as a shortcut does from anywhere in the app.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
  await until("back to the list", () => !getState().route.thread);
});

step("menu bar: Share sends the open conversation to the Share menu; Paste and Match Style pastes plain text", async () => {
  await backToInbox();
  click(await until("a conversation", () => row("Quarterly planning notes")));
  await el("conversation");
  await until("loaded", () => getState().thread.detail?.messages.length);
  await emit("menu", { id: "share" });
  await until("shared as a message file", async () => (await server()).opened.some((u) => u.startsWith("share:") && u.endsWith(".eml")));
  await backToInbox();
  const w = await newCompose();
  const body = await el("compose-body", w);
  body.focus();
  await emit("menu", { id: "paste-plain" });
  await until("pasted", () => body.textContent?.includes("Pasted as plain text"));
  click(await el("compose-discard", w));
});

step("settings that change the list and replies: text button labels, personal markers, send and archive", async () => {
  await backToInbox();
  await setSetting("buttonLabels", "text");
  await setSetting("personalIndicators", true);
  await setSetting("sendAndArchive", true);
  try {
    const lunch = await until("a row", () => row("Lunch on Friday?"));
    click(await el("row-checkbox", lunch));
    const del = await el("tb-delete");
    await until("words instead of icons", () => del.textContent?.includes("Delete") && getComputedStyle(del.querySelector(".ic")!).display === "none");
    click(await el("row-checkbox", row("Lunch on Friday?")!));
    await until("› / » markers", () => qa("row-pli").some((x) => x.textContent === "»"));
    // Send and archive from a reply.
    click(await until("a conversation", () => row("Your application")));
    await el("conversation");
    click(await el("reply"));
    const box = await el("inline-compose");
    setHtml(await el("compose-body", box), "<div>Thanks for confirming.</div>");
    click(await el("compose-send-archive", box));
    await until("the reply sent", () => sentWith("Re: Your application"), 30_000);
    await until(
      "the conversation archived",
      async () => ((await server()).gmailMessages.filter((m) => m.subject === "Your application").every((m) => !m.labels.includes("INBOX")) ? true : null),
      20_000,
    );
  } finally {
    await setSetting("buttonLabels", "icons");
    await setSetting("personalIndicators", false);
    await setSetting("sendAndArchive", false);
  }
  await backToInbox();
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

step(
  "offline: a delete is made at once and waits, Undo takes it back, and it reaches the server when back online",
  async () => {
    await backToInbox();
    for (const subject of ["Deleted while offline", "Undone while offline"])
      await api.e2eControl("deliver-gmail", { from: "Offline Test <offline@test.example>", subject, body: "Changed with no connection." });
    await until("the test rows", () => row("Deleted while offline") && row("Undone while offline"), 30_000);
    const gone = row("Deleted while offline")!.dataset.thread!;
    const inInbox = async (subject: string) => (await msgsWith(subject)).every((m) => m.labels.includes("INBOX") && !m.labels.includes("TRASH"));
    await api.e2eControl("offline", { on: true });
    try {
      // Delete, then Undo before the connection is back: the row comes back and nothing is left to send.
      click(await el("hover-delete", row("Undone while offline")!));
      const queued = await until("the toast says when", () => toastWith(/^Conversation moved to Trash\. It'll sync when you're back online\./), 20_000);
      await until("the row leaves", () => !row("Undone while offline"));
      click(await el("toast-action", queued));
      await until("Undo brings the row back", () => row("Undone while offline"), 20_000);
      // Delete and leave it: gone here, still in the Inbox on the server, and a sync attempt doesn't bring it back.
      click(await el("hover-delete", row("Deleted while offline")!));
      await until("the toast says when", () => toastWith(/^Conversation moved to Trash\. It'll sync when you're back online\./), 20_000);
      await until("the row leaves", () => !row("Deleted while offline"));
      await until("offline shown", () => getState().online === false);
      await api.e2eControl("sync");
      await sleep(1500);
      check(!row("Deleted while offline"), "the deleted row came back while offline");
      check((await inInbox("Deleted while offline")) && (await inInbox("Undone while offline")), "the server changed while offline");
    } finally {
      await api.e2eControl("offline", { on: false });
    }
    const rec = recordFrames();
    await api.e2eControl("sync");
    await until("in Trash on the server", async () => (await msgsWith("Deleted while offline")).every((m) => m.labels.includes("TRASH")) || null, 40_000);
    await until("online again", () => getState().online === true, 40_000);
    await sleep(2500);
    const back = rec.stop().frames.find((f) => f.rows.includes(gone));
    check(!back, `the deleted row came back at +${back?.t} ms after reconnecting`);
    check(await inInbox("Undone while offline"), "the undone delete reached the server");
    check(row("Undone while offline") && !row("Deleted while offline"), "the Inbox doesn't match");
  },
  120_000,
);

step(
  "every button and menu item does something: list toolbar, conversation, message and their menus",
  async () => {
    await backToInbox();
    await api.e2eControl("deliver-gmail", { from: "Sweep Target <sweep@test.example>", subject: "Sweep target", body: "Something to act on." });
    await until("the target", () => row("Sweep target"), 30_000);
    const original = async () => (await msgsWith("Sweep target")).map((m) => m.labels.slice().sort().join()).join("|");
    const start = await original();
    const dead: string[] = [];
    const broken: string[] = [];
    const SKIP = /print|new window|download|share|delete forever|add to calendar|report phishing/i;
    const snap = async () =>
      JSON.stringify({
        hash: location.hash,
        toasts: qa("toast").map((t) => t.firstChild?.textContent),
        dialogs: document.querySelectorAll("[role=dialog],[role=alertdialog]").length,
        menus: [...document.querySelectorAll<HTMLElement>(".menu, [role=menu], [role=listbox], .popover")].map(
          (m) => m.getAttribute("aria-label") ?? m.textContent?.slice(0, 40),
        ),
        selected: getState().selected.length,
        composes: getState().composes.length,
        ui: getState().ui,
        settings: getState().settings,
        details: !!document.querySelector(".details-pop, [data-testid=details]"),
        server: await original(),
      });
    const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        const cancel =
          q("confirm-cancel") ??
          [...document.querySelectorAll<HTMLElement>("[role=dialog] button, [role=alertdialog] button")].find((b) =>
            /^(Cancel|Close)$/.test(b.textContent?.trim() ?? ""),
          );
        if (cancel) click(cancel);
        else if (document.querySelector("[role=dialog],[role=alertdialog],.menu")) escape();
        await sleep(120);
      }
      for (const w of qa("compose-window")) click(await el("compose-discard", w));
      const inline = q("inline-compose");
      if (inline) click(await el("compose-discard", inline));
      if (getState().route.settings) click(await el("settings-close"));
      const undo = qa("toast-action").find((b) => b.textContent === "Undo");
      if (undo) click(undo);
      // Whatever Undo didn't cover (a star, a label), straight through the API, so the next button starts clean.
      await until("the target as it was", async () => ((await original()) === start ? true : null), undo ? 6000 : 1500).catch(async () => {
        const want = start.split("|")[0].split(",");
        for (const m of await msgsWith("Sweep target")) {
          const acct = getState().accounts.find((a) => a.kind === "gmail")!.id;
          await api.modifyMessages(
            acct,
            [m.id],
            want.filter((l) => !m.labels.includes(l)),
            m.labels.filter((l) => !want.includes(l)),
          );
        }
        await until("the target as it was", async () => ((await original()) === start ? true : null), 10_000).catch(() =>
          broken.push("couldn't put the target back"),
        );
      });
      await api.mute(getState().accounts.find((a) => a.kind === "gmail")!.id, [(await msgsWith("Sweep target"))[0].threadId], false);
      for (const t of qa("toast")) q("toast-close", t) && click(q("toast-close", t)!);
    };
    const press = async (where: string, b: HTMLElement) => {
      const name = (b.getAttribute("aria-label") || b.querySelector(":scope > span:not(.ic)")?.textContent || b.dataset.testid || b.textContent || "").trim();
      if (!name || SKIP.test(name) || (b as HTMLButtonElement).disabled) return;
      const before = await snap();
      const errors = appErrors.length;
      click(b);
      let changed = false;
      for (let i = 0; i < 10 && !changed; i++) {
        await sleep(150);
        changed = (await snap()) !== before;
      }
      if (!changed) dead.push(`${where}: ${name}`);
      if (appErrors.length > errors) broken.push(`${where}: ${name} threw ${appErrors[appErrors.length - 1]}`);
      await settle();
    };
    const buttons = (root: Element | null) => [...(root?.querySelectorAll<HTMLElement>("button, [role=button]") ?? [])].filter((b) => b.offsetParent !== null);
    const menuItems = () => [...document.querySelectorAll<HTMLElement>(".menu .menu-item")].filter((b) => !b.classList.contains("disabled"));
    const sweepMenu = async (where: string, open: () => Promise<void>) => {
      await open();
      const names = menuItems().map((m) => m.textContent?.trim() ?? "");
      escape();
      await sleep(120);
      for (const n of names) {
        await open();
        const item = menuItems().find((m) => m.textContent?.trim() === n);
        if (item && !item.querySelector(".submenu-arrow, [data-submenu]")) await press(where, item);
        else escape();
        await sleep(80);
      }
    };
    const selectTarget = async () => {
      await backToInbox();
      if (!getState().selected.length) click(await el("row-checkbox", await until("target row", () => row("Sweep target"), 15_000)));
      await until("selected", () => getState().selected.length === 1);
    };
    // The list toolbar with the target ticked, then its More menu.
    await selectTarget();
    const tbNames = buttons(q("list-view")?.querySelector(".toolbar") ?? null)
      .map((b) => b.dataset.testid)
      .filter((t): t is string => !!t && t !== "tb-more" && !t.startsWith("page-"));
    for (const t of tbNames) {
      await selectTarget();
      const b = q(t);
      if (b) await press("list toolbar", b);
    }
    await sweepMenu("list toolbar ▸ More", async () => {
      await selectTarget();
      click(await el("tb-more"));
      await until("the menu", () => menuItems().length);
    });
    // The open conversation: its toolbar, its More menu, the message's own buttons and menu.
    const openTarget = async () => {
      if (q("conv-subject")?.textContent?.includes("Sweep target")) return;
      await backToInbox();
      click(await until("target row", () => row("Sweep target"), 15_000));
      await until("open", () => q("conv-subject")?.textContent?.includes("Sweep target"));
    };
    await openTarget();
    const convNames = buttons(q("conversation")?.querySelector(".conv-toolbar") ?? null)
      .map((b) => b.dataset.testid)
      .filter((t): t is string => !!t && t !== "conv-more");
    for (const t of convNames) {
      await openTarget();
      const b = q(t);
      if (b) await press("conversation toolbar", b);
    }
    await sweepMenu("conversation ▸ More", async () => {
      await openTarget();
      click(await el("conv-more"));
      await until("the menu", () => menuItems().length);
    });
    for (const t of ["msg-star", "msg-reply", "msg-details", "reply", "reply-all", "forward"]) {
      await openTarget();
      const b = q(t);
      if (b) await press("message", b);
    }
    await sweepMenu("message ▸ More", async () => {
      await openTarget();
      click(await el("msg-more"));
      await until("the menu", () => menuItems().length);
    });
    // A row's right-click menu.
    await sweepMenu("row menu", async () => {
      await backToInbox();
      const r = await until("target row", () => row("Sweep target"), 15_000);
      const box = r.getBoundingClientRect();
      r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 300, clientY: box.top + 10 }));
      await until("the menu", () => menuItems().length);
    });
    // The header: menu, search options, quick settings, help and its items, the account menu.
    for (const t of ["main-menu", "search-options", "settings-gear", "account-button"]) {
      await backToInbox();
      const b = q(t);
      if (b) await press("header", b);
      if (t === "main-menu" && !getState().settings.navOpen) await setSetting("navOpen", true);
    }
    await sweepMenu("header ▸ Help", async () => {
      await backToInbox();
      click(await until("help", () => document.querySelector<HTMLElement>('[aria-label="Support"], [aria-label="Help"]')));
      await until("the menu", () => menuItems().length);
    });
    // A label's ⋮ menu in the nav.
    await sweepMenu("label menu", async () => {
      await backToInbox();
      // Undo what the last item did to the label (hidden, recoloured), so it can be found again.
      const acct = getState().accounts.find((a) => a.kind === "gmail")!.id;
      await api.labelUpdate(acct, "Label_1", { labelListVisibility: "labelShow", messageListVisibility: "show" }).catch(() => {});
      await loadLabels(acct);
      click(await until("the label's options", () => document.querySelector<HTMLElement>('[aria-label="Options for Projects"]')));
      await until("the menu", () => menuItems().length);
    });
    // A new message: every button but Send and the file pickers, with text selected for the formatting ones.
    const compose = async () => {
      const w = qa("compose-window")[0] ?? (await newCompose());
      // A minimised window shows only its title bar; clicking it brings the message back.
      if (getState().composes.find((c) => c.placement === "dock")?.minimized) click(await el("compose-head", w));
      const body = await el("compose-body", w);
      if (!body.textContent?.includes("Sweep text")) setHtml(body, "<div>Sweep text</div>");
      const r = document.createRange();
      r.selectNodeContents(body);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      return w;
    };
    const composeSnap = () =>
      JSON.stringify([
        q("compose-body")?.innerHTML,
        !!q("fmt-bold"),
        getState().composes.map((c) => [c.minimized, c.fullscreen, c.showCc, c.showBcc, c.plain]),
      ]);
    const w = await compose();
    if (!q("fmt-bold", w)) click(await el("compose-format", w));
    const composeIds = buttons(w)
      .map((b) => b.dataset.testid)
      .filter((t): t is string => !!t && !/compose-send|send-options|compose-attach|compose-photo|compose-discard|compose-close/.test(t));
    for (const t of composeIds) {
      const cw = await compose();
      if (!q("fmt-bold", cw) && t.startsWith("fmt-")) click(await el("compose-format", cw));
      const b = q(t, cw);
      if (!b || (b as HTMLButtonElement).disabled) continue;
      const before = composeSnap() + (await snap());
      click(b);
      let changed = false;
      for (let i = 0; i < 8 && !changed; i++) {
        await sleep(120);
        changed = composeSnap() + (await snap()) !== before;
      }
      if (!changed) dead.push(`compose: ${b.getAttribute("aria-label") ?? t}`);
      escape();
      for (const c of qa("confirm-cancel")) click(c);
      for (const d of [...document.querySelectorAll<HTMLElement>("[role=dialog] button")].filter((x) => /^(Cancel|Close)$/.test(x.textContent?.trim() ?? "")))
        click(d);
      const cwin = qa("compose-window")[0];
      if (cwin) {
        const st = getState().composes.find((c) => c.placement === "dock");
        if (st?.minimized) click(await el("compose-head", cwin));
        if (st?.fullscreen) click(await el("compose-fullscreen", cwin));
        setHtml(await el("compose-body", cwin), "<div>Sweep text</div>");
      }
      await sleep(100);
    }
    for (const cw of qa("compose-window")) click(await el("compose-discard", cw));
    await backToInbox();
    check(!dead.length && !broken.length, [...broken, ...dead.map((d) => `did nothing: ${d}`)].join("\n    "));
  },
  360_000,
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
/** Every toast shown during the run: none may carry a server's or a library's own error text. */
const toastsSeen = new Set<string>();
const RAW_ERROR =
  /\b[45]\d\d:|\([45]\d\d\)|precondition|failedPrecondition|error sending request|^(server|network|imap|smtp|json|io|database|not found):|\bat line\b/i;

export async function runE2E() {
  new MutationObserver(() => qa("toast").forEach((t) => toastsSeen.add(t.firstChild?.textContent ?? t.textContent ?? ""))).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  if (started) return;
  started = true;
  window.addEventListener("error", (e) => appErrors.push(`${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string } | string | undefined;
    appErrors.push(`unhandled rejection: ${typeof r === "string" ? r : (r?.message ?? JSON.stringify(r))}`);
  });
  const t0 = Date.now();
  const results: StepResult[] = [];
  // COURIER_E2E_ONLY=word,word runs the account setup (the first five steps) and the steps whose names match.
  const only = ((await api.e2eInfo()) as Record<string, string>).only?.split(",").filter(Boolean) ?? [];
  if (only.length) steps.splice(0, steps.length, ...steps.filter((s, i) => i < 5 || only.some((w) => s.name.includes(w))));
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
  const raw = [...toastsSeen].filter((t) => RAW_ERROR.test(t));
  results.push({ name: "no toast showed a raw error", ok: raw.length === 0, ms: 0, error: raw.length ? raw.slice(0, 5).join(" | ") : undefined });
  log(`${raw.length ? "  FAILED" : "  ok"} no toast showed a raw error${raw.length ? `: ${raw.slice(0, 5).join(" | ")}` : ""}`);
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
