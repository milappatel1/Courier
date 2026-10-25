// The main window: header, navigation, the list / conversation (with the reading-pane split), quick
// settings, compose dock, dialogs and toasts; plus global keyboard shortcuts and native menu commands.
import { useEffect, useRef, useState } from "react";
import { isTypingTarget, ShortcutMatcher, type ShortcutAction } from "./core/shortcuts";
import { api, on, type OpenItem } from "./ipc/api";
import { act, currentTargets, emptyLabel, markUnreadFromHere, selectWhere, toggleStar } from "./state/actions";
import { composeWithFiles, forwardAsAttachment, openCompose, openMailto, openReply } from "./state/compose";
import {
  closeThread,
  getState,
  go,
  loadList,
  openSettings,
  openThread,
  runUndo,
  setAccount,
  setSetting,
  setState,
  applyViewportSize,
  openThreadById,
  stepThread,
  toast,
  toggleNav,
  ui,
  useMail,
  visibleThreads,
  accountById,
  hasTabs,
} from "./state/store";
import { CATEGORIES } from "./core/labels";
import { Dialogs, Toasts } from "./ui/Dialogs";
import { ComposeDock } from "./ui/Compose";
import { Conversation, shareOpenConversation } from "./ui/Conversation";
import { scrollToAnchor } from "./ui/MessageFrame";
import { Header } from "./ui/Header";
import { ListView } from "./ui/ListView";
import { Nav } from "./ui/Nav";
import { QuickSettings, ThemePicker } from "./ui/QuickSettings";
import { SettingsPage } from "./ui/Settings";
import { Subscriptions } from "./ui/Subscriptions";
import { Icon, LogoMark, TooltipHost, Menu } from "./ui/common";
import { SnoozeMenu } from "./ui/menus";

export function App() {
  const ready = useMail((s) => s.ready);
  const accounts = useMail((s) => s.accounts);
  const navOpen = useMail((s) => s.settings.navOpen);
  const qs = useMail((s) => s.ui.quickSettings);
  const themePicker = useMail((s) => s.ui.themePicker);
  const route = useMail((s) => s.route);
  const pane = useMail((s) => s.settings.readingPane);
  const size = useMail((s) => s.size);
  const drawer = useMail((s) => s.drawer);
  const peek = useMail((s) => s.peek);
  useViewportSize();
  useFrameFocusReturn();
  useChromeInset();
  useShortcuts();
  useMenuCommands();
  useOpenItems();
  useFrameAnchors();
  if (!ready) return <div className="app" />;
  if (!accounts.length) {
    return (
      <div className="app no-account">
        <Header />
        <Welcome />
        <Dialogs />
        <Toasts />
        <TooltipHost />
      </div>
    );
  }
  const subs = route.list.label === "SUBSCRIPTIONS" && !route.list.query && !route.thread;
  // The phone layout has no room for a reading pane: a conversation fills the window.
  const split = pane !== "none" && size !== "phone" && !route.settings && !subs && !route.list.query?.startsWith("__");
  const showQs = qs && !route.settings;
  return (
    <div className="app">
      <Header />
      <div
        className={[
          "body",
          size === "phone"
            ? "nav-hidden"
            : size === "medium" || !navOpen
              ? // The rail; the whole menu slides out over the content from the menu button or a resting pointer.
                drawer || peek
                ? "nav-rail"
                : "nav-closed"
              : "",
          (drawer && size !== "wide") || (peek && size !== "phone" && (size === "medium" || !navOpen)) ? "drawer-open" : "",
        ].join(" ")}
      >
        <Nav />
        {drawer && <div className="drawer-scrim" onClick={() => useMail.setState({ drawer: false })} data-testid="drawer-scrim" />}
        <main className={["main", showQs ? "with-qs" : ""].join(" ")} aria-label="Mail">
          {route.settings ? <SettingsPage /> : subs ? <Subscriptions /> : split ? <Split /> : route.thread ? <Conversation /> : <ListView />}
        </main>
        {showQs ? <QuickSettings /> : <span />}
      </div>
      {size === "phone" && !route.thread && !route.settings && !drawer && (
        <button type="button" className="fab" onClick={() => void openCompose()} aria-label="Compose" data-testid="compose-fab">
          <Icon name="edit" size={24} />
          <span>Compose</span>
        </button>
      )}
      <ComposeDock />
      <Dialogs />
      {themePicker && <ThemePicker />}
      <SnoozeShortcutMenu />
      <Toasts />
      <TooltipHost />
    </div>
  );
}

