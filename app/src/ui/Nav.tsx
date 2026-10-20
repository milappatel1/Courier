// Left navigation: Compose, system labels with counts, More, categories, the nested label tree with
// per-label menus, and drop targets for dragging conversations onto labels.
import { useEffect, useMemo, useState } from "react";
import { LABEL_BG, labelTextColor, labelTree, leafName, type LabelNode } from "../core/labels";
import { api, errorText, on } from "../ipc/api";
import type { Label, OutboxRow } from "../ipc/types";
import { applyLabels } from "../state/actions";
import { openCompose } from "../state/compose";
import { go, hasTabs, labelsFor, loadLabels, toast, ui, useMail, SYSTEM_DISPLAY, getState, NO_LABELS } from "../state/store";
import { Icon, IconButton, Menu, anchorOf, type MenuEntry } from "./common";

const PRIMARY = [
  { id: "INBOX", icon: "inbox" },
  { id: "STARRED", icon: "star" },
  { id: "SNOOZED", icon: "schedule" },
  { id: "SENT", icon: "send" },
  { id: "DRAFT", icon: "draft" },
  { id: "SUBSCRIPTIONS", icon: "unsubscribe" },
];
const MORE = [
  { id: "IMPORTANT", icon: "label_important" },
  { id: "SCHEDULED", icon: "schedule_send" },
  { id: "ALL", icon: "stacked_email" },
  { id: "SPAM", icon: "report" },
  { id: "TRASH", icon: "delete" },
];
const PHONE_TABS = [
  { key: "primary", label: "INBOX", icon: "inbox", name: "Primary" },
  { key: "promotions", label: "CATEGORY_PROMOTIONS", icon: "sell", name: "Promotions" },
  { key: "social", label: "CATEGORY_SOCIAL", icon: "group", name: "Social" },
  { key: "updates", label: "CATEGORY_UPDATES", icon: "info", name: "Updates" },
  { key: "forums", label: "CATEGORY_FORUMS", icon: "forum", name: "Forums" },
];
const CATS = [
  { id: "social", label: "CATEGORY_SOCIAL", icon: "group" },
  { id: "updates", label: "CATEGORY_UPDATES", icon: "info" },
  { id: "forums", label: "CATEGORY_FORUMS", icon: "forum" },
  { id: "promotions", label: "CATEGORY_PROMOTIONS", icon: "sell" },
];

export function useOutbox(): OutboxRow[] {
  const [rows, setRows] = useState<OutboxRow[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .outbox()
        .then((r) => live && setRows(r))
        .catch(() => {});
    load();
    const un = on("outbox-changed", load);
    const un2 = on("mail-changed", load);
    return () => {
      live = false;
      void un.then((f) => f());
      void un2.then((f) => f());
    };
  }, []);
  return rows;
}

let peekTimer = 0;

