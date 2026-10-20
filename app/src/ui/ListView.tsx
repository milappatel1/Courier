// The thread list: toolbar (select, refresh, selection actions, paging), category tabs, inbox-type
// sections, rows (checkbox, star, importance, participants, label chips, subject + snippet, attachment
// chips, date / hover actions), select-all banner, search chips, empty states.
import { useEffect, useMemo, useRef, useState } from "react";
import { listDate, scheduledWhen, shortWhen } from "../core/dates";
import { chipState, setChip, TIME_CHIPS } from "../core/search/advanced";
import { parseQuery } from "../core/search/parser";
import { participants as summarize } from "../core/threading";
import { CATEGORIES, chipStyle, isSystemLabel } from "../core/labels";
import { api } from "../ipc/api";
import type { Label, ThreadSummary, ViewQuery, ViewResult } from "../ipc/types";
import {
  act,
  allExceptSelected,
  allMatchingTargets,
  BULK_KINDS,
  bulkAct,
  currentTargets,
  emptyLabel,
  selectAllMatching,
  selectWhere,
  toggleImportant,
  toggleSelect,
  toggleStar,
} from "../state/actions";
import { forwardAsAttachment, openReply } from "../state/compose";
import { STAR_TYPES, SWIPE_ACTIONS, type SwipeAction } from "../state/settings";
import {
  accountById,
  currentView,
  go,
  hasTabs,
  loadList,
  openThread,
  SYSTEM_DISPLAY,
  ui,
  useMail,
  visibleThreads,
  getState,
  labelName,
  search,
  setState,
  setSetting,
  NO_LABELS,
} from "../state/store";
import { Avatar, FileIcon, Icon, IconButton, Menu, MenuButton, anchorOf, type MenuEntry } from "./common";
import { FilterDialog } from "./FilterDialog";
import { LabelAsBody, LabelAsMenu, MoveToMenu, SnoozeMenu } from "./menus";

type Anchor = ReturnType<typeof anchorOf>;

export function ListView() {
  const route = useMail((s) => s.route);
  const list = useMail((s) => s.list);
  const inboxType = useMail((s) => s.settings.inboxType);
  const accountId = useMail((s) => s.accountId);
  const showTabs = useMail(() => hasTabs()) && route.list.label === "INBOX" && !route.list.query;
  const sections = route.list.label === "INBOX" && !route.list.query && inboxType !== "default" && accountId !== "all";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="list-view">
      {route.list.query && <SearchChips query={route.list.query} />}
      <div className="phone-title" data-testid="phone-title">
        {route.list.query
          ? "Search results"
          : route.list.label === "INBOX" && showTabs
            ? (CATEGORIES.find((c) => c.key === (route.list.category ?? "primary"))?.name ?? "Inbox")
            : labelName(accountId === "all" ? "" : accountId, route.list.label ?? "INBOX")}
      </div>
      <ListToolbar />
      <SelectAllBanner />
      <EmptyBinBanner />
      {showTabs && <CategoryTabs />}
      {list.loading && <div className="loading-bar" />}
      <div className="list" role="grid" aria-label="Conversations" data-testid="thread-list">
        {sections ? <InboxSections /> : <Rows threads={null} />}
        {list.error && <div className="empty">{list.error}</div>}
      </div>
    </div>
  );
}

/** "1–50 of 1,234" for the rows shown (conversations on their way out of the view don't count). */
/** Above Trash and Spam: what happens to mail there, and a way to empty it now. */
function EmptyBinBanner() {
  const route = useMail((s) => s.route.list);
  const accountId = useMail((s) => s.accountId);
  const any = useMail((s) => (s.list.result?.threads.length ?? 0) > 0);
  const label = route.query ? null : route.label;
  if ((label !== "TRASH" && label !== "SPAM") || accountId === "all") return null;
  const where = label === "TRASH" ? "Trash" : "Spam";
  const gmail = accountById(accountId)?.kind === "gmail";
  if (!gmail && !any) return null;
  return (
    <div className="bin-banner" data-testid="bin-banner">
      {gmail && `Messages that have been in ${where} more than 30 days will be automatically deleted. `}
      {any && (
        <button type="button" className="linkbtn" onClick={() => void emptyLabel(accountId, label)} data-testid="bin-empty">
          {label === "TRASH" ? "Empty Trash now" : "Delete all spam messages now"}
        </button>
      )}
    </div>
  );
}

function pageInfo(r: ViewResult | null, page: number, size: number, shown: number) {
  const n = shown;
  if (!r || !n) return "";
  const start = page * size + 1;
  const end = page * size + n;
  // A listing fetched before the action still counts the hidden rows.
  const total = Math.max(r.total - (r.threads.length - shown), end);
  return `${start.toLocaleString()}–${end.toLocaleString()} of ${r.estimate && r.hasMore ? "many" : total.toLocaleString()}`;
}

