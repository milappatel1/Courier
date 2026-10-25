// Keyboard shortcuts: the full single-key set plus "g then …" and "* then …" sequences.
// Pure — the UI feeds key events in and gets action ids out.

export type ShortcutAction =
  | "compose"
  | "compose-window"
  | "search"
  | "help"
  | "older"
  | "newer"
  | "open"
  | "back"
  | "next-message"
  | "prev-message"
  | "next-section"
  | "prev-section"
  | "select"
  | "star"
  | "archive"
  | "mute"
  | "spam"
  | "delete"
  | "reply"
  | "reply-window"
  | "reply-all"
  | "reply-all-window"
  | "forward"
  | "forward-window"
  | "refresh"
  | "archive-older"
  | "archive-newer"
  | "undo"
  | "mark-read"
  | "mark-unread"
  | "mark-unread-from-here"
  | "important"
  | "not-important"
  | "snooze"
  | "expand-all"
  | "collapse-all"
  | "more-actions"
  | "label-as"
  | "move-to"
  | "toolbar-focus"
  | "go-inbox"
  | "go-starred"
  | "go-snoozed"
  | "go-sent"
  | "go-drafts"
  | "go-all"
  | "go-label"
  | "go-next-page"
  | "go-prev-page"
  | "go-list"
  | "go-settings"
  | "select-all"
  | "select-none"
  | "select-read"
  | "select-unread"
  | "select-starred"
  | "select-unstarred";

export interface ShortcutDef {
  keys: string; // "c", "Shift+I", "g i", "* a", "#"
  action: ShortcutAction;
  label: string;
  group: "Jumping" | "Threadlist selection" | "Navigation" | "Application" | "Actions";
}

export const SHORTCUTS: ShortcutDef[] = [
  { keys: "c", action: "compose", label: "Compose", group: "Application" },
  { keys: "d", action: "compose-window", label: "Compose in a new window", group: "Application" },
  { keys: "/", action: "search", label: "Search mail", group: "Application" },
  { keys: "?", action: "help", label: "Open keyboard shortcut help", group: "Application" },
  { keys: ".", action: "more-actions", label: 'Open "more actions" menu', group: "Application" },
  { keys: "v", action: "move-to", label: 'Open "move to" menu', group: "Application" },
  { keys: "l", action: "label-as", label: 'Open "label as" menu', group: "Application" },
  { keys: "k", action: "newer", label: "Newer conversation", group: "Navigation" },
  { keys: "j", action: "older", label: "Older conversation", group: "Navigation" },
  { keys: "o", action: "open", label: "Open conversation", group: "Navigation" },
  { keys: "Enter", action: "open", label: "Open conversation", group: "Navigation" },
  { keys: "u", action: "back", label: "Back to threadlist", group: "Navigation" },
  { keys: "n", action: "next-message", label: "Next message in open conversation", group: "Navigation" },
  { keys: "p", action: "prev-message", label: "Previous message in open conversation", group: "Navigation" },
  { keys: "`", action: "next-section", label: "Go to next inbox section", group: "Navigation" },
  { keys: "~", action: "prev-section", label: "Go to previous inbox section", group: "Navigation" },
  { keys: ",", action: "toolbar-focus", label: "Move focus to toolbar", group: "Actions" },
  { keys: "x", action: "select", label: "Select conversation", group: "Actions" },
  { keys: "s", action: "star", label: "Toggle star / rotate among stars", group: "Actions" },
  { keys: "e", action: "archive", label: "Archive", group: "Actions" },
  { keys: "m", action: "mute", label: "Mute conversation", group: "Actions" },
  { keys: "!", action: "spam", label: "Report as spam", group: "Actions" },
  { keys: "#", action: "delete", label: "Delete", group: "Actions" },
  { keys: "r", action: "reply", label: "Reply", group: "Actions" },
  { keys: "Shift+R", action: "reply-window", label: "Reply in a new window", group: "Actions" },
  { keys: "a", action: "reply-all", label: "Reply all", group: "Actions" },
  { keys: "Shift+A", action: "reply-all-window", label: "Reply all in a new window", group: "Actions" },
  { keys: "f", action: "forward", label: "Forward", group: "Actions" },
  { keys: "Shift+F", action: "forward-window", label: "Forward in a new window", group: "Actions" },
  { keys: "Shift+N", action: "refresh", label: "Update conversation", group: "Actions" },
  { keys: "]", action: "archive-older", label: "Archive and go to older", group: "Actions" },
  { keys: "[", action: "archive-newer", label: "Archive and go to newer", group: "Actions" },
  { keys: "z", action: "undo", label: "Undo last action", group: "Actions" },
  { keys: "Shift+I", action: "mark-read", label: "Mark as read", group: "Actions" },
  { keys: "Shift+U", action: "mark-unread", label: "Mark as unread", group: "Actions" },
  { keys: "_", action: "mark-unread-from-here", label: "Mark unread from the selected message", group: "Actions" },
  { keys: "+", action: "important", label: "Mark as important", group: "Actions" },
  { keys: "=", action: "important", label: "Mark as important", group: "Actions" },
  { keys: "-", action: "not-important", label: "Mark as not important", group: "Actions" },
  { keys: "b", action: "snooze", label: "Snooze", group: "Actions" },
  { keys: ";", action: "expand-all", label: "Expand entire conversation", group: "Actions" },
  { keys: ":", action: "collapse-all", label: "Collapse entire conversation", group: "Actions" },
  { keys: "g i", action: "go-inbox", label: "Go to Inbox", group: "Jumping" },
  { keys: "g s", action: "go-starred", label: "Go to Starred conversations", group: "Jumping" },
  { keys: "g b", action: "go-snoozed", label: "Go to Snoozed conversations", group: "Jumping" },
  { keys: "g t", action: "go-sent", label: "Go to Sent messages", group: "Jumping" },
  { keys: "g d", action: "go-drafts", label: "Go to Drafts", group: "Jumping" },
  { keys: "g a", action: "go-all", label: "Go to All Mail", group: "Jumping" },
  { keys: "g l", action: "go-label", label: "Go to label", group: "Jumping" },
  { keys: "g n", action: "go-next-page", label: "Go to next page", group: "Jumping" },
  { keys: "g p", action: "go-prev-page", label: "Go to previous page", group: "Jumping" },
  { keys: "g u", action: "go-list", label: "Back to threadlist", group: "Jumping" },
  { keys: "g e", action: "go-settings", label: "Go to Settings", group: "Jumping" },
  { keys: "* a", action: "select-all", label: "Select all conversations", group: "Threadlist selection" },
  { keys: "* n", action: "select-none", label: "Deselect all conversations", group: "Threadlist selection" },
  { keys: "* r", action: "select-read", label: "Select read conversations", group: "Threadlist selection" },
  { keys: "* u", action: "select-unread", label: "Select unread conversations", group: "Threadlist selection" },
  { keys: "* s", action: "select-starred", label: "Select starred conversations", group: "Threadlist selection" },
  { keys: "* t", action: "select-unstarred", label: "Select unstarred conversations", group: "Threadlist selection" },
];

