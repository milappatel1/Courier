// Layout check for every window size: finds siblings that overlap, things past the window's right edge, a
// page that scrolls sideways, and one-line text cut off without an ellipsis. Used by the end-to-end run and,
// in the browser preview, as window.__layoutIssues().

/** The part of an element that can be seen, after every ancestor that clips. */
function visibleRect(e: Element) {
  const r = e.getBoundingClientRect();
  let [left, right, top, bottom] = [r.left, r.right, r.top, r.bottom];
  for (let p = e.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const q = p.getBoundingClientRect();
      left = Math.max(left, q.left);
      right = Math.min(right, q.right);
      top = Math.max(top, q.top);
      bottom = Math.min(bottom, q.bottom);
    }
  }
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function shown(e: Element) {
  if (e.closest(".sr-only")) return false;
  const cs = getComputedStyle(e);
  const r = visibleRect(e);
  return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
}

function describe(e: Element) {
  const el = e as HTMLElement;
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  return `${el.dataset?.testid ? `[${el.dataset.testid}]` : ""}${el.tagName.toLowerCase()}${cls}`;
}

const GROUPS = [
  ".header",
  ".header > *",
  ".search",
  ".toolbar",
  ".tabs",
  ".tab",
  ".tab-label",
  ".row",
  ".subject-line",
  ".select-all-banner",
  ".conv-head",
  ".msg-head",
  ".compose-head",
  ".compose-bottom",
  ".sub-row",
  ".nav-item",
  ".settings-tabs",
];

export function layoutIssues(root: ParentNode = document): string[] {
  const out: string[] = [];
  const W = window.innerWidth;
  if (document.documentElement.scrollWidth > W + 1) {
    // Name what's wider than the window (anything, shown or not, that no ancestor clips).
    const wide = [...document.querySelectorAll("body *")]
      .filter((e) => {
        if (e.getBoundingClientRect().right <= W + 1 || getComputedStyle(e).position === "fixed") return false;
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== "visible" || cs.position === "fixed") return false;
        }
        return true;
      })
      .slice(0, 4)
      .map((e) => `${describe(e)} (right ${Math.round(e.getBoundingClientRect().right)})`);
    out.push(`the page scrolls sideways by ${document.documentElement.scrollWidth - W}px: ${wide.join(", ") || "nothing named"}`);
  }
  for (const sel of GROUPS) {
    for (const p of root.querySelectorAll(sel)) {
      if (!shown(p)) continue;
      const kids = [...p.children].filter((k) => shown(k) && !["absolute", "fixed"].includes(getComputedStyle(k).position));
      // A child spilling out of its box (and over whatever is next to it).
      const box = p.getBoundingClientRect();
      for (const k of kids) {
        const r = visibleRect(k);
        const m = getComputedStyle(k);
        // Negative margins hang a control into the gutter on purpose (the message action buttons).
        const hang = Math.max(0, -parseFloat(m.marginRight) || 0, -parseFloat(m.marginLeft) || 0);
        if (r.right > box.right + 1 + hang || r.left < box.left - 1 - hang)
          out.push(`${describe(k)} spills out of ${describe(p)} by ${Math.round(Math.max(r.right - box.right, box.left - r.left))}px`);
      }
      for (let i = 0; i < kids.length; i++)
        for (let j = i + 1; j < kids.length; j++) {
          const a = visibleRect(kids[i]);
          const b = visibleRect(kids[j]);
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 2 && y > 2) out.push(`${describe(kids[i])} overlaps ${describe(kids[j])} in ${describe(p)} by ${Math.round(x)}×${Math.round(y)}`);
        }
    }
  }
  // Popups must be whole: not cut off by the window or by the scrolling box they sit in.
  for (const e of root.querySelectorAll(".details-pop, .menu, .sender-card, .emoji-pop, .event-card, .compose, .qs, .toast, .advanced, .search-suggest")) {
    if (!shown(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.left < -1 || r.right > W + 1) out.push(`${describe(e)} is cut off by the window (${Math.round(r.left)}–${Math.round(r.right)})`);
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const box = p.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${describe(e)} is cut off by ${describe(p)} on the side`);
      break;
    }
  }
  for (const e of root.querySelectorAll(".app *")) {
    if (!shown(e)) continue;
    if (visibleRect(e).right > W + 1) out.push(`${describe(e)} sticks out past the right edge`);
    if (!e.children.length && (e.textContent ?? "").trim()) {
      const cs = getComputedStyle(e);
      const el = e as HTMLElement;
      if (cs.overflowX === "hidden" && cs.textOverflow !== "ellipsis" && cs.whiteSpace === "nowrap" && el.scrollWidth > el.clientWidth + 1)
        out.push(`${describe(e)} is cut off without an ellipsis ("${(e.textContent ?? "").trim().slice(0, 24)}")`);
    }
  }
  return [...new Set(out)];
}

if (typeof window !== "undefined") (window as unknown as { __layoutIssues: typeof layoutIssues }).__layoutIssues = layoutIssues;