function ListToolbar() {
  const route = useMail((s) => s.route);
  const list = useMail((s) => s.list);
  const selected = useMail((s) => s.selected);
  const size = useMail((s) => s.settings.pageSize);
  const allMatching = useMail((s) => s.selectAllMatching);
  const advanced = useMail((s) => s.settings.advancedToolbar);
  const textLabels = useMail((s) => s.settings.buttonLabels === "text");
  const [menu, setMenu] = useState<{ kind: "label" | "move" | "snooze" | "more"; anchor: Anchor } | null>(null);
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  useMail((s) => s.hiddenThreads);
  const threads = visibleThreads();
  const any = selected.length > 0 || allMatching;
  const label = route.list.query ? null : route.list.label;
  const accountId = useMail.getState().accountId;
  const selThreads = threads.filter((t) => selected.includes(t.threadId));
  const allUnread = selThreads.length > 0 && selThreads.every((t) => t.unread);
  const r = list.result;
  const keep = useMail((s) => s.keepThreads);
  const targets = async () => (allMatching ? await allMatchingTargets() : currentTargets());
  const viewTotal = r && !r.estimate ? r.total : null;
  // With the whole view selected, the action runs on the server over every page (minus the unticked rows).
  const run = async (k: Parameters<typeof act>[0]) => (allMatching && BULK_KINDS.includes(k) ? bulkAct(k, keep, viewTotal) : act(k, await targets()));
  const exceptSelected: MenuEntry[] =
    any && !allMatching
      ? [
          { sep: true },
          label === "TRASH" || label === "SPAM"
            ? {
                label: "Delete all except selected",
                icon: "delete_forever",
                run: () => allExceptSelected("delete-forever", viewTotal),
                testId: "except-delete",
              }
            : { label: "Delete all except selected", icon: "delete_sweep", run: () => allExceptSelected("trash", viewTotal), testId: "except-delete" },
          ...(label === "INBOX" && !route.list.query
            ? [{ label: "Archive all except selected", icon: "archive", run: () => allExceptSelected("archive", viewTotal), testId: "except-archive" }]
            : []),
        ]
      : [];
  const box = selected.length === 0 ? "check_box_outline_blank" : selected.length === threads.length ? "check_box" : "indeterminate_check_box";
  const toolbarSwitch: MenuEntry = advanced
    ? { label: "Switch to simplified toolbar", icon: "sync_alt", run: () => void setSetting("advancedToolbar", false), testId: "toolbar-simplified" }
    : { label: "Switch to advanced toolbar", icon: "sync_alt", run: () => void setSetting("advancedToolbar", true), testId: "toolbar-advanced" };
  const moreAnchor = () => menu?.anchor ?? { x: 0, y: 0 };
  const moreItems = (): MenuEntry[] =>
    any
      ? advanced
        ? [
            { label: "Mark as important", icon: "label_important", run: () => void run("important") },
            { label: "Mark as not important", icon: "label_important_outline", run: () => void run("not-important") },
            { label: "Add star", icon: "star", run: () => void run("star") },
            { label: "Remove star", icon: "star_outline", run: () => void run("unstar") },
            { sep: true },
            { label: "Forward as attachment", icon: "forward", run: () => void fwdAttach(selThreads) },
            { label: "Filter messages like these", icon: "filter_alt", run: () => setFilter(likeThese(selThreads)) },
            { label: "Mute", icon: "notifications_off", run: () => void run("mute") },
            ...exceptSelected,
            { sep: true },
            toolbarSwitch,
          ]
        : [
            // Simplified toolbar (the default): Snooze and Label as live here.
            { label: "Snooze", icon: "schedule", run: () => setMenu({ kind: "snooze", anchor: moreAnchor() }), keepOpen: true, testId: "more-snooze" },
            { sep: true },
            {
              label: "Label as",
              icon: "label",
              testId: "more-label",
              subClassName: "label-menu",
              submenu: (close) => <LabelAsBody onClose={close} accountId={selThreads[0]?.accountId ?? accountId} current={selThreads.map((t) => t.labels)} />,
            },
            { label: "Forward as attachment", icon: "forward", run: () => void fwdAttach(selThreads) },
            { label: "Filter messages like these", icon: "filter_alt", run: () => setFilter(likeThese(selThreads)) },
            { label: "Mute", icon: "notifications_off", run: () => void run("mute") },
            ...exceptSelected,
            { sep: true },
            toolbarSwitch,
          ]
      : [
          { label: "Mark all as read", icon: "drafts", disabled: !threads.some((t) => t.unread), run: () => (selectWhere("all"), void act("read")) },
          ...(label === "TRASH" ? [{ label: "Empty Trash now", icon: "delete_forever", run: () => void emptyLabel(accountId, "TRASH") }] : []),
          ...(label === "SPAM" ? [{ label: "Delete all spam messages now", icon: "delete_forever", run: () => void emptyLabel(accountId, "SPAM") }] : []),
          { sep: true },
          { label: "Select messages to see more actions", disabled: true },
          { sep: true },
          toolbarSwitch,
        ];
  const inTrash = label === "TRASH";
  const inSpam = label === "SPAM";
  const inbox = label === "INBOX";
  return (
    <div className={["toolbar", textLabels ? "text-labels" : ""].join(" ")} role="toolbar" aria-label="Conversation actions">
      <div className="select-btn" style={{ padding: 0 }}>
        <button
          type="button"
          className="icon-btn"
          aria-label="Select"
          data-tip="Select"
          onClick={() => selectWhere(any ? "none" : "all")}
          data-testid="select-all"
        >
          <Icon name={box} fill={any} />
        </button>
        <MenuButton
          className="icon-btn"
          label="Select options"
          testId="select-menu"
          items={() => [
            { label: "All", run: () => selectWhere("all") },
            { label: "None", run: () => selectWhere("none") },
            { label: "Read", run: () => selectWhere("read") },
            { label: "Unread", run: () => selectWhere("unread") },
            { label: "Starred", run: () => selectWhere("starred") },
            { label: "Unstarred", run: () => selectWhere("unstarred") },
          ]}
        >
          <Icon name="arrow_drop_down" size={18} />
        </MenuButton>
      </div>
      {!any && (
        <IconButton
          icon="refresh"
          label="Refresh"
          onClick={() => (void api.syncNow(accountId === "all" ? null : accountId), void loadList())}
          testId="refresh"
        />
      )}
      {any && (
        <>
          {inTrash || inSpam ? (
            <IconButton icon="delete_forever" label="Delete forever" onClick={() => void run("delete-forever")} testId="tb-delete-forever" />
          ) : !inbox && label !== "STARRED" && label !== "IMPORTANT" ? (
            <IconButton icon="move_to_inbox" label="Move to Inbox" onClick={() => void run("inbox")} testId="tb-inbox" />
          ) : (
            <IconButton icon="archive" label="Archive" onClick={() => void run("archive")} testId="tb-archive" />
          )}
          {inSpam ? (
            <IconButton icon="report_off" label="Not spam" onClick={() => void run("not-spam")} testId="tb-not-spam" />
          ) : (
            <IconButton icon="report" label="Report spam" onClick={() => void run("spam")} testId="tb-spam" />
          )}
          {inTrash ? (
            <IconButton icon="restore_from_trash" label="Move to Inbox" onClick={() => void run("restore")} />
          ) : (
            <IconButton icon="delete" label="Delete" onClick={() => void run("trash")} testId="tb-delete" />
          )}
          <span className="sep" />
          {allUnread ? (
            <IconButton icon="drafts" label="Mark as read" onClick={() => void run("read")} testId="tb-read" />
          ) : (
            <IconButton icon="mark_email_unread" label="Mark as unread" onClick={() => void run("unread")} testId="tb-unread" />
          )}
          {advanced && (
            <IconButton icon="schedule" label="Snooze" onClick={(e) => setMenu({ kind: "snooze", anchor: anchorOf(e.currentTarget) })} testId="tb-snooze" />
          )}
          {advanced && <span className="sep" />}
          <IconButton icon="drive_file_move" label="Move to" onClick={(e) => setMenu({ kind: "move", anchor: anchorOf(e.currentTarget) })} testId="tb-move" />
          {advanced && (
            <IconButton icon="label" label="Labels" onClick={(e) => setMenu({ kind: "label", anchor: anchorOf(e.currentTarget) })} testId="tb-label" />
          )}
        </>
      )}
      <IconButton
        icon="more_vert"
        label="More email options"
        className="tb-more"
        onClick={(e) => setMenu({ kind: "more", anchor: anchorOf(e.currentTarget) })}
        testId="tb-more"
      />
      <div className="grow" />
      {r && threads.length > 0 && (
        <>
          <span className="page-info" data-testid="page-info">
            {pageInfo(r, route.list.page, size, threads.length)}
          </span>
          <IconButton
            icon="chevron_left"
            label="Newer"
            className="page-btn"
            disabled={route.list.page === 0}
            onClick={() => go({ ...route.list, page: route.list.page - 1 })}
            testId="page-newer"
          />
          <IconButton
            icon="chevron_right"
            label="Older"
            className="page-btn"
            disabled={!r.hasMore}
            onClick={() => go({ ...route.list, page: route.list.page + 1 })}
            testId="page-older"
          />
        </>
      )}
      {menu?.kind === "more" && <Menu anchor={menu.anchor} items={moreItems()} onClose={() => setMenu(null)} className="icons" label="More" />}
      {menu?.kind === "label" && (
        <LabelAsMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          accountId={selThreads[0]?.accountId ?? accountId}
          current={selThreads.map((t) => t.labels)}
        />
      )}
      {menu?.kind === "move" && <MoveToMenu anchor={menu.anchor} onClose={() => setMenu(null)} accountId={selThreads[0]?.accountId ?? accountId} />}
      {menu?.kind === "snooze" && <SnoozeMenu anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {filter && <FilterDialog criteria={filter} onClose={() => setFilter(null)} />}
    </div>
  );
}

function likeThese(ts: ThreadSummary[]) {
  const senders = [...new Set(ts.flatMap((t) => t.participants.map((p) => p.email)))].slice(0, 5);
  return { from: senders.join(" OR ") };
}

async function fwdAttach(ts: ThreadSummary[]) {
  if (!ts.length) return;
  const d = await api.thread(ts[0].accountId, ts[0].threadId);
  const others = await Promise.all(ts.slice(1).map((t) => api.thread(t.accountId, t.threadId)));
  await forwardAsAttachment(
    ts[0].accountId,
    [d, ...others].flatMap((x) => x.messages.filter((m) => !m.labels.includes("DRAFT"))),
  );
}

function SelectAllBanner() {
  const selected = useMail((s) => s.selected);
  const list = useMail((s) => s.list.result);
  const matching = useMail((s) => s.selectAllMatching);
  const keep = useMail((s) => s.keepThreads);
  const threads = visibleThreads();
  if (!list || !threads.length) return null;
  if (!matching && (selected.length !== threads.length || !list.hasMore)) return null;
  const n = list.estimate ? "" : `${list.total.toLocaleString()} `;
  return (
    <div className="select-all-banner" data-testid="select-all-banner">
      {matching ? (
        <>
          All {n}conversations in this view are selected
          {keep.length ? `, except ${keep.length === 1 ? "the one" : `the ${keep.length}`} you unticked (kept)` : ""}.
          <button onClick={() => (selectWhere("none"), setState({ selectAllMatching: false, keepThreads: [] }))} data-testid="clear-selection">
            Clear selection
          </button>
        </>
      ) : (
        <>
          All {threads.length} conversations on this page are selected.
          <button onClick={() => void selectAllMatching()} data-testid="select-all-matching">
            Select all {list.estimate ? "" : list.total.toLocaleString()} conversations in this view
          </button>
        </>
      )}
    </div>
  );
}

function CategoryTabs() {
  const route = useMail((s) => s.route);
  const cats = useMail((s) => s.settings.categories);
  const accountId = useMail((s) => s.accountId);
  const labels = useMail((s) => s.labels[s.accountId] ?? NO_LABELS);
  const tabs = CATEGORIES.filter((c) => c.key === "primary" || cats[c.key as keyof typeof cats]);
  const [subs, setSubs] = useState<Record<string, { names: string; unread: number }>>({});
  useEffect(() => {
    // New-mail summaries under the tab names (unread senders), like the web client.
    let live = true;
    for (const t of tabs.filter((x) => x.key !== "primary")) {
      void api.list({ accountId, label: "INBOX", category: t.key, query: "is:unread", page: 0, pageSize: 5, conversations: true, mode: "cache" }).then((r) => {
        if (!live) return;
        const names = [...new Set(r.threads.flatMap((x) => x.participants.filter((p) => p.unread).map((p) => p.name || p.email)))].slice(0, 3).join(", ");
        setSubs((s) => ({ ...s, [t.key]: { names, unread: r.total } }));
      });
    }
    return () => {
      live = false;
    };
  }, [accountId, labels, tabs.map((t) => t.key).join()]);
  const colors: Record<string, string> = { promotions: "#188038", social: "#1a73e8", updates: "#e37400", forums: "#9334e6" };
  return (
    <div className="tabs" role="tablist" aria-label="Inbox categories">
      {tabs.map((t) => {
        const active = (route.list.category ?? "primary") === t.key;
        const sub = subs[t.key];
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            className={["tab", active ? "active" : ""].join(" ")}
            onClick={() => go({ label: "INBOX", category: t.key })}
            data-testid={`tab-${t.key}`}
          >
            <Icon name={t.icon} fill={active} />
            <span className="tab-text">
              <span className="tab-label">
                <span className="tab-name">{t.name}</span>
                {!active && sub?.unread ? (
                  <span className="new-badge" style={{ background: colors[t.key] }}>
                    {sub.unread} new
                  </span>
                ) : null}
              </span>
              {!active && sub?.names && <span className="tab-sub">{sub.names}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SearchChips({ query }: { query: string }) {
  const state = chipState(query);
  const [menu, setMenu] = useState<{ kind: "from" | "time" | "to"; anchor: Anchor } | null>(null);
  const [from, setFrom] = useState("");
  const apply = (q: string) => go({ label: null, category: null, query: q });
  return (
    <div className="chips" role="toolbar" aria-label="Search filters">
      <button
        className={["chip", state.from ? "on" : ""].join(" ")}
        onClick={(e) => setMenu({ kind: "from", anchor: anchorOf(e.currentTarget) })}
        data-testid="chip-from"
      >
        {state.from ? `From: ${state.from}` : "From"} <Icon name="arrow_drop_down" size={18} />
      </button>
      <button
        className={["chip", state.time ? "on" : ""].join(" ")}
        onClick={(e) => setMenu({ kind: "time", anchor: anchorOf(e.currentTarget) })}
        data-testid="chip-time"
      >
        {state.time ? (TIME_CHIPS.find(([, v]) => v === state.time)?.[0] ?? state.time) : "Any time"} <Icon name="arrow_drop_down" size={18} />
      </button>
      <button
        className={["chip plain", state.attachment ? "on" : ""].join(" ")}
        onClick={() => apply(setChip(query, "attachment", state.attachment ? null : "yes"))}
        data-testid="chip-attachment"
      >
        {state.attachment && <Icon name="check" size={18} />} Has attachment
      </button>
      <button className={["chip", state.to ? "on" : ""].join(" ")} onClick={(e) => setMenu({ kind: "to", anchor: anchorOf(e.currentTarget) })}>
        {state.to ? `To: ${state.to}` : "To"} <Icon name="arrow_drop_down" size={18} />
      </button>
      <button
        className={["chip plain", state.unread ? "on" : ""].join(" ")}
        onClick={() => apply(setChip(query, "unread", state.unread ? null : "yes"))}
        data-testid="chip-unread"
      >
        {state.unread && <Icon name="check" size={18} />} Is unread
      </button>
      <button className="chip link" onClick={() => ui({ advancedSearch: true })} data-testid="chip-advanced">
        Advanced search
      </button>
      {menu && (menu.kind === "from" || menu.kind === "to") && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label={menu.kind === "from" ? "From" : "To"}>
          <div className="menu-search" style={{ width: 280 }}>
            <input
              autoFocus
              placeholder="Type a name or email"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && from.trim()) {
                  apply(setChip(query, menu.kind as "from" | "to", from.trim()));
                  setMenu(null);
                }
              }}
            />
          </div>
          {(menu.kind === "from" ? state.from : state.to) && (
            <button className="menu-item" onClick={() => (apply(setChip(query, menu.kind as "from" | "to", null)), setMenu(null))}>
              Clear
            </button>
          )}
        </Menu>
      )}
      {menu?.kind === "time" && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            { label: "Any time", run: () => apply(setChip(query, "time", null)) },
            ...TIME_CHIPS.map(([label, v]) => ({ label, checked: state.time === v, run: () => apply(setChip(query, "time", v)) })),
          ]}
        />
      )}
    </div>
  );
}