export function Nav() {
  const accountId = useMail((s) => s.accountId);
  const labels = useMail((s) => s.labels[s.accountId] ?? NO_LABELS);
  const allLabels = useMail((s) => s.labels);
  const route = useMail((s) => s.route);
  const navOpen = useMail((s) => s.settings.navOpen);
  const accounts = useMail((s) => s.accounts);
  const outbox = useOutbox();
  const [more, setMore] = useState(false);
  const [cats, setCats] = useState(false);
  const catSettings = useMail((s) => s.settings.categories);
  const phoneSize = useMail((s) => s.size === "phone");
  const tabsOn = useMail(() => hasTabs());
  const phoneTabs = phoneSize && tabsOn;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const acct = accounts.find((a) => a.id === accountId);
  const unified = accountId === "all";
  const byId = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const current = route.settings ? null : route.list.query ? "__search" : route.list.label;
  const scheduled = outbox.filter((r) => r.scheduled && (unified || r.accountId === accountId)).length;
  const pending = outbox.filter((r) => !r.scheduled && r.attempts > 0 && (unified || r.accountId === accountId)).length;
  const count = (id: string) => {
    if (unified) {
      const sum = Object.values(allLabels).reduce((n, ls) => n + (ls.find((l) => l.id === id)?.threadsUnread ?? 0), 0);
      return id === "INBOX" || id === "SPAM" ? sum : 0;
    }
    const l = byId.get(id);
    if (!l) return 0;
    if (id === "DRAFT") return l.threadsTotal || l.messagesTotal;
    if (["INBOX", "SPAM", "IMPORTANT"].includes(id)) return l.threadsUnread;
    if (l.type === "user" || id.startsWith("CATEGORY_")) return l.threadsUnread;
    return 0;
  };
  const exists = (id: string) =>
    unified ||
    ["SNOOZED", "SCHEDULED", "OUTBOX", "STARRED", "ALL", "SUBSCRIPTIONS"].includes(id) ||
    byId.has(id) ||
    (acct?.kind === "gmail" && ["IMPORTANT"].includes(id));
  const item = (
    id: string,
    icon: string,
    opts: {
      name?: string;
      countValue?: number;
      label?: Label;
      depth?: number;
      expander?: React.ReactNode;
      color?: string | null;
      onClick?: () => void;
      test?: string;
    } = {},
  ) => {
    const n = opts.countValue ?? count(id);
    const active = current === id && !(id === "INBOX" && route.list.category && route.list.category !== "primary" && false);
    const bold = n > 0 && id !== "DRAFT" && id !== "SCHEDULED";
    return (
      <NavItem
        key={id}
        id={id}
        icon={icon}
        name={opts.name ?? SYSTEM_DISPLAY[id] ?? id}
        count={n}
        active={active}
        bold={bold}
        depth={opts.depth ?? 0}
        expander={opts.expander}
        color={opts.color ?? null}
        label={opts.label}
        accountId={accountId}
        test={opts.test}
        onClick={opts.onClick ?? (() => go({ label: id }))}
      />
    );
  };
  const tree = useMemo(() => labelTree(labels.filter((l) => l.type === "user" && l.labelListVisibility !== "labelHide")), [labels]);
  const renderTree = (nodes: LabelNode<Label>[], depth: number): React.ReactNode[] =>
    nodes.flatMap((node) => {
      const l = node.label;
      if (l && l.labelListVisibility === "labelShowIfUnread" && !l.threadsUnread) return [];
      const id = l?.id ?? `__${node.path}`;
      const hasKids = node.children.length > 0;
      const isCollapsed = collapsed[node.path];
      const expander = hasKids ? (
        <span
          className="nav-expander"
          role="button"
          aria-label={isCollapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => ({ ...c, [node.path]: !c[node.path] }));
          }}
        >
          <Icon name={isCollapsed ? "arrow_right" : "arrow_drop_down"} size={18} />
        </span>
      ) : undefined;
      const row = item(id, "label", {
        name: node.name,
        label: l ?? undefined,
        depth,
        expander,
        color: l?.bg,
        onClick: () => l && go({ label: l.id }),
        test: `nav-label-${node.path}`,
      });
      return [row, ...(hasKids && !isCollapsed ? renderTree(node.children, depth + 1) : [])];
    });
  return (
    <nav
      className="nav"
      aria-label="Mailboxes"
      onMouseEnter={() => {
        window.clearTimeout(peekTimer);
        peekTimer = window.setTimeout(() => useMail.setState({ peek: true }), 300);
      }}
      onMouseLeave={() => {
        window.clearTimeout(peekTimer);
        if (useMail.getState().peek) useMail.setState({ peek: false });
      }}
    >
      <div className="compose-wrap">
        <button type="button" className="compose-btn" onClick={() => void openCompose()} data-testid="compose" aria-label="Compose">
          <span className="ic s24">edit</span>
          <span>Compose</span>
        </button>
      </div>
      <div className="nav-scroll">
        {phoneTabs
          ? // The phone app lists the inbox tabs in its menu instead of across the top of the list.
            [
              ...PHONE_TABS.filter((c) => c.key === "primary" || catSettings[c.key as keyof typeof catSettings]).map((c) => (
                <NavItem
                  key={c.key}
                  id={`__tab-${c.key}`}
                  icon={c.icon}
                  name={c.name}
                  count={c.key === "primary" ? count("INBOX") : (byId.get(c.label)?.threadsUnread ?? 0)}
                  active={current === "INBOX" && (route.list.category ?? "primary") === c.key}
                  bold={(c.key === "primary" ? count("INBOX") : (byId.get(c.label)?.threadsUnread ?? 0)) > 0}
                  depth={0}
                  accountId={accountId}
                  test={`nav-tab-${c.key}`}
                  onClick={() => go({ label: "INBOX", category: c.key })}
                />
              )),
              ...PRIMARY.filter((x) => x.id !== "INBOX" && exists(x.id)).map((x) => item(x.id, x.icon, { test: `nav-${x.id}` })),
            ]
          : PRIMARY.filter((x) => exists(x.id)).map((x) => item(x.id, x.icon, { test: `nav-${x.id}` }))}
        {pending > 0 && item("OUTBOX", "outbox", { countValue: pending, test: "nav-OUTBOX" })}
        {scheduled > 0 && item("SCHEDULED", "schedule_send", { countValue: scheduled, test: "nav-SCHEDULED" })}
        <NavItem
          id="__more"
          icon={more ? "expand_less" : "expand_more"}
          name={more ? "Less" : "More"}
          count={0}
          active={false}
          bold={false}
          depth={0}
          accountId={accountId}
          onClick={() => setMore(!more)}
          test="nav-more"
        />
        {more && (
          <>
            {MORE.filter((x) => exists(x.id) && !(x.id === "SCHEDULED" && scheduled > 0)).map((x) =>
              item(x.id, x.icon, { name: x.id === "ALL" && acct?.kind === "imap" ? "All Mail" : undefined, test: `nav-${x.id}` }),
            )}
            {acct?.kind === "gmail" && (
              <>
                <NavItem
                  id="__cats"
                  icon={cats ? "arrow_drop_down" : "arrow_right"}
                  name="Categories"
                  count={0}
                  active={false}
                  bold={false}
                  depth={0}
                  accountId={accountId}
                  onClick={() => setCats(!cats)}
                />
                {cats && CATS.map((c) => item(c.label, c.icon, { depth: 1, onClick: () => go({ label: c.label }), test: `nav-${c.label}` }))}
              </>
            )}
            {!unified && (
              <NavItem
                id="__manage"
                icon="settings"
                name="Manage labels"
                count={0}
                active={false}
                bold={false}
                depth={0}
                accountId={accountId}
                onClick={() => useMail.setState((s) => ({ route: { ...s.route, settings: "labels" } }))}
              />
            )}
            {!unified && (
              <NavItem
                id="__new"
                icon="add"
                name="Create new label"
                count={0}
                active={false}
                bold={false}
                depth={0}
                accountId={accountId}
                onClick={() => ui({ labelDialog: { accountId } })}
              />
            )}
          </>
        )}
        {!unified && (
          <>
            <div className="labels-head">
              <span className="grow">Labels</span>
              <IconButton icon="add" label="Create new label" size="sm" onClick={() => ui({ labelDialog: { accountId } })} testId="new-label" />
            </div>
            {renderTree(tree, 0)}
          </>
        )}
        {unified && (
          <div className="account-strip">
            <Icon name="stacks" size={16} /> All inboxes ({accounts.length} accounts)
          </div>
        )}
      </div>
      {!navOpen && <span className="sr-only">Main menu collapsed</span>}
    </nav>
  );
}