/** Compose-window and formatting shortcuts (always on; listed in the help sheet). */
export const COMPOSE_SHORTCUTS: [string, string][] = [
  ["⌘Enter", "Send"],
  ["⌘⇧C", "Add Cc recipients"],
  ["⌘⇧B", "Add Bcc recipients"],
  ["⌘⇧F", "Change the From address"],
  ["⌘K", "Insert a link"],
  ["⌘B / ⌘I / ⌘U", "Bold / italic / underline"],
  ["⌘⇧7", "Numbered list"],
  ["⌘⇧8", "Bulleted list"],
  ["⌘⇧9", "Quote"],
  ["⌘[ / ⌘]", "Indent less / more"],
  ["⌘⇧L / ⌘⇧E / ⌘⇧R", "Align left / centre / right"],
  ["⌘⇧X", "Strikethrough"],
  ["⌘\\", "Remove formatting"],
  ["⌘⇧D", "Discard draft"],
];

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** "Shift+I" for uppercase letters, the bare key for punctuation ("#", "!", "?"). */
export function keyName(e: KeyLike): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const k = e.key;
  if (k.length === 1 && /[A-Z]/.test(k)) return `Shift+${k}`;
  if (k.length === 1) return k.toLowerCase();
  if (k === "Enter") return "Enter";
  return null;
}

export class ShortcutMatcher {
  private pending: string | null = null;
  private pendingAt = 0;
  private readonly byKeys = new Map<string, ShortcutAction>();
  /** First keys of two-key sequences ("g", "*", or a custom one). */
  private readonly prefixes = new Set<string>();
  constructor(
    defs: ShortcutDef[] = SHORTCUTS,
    private timeoutMs = 2000,
  ) {
    for (const d of defs) {
      this.byKeys.set(d.keys, d.action);
      if (d.keys.includes(" ")) this.prefixes.add(d.keys.split(" ")[0]);
    }
  }
  /** Returns the action for this key, "pending" inside a sequence, or null. */
  feed(e: KeyLike, now = Date.now()): ShortcutAction | "pending" | null {
    const k = keyName(e);
    if (!k) {
      this.pending = null;
      return null;
    }
    if (this.pending && now - this.pendingAt <= this.timeoutMs) {
      const seq = `${this.pending} ${k}`;
      this.pending = null;
      return this.byKeys.get(seq) ?? null;
    }
    this.pending = null;
    if (this.prefixes.has(k)) {
      this.pending = k;
      this.pendingAt = now;
      return "pending";
    }
    return this.byKeys.get(k) ?? null;
  }
  reset() {
    this.pending = null;
  }
}

/** Keys that must not trigger while typing in a field. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null): boolean {
  if (!el) return false;
  const t = (el.tagName ?? "").toLowerCase();
  if (t === "input" || t === "textarea" || t === "select") return true;
  if (el.isContentEditable) return true;
  return el.getAttribute?.("role") === "textbox";
}

/**
 * The shortcut list with the user's own keys (Settings ▸ Keyboard Shortcuts) in place of the defaults: each action
 * maps to one or more keys, comma-separated ("e, y"); an action left empty keeps its default.
 */
export function withCustomKeys(custom: Record<string, string>): ShortcutDef[] {
  const mine = (d: ShortcutDef) =>
    (custom[d.action] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  // The user's keys go last, so they win over another action's default on the same key.
  return [...SHORTCUTS.filter((d) => !mine(d).length), ...SHORTCUTS.flatMap((d) => mine(d).map((k) => ({ ...d, keys: k })))];
}
