// The header (drawn into the window's title bar): menu button, logo, search with suggestions and the
// advanced-search panel, help, quick settings and the account switcher.
import { useEffect, useMemo, useRef, useState } from "react";
import { DATE_WITHIN, EMPTY_ADVANCED, criteriaFromAdvanced, fromAdvanced, toAdvanced, type AdvancedFields } from "../core/search/advanced";
import { api } from "../ipc/api";
import type { Contact } from "../ipc/types";
import { getState, setSetting, search, ui, useMail, activeAccount, go, NO_LABELS } from "../state/store";
import { AccountMenu } from "./AccountMenu";
import { Avatar, Icon, IconButton, Logo, MenuButton } from "./common";
import { FilterDialog } from "./FilterDialog";

export function Header() {
  const navOpen = useMail((s) => s.settings.navOpen);
  const online = useMail((s) => s.online);
  const accounts = useMail((s) => s.accounts);
  const accountId = useMail((s) => s.accountId);
  const acct = activeAccount();
  const menuOpen = useMail((s) => s.ui.accountMenu);
  return (
    <header className="header drag" data-tauri-drag-region>
      <div className="header-left" data-tauri-drag-region>
        <IconButton icon="menu" label="Main menu" className="menu-btn" iconSize={24} onClick={() => void setSetting("navOpen", !navOpen)} testId="main-menu" />
        <Logo onClick={() => go({ label: "INBOX" })} />
      </div>
      {accounts.length > 0 && <SearchBar />}
      <div className="header-right" data-tauri-drag-region>
        {!online && (
          <span className="offline-pill" role="status">
            <Icon name="cloud_off" size={18} /> Offline
          </span>
        )}
        <MenuButton
          className="icon-btn"
          label="Support"
          align="right"
          items={() => [
            { label: "Keyboard shortcuts", icon: "keyboard", run: () => ui({ shortcutsHelp: true }) },
            {
              label: "Set up Google sign-in",
              icon: "key",
              // Settings needs an account to open; before the first one, the Add Gmail dialog has the same setup.
              run: () =>
                useMail.getState().accounts.length
                  ? useMail.setState((s) => ({ route: { ...s.route, settings: "accounts" } }))
                  : ui({ addAccount: { kind: "gmail" } }),
            },
            {
              label: "About Courier",
              icon: "info",
              run: () =>
                ui({
                  confirm: {
                    title: "Courier",
                    body: `Version ${useMail.getState().info?.version ?? ""}. A mail client for every account.`,
                    ok: "OK",
                    run: () => {},
                  },
                }),
            },
          ]}
        >
          <Icon name="help" size={24} />
        </MenuButton>
        <IconButton
          icon="settings"
          label="Settings"
          iconSize={24}
          onClick={() => ui({ quickSettings: !useMail.getState().ui.quickSettings })}
          on={useMail.getState().ui.quickSettings}
          testId="settings-gear"
        />
        {accounts.length > 0 && (
          <button
            type="button"
            className="avatar-btn"
            aria-label={acct ? `Account: ${acct.name} (${acct.email})` : "All inboxes"}
            data-testid="account-button"
            onClick={() => ui({ accountMenu: !menuOpen })}
          >
            {accountId === "all" ? (
              <span className="avatar" style={{ width: 32, height: 32, background: "#5f6368" }}>
                <Icon name="stacks" />
              </span>
            ) : (
              acct && <Avatar name={acct.name} email={acct.email} photo={acct.photo} color={acct.color} size={32} />
            )}
          </button>
        )}
      </div>
      {menuOpen && <AccountMenu onClose={() => ui({ accountMenu: false })} />}
    </header>
  );
}

function SearchBar() {
  const route = useMail((s) => s.route);
  const focusTick = useMail((s) => s.ui.searchFocus);
  const advancedOpen = useMail((s) => s.ui.advancedSearch);
  const [text, setText] = useState(route.list.query ?? "");
  const [focused, setFocused] = useState(false);
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [on, setOn] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(route.list.query ?? ""), [route.list.query]);
  useEffect(() => {
    if (focusTick) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusTick]);
  useEffect(() => {
    const q = text.trim();
    if (!focused || q.length < 2 || /[:()]/.test(q)) {
      setSugg([]);
      return;
    }
    let live = true;
    void api.contacts(q, useMail.getState().accountId === "all" ? null : useMail.getState().accountId, 6).then((c) => live && setSugg(c));
    return () => {
      live = false;
    };
  }, [text, focused]);
  const submit = (q = text) => {
    setFocused(false);
    input.current?.blur();
    // Running a search closes the search options, as on the web.
    if (getState().ui.advancedSearch) ui({ advancedSearch: false });
    search(q);
  };
  return (
    <form
      className={["search", focused ? "focused" : "", focused && sugg.length ? "dropdown" : ""].join(" ")}
      role="search"
      aria-label="Search mail"
      onSubmit={(e) => {
        e.preventDefault();
        submit(on >= 0 && sugg[on] ? `from:${sugg[on].email}` : text);
      }}
    >
      <IconButton icon="search" label="Search mail" iconSize={24} onClick={() => submit()} />
      <input
        ref={input}
        value={text}
        placeholder="Search mail"
        aria-label="Search mail"
        data-testid="search-input"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setOn(-1);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setText(route.list.query ?? "");
            input.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOn((o) => Math.min(sugg.length - 1, o + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setOn((o) => Math.max(-1, o - 1));
          }
        }}
      />
      {text && <IconButton icon="close" label="Clear search" iconSize={24} onClick={() => submit("")} />}
      <IconButton icon="tune" label="Show search options" iconSize={24} onClick={() => ui({ advancedSearch: !advancedOpen })} testId="search-options" />
      {focused && sugg.length > 0 && (
        <div className="search-suggest" role="listbox">
          {sugg.map((c, i) => (
            <div
              key={c.email}
              role="option"
              aria-selected={on === i}
              className={["sugg", on === i ? "on" : ""].join(" ")}
              onMouseDown={(e) => {
                e.preventDefault();
                submit(`from:${c.email}`);
              }}
            >
              <Avatar name={c.name} email={c.email} size={24} />
              <span>{c.name || c.email}</span>
              {c.name && <span className="who">{c.email}</span>}
            </div>
          ))}
        </div>
      )}
      {advancedOpen && <AdvancedSearch initial={toAdvanced(text)} onClose={() => ui({ advancedSearch: false })} onSearch={(q) => submit(q)} />}
    </form>
  );
}