function NavItem(props: {
  id: string;
  icon: string;
  name: string;
  count: number;
  active: boolean;
  bold: boolean;
  depth: number;
  expander?: React.ReactNode;
  color?: string | null;
  label?: Label;
  accountId: string;
  onClick: () => void;
  test?: string;
}) {
  const [drop, setDrop] = useState(false);
  const [menu, setMenu] = useState<ReturnType<typeof anchorOf> | null>(null);
  const droppable = !props.id.startsWith("__") && !["SNOOZED", "SCHEDULED", "OUTBOX", "DRAFT", "SENT", "ALL", "IMPORTANT"].includes(props.id);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-current={props.active ? "page" : undefined}
      aria-label={`${props.name}${props.count ? `, ${props.count} ${props.id === "DRAFT" ? "" : "unread"}` : ""}`}
      data-testid={props.test}
      className={["nav-item", props.active ? "active" : "", props.bold ? "bold" : "", drop ? "drop-target" : ""].join(" ")}
      style={{ paddingLeft: 26 + props.depth * 12 }}
      onClick={props.onClick}
      onKeyDown={(e) => e.key === "Enter" && props.onClick()}
      onDragOver={(e) => {
        if (!droppable || !e.dataTransfer.types.includes("application/x-courier-threads")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        const data = e.dataTransfer.getData("application/x-courier-threads");
        if (!data) return;
        e.preventDefault();
        const { accountId, threadIds } = JSON.parse(data) as { accountId: string; threadIds: string[] };
        const targets = [{ accountId, threadIds }];
        if (props.id === "INBOX" || props.id === "TRASH" || props.id === "SPAM") void applyLabels([props.id], [], { move: true, targets });
        else if (props.id === "STARRED") void applyLabels(["STARRED"], [], { targets });
        else void applyLabels([props.id], [], { move: true, targets });
      }}
    >
      {props.expander}
      <Icon name={props.icon} fill={props.active || props.icon === "label"} style={props.color ? { color: props.color } : undefined} />
      <span className="nav-name">{props.name}</span>
      {props.count > 0 && <span className="nav-count">{props.count.toLocaleString()}</span>}
      <span className="dot" style={{ display: props.bold ? undefined : "none" }} />
      {props.label && (
        <button
          type="button"
          className={["icon-btn xs nav-more", menu ? "open" : ""].join(" ")}
          aria-label={`Options for ${props.label.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(anchorOf(e.currentTarget));
          }}
        >
          <Icon name="more_vert" size={18} />
        </button>
      )}
      {menu && props.label && <LabelMenu label={props.label} anchor={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function LabelMenu({ label, anchor, onClose }: { label: Label; anchor: ReturnType<typeof anchorOf>; onClose: () => void }) {
  const update = (patch: Record<string, unknown>) =>
    void api
      .labelUpdate(label.accountId, label.id, patch)
      .then(() => loadLabels(label.accountId))
      .catch((e) => toast(errorText(e)));
  const colors: MenuEntry = {
    label: "Label color",
    submenu: () => (
      <>
        <div className="color-grid" role="group" aria-label="Label colors">
          {LABEL_BG.map((c) => (
            <button
              key={c}
              style={{ background: c }}
              className={label.bg === c ? "on" : ""}
              aria-label={`Color ${c}`}
              onClick={() => (update({ color: { backgroundColor: c, textColor: labelTextColor(c) } }), onClose())}
            />
          ))}
        </div>
        <button className="menu-item" onClick={() => (update({ color: { backgroundColor: "", textColor: "" } }), onClose())}>
          Remove color
        </button>
      </>
    ),
  };
  const vis = label.labelListVisibility ?? "labelShow";
  const items: MenuEntry[] = [
    { head: "In label list" },
    { label: "Show", checked: vis === "labelShow", run: () => update({ labelListVisibility: "labelShow" }) },
    { label: "Show if unread", checked: vis === "labelShowIfUnread", run: () => update({ labelListVisibility: "labelShowIfUnread" }) },
    { label: "Hide", checked: vis === "labelHide", run: () => update({ labelListVisibility: "labelHide" }) },
    { head: "In message list" },
    { label: "Show", checked: label.messageListVisibility !== "hide", run: () => update({ messageListVisibility: "show" }) },
    { label: "Hide", checked: label.messageListVisibility === "hide", run: () => update({ messageListVisibility: "hide" }) },
    { sep: true },
    colors,
    { label: "Edit", run: () => ui({ labelDialog: { accountId: label.accountId, edit: label } }) },
    {
      label: "Remove label",
      run: () =>
        ui({
          confirm: {
            title: "Remove label",
            body: `Delete the label "${leafName(label.name)}"? Conversations keep their other labels.`,
            ok: "Delete",
            run: () =>
              void api
                .labelDelete(label.accountId, label.id)
                .then(() => (loadLabels(label.accountId), getState().route.list.label === label.id && go({ label: "INBOX" })))
                .catch((e) => toast(errorText(e))),
          },
        }),
    },
    { label: "Add sublabel", run: () => ui({ labelDialog: { accountId: label.accountId, parent: label.name } }) },
  ];
  return <Menu anchor={anchor} items={items} onClose={onClose} label={`${label.name} options`} />;
}

export function labelForRoute(): Label | undefined {
  const s = getState();
  return labelsFor(s.accountId).find((l) => l.id === s.route.list.label);
}