// ---- inbox types ----

interface Section {
  title: string;
  view: Partial<ViewQuery>;
  max: number;
  main?: boolean;
}

function sectionsFor(type: string): Section[] {
  const s = getState().settings;
  switch (type) {
    case "important":
      return [
        { title: "Important", view: { query: "in:inbox is:important" }, max: 50 },
        { title: "Everything else", view: { query: "in:inbox -is:important" }, max: 50, main: true },
      ];
    case "unread":
      return [
        { title: "Unread", view: { query: "in:inbox is:unread" }, max: 50 },
        { title: "Everything else", view: { query: "in:inbox -is:unread" }, max: 50, main: true },
      ];
    case "starred":
      return [
        { title: "Starred", view: { query: "in:inbox is:starred" }, max: 50 },
        { title: "Everything else", view: { query: "in:inbox -is:starred" }, max: 50, main: true },
      ];
    case "priority":
      return s.prioritySections.map((p, i) => ({
        title:
          p.kind === "important-unread"
            ? "Important and unread"
            : p.kind === "important"
              ? "Important"
              : p.kind === "unread"
                ? "Unread"
                : p.kind === "starred"
                  ? "Starred"
                  : p.kind === "label"
                    ? (p.label ?? "Label")
                    : "Everything else",
        view: {
          query:
            p.kind === "important-unread"
              ? "in:inbox is:important is:unread"
              : p.kind === "important"
                ? "in:inbox is:important"
                : p.kind === "unread"
                  ? "in:inbox is:unread"
                  : p.kind === "starred"
                    ? "is:starred"
                    : p.kind === "label"
                      ? `label:${(p.label ?? "").replace(/\s+/g, "-")}`
                      : "in:inbox",
        },
        max: p.max,
        main: i === s.prioritySections.length - 1,
      }));
    case "multiple":
      return [
        ...s.multipleInboxes.sections.map((m) => ({ title: m.name || m.query, view: { query: m.query }, max: s.multipleInboxes.max })),
        { title: "Inbox", view: { label: "INBOX" }, max: s.pageSize, main: true },
      ];
    default:
      return [];
  }
}