function Split() {
  const pane = useMail((s) => s.settings.readingPane);
  const size = useMail((s) => s.settings.readingPaneSize);
  const thread = useMail((s) => s.route.thread);
  const [drag, setDrag] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const below = pane === "below";
  useEffect(() => {
    if (drag === null) return;
    const move = (e: MouseEvent) => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      setDrag(Math.max(below ? 120 : 320, Math.min(below ? r.height - 120 : r.width - 360, below ? e.clientY - r.top : e.clientX - r.left)));
    };
    const up = () => {
      if (drag !== null) void setSetting("readingPaneSize", Math.round(drag));
      setDrag(null);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [drag, below]);
  const s = drag ?? (below ? Math.min(size, 360) : size);
  return (
    <div ref={box} className={["split", below ? "below" : ""].join(" ")} data-testid="split">
      <div className="pane-list" style={below ? { height: s } : { width: s }}>
        <ListView />
      </div>
      <div className="splitter" role="separator" aria-orientation={below ? "horizontal" : "vertical"} onMouseDown={(e) => (e.preventDefault(), setDrag(s))} />
      <div className="pane-thread">
        {thread ? (
          <Conversation split />
        ) : (
          <div className="pane-empty">
            <Icon name="mail" size={24} />
            No conversations selected
          </div>
        )}
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome" data-testid="welcome">
      <LogoMark size={64} />
      <h1>Welcome to Courier</h1>
      <p>Add an account to get started. Gmail signs in through your browser; other providers use IMAP with an app password.</p>
      <div className="choices">
        <button className="btn filled" onClick={() => ui({ addAccount: { kind: "gmail" } })} data-testid="welcome-gmail">
          Add a Gmail account
        </button>
        <button className="btn outline" onClick={() => ui({ addAccount: { kind: "imap" } })} data-testid="welcome-imap">
          Add another account
        </button>
      </div>
    </div>
  );
}

/** Room for the window's traffic lights in the header (not in full screen or the browser preview). */
/**
 * Clicking into a message's body moves focus into its frame, where WebKit never hands key presses to the app,
 * so shortcuts (e, j, k, r…) would stop working. As soon as the click is over, and unless text is being
 * selected there (to copy), focus comes back to the app — inside the same window, never activating it.
 */
function useFrameFocusReturn() {
  useEffect(() => {
    let timer = 0;
    const check = () => {
      const f = document.activeElement;
      if (!(f instanceof HTMLIFrameElement) || !f.classList.contains("msg-frame")) return void window.clearInterval(timer);
      const sel = f.contentWindow?.getSelection();
      if (!sel || sel.isCollapsed) {
        window.clearInterval(timer);
        f.blur();
      }
    };
    const onBlur = () => {
      window.clearInterval(timer);
      timer = window.setInterval(check, 150);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.clearInterval(timer);
    };
  }, []);
}

/** Follow the window's width: data-size on <html> for the CSS, and the store for layout choices. */
function useViewportSize() {
  useEffect(() => {
    applyViewportSize();
    window.addEventListener("resize", applyViewportSize);
    return () => window.removeEventListener("resize", applyViewportSize);
  }, []);
}

function useChromeInset() {
  useEffect(() => {
    const tauri = "__TAURI_INTERNALS__" in window && !(window as unknown as { __COURIER_PREVIEW__?: boolean }).__COURIER_PREVIEW__;
    if (!tauri) return;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const apply = async () => document.documentElement.style.setProperty("--chrome-left", (await w.isFullscreen().catch(() => false)) ? "0px" : "72px");
      await apply();
      un = await w.onResized(() => void apply());
    });
    return () => un?.();
  }, []);
}

