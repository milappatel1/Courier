// Quick settings drawer: density, theme, inbox type, reading pane, conversation view.
import { useRef } from "react";
import type { Density, InboxType, ReadingPane } from "../state/settings";
import { THEMES, themeById } from "../state/themes";
import { openSettings, setSetting, ui, useMail } from "../state/store";
import { Dialog, Icon, IconButton } from "./common";

/** Small drawings of each choice (our own, not copies of the reference artwork). */
function Thumb({ kind }: { kind: string }) {
  // Density rows: a checkbox square and a line per row; Default also shows an attachment chip.
  const rows = (n: number, top: number, gap: number, chip = false) =>
    Array.from({ length: n }, (_, i) => (
      <span key={i}>
        <b style={{ top: top + i * gap }} />
        <i style={{ top: top + i * gap + 1, left: 16 }} />
        {chip && i === n - 1 && <em style={{ top: top + i * gap + 6 }} />}
      </span>
    ));
  const lines = (n: number, top = 8, gap = 8, left = 8, right = 8) =>
    Array.from({ length: n }, (_, i) => <i key={i} style={{ top: top + i * gap, left, right }} />);
  if (kind === "default") return <span className="qs-thumb density">{rows(2, 6, 10, true)}</span>;
  if (kind === "comfortable") return <span className="qs-thumb density">{rows(2, 8, 14)}</span>;
  if (kind === "compact") return <span className="qs-thumb density">{rows(3, 5, 9)}</span>;
  if (kind === "pane-none") return <span className="qs-thumb">{lines(5, 7, 8)}</span>;
  if (kind === "pane-right")
    return (
      <span className="qs-thumb">
        <span className="split-v" />
        {lines(5, 7, 8, 6, 40)}
        {lines(3, 9, 8, 38, 6)}
      </span>
    );
  if (kind === "pane-below")
    return (
      <span className="qs-thumb">
        <span className="split-h" />
        {lines(2, 6, 8)}
        {lines(2, 30, 7)}
      </span>
    );
  // Inbox types: sections drawn as header bars over rows.
  if (kind === "inbox-default") return <span className="qs-thumb">{lines(5, 7, 8)}</span>;
  if (kind === "inbox-split")
    return (
      <span className="qs-thumb">
        <span className="sec-bar" style={{ top: 4 }} />
        {lines(2, 11, 6)}
        <span className="sec-bar" style={{ top: 25 }} />
        {lines(2, 32, 6)}
      </span>
    );
  if (kind === "inbox-multiple")
    return (
      <span className="qs-thumb">
        <span className="sec-bar" style={{ top: 4 }} />
        {lines(1, 11, 6)}
        <span className="sec-bar" style={{ top: 17 }} />
        {lines(1, 24, 6)}
        <span className="sec-bar" style={{ top: 30 }} />
        {lines(1, 37, 6)}
      </span>
    );
  return <span className="qs-thumb">{lines(3, 8, 12)}</span>;
}

/** The current theme as a tiny window: backdrop, a nav strip and the panel. */
function ThemeThumb({ id }: { id: string }) {
  const t = themeById(id);
  const dark = t.family === "dark" || t.family === "dark-panel";
  return (
    <span className="qs-theme-thumb" style={{ background: t.swatch }}>
      <span className="nav" style={{ background: dark ? "rgba(255,255,255,.5)" : "rgba(68,71,70,.5)" }} />
      <span className="panel" style={{ background: dark ? "rgba(51,51,51,.9)" : "rgba(255,255,255,.9)" }}>
        <i style={{ background: dark ? "rgba(255,255,255,.4)" : "#c4c7c5" }} />
        <i style={{ background: dark ? "rgba(255,255,255,.4)" : "#c4c7c5" }} />
      </span>
    </span>
  );
}