function InboxSections() {
  const type = useMail((s) => s.settings.inboxType);
  const position = useMail((s) => s.settings.multipleInboxes.position);
  const sections = sectionsFor(type);
  if (type === "multiple" && position !== "above") {
    const main = sections.find((s) => s.main)!;
    const rest = sections.filter((s) => !s.main);
    return position === "right" ? (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 0.8fr)" }}>
        <SectionList section={main} />
        <div style={{ borderLeft: "1px solid var(--row-divider)" }}>
          {rest.map((s) => (
            <SectionList key={s.title} section={s} />
          ))}
        </div>
      </div>
    ) : (
      <>
        <SectionList section={main} />
        {rest.map((s) => (
          <SectionList key={s.title} section={s} />
        ))}
      </>
    );
  }
  return (
    <>
      {sections.map((s) => (
        <SectionList key={s.title} section={s} />
      ))}
    </>
  );
}

function SectionList({ section }: { section: Section }) {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState<ViewResult | null>(null);
  const accountId = useMail((s) => s.accountId);
  const tick = useMail((s) => s.list.result);
  useEffect(() => {
    let live = true;
    const v: ViewQuery = { ...currentView(0), label: section.view.label ?? null, query: section.view.query ?? null, category: null, pageSize: section.max };
    void api.list({ ...v, mode: "cache" }).then((r) => live && setResult(r));
    if (accountById(accountId)?.kind === "gmail")
      void api
        .list({ ...v, mode: "server" })
        .then((r) => live && setResult(r))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [accountId, section.title, tick]);
  return (
    <div data-testid={`section-${section.title}`}>
      <div className="list-section-title" onClick={() => setOpen(!open)}>
        <Icon name={open ? "arrow_drop_down" : "arrow_right"} />
        {section.title}
        {result && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-2)" }}>
            {result.total ? `1–${result.threads.length} of ${result.total}` : ""}
          </span>
        )}
      </div>
      {open && <Rows threads={result?.threads ?? []} />}
    </div>
  );
}

