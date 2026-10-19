// Menus shared by the list and the conversation: Label as, Move to, Snooze, star picker.
import { useMemo, useState } from "react";
import { snoozePresets } from "../core/dates";
import { labelTree, type LabelNode } from "../core/labels";
import type { Label } from "../ipc/types";
import { applyLabels, currentTargets, snooze } from "../state/actions";
import { labelsFor, ui, useMail } from "../state/store";
import { Icon, Menu, type MenuEntry } from "./common";

type Anchor = Parameters<typeof Menu>[0]["anchor"];

function flatten(nodes: LabelNode<Label>[], depth = 0): { label: Label; depth: number }[] {
  return nodes.flatMap((n) => [...(n.label ? [{ label: n.label, depth }] : []), ...flatten(n.children, depth + 1)]);
}

const CATEGORY_ITEMS: [string, string][] = [
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_FORUMS", "Forums"],
  ["CATEGORY_PROMOTIONS", "Promotions"],
];

/**
 * "Label as": checkboxes (mixed when only some conversations have it) for user labels by full name, then
 * the categories on Gmail accounts; search; Apply, or Create new / Manage labels when nothing changed.
 */
export function LabelAsBody({ onClose, accountId, current }: { onClose: () => void; accountId: string; current: string[][] }) {
  const labels = labelsFor(accountId);
  const gmail = useMail((s) => s.accounts.find((a) => a.id === accountId)?.kind === "gmail");
  const [q, setQ] = useState("");
  const choices = useMemo(
    () => [
      ...flatten(labelTree(labels.filter((l) => l.type === "user"))).map((u) => ({ id: u.label.id, name: u.label.name })),
      ...(gmail ? CATEGORY_ITEMS.map(([id, name]) => ({ id, name })) : []),
    ],
    [labels, gmail],
  );
  const initial = (id: string): boolean | "mixed" => {
    const n = current.filter((ls) => ls.includes(id)).length;
    return n === 0 ? false : n === current.length ? true : "mixed";
  };
  const [state, setState] = useState<Record<string, boolean | "mixed">>(() => Object.fromEntries(choices.map((c) => [c.id, initial(c.id)])));
  const changed = choices.filter((c) => (state[c.id] ?? false) !== initial(c.id));
  const shown = choices.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const apply = () => {
    const add = changed.filter((c) => state[c.id] === true).map((c) => c.id);
    const remove = changed.filter((c) => state[c.id] === false).map((c) => c.id);
    // A conversation sits in one category: picking one takes it out of the others.
    const cat = add.find((id) => id.startsWith("CATEGORY_"));
    if (cat) remove.push(...["CATEGORY_PERSONAL", ...CATEGORY_ITEMS.map(([id]) => id)].filter((id) => id !== cat && !remove.includes(id)));
    if (add.length || remove.length) void applyLabels(add, remove);
    onClose();
  };
  return (
    <>
      <div className="menu-head">Label as:</div>
      <div className="menu-search">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder=""
          aria-label="Search labels"
          onKeyDown={(e) => e.key === "Enter" && apply()}
          data-testid="label-search"
        />
        <Icon name="search" size={20} />
      </div>
      {shown.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={state[c.id] === "mixed" ? "mixed" : !!state[c.id]}
          className="menu-item"
          data-testid={`label-as-${c.name}`}
          onClick={() => setState((s) => ({ ...s, [c.id]: s[c.id] === true ? false : true }))}
        >
          <span className="menu-check">
            <Icon
              name={state[c.id] === "mixed" ? "indeterminate_check_box" : state[c.id] ? "check_box" : "check_box_outline_blank"}
              fill={!!state[c.id]}
              size={18}
            />
          </span>
          <span>{c.name}</span>
        </button>
      ))}
      <div className="menu-sep" />
      {changed.length > 0 ? (
        <button type="button" className="menu-item indent" onClick={apply} data-testid="label-apply">
          Apply
        </button>
      ) : (
        <>
          <button
            type="button"
            className="menu-item indent"
            onClick={() => (ui({ labelDialog: { accountId, applyTo: currentTargets().flatMap((t) => t.threadIds) } }), onClose())}
          >
            Create new
          </button>
          <button
            type="button"
            className="menu-item indent"
            onClick={() => (useMail.setState((s) => ({ route: { ...s.route, settings: "labels" } })), onClose())}
          >
            Manage labels
          </button>
        </>
      )}
    </>
  );
}

export function LabelAsMenu({ anchor, onClose, accountId, current }: { anchor: Anchor; onClose: () => void; accountId: string; current: string[][] }) {
  return (
    <Menu anchor={anchor} onClose={onClose} label="Label as" className="label-menu">
      <LabelAsBody onClose={onClose} accountId={accountId} current={current} />
    </Menu>
  );
}

/** "Move to": the inbox, a label, spam or trash. */
export function MoveToMenu({ anchor, onClose, accountId }: { anchor: Anchor; onClose: () => void; accountId: string }) {
  const labels = labelsFor(accountId);
  const user = flatten(labelTree(labels.filter((l) => l.type === "user")));
  const here = useMail.getState().route.list.label;
  const items: MenuEntry[] = [
    { head: "Move to:" },
    ...(here !== "INBOX" ? [{ label: "Inbox", run: () => void applyLabels(["INBOX"], [], { move: true }), testId: "move-INBOX" }] : []),
    ...user.map((u) => ({ label: u.label.name, run: () => void applyLabels([u.label.id], [], { move: true }), testId: `move-${u.label.name}` })),
    { sep: true },
    { label: "Spam", run: () => void applyLabels(["SPAM"], [], { move: true }) },
    { label: "Trash", run: () => void applyLabels(["TRASH"], [], { move: true }) },
    { sep: true },
    { label: "Create new", run: () => ui({ labelDialog: { accountId, applyTo: currentTargets().flatMap((t) => t.threadIds) } }) },
  ];
  return <Menu anchor={anchor} items={items} onClose={onClose} label="Move to" />;
}

export function SnoozeMenu({ anchor, onClose, targets }: { anchor: Anchor; onClose: () => void; targets?: ReturnType<typeof currentTargets> }) {
  const presets = snoozePresets();
  return (
    <Menu anchor={anchor} onClose={onClose} label="Snooze until" className="snooze-menu">
      <div className="menu-head" style={{ height: 32 }}>
        Snooze until…
      </div>
      {presets.map((p) => (
        <button
          key={p.key}
          type="button"
          role="menuitem"
          className="menu-item"
          style={{ paddingLeft: 24, minWidth: 256 }}
          data-testid={`snooze-${p.key}`}
          onClick={() => (void snooze(p.when.getTime(), targets), onClose())}
        >
          <span>{p.label}</span>
          <span className="right" style={{ marginRight: -24 }}>
            {p.detail}
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        style={{ paddingLeft: 24 }}
        data-testid="snooze-pick"
        onClick={() => {
          const t = targets ?? currentTargets();
          ui({ snoozePicker: { accountId: t[0]?.accountId ?? "", threadIds: t.flatMap((x) => x.threadIds) } });
          onClose();
        }}
      >
        <Icon name="calendar_today" />
        <span>Pick date & time</span>
      </button>
    </Menu>
  );
}