let snoozeOpener: (() => void) | null = null;
function SnoozeShortcutMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    snoozeOpener = () => setOpen(true);
    return () => {
      snoozeOpener = null;
    };
  }, []);
  if (!open) return null;
  return <SnoozeMenu anchor={{ x: window.innerWidth / 2 - 128, y: 120 }} onClose={() => setOpen(false)} />;
}

function openThreadAtCursor() {
  const s = getState();
  const t = visibleThreads()[s.cursor];
  if (t) openThread(t);
}

async function replyTo(kind: "reply" | "reply-all" | "forward") {
  const s = getState();
  let d = s.thread.detail;
  if (!s.route.thread) {
    const t = visibleThreads()[s.cursor];
    if (!t) return;
    openThread(t);
    d = await api.thread(t.accountId, t.threadId);
  }
  const last = d?.messages.filter((m) => !m.labels.includes("DRAFT")).at(-1);
  if (d && last) await openReply(d.accountId, last, kind);
}

/** Edit ▸ Paste and Match Style: the clipboard's text, without its formatting, where the cursor is. */
async function pastePlain() {
  const target = document.activeElement as HTMLElement | null;
  const text = await api.clipboardText().catch(() => null);
  if (!text || !target) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const [a, b] = [target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length];
    target.setRangeText(text, a, b, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (target.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
}

export function runCommand(a: ShortcutAction | string) {
  const s = getState();
  const thread = s.route.thread;
  const list = visibleThreads();
  const cursorThread = list[s.cursor];
  switch (a) {
    case "compose":
      return void openCompose();
    case "compose-window":
      return void api.windowOpen("compose", null, "New Message");
    case "search":
      return ui({ searchFocus: Date.now() });
    case "help":
      return ui({ shortcutsHelp: true });
    case "older":
      if (thread) stepThread(1);
      else setState({ cursor: Math.min(list.length - 1, s.cursor + 1) });
      return;
    case "newer":
      if (thread) stepThread(-1);
      else setState({ cursor: Math.max(0, s.cursor - 1) });
      return;
    case "open":
      return thread ? undefined : openThreadAtCursor();
    case "back":
    case "go-list":
      return thread ? closeThread() : undefined;
    case "select":
      if (cursorThread)
        setState({
          selected: s.selected.includes(cursorThread.threadId) ? s.selected.filter((x) => x !== cursorThread.threadId) : [...s.selected, cursorThread.threadId],
        });
      return;
    case "star": {
      const t = thread ? list.find((x) => x.threadId === thread.threadId) : cursorThread;
      if (t) void toggleStar(t);
      return;
    }
    case "archive":
      return void act("archive");
    case "mute":
      return void act("mute");
    case "spam":
      return void act("spam");
    case "delete":
      return void act(s.route.list.label === "TRASH" ? "delete-forever" : "trash");
    case "reply":
    case "reply-window":
      return void replyTo("reply");
    case "reply-all":
    case "reply-all-window":
      return void replyTo("reply-all");
    case "forward":
    case "forward-window":
      return void replyTo("forward");
    case "forward-attachment":
      if (s.thread.detail)
        void forwardAsAttachment(
          s.thread.detail.accountId,
          s.thread.detail.messages.filter((m) => !m.labels.includes("DRAFT")),
        );
      return;
    case "refresh":
      void api.syncNow(s.accountId === "all" ? null : s.accountId);
      return void loadList();
    case "archive-older":
      return void act("archive", currentTargets(), { advance: "older" });
    case "archive-newer":
      return void act("archive", currentTargets(), { advance: "newer" });
    case "undo":
      return void runUndo();
    case "mark-read":
      return void act("read");
    case "mark-unread":
      return void act("unread");
    case "important":
      return void act("important");
    case "not-important":
      return void act("not-important");
    case "snooze":
      return snoozeOpener?.();
    case "expand-all":
    case "collapse-all":
      window.dispatchEvent(new CustomEvent("courier:expand-all", { detail: a === "expand-all" }));
      return;
    case "next-section":
    case "prev-section": {
      // With inbox tabs, the next or previous tab.
      if (thread || s.route.list.label !== "INBOX" || s.route.list.query || !hasTabs()) return;
      const cats = s.settings.categories;
      const tabs: string[] = CATEGORIES.filter((c) => c.key === "primary" || cats[c.key as keyof typeof cats]).map((c) => c.key);
      const at = tabs.indexOf(s.route.list.category ?? "primary");
      return go({ label: "INBOX", category: tabs[(at + (a === "next-section" ? 1 : tabs.length - 1)) % tabs.length] });
    }
    case "mark-unread-from-here": {
      // From the message at the top of the conversation's view.
      const d = s.thread.detail;
      if (!thread || !d) return;
      const shown = [...document.querySelectorAll<HTMLElement>('[data-testid="message"]')];
      const below = shown.findIndex((m) => m.getBoundingClientRect().top > 120);
      const el = below === -1 ? shown.at(-1) : shown[Math.max(0, below - 1)];
      const i = d.messages.findIndex((m) => m.id === el?.dataset.message);
      return void markUnreadFromHere(thread, i === -1 ? d.messages.length - 1 : i);
    }
    case "more-actions":
      document.querySelector<HTMLButtonElement>(thread ? '[data-testid="conv-more"]' : '[data-testid="tb-more"]')?.click();
      return;
    case "label-as":
      document.querySelector<HTMLButtonElement>(thread ? '[data-testid="conv-label"]' : '[data-testid="tb-label"]')?.click();
      return;
    case "move-to":
      document.querySelector<HTMLButtonElement>(thread ? '[data-testid="conv-move"]' : '[data-testid="tb-move"]')?.click();
      return;
    case "go-inbox":
      return go({ label: "INBOX" });
    case "go-starred":
      return go({ label: "STARRED" });
    case "go-snoozed":
      return go({ label: "SNOOZED" });
    case "go-sent":
      return go({ label: "SENT" });
    case "go-drafts":
      return go({ label: "DRAFT" });
    case "go-all":
      return go({ label: "ALL" });
    case "go-label": {
      const user = (s.labels[s.accountId] ?? []).filter((x) => x.type === "user");
      return ui({
        ask: {
          title: "Go to label",
          label: "Label name",
          ok: "Go",
          options: user.map((x) => x.name),
          run: (name) => {
            const l = user.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (l) go({ label: l.id });
            else toast(`No label called "${name}".`);
          },
        },
      });
    }
    case "go-next-page":
      if (s.list.result?.hasMore) go({ ...s.route.list, page: s.route.list.page + 1 });
      return;
    case "go-prev-page":
      if (s.route.list.page > 0) go({ ...s.route.list, page: s.route.list.page - 1 });
      return;
    case "go-settings":
      return openSettings();
    case "select-all":
      return selectWhere("all");
    case "select-none":
      return selectWhere("none");
    case "select-read":
      return selectWhere("read");
    case "select-unread":
      return selectWhere("unread");
    case "select-starred":
      return selectWhere("starred");
    case "select-unstarred":
      return selectWhere("unstarred");
    case "toolbar-focus":
      document.querySelector<HTMLElement>(".toolbar button")?.focus();
      return;
    case "next-message":
    case "prev-message": {
      const msgs = [...document.querySelectorAll<HTMLElement>('[data-testid="message"],[data-testid="message-collapsed"]')];
      const top = msgs.findIndex((m) => m.getBoundingClientRect().top > 120);
      const target = a === "next-message" ? (msgs[top + 1] ?? msgs[top]) : msgs[Math.max(0, top - 1)];
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
  }
}

function useShortcuts() {
  useEffect(() => {
    const m = new ShortcutMatcher();
    const down = (e: KeyboardEvent) => {
      const s = getState();
      if (e.key === "Escape") {
        if (s.ui.advancedSearch) return ui({ advancedSearch: false });
        if (s.ui.quickSettings) return ui({ quickSettings: false });
        if (s.selected.length) return setState({ selected: [] });
        return;
      }
      if (
        !s.settings.keyboardShortcuts ||
        isTypingTarget(document.activeElement as HTMLElement) ||
        document.querySelector(".scrim") ||
        document.querySelector(".menu")
      )
        return;
      const action = m.feed(e);
      if (!action) return;
      e.preventDefault();
      if (action === "pending") return;
      runCommand(action);
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);
}

function useMenuCommands() {
  useEffect(() => {
    const p = on<{ id: string }>("menu", ({ id }) => {
      const s = getState();
      if (id.startsWith("account-")) {
        const a = s.accounts[Number(id.slice(8)) - 1];
        if (a) void setAccount(a.id);
        return;
      }
      switch (id) {
        case "settings":
          return openSettings();
        case "default-mail":
          return void api.setDefaultMailApp();
        case "open-eml":
          return void openEmlDialog();
        case "save-eml":
          return document.querySelector<HTMLButtonElement>('[data-testid="msg-more"]')?.click();
        case "print":
          if (s.route.thread) void api.windowOpen("print", s.route.thread, "Print");
          return;
        case "find":
          return ui({ searchFocus: Date.now() });
        case "advanced-search":
          return ui({ advancedSearch: true });
        case "toggle-nav":
          return toggleNav();
        case "pane-none":
          return void setSetting("readingPane", "none");
        case "pane-right":
          return void setSetting("readingPane", "right");
        case "pane-below":
          return void setSetting("readingPane", "below");
        case "density-default":
        case "density-comfortable":
        case "density-compact":
          return void setSetting("density", id.slice(8) as "default");
        case "conversation-view":
          return void setSetting("conversationView", !s.settings.conversationView);
        case "theme-light":
          return void setSetting("theme", "default");
        case "theme-dark":
          return void setSetting("theme", "dark");
        case "themes":
          return ui({ themePicker: true });
        case "all-inboxes":
          return void setAccount("all");
        case "empty-trash":
          if (s.accountId !== "all") void emptyLabel(s.accountId, "TRASH");
          return;
        case "shortcuts":
          return ui({ shortcutsHelp: true });
        case "help":
          return ui({ shortcutsHelp: true });
        case "show-original":
          if (s.thread.detail) {
            const last = s.thread.detail.messages.at(-1);
            if (last) ui({ showOriginal: { accountId: s.thread.detail.accountId, messageId: last.id } });
          }
          return;
        case "unsubscribe":
          document.querySelector<HTMLButtonElement>('[data-testid="unsubscribe"]')?.click();
          return;
        case "share":
          return void shareOpenConversation();
        case "paste-plain":
          return void pastePlain();
        case "spelling":
          document.querySelector<HTMLButtonElement>('[data-testid="compose-more"]')?.click();
          return;
        case "delete":
          return runCommand("delete");
        case "star":
          return runCommand("star");
        case "forward-attachment":
          return runCommand("forward-attachment");
        default:
          return runCommand(id as ShortcutAction);
      }
    });
    return () => void p.then((f) => f());
  }, []);
}

async function openEmlDialog() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ filters: [{ name: "Email message", extensions: ["eml"] }] }).catch(() => null);
  if (typeof path === "string") await api.windowOpen("eml", { path }, path.split("/").pop());
}

/** In-message links to a spot in the same message, reported by the native navigation handler (WebKit). */
function useFrameAnchors() {
  useEffect(() => {
    const p = on<{ id: string }>("frame-anchor", (e) => scrollToAnchor(e.id));
    return () => void p.then((f) => f());
  }, []);
}

function useOpenItems() {
  useEffect(() => {
    const handle = (item: OpenItem) => {
      if (item.kind === "mailto" && item.url) void openMailto(item.url);
      if (item.kind === "eml" && item.path) void api.windowOpen("eml", { path: item.path }, item.path.split("/").pop());
      if (item.kind === "attach" && item.paths?.length) void composeWithFiles(item.paths);
      // A clicked notification: that conversation (or the account's inbox for a summary of several).
      if (item.kind === "thread" && item.accountId) void openThreadById(item.accountId, item.threadId ?? "");
    };
    void api
      .pendingOpens()
      .then((list) => list.forEach(handle))
      .catch(() => {});
    const p = on<OpenItem>("open-item", (item) => {
      handle(item);
      void api.pendingOpens();
    });
    return () => void p.then((f) => f());
  }, []);
}

export { currentTargets, accountById, Menu };
