// Shared bits: icons, avatars, the logo, popover menus, dialogs, tooltips, file-type icons.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { avatarColor, initialOf } from "../core/addresses";

export function Icon({
  name,
  fill,
  size,
  style,
  className,
}: {
  name: string;
  fill?: boolean;
  size?: 16 | 18 | 20 | 24;
  style?: CSSProperties;
  className?: string;
}) {
  const cls = ["ic", fill ? "fill" : "", size === 24 ? "s24" : size === 18 ? "s18" : size === 16 ? "s16" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} style={style} aria-hidden="true">
      {name}
    </span>
  );
}

export function IconButton(props: {
  icon: string;
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  size?: "sm" | "xs";
  fill?: boolean;
  iconSize?: 16 | 18 | 20 | 24;
  disabled?: boolean;
  on?: boolean;
  className?: string;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={["icon-btn", props.size ?? "", props.on ? "on" : "", props.className ?? ""].filter(Boolean).join(" ")}
      aria-label={props.label}
      data-tip={props.label}
      data-testid={props.testId}
      disabled={props.disabled}
      style={props.style}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick?.(e);
      }}
    >
      <Icon name={props.icon} fill={props.fill} size={props.iconSize} />
    </button>
  );
}

export function Avatar({ name, email, size = 32, photo, color }: { name: string; email: string; size?: number; photo?: string | null; color?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: photo && !broken ? "transparent" : (color ?? avatarColor(email)) }}
      aria-hidden="true"
    >
      {photo && !broken ? <img src={photo} alt="" onError={() => setBroken(true)} referrerPolicy="no-referrer" /> : initialOf(name || email)}
    </span>
  );
}

/** Courier's mark: a paper plane on a teal tile (our own artwork, same as the app icon). */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#16a0a0" />
          <stop offset="1" stopColor="#0e5c7a" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="url(#cg)" />
      <circle cx="9.2" cy="22.6" r="1.1" fill="#ffb84d" />
      <circle cx="7" cy="24.3" r="0.8" fill="#ffc977" />
      <path d="M7 15.6 25.4 8 15 19.6Z" fill="#fff" />
      <path d="M15 19.6 25.4 8 18.6 25.6Z" fill="#d6e9f0" />
      <path d="M15 19.6 16.6 23.4 18.6 25.6 17.6 21.4Z" fill="#a0c8d6" />
    </svg>
  );
}

export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <a
      className="logo"
      href="#inbox"
      aria-label="Courier"
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
    >
      <LogoMark />
      <span className="logo-word">Courier</span>
    </a>
  );
}

// ---- menus ----

export interface MenuEntry {
  label?: string;
  icon?: string;
  iconFill?: boolean;
  iconColor?: string;
  right?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  sep?: boolean;
  head?: string;
  submenu?: MenuEntry[] | ((close: () => void) => ReactNode);
  subClassName?: string;
  run?: () => void;
  testId?: string;
  keepOpen?: boolean;
  custom?: ReactNode;
}

interface Anchor {
  x: number;
  y: number;
  w?: number;
  h?: number;
  align?: "left" | "right";
}

export function anchorOf(el: Element, align: "left" | "right" = "left"): Anchor {
  // Menus hang off the 20 px icon, not the 40 px hover circle around it (as in the reference).
  const icon = el.classList.contains("icon-btn") ? el.querySelector(":scope > .ic") : null;
  const r = (icon ?? el).getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, align };
}