export function QuickSettings() {
  const s = useMail((st) => st.settings);
  const opt = (on: boolean, label: React.ReactNode, onClick: () => void, thumb?: string, test?: string) => (
    <div className="qs-opt" role="radio" aria-checked={on} tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === "Enter" && onClick()} data-testid={test}>
      <span className={["radio", on ? "on" : ""].join(" ")} />
      <span className="lbl">{label}</span>
      {thumb && <Thumb kind={thumb} />}
    </div>
  );
  const density = (d: Density, label: string) => opt(s.density === d, label, () => void setSetting("density", d), d, `qs-density-${d}`);
  const inboxThumb: Record<InboxType, string> = {
    default: "inbox-default",
    important: "inbox-split",
    unread: "inbox-split",
    starred: "inbox-split",
    priority: "inbox-multiple",
    multiple: "inbox-multiple",
  };
  const inbox = (t: InboxType, label: string, customize?: string) =>
    opt(
      s.inboxType === t,
      <>
        {label}
        {customize && s.inboxType === t && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openSettings("inbox");
            }}
          >
            Customize
          </button>
        )}
      </>,
      () => void setSetting("inboxType", t),
      inboxThumb[t],
      `qs-inbox-${t}`,
    );
  const pane = (p: ReadingPane, label: string) => opt(s.readingPane === p, label, () => void setSetting("readingPane", p), `pane-${p}`, `qs-pane-${p}`);
  const theme = themeById(s.theme);
  return (
    <aside className="qs" aria-label="Quick settings" data-testid="quick-settings">
      <div className="qs-head">
        <h2>Quick settings</h2>
        <IconButton icon="close" label="Close" className="qs-close" onClick={() => ui({ quickSettings: false })} />
      </div>
      <button className="qs-all" onClick={() => openSettings("general")} data-testid="see-all-settings">
        See all settings
      </button>
      <div className="qs-scroll">
        <div className="qs-sec">
          <h3>Density</h3>
          {density("default", "Default")}
          {density("comfortable", "Comfortable")}
          {density("compact", "Compact")}
        </div>
        <div className="qs-sec">
          <h3>
            Theme
            <button onClick={() => ui({ themePicker: true })} data-testid="qs-themes">
              View all
            </button>
          </h3>
          <button
            className="qs-theme"
            onClick={() => ui({ themePicker: true })}
            aria-label={`${theme.name} theme. Change theme`}
            data-testid="qs-theme-current"
          >
            <ThemeThumb id={theme.id} />
          </button>
        </div>
        <div className="qs-sec">
          <h3>Inbox type</h3>
          {inbox("default", "Default", "customize")}
          {inbox("important", "Important first")}
          {inbox("unread", "Unread first")}
          {inbox("starred", "Starred first")}
          {inbox("priority", "Priority Inbox", "customize")}
          {inbox("multiple", "Multiple Inboxes", "customize")}
        </div>
        <div className="qs-sec">
          <h3>Reading pane</h3>
          {pane("none", "No split")}
          {pane("right", "Right of inbox")}
          {pane("below", "Below inbox")}
        </div>
        <div className="qs-sec" style={{ borderBottom: 0 }}>
          <h3>Email threading</h3>
          <label className="qs-opt" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={s.conversationView}
              onChange={(e) => void setSetting("conversationView", e.target.checked)}
              style={{ width: 18, height: 18 }}
              data-testid="qs-conversation-view"
            />
            <span className="lbl">Conversation view</span>
            <Icon name="help" size={18} />
          </label>
        </div>
      </div>
    </aside>
  );
}

export function ThemePicker() {
  const current = useMail((s) => s.settings.theme);
  const orig = useRef(current);
  const file = useRef<HTMLInputElement>(null);
  const close = (save: boolean) => {
    if (!save) void setSetting("theme", orig.current);
    ui({ themePicker: false });
  };
  return (
    <Dialog
      title="Pick your theme"
      wide
      onClose={() => close(false)}
      testId="theme-picker"
      actions={
        <>
          <button className="btn text" onClick={() => file.current?.click()}>
            My photos
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn text" onClick={() => close(false)}>
            Cancel
          </button>
          <button className="btn filled" onClick={() => close(true)} data-testid="theme-save">
            Save
          </button>
        </>
      }
    >
      <div className="theme-grid">
        {THEMES.filter((t) => t.id !== "custom").map((t) => (
          <button
            key={t.id}
            className={["theme-tile", current === t.id ? "on" : ""].join(" ")}
            style={{ background: t.swatch }}
            onClick={() => void setSetting("theme", t.id)}
            aria-label={`${t.name} theme`}
            data-testid={`theme-${t.id}`}
          >
            <span>{t.name}</span>
          </button>
        ))}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => {
            void setSetting("customImage", String(r.result));
            void setSetting("theme", "custom");
          };
          r.readAsDataURL(f);
        }}
      />
    </Dialog>
  );
}