// ---- rows ----

function Rows({ threads }: { threads: ThreadSummary[] | null }) {
  const list = useMail((s) => s.list);
  const hidden = useMail((s) => s.hiddenThreads);
  const route = useMail((s) => s.route);
  const items = (threads ?? list.result?.threads ?? []).filter((t) => !hidden.includes(t.threadId));
  if (!items.length && !list.loading && threads === null) return <EmptyList />;
  return (
    <>
      {items.map((t, i) => (
        <Row key={`${t.accountId}:${t.threadId}`} t={t} index={i} open={route.thread?.threadId === t.threadId} />
      ))}
      {threads === null && items.length > 0 && <ListFooter />}
    </>
  );
}

function ListFooter() {
  const accounts = useMail((s) => s.accounts);
  const sync = useMail((s) => s.sync);
  const online = useMail((s) => s.online);
  const states = Object.values(sync);
  const text = !online
    ? "Offline · showing mail saved on this Mac"
    : states.includes("error")
      ? "An account couldn't sync · see Settings ▸ Accounts"
      : states.includes("busy")
        ? "Catching up · Gmail is pacing requests"
        : states.includes("syncing")
          ? "Syncing…"
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} · up to date`;
  return (
    <div className="list-footer">
      <span>{text}</span>
      <span>Courier</span>
    </div>
  );
}

function EmptyList() {
  const route = useMail((s) => s.route);
  const l = route.list;
  // Courier's own wording throughout.
  let title = "Nothing here.";
  let body = "";
  if (l.query) {
    title = "Nothing matches that search.";
    body = "Try fewer words, or narrow it down with the search options (sender, dates, size…).";
  } else if (l.label === "INBOX") {
    const cat = l.category && l.category !== "primary" ? CATEGORIES.find((c) => c.key === l.category)?.name : null;
    title = cat ? `Nothing in ${cat}.` : "Inbox is clear.";
    body = cat ? `New ${cat.toLowerCase()} mail will show up here.` : "New mail will show up here.";
  } else if (l.label === "STARRED") {
    title = "No starred conversations.";
    body = "Click the star next to a conversation to keep it here.";
  } else if (l.label === "SNOOZED") {
    title = "Nothing snoozed.";
    body = "Snoozed conversations come back to your inbox at the time you pick.";
  } else if (l.label === "SENT") title = "Nothing sent yet.";
  else if (l.label === "DRAFT") title = "No drafts.";
  else if (l.label === "SCHEDULED") title = "Nothing scheduled.";
  else if (l.label === "SPAM") title = "Spam is empty.";
  else if (l.label === "TRASH") title = "Trash is empty.";
  return (
    <div className="empty" data-testid="empty-list">
      <h3>{title}</h3>
      {body && <div>{body}</div>}
    </div>
  );
}

function Row({ t, index, open }: { t: ThreadSummary; index: number; open: boolean }) {
  const selected = useMail((s) => s.selected.includes(t.threadId));
  const cursor = useMail((s) => s.cursor === index);
  const settings = useMail((s) => s.settings);
  const route = useMail((s) => s.route);
  const accountId = useMail((s) => s.accountId);
  const labels = useMail((s) => s.labels[t.accountId] ?? NO_LABELS);
  const acct = useMail((s) => s.accounts.find((a) => a.id === t.accountId));
  const [snooze, setSnooze] = useState<Anchor | null>(null);
  const [ctx, setCtx] = useState<{ at: Anchor; picked: boolean } | null>(null);
  const [ctxSub, setCtxSub] = useState<{ kind: "move"; at: Anchor } | null>(null);
  const keepTicked = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cursor) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const self = [acct?.email ?? "", ...(acct?.aliases ?? [])];
  const people = summarize(
    t.participants.map((p) => ({ from: { name: p.name, email: p.email }, unread: p.unread, isDraft: p.draft })),
    self,
  );
  const inSent = route.list.label === "SENT" || route.list.label === "SCHEDULED" || route.list.label === "OUTBOX" || route.list.label === "DRAFT";
  const sentTo = inSent && t.outboxId != null ? t.participants.map((p) => p.email.split("@")[0]).join(", ") : null;
  const byId = useMemo(() => new Map<string, Label>(labels.map((l) => [l.id, l])), [labels]);
  const viewing = route.list.query ? null : route.list.label;
  const chips = t.labels.filter((id) => {
    if (id === viewing) return false;
    // Search results and other labels show an Inbox chip; the Inbox itself does not.
    if (id === "INBOX") return viewing !== "INBOX";
    const l = byId.get(id);
    if (!l || isSystemLabel(id)) return false;
    return l.messageListVisibility !== "hide";
  });
  const lastSender = people.parts;
  const face = t.participants.find((p) => !self.includes(p.email)) ?? t.participants[0];
  const star = STAR_TYPES.find((s) => s.id === (t.starType ?? "yellow-star"));
  const date = t.scheduledAt ? scheduledWhen(t.scheduledAt) : viewing === "SNOOZED" && t.snoozedUntil ? shortWhen(t.snoozedUntil) : listDate(t.lastDate);
  const archiveLike =
    viewing === "INBOX" ||
    viewing === null ||
    viewing === "STARRED" ||
    viewing === "IMPORTANT" ||
    viewing === "SNOOZED" ||
    viewing?.startsWith("CATEGORY_") ||
    !isSystemLabel(viewing ?? "");
  const target = [{ accountId: t.accountId, threadIds: [t.threadId] }];
  const showAttachments = settings.density === "default" && t.attachments.length > 0;
  // Two-finger swipe across the row (the phone app's swipe actions).
  const swipeAction = (dir: "left" | "right"): SwipeAction => {
    const a = dir === "left" ? settings.swipeLeft : settings.swipeRight;
    return a === "archive" && !archiveLike ? "none" : a;
  };
  useRowSwipe(
    rowRef,
    (dir) => swipeAction(dir) !== "none",
    (dir) => {
      const a = swipeAction(dir);
      if (a === "archive") void act("archive", target);
      else if (a === "trash") void act(viewing === "TRASH" || viewing === "SPAM" ? "delete-forever" : "trash", target);
      else if (a === "read") void act(t.unread ? "read" : "unread", target);
      else if (a === "snooze") {
        const r = rowRef.current?.getBoundingClientRect();
        setSnooze({ x: r ? r.right - 280 : 200, y: r ? r.bottom : 200 });
      }
    },
  );
  const strip = (dir: "left" | "right") => {
    const a = SWIPE_ACTIONS.find((x) => x.id === swipeAction(dir)) ?? SWIPE_ACTIONS[4];
    const icon = a.id === "read" ? (t.unread ? "drafts" : "mark_email_unread") : a.icon;
    return (
      <span className={`swipe-strip ${dir}`} style={{ background: a.color }} aria-hidden="true">
        <Icon name={icon} />
      </span>
    );
  };
  const acctColor = accountId === "all" ? acct?.color : null;
  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selected}
      tabIndex={-1}
      aria-label={`${t.unread ? "Unread, " : ""}${people.parts.map((p) => p.text).join(", ")}, ${t.subject || "(no subject)"}, ${date}`}
      data-testid="thread-row"
      data-thread={t.threadId}
      className={["row", t.unread ? "unread" : "read", selected ? "selected" : "", cursor ? "focused" : "", settings.hoverActions ? "" : "no-hover"].join(" ")}
      style={settings.importanceMarkers ? ({ "--imp-col": "20px" } as React.CSSProperties) : undefined}
      draggable
      onDragStart={(e) => {
        const s = getState();
        const ids = s.selected.includes(t.threadId) ? s.selected : [t.threadId];
        e.dataTransfer.setData("application/x-courier-threads", JSON.stringify({ accountId: t.accountId, threadIds: ids }));
        e.dataTransfer.effectAllowed = "move";
        const ghost = document.createElement("div");
        ghost.textContent = ids.length === 1 ? t.subject || "1 conversation" : `${ids.length} conversations`;
        Object.assign(ghost.style, {
          position: "absolute",
          top: "-100px",
          padding: "8px 12px",
          background: "#0b57d0",
          color: "#fff",
          borderRadius: "8px",
          font: "500 14px sans-serif",
        });
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
      }}
      onClick={(e) => {
        if (e.metaKey || e.shiftKey) {
          toggleSelect(t.threadId, e.shiftKey);
          return;
        }
        useMail.setState({ cursor: index });
        openThread(t);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // The menu acts on the selection when this row is part of it, otherwise on this row alone.
        const picked = !getState().selected.includes(t.threadId);
        if (picked) setState({ selected: [t.threadId], selectAllMatching: false, keepThreads: [] });
        setCtx({ at: { x: e.clientX, y: e.clientY }, picked });
      }}
    >
      {strip("left")}
      {strip("right")}
      {acctColor ? <span className="acct-bar" style={{ background: acctColor, width: 3, height: 20, borderRadius: 2 }} /> : <span className="drag-handle" />}
      {/* Phone width: the sender's picture, which selects the row like the phone app's. */}
      <span
        className="row-avatar"
        role="checkbox"
        aria-checked={selected}
        aria-label="Select conversation"
        data-testid="row-avatar"
        onClick={(e) => {
          e.stopPropagation();
          toggleSelect(t.threadId, e.shiftKey);
        }}
      >
        {selected ? (
          <span className="avatar sel">
            <Icon name="check" />
          </span>
        ) : (
          <Avatar name={face?.name ?? ""} email={face?.email ?? ""} size={40} />
        )}
      </span>
      <span className="cb">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label="Select conversation"
          className={["checkbox", selected ? "on" : ""].join(" ")}
          data-testid="row-checkbox"
          onClick={(e) => {
            e.stopPropagation();
            toggleSelect(t.threadId, e.shiftKey);
          }}
        >
          <Icon name={selected ? "check_box" : "check_box_outline_blank"} fill={selected} />
        </button>
      </span>
      <span className="star">
        <button
          type="button"
          className={["star-btn", t.starred ? "on" : ""].join(" ")}
          aria-label={t.starred ? "Starred" : "Not starred"}
          aria-pressed={t.starred}
          data-tip={t.starred ? "Starred" : "Not starred"}
          data-testid="row-star"
          style={t.starred && star && star.id !== "yellow-star" ? { color: star.color } : undefined}
          onClick={(e) => {
            e.stopPropagation();
            void toggleStar(t);
          }}
        >
          <Icon name={t.starred ? (star?.icon ?? "star") : "star"} fill={t.starred} />
        </button>
      </span>
      {settings.importanceMarkers ? (
        <span className="imp-cell">
          <button
            type="button"
            className={["imp-btn", t.important ? "on" : ""].join(" ")}
            aria-label={t.important ? "Important" : "Not important"}
            onClick={(e) => {
              e.stopPropagation();
              void toggleImportant(t);
            }}
          >
            <Icon name="label_important" fill={t.important} />
          </button>
        </span>
      ) : (
        <span className="imp-cell" />
      )}
      <span className="sender" data-testid="row-sender">
        {settings.personalIndicators && (
          <span className="pli" title={t.toMe === 2 ? "Sent only to you" : t.toMe === 1 ? "Sent to you" : undefined} data-testid="row-pli">
            {t.toMe === 2 ? "»" : t.toMe === 1 ? "›" : ""}
          </span>
        )}
        {sentTo ? (
          <span>To: {sentTo}</span>
        ) : (
          lastSender.map((p, i) => (
            <span key={i}>
              {i > 0 && (p.text === ".." ? " " : ", ")}
              {p.draft ? <span className="draft">Draft</span> : p.bold ? <b>{p.text}</b> : p.text}
            </span>
          ))
        )}
        {people.count > 0 && <span className="count">{people.count}</span>}
      </span>
      <span className="subject-cell">
        <span className="subject-line">
          {chips.map((id) => {
            const l = byId.get(id);
            const name = id === "INBOX" ? "Inbox" : (l?.name ?? SYSTEM_DISPLAY[id] ?? id);
            return (
              <span key={id} className="chip-label" style={chipStyle(l?.bg ? { backgroundColor: l.bg, textColor: l.fg ?? "" } : null)} data-testid="row-label">
                {name}
              </span>
            );
          })}
          <span className="text">
            <span className="subj">{t.subject || "(no subject)"}</span>
            {settings.snippets && t.snippet && (
              <span className="snippet">
                <span className="dash"> - </span>
                {t.snippet}
              </span>
            )}
          </span>
        </span>
        {showAttachments && (
          <span className="attachments">
            {t.attachments.slice(0, 3).map((a, i) => (
              <button key={i} type="button" className="attach-chip" title={a.name} onClick={(e) => (e.stopPropagation(), openThread(t))}>
                <FileIcon mime={a.mime} name={a.name} />
                <span>{a.name}</span>
              </button>
            ))}
            {t.attachments.length > 3 && <span className="attach-chip">+{t.attachments.length - 3}</span>}
          </span>
        )}
      </span>
      <span className="attach-cell">{!showAttachments && t.hasAttachments && <Icon name="attachment" className="attach-ic" />}</span>
      <span className="date" title={new Date(t.lastDate).toLocaleString()}>
        {date}
      </span>
      {settings.hoverActions && t.outboxId == null && (
        <span className="hover-actions" onClick={(e) => e.stopPropagation()}>
          {archiveLike ? (
            <IconButton icon="archive" label="Archive" onClick={() => void act("archive", target)} testId="hover-archive" />
          ) : (
            <IconButton
              icon="move_to_inbox"
              label="Move to Inbox"
              onClick={() => void act(viewing === "TRASH" ? "restore" : viewing === "SPAM" ? "not-spam" : "inbox", target)}
            />
          )}
          <IconButton icon="delete" label="Delete" onClick={() => void act(viewing === "TRASH" ? "delete-forever" : "trash", target)} testId="hover-delete" />
          <IconButton
            icon={t.unread ? "drafts" : "mark_email_unread"}
            label={t.unread ? "Mark as read" : "Mark as unread"}
            onClick={() => void act(t.unread ? "read" : "unread", target)}
            testId="hover-read"
          />
          <IconButton icon="schedule" label="Snooze" onClick={(e) => setSnooze(anchorOf(e.currentTarget, "right"))} testId="hover-snooze" />
        </span>
      )}
      {snooze && <SnoozeMenu anchor={snooze} onClose={() => setSnooze(null)} targets={target} />}
      {ctx && (
        <Menu
          anchor={ctx.at}
          className="icons row-menu"
          label="Conversation"
          items={rowMenu(
            t,
            viewing,
            archiveLike,
            (a) => setSnooze(a),
            (a) => ((keepTicked.current = true), setCtxSub({ kind: "move", at: a })),
            ctx.at,
          )}
          onClose={() => {
            setCtx(null);
            // Closed without a follow-up menu: the row ticked for the menu goes back to how it was.
            if (ctx.picked && !keepTicked.current) setTimeout(() => getState().selected.join() === t.threadId && setState({ selected: [] }), 0);
            keepTicked.current = false;
          }}
        />
      )}
      {ctxSub?.kind === "move" && <MoveToMenu anchor={ctxSub.at} onClose={() => (setCtxSub(null), setState({ selected: [] }))} accountId={t.accountId} />}
      {open && <span className="sr-only">open</span>}
    </div>
  );
}

/**
 * Horizontal two-finger scrolling over a row slides it; past a third of the row (or 140 px) the action runs.
 * The wheel listener isn't passive, so the swipe doesn't also scroll the page or go back.
 */
function useRowSwipe(ref: React.RefObject<HTMLDivElement | null>, allowed: (dir: "left" | "right") => boolean, commit: (dir: "left" | "right") => void) {
  const fns = useRef({ allowed, commit });
  fns.current = { allowed, commit };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dx = 0;
    let axis: "x" | "y" | null = null;
    let timer = 0;
    const show = () => {
      el.style.setProperty("--dx", `${dx}px`);
      el.classList.toggle("swiping", dx !== 0);
      el.dataset.dir = dx > 0 ? "right" : dx < 0 ? "left" : "";
    };
    const settle = (cls: string, then?: () => void) => {
      el.classList.add(cls);
      show();
      window.setTimeout(() => {
        el.classList.remove(cls);
        then?.();
      }, 180);
    };
    const end = () => {
      axis = null;
      const dir = dx > 0 ? "right" : "left";
      if (Math.abs(dx) > Math.min(140, el.clientWidth / 3) && fns.current.allowed(dir)) {
        dx = dir === "right" ? el.clientWidth : -el.clientWidth;
        settle("swipe-go", () => {
          fns.current.commit(dir);
          dx = 0;
          show();
        });
      } else {
        dx = 0;
        settle("swipe-back");
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (axis === null) {
        axis = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && Math.abs(e.deltaX) > 1 ? "x" : "y";
        // A direction with no action is the web view's own back/forward swipe: leave it alone.
        if (axis === "x" && dx === 0 && !fns.current.allowed(e.deltaX < 0 ? "right" : "left")) axis = "y";
      }
      window.clearTimeout(timer);
      if (axis === "y") {
        timer = window.setTimeout(() => (axis = null), 160);
        return;
      }
      e.preventDefault();
      dx = Math.max(-el.clientWidth, Math.min(el.clientWidth, dx - e.deltaX));
      if (dx !== 0 && !fns.current.allowed(dx > 0 ? "right" : "left")) dx = 0;
      show();
      timer = window.setTimeout(end, 140);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(timer);
    };
  }, [ref]);
}

/** The row's right-click menu. Actions apply to the selection (this row, ticked for the menu, or more). */
function rowMenu(
  t: ThreadSummary,
  viewing: string | null,
  archiveLike: boolean,
  snoozeAt: (a: Anchor) => void,
  moveAt: (a: Anchor) => void,
  at: Anchor,
): MenuEntry[] {
  const targets = () => currentTargets();
  const lastMessage = async () => {
    const d = await api.thread(t.accountId, t.threadId);
    return [...d.messages].reverse().find((m) => !m.labels.includes("DRAFT")) ?? d.messages[d.messages.length - 1];
  };
  const reply = (kind: "reply" | "reply-all" | "forward") => void lastMessage().then((m) => m && openReply(t.accountId, m, kind));
  const sender = [...t.participants].reverse().find((p) => p.email) ?? t.participants[0];
  const inTrash = viewing === "TRASH";
  const inSpam = viewing === "SPAM";
  return [
    { label: "Reply", icon: "reply", run: () => reply("reply"), testId: "ctx-reply" },
    { label: "Reply all", icon: "reply_all", run: () => reply("reply-all") },
    { label: "Forward", icon: "forward", run: () => reply("forward"), testId: "ctx-forward" },
    { label: "Forward as attachment", icon: "attach_email", run: () => void fwdAttach([t]) },
    { sep: true },
    archiveLike
      ? { label: "Archive", icon: "archive", run: () => void act("archive", targets()), testId: "ctx-archive" }
      : { label: "Move to Inbox", icon: "move_to_inbox", run: () => void act(inTrash ? "restore" : inSpam ? "not-spam" : "inbox", targets()) },
    inTrash || inSpam
      ? { label: "Delete forever", icon: "delete_forever", run: () => void act("delete-forever", targets()) }
      : { label: "Delete", icon: "delete", run: () => void act("trash", targets()), testId: "ctx-delete" },
    t.unread
      ? { label: "Mark as read", icon: "drafts", run: () => void act("read", targets()), testId: "ctx-read" }
      : { label: "Mark as unread", icon: "mark_email_unread", run: () => void act("unread", targets()), testId: "ctx-unread" },
    { label: "Snooze", icon: "schedule", run: () => snoozeAt(at) },
    { sep: true },
    { label: "Move to", icon: "drive_file_move", run: () => moveAt(at) },
    {
      label: "Label as",
      icon: "label",
      subClassName: "label-menu",
      submenu: (close) => <LabelAsBody onClose={close} accountId={t.accountId} current={[t.labels]} />,
    },
    { label: "Mute", icon: "notifications_off", run: () => void act("mute", targets()) },
    { sep: true },
    ...(sender
      ? [{ label: `Find emails from ${sender.name || sender.email}`, icon: "search", run: () => search(`from:${sender.email}`), testId: "ctx-find-from" }]
      : []),
    { label: "Find emails with this subject", icon: "manage_search", run: () => search(`subject:"${(t.subject || "").replace(/"/g, "")}"`) },
    { sep: true },
    { label: "Open in new window", icon: "open_in_new", run: () => void api.windowOpen("thread", { accountId: t.accountId, threadId: t.threadId }, t.subject) },
  ];
}

export { parseQuery };