function place(menu: HTMLElement, a: Anchor, side: "below" | "right") {
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x: number;
  let y: number;
  if (side === "right") {
    // Submenus open level with the item that opened them.
    x = a.x + (a.w ?? 0);
    y = a.y;
    if (x + mw > vw - 8) x = a.x - mw;
  } else {
    x = a.align === "right" ? a.x + (a.w ?? 0) - mw : a.x;
    y = a.y + (a.h ?? 0);
    if (y + mh > vh - 8) y = Math.max(8, a.y - mh);
  }
  x = Math.max(8, Math.min(x, vw - mw - 8));
  y = Math.max(8, Math.min(y, vh - mh - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

export function Menu({
  anchor,
  items,
  onClose,
  side = "below",
  className,
  label,
  children,
}: {
  anchor: Anchor;
  items?: MenuEntry[];
  onClose: () => void;
  side?: "below" | "right";
  className?: string;
  label?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ i: number; anchor: Anchor } | null>(null);
  useLayoutEffect(() => {
    if (ref.current) place(ref.current, anchor, side);
  });
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as Element).closest?.(".menu")) return; // a submenu
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (!items) return;
      const usable = items.map((it, i) => (!it.sep && !it.head && !it.disabled && !it.custom ? i : -1)).filter((i) => i >= 0);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const pos = usable.indexOf(active);
        const next = e.key === "ArrowDown" ? usable[(pos + 1) % usable.length] : usable[(pos - 1 + usable.length) % usable.length];
        setActive(next ?? -1);
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const it = items[active];
        if (it.run) {
          it.run();
          if (!it.keepOpen) onClose();
        }
      }
    };
    setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [items, active, onClose]);
  return createPortal(
    <div ref={ref} className={["menu", className ?? ""].join(" ")} role="menu" aria-label={label} onMouseDown={(e) => e.stopPropagation()}>
      {children}
      {items?.map((it, i) => {
        if (it.sep) return <div key={i} className="menu-sep" role="separator" />;
        if (it.head)
          return (
            <div key={i} className="menu-head">
              {it.head}
            </div>
          );
        if (it.custom) return <div key={i}>{it.custom}</div>;
        return (
          <button
            key={i}
            type="button"
            role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={it.checked === undefined ? undefined : it.checked === "mixed" ? "mixed" : it.checked}
            aria-disabled={it.disabled}
            data-testid={it.testId}
            className={[
              "menu-item",
              it.disabled ? "disabled" : "",
              active === i ? "active" : "",
              !it.icon && it.checked === undefined && items.some((x) => x.icon || x.checked !== undefined) ? "indent" : "",
            ].join(" ")}
            onMouseEnter={(e) => {
              setActive(i);
              if (it.submenu) setSub({ i, anchor: anchorOf(e.currentTarget) });
              else setSub(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled) return;
              if (it.submenu) {
                setSub({ i, anchor: anchorOf(e.currentTarget) });
                return;
              }
              it.run?.();
              if (!it.keepOpen) onClose();
            }}
          >
            {it.checked !== undefined && (
              <span className="menu-check">
                <Icon
                  name={it.checked === "mixed" ? "indeterminate_check_box" : it.checked ? "check_box" : "check_box_outline_blank"}
                  fill={!!it.checked}
                  size={18}
                />
              </span>
            )}
            {it.icon && <Icon name={it.icon} fill={it.iconFill} style={it.iconColor ? { color: it.iconColor } : undefined} />}
            <span>{it.label}</span>
            {it.right && <span className="right">{it.right}</span>}
            {it.submenu && <Icon name="arrow_right" className="sub-arrow" />}
          </button>
        );
      })}
      {sub &&
        items?.[sub.i]?.submenu &&
        (typeof items[sub.i].submenu === "function" ? (
          <Menu anchor={sub.anchor} side="right" onClose={onClose} className={items[sub.i].subClassName}>
            {(items[sub.i].submenu as (close: () => void) => ReactNode)(onClose)}
          </Menu>
        ) : (
          <Menu anchor={sub.anchor} side="right" items={items[sub.i].submenu as MenuEntry[]} onClose={onClose} />
        ))}
    </div>,
    document.body,
  );
}

/** A button that opens a menu below itself. */
export function MenuButton({
  children,
  items,
  className,
  label,
  align = "left",
  testId,
  render,
}: {
  children: ReactNode;
  items?: () => MenuEntry[];
  className?: string;
  label: string;
  align?: "left" | "right";
  testId?: string;
  render?: (close: () => void) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label}
        data-tip={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : anchorOf(e.currentTarget, align));
        }}
      >
        {children}
      </button>
      {anchor && (
        <Menu anchor={anchor} items={items?.()} onClose={() => setAnchor(null)} label={label}>
          {render?.(() => setAnchor(null))}
        </Menu>
      )}
    </>
  );
}

// ---- dialogs ----

export function Dialog({
  title,
  children,
  actions,
  onClose,
  wide,
  testId,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  testId?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={["dialog", wide ? "wide" : ""].join(" ")} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        {title && <h2>{title}</h2>}
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---- tooltips ([data-tip]) ----

export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.("[data-tip]");
      if (el === current) return;
      current = el;
      clearTimeout(timer);
      setTip(null);
      if (!el) return;
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const text = el.getAttribute("data-tip") ?? "";
        if (text) setTip({ text, x: r.left + r.width / 2, y: r.bottom + 6 });
      }, 600);
    };
    const hide = () => {
      clearTimeout(timer);
      setTip(null);
      current = null;
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("keydown", hide);
    };
  }, []);
  if (!tip) return null;
  const left = Math.min(window.innerWidth - 8, Math.max(8, tip.x));
  return (
    <div className="tooltip" style={{ left, top: tip.y, transform: "translateX(-50%)" }} role="tooltip">
      {tip.text}
    </div>
  );
}

// ---- file icons ----

const FILE_KINDS: [RegExp, string, string][] = [
  [/pdf/, "PDF", "#ea4335"],
  [/^image\//, "IMG", "#d93025"],
  [/word|msword|officedocument\.wordprocessing|rtf|opendocument\.text/, "DOC", "#4285f4"],
  [/sheet|excel|csv|opendocument\.spreadsheet/, "XLS", "#0f9d58"],
  [/presentation|powerpoint|opendocument\.presentation/, "PPT", "#f4b400"],
  [/zip|compressed|tar|gzip|rar|7z/, "ZIP", "#5f6368"],
  [/^audio\//, "AUD", "#9334e6"],
  [/^video\//, "VID", "#d93025"],
  [/calendar/, "CAL", "#1a73e8"],
  [/rfc822/, "EML", "#5f6368"],
  [/^text\//, "TXT", "#5f6368"],
];

export function FileIcon({ mime, name }: { mime: string; name?: string }) {
  const m = (mime || "").toLowerCase();
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  const hit = FILE_KINDS.find(([re]) => re.test(m)) ?? (ext === "pdf" ? FILE_KINDS[0] : null);
  const [, label, color] = hit ?? [null, (ext || "file").slice(0, 3).toUpperCase(), "#5f6368"];
  return (
    <span className="file-ic" style={{ background: color }} aria-hidden="true">
      {label}
    </span>
  );
}

export function useOutsideClick(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const f = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    setTimeout(() => document.addEventListener("mousedown", f), 0);
    return () => document.removeEventListener("mousedown", f);
  }, [ref, onOut, active]);
}
