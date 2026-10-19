// Settings with their defaults. Stored per key in the Rust key–value table (settings_set) so they survive
// restarts and the Rust side can read the ones it needs (notifications, categories, badge, offline).

export type Density = "default" | "comfortable" | "compact";
export type ReadingPane = "none" | "right" | "below";
export type InboxType = "default" | "important" | "unread" | "starred" | "priority" | "multiple";

export interface PrioritySection {
  kind: "important-unread" | "important" | "unread" | "starred" | "label" | "everything";
  label?: string;
  max: number;
}

export interface MultiSection {
  name: string;
  query: string;
}

export interface FontStyle {
  family: string; // key of FONTS
  size: "small" | "normal" | "large" | "huge";
  color: string;
}

export interface Settings {
  language: string;
  pageSize: number;
  undoSendSeconds: number;
  defaultReply: "reply" | "reply-all";
  hoverActions: boolean;
  /** Toolbar with every action (Snooze and Label as next to Move to); off = the simplified toolbar. */
  advancedToolbar: boolean;
  sendAndArchive: boolean;
  defaultFont: FontStyle;
  images: "always" | "ask";
  conversationView: boolean;
  stars: string[];
  keyboardShortcuts: boolean;
  buttonLabels: "icons" | "text";
  autoContacts: boolean;
  personalIndicators: boolean;
  snippets: boolean;
  notifications: { mode: "all" | "important" | "off"; accounts: Record<string, boolean>; labels: Record<string, Record<string, boolean>> };
  inboxType: InboxType;
  categories: Record<"social" | "promotions" | "updates" | "forums", boolean>;
  includeStarredInPrimary: boolean;
  readingPane: ReadingPane;
  readingPaneSize: number; // px of the list (right) or list height (below)
  importanceMarkers: boolean;
  prioritySections: PrioritySection[];
  multipleInboxes: { sections: MultiSection[]; position: "right" | "above" | "below"; max: number };
  autoAdvance: "newer" | "older" | "list";
  templates: boolean;
  badge: { enabled: boolean; primaryOnly: boolean };
  offline: { enabled: boolean; days: number };
  theme: string;
  customImage: string | null;
  density: Density;
  navOpen: boolean;
  unifiedInbox: boolean;
  compose: { fullScreenDefault: boolean; plainTextDefault: boolean };
  syncSeconds: number;
  alwaysShowRemoteFrom: string[];
  vacation?: unknown;
}

export const DEFAULTS: Settings = {
  language: "en",
  pageSize: 50,
  undoSendSeconds: 5,
  defaultReply: "reply",
  hoverActions: true,
  advancedToolbar: false,
  sendAndArchive: false,
  defaultFont: { family: "sans", size: "normal", color: "#222222" },
  images: "ask",
  conversationView: true,
  stars: ["yellow-star"],
  keyboardShortcuts: true,
  buttonLabels: "icons",
  autoContacts: true,
  personalIndicators: false,
  snippets: true,
  notifications: { mode: "all", accounts: {}, labels: {} },
  inboxType: "default",
  categories: { social: true, promotions: true, updates: true, forums: false },
  includeStarredInPrimary: false,
  readingPane: "none",
  readingPaneSize: 520,
  importanceMarkers: false,
  prioritySections: [
    { kind: "important-unread", max: 25 },
    { kind: "starred", max: 25 },
    { kind: "everything", max: 50 },
  ],
  multipleInboxes: {
    sections: [
      { name: "Starred", query: "is:starred" },
      { name: "Drafts", query: "is:draft" },
    ],
    position: "right",
    max: 9,
  },
  autoAdvance: "list",
  templates: false,
  badge: { enabled: true, primaryOnly: true },
  offline: { enabled: true, days: 30 },
  theme: "default",
  customImage: null,
  density: "default",
  navOpen: true,
  unifiedInbox: false,
  compose: { fullScreenDefault: false, plainTextDefault: false },
  syncSeconds: 60,
  alwaysShowRemoteFrom: [],
};

export function mergeSettings(stored: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in DEFAULTS) || v === null || v === undefined) continue;
    const d = (DEFAULTS as unknown as Record<string, unknown>)[k];
    out[k] = d && typeof d === "object" && !Array.isArray(d) && typeof v === "object" && !Array.isArray(v) ? { ...(d as object), ...(v as object) } : v;
  }
  return out as unknown as Settings;
}

/** Compose fonts ("Sans Serif" etc.) → CSS stacks. */
export const FONTS: Record<string, { label: string; css: string }> = {
  sans: { label: "Sans Serif", css: "Arial, Helvetica, sans-serif" },
  serif: { label: "Serif", css: '"Times New Roman", Times, serif' },
  fixed: { label: "Fixed Width", css: '"Courier New", Courier, monospace' },
  wide: { label: "Wide", css: '"Arial Black", Arial, sans-serif' },
  narrow: { label: "Narrow", css: '"Arial Narrow", Arial, sans-serif' },
  comic: { label: "Comic Sans MS", css: '"Comic Sans MS", "Chalkboard SE", cursive' },
  garamond: { label: "Garamond", css: "Garamond, serif" },
  georgia: { label: "Georgia", css: "Georgia, serif" },
  tahoma: { label: "Tahoma", css: "Tahoma, Verdana, sans-serif" },
  trebuchet: { label: "Trebuchet MS", css: '"Trebuchet MS", sans-serif' },
  verdana: { label: "Verdana", css: "Verdana, Geneva, sans-serif" },
};

/** Compose sizes map to execCommand fontSize steps and CSS. */
export const SIZES: Record<FontStyle["size"], { label: string; step: string; css: string }> = {
  small: { label: "Small", step: "1", css: "x-small" },
  normal: { label: "Normal", step: "2", css: "small" },
  large: { label: "Large", step: "4", css: "large" },
  huge: { label: "Huge", step: "6", css: "xx-large" },
};

/** Star types, in their rotation order when several are in use. */
export const STAR_TYPES: { id: string; label: string; icon: string; color: string; fill?: boolean }[] = [
  { id: "yellow-star", label: "yellow star", icon: "star", color: "#f4b400", fill: true },
  { id: "orange-star", label: "orange star", icon: "star", color: "#f57c00", fill: true },
  { id: "red-star", label: "red star", icon: "star", color: "#db4437", fill: true },
  { id: "purple-star", label: "purple star", icon: "star", color: "#9c27b0", fill: true },
  { id: "blue-star", label: "blue star", icon: "star", color: "#4285f4", fill: true },
  { id: "green-star", label: "green star", icon: "star", color: "#0f9d58", fill: true },
  { id: "red-bang", label: "red bang", icon: "error", color: "#db4437", fill: true },
  { id: "orange-guillemet", label: "orange guillemet", icon: "keyboard_double_arrow_right", color: "#f57c00" },
  { id: "yellow-bang", label: "yellow bang", icon: "error", color: "#f4b400", fill: true },
  { id: "green-check", label: "green check", icon: "check_circle", color: "#0f9d58", fill: true },
  { id: "blue-info", label: "blue info", icon: "info", color: "#4285f4", fill: true },
  { id: "purple-question", label: "purple question", icon: "help", color: "#9c27b0", fill: true },
];

/** Next star type when clicking a star repeatedly (null = unstarred). */
export function nextStar(current: string | null, inUse: string[]): string | null {
  const list = inUse.length ? inUse : ["yellow-star"];
  if (!current) return list[0];
  const i = list.indexOf(current);
  if (i < 0 || i === list.length - 1) return null;
  return list[i + 1];
}