export function AdvancedSearch({ initial, onClose, onSearch }: { initial: AdvancedFields; onClose: () => void; onSearch: (q: string) => void }) {
  const [f, setF] = useState<AdvancedFields>({ ...EMPTY_ADVANCED, ...initial });
  const [filter, setFilter] = useState(false);
  const labels = useMail((s) => s.labels[s.accountId] ?? NO_LABELS);
  const ref = useRef<HTMLDivElement>(null);
  const set = (k: keyof AdvancedFields, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const searchIn = useMemo(
    () => [
      ["anywhere", "All Mail"],
      ["inbox", "Inbox"],
      ["starred", "Starred"],
      ["sent", "Sent Mail"],
      ["drafts", "Drafts"],
      ["spam", "Spam"],
      ["trash", "Trash"],
      ...labels.filter((l) => l.type === "user").map((l) => [l.name, l.name]),
    ],
    [labels],
  );
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".scrim") && onClose();
    document.addEventListener("keydown", k);
    setTimeout(() => document.addEventListener("mousedown", down), 0);
    return () => {
      document.removeEventListener("keydown", k);
      document.removeEventListener("mousedown", down);
    };
  }, [onClose]);
  const text = (k: "from" | "to" | "subject" | "hasWords" | "doesntHave", label: string) => (
    <div className="adv-row">
      <label htmlFor={`adv-${k}`}>{label}</label>
      <input id={`adv-${k}`} type="text" value={f[k]} onChange={(e) => set(k, e.target.value)} data-testid={`adv-${k}`} />
    </div>
  );
  return (
    <div className="advanced" ref={ref} role="dialog" aria-label="Advanced search" onMouseDown={(e) => e.stopPropagation()} data-testid="advanced-search">
      {text("from", "From")}
      {text("to", "To")}
      {text("subject", "Subject")}
      {text("hasWords", "Has the words")}
      {text("doesntHave", "Doesn't have")}
      <div className="adv-row">
        <label>Size</label>
        <div className="adv-pair">
          <select value={f.sizeOp} onChange={(e) => set("sizeOp", e.target.value)} aria-label="Size operator" style={{ width: 252 }}>
            <option value="larger">greater than</option>
            <option value="smaller">less than</option>
          </select>
          <input type="number" min="0" value={f.size} onChange={(e) => set("size", e.target.value)} aria-label="Size value" style={{ width: 138 }} />
          <select value={f.sizeUnit} onChange={(e) => set("sizeUnit", e.target.value)} aria-label="Size unit" style={{ width: 114 }}>
            <option value="MB">MB</option>
            <option value="KB">KB</option>
            <option value="bytes">Bytes</option>
          </select>
        </div>
      </div>
      <div className="adv-row">
        <label>Date within</label>
        <div className="adv-pair">
          <select value={f.dateWithin || "1 day"} onChange={(e) => set("dateWithin", e.target.value)} aria-label="Date within" style={{ width: 252 }}>
            {Object.keys(DATE_WITHIN).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={f.date.replace(/\//g, "-")}
            onChange={(e) => set("date", e.target.value.replace(/-/g, "/"))}
            aria-label="Date"
            style={{ width: 257 }}
          />
        </div>
      </div>
      <div className="adv-row">
        <label>Search</label>
        <select value={f.searchIn} onChange={(e) => set("searchIn", e.target.value)} aria-label="Search in">
          {searchIn.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <label className="adv-check">
        <input type="checkbox" checked={f.hasAttachment} onChange={(e) => set("hasAttachment", e.target.checked)} data-testid="adv-has-attachment" />
        Has attachment
      </label>
      <div className="adv-actions">
        <button type="button" className="btn text" onClick={() => setFilter(true)} data-testid="adv-create-filter">
          Create filter
        </button>
        <button type="button" className="btn filled" onClick={() => onSearch(fromAdvanced(f))} data-testid="adv-search">
          Search
        </button>
      </div>
      {filter && <FilterDialog criteria={criteriaFromAdvanced(f)} onClose={() => (setFilter(false), onClose())} />}
    </div>
  );
}

export function AvatarFor({ accountId, size = 32 }: { accountId: string; size?: number }) {
  const a = useMail((s) => s.accounts.find((x) => x.id === accountId));
  if (!a) return null;
  return <Avatar name={a.name} email={a.email} photo={a.photo} color={a.color} size={size} />;
}
