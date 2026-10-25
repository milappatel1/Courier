// The web client's side of the differential runner (see steps.mjs): one `env` over a CDP session of the recon tab.
// Real input events (mouse, keys) do the clicking; the page is only read with small functions installed as window.__d.
// Only research/tools/cdp-do.mjs imports this (the recon tab may only be touched by that script).
//
// Nothing here sends mail, changes a setting or deletes for good; scripts act on seeded test mail and put it back.

/** Page-side helpers, installed once per run. Everything that reads the Gmail page lives here. */
const PAGE = String.raw`(() => {
  const D = (window.__d = { known: [] });
  const vis = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== "hidden";
  const txt = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  D.vis = vis;
  D.rows = () => [...document.querySelectorAll("tr.zA")].filter(vis);
  D.subject = (tr) => txt(tr.querySelector(".bog"));
  D.row = (s) => D.rows().find((r) => D.subject(r) === s);
  D.mask = (s) => (D.known.includes(s) ? s : "(other)");
  D.checked = (tr) => tr.querySelector("[role=checkbox]")?.getAttribute("aria-checked") === "true";
  D.starred = (tr) => /^Starred/.test(tr.querySelector(".T-KT")?.getAttribute("aria-label") ?? "");
  D.chips = (tr) => [...tr.querySelectorAll(".ar .at, .ar .av")].filter((e) => e.classList.contains("at")).map((e) => e.getAttribute("title") || txt(e)).filter(Boolean).sort();
  D.toolbar = () => document.querySelector("[gh=tm]");
  const bars = () => [...document.querySelectorAll("[gh=tm], [gh=mtb]")];
  const labelOf = (e) => e.getAttribute("aria-label") || e.getAttribute("data-tooltip") || "";
  D.toolbarRaw = () => [...new Set(bars().flatMap((b) => [...b.querySelectorAll("[role=button], [role=checkbox]")]))].filter(vis).sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
  // Gmail puts a button's label on it only once the mouse has been over it (the conversation's toolbar starts unlabelled).
  D.unlabelled = () => D.toolbarRaw().filter((e) => !labelOf(e)).map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  D.toolbarButtons = () => D.toolbarRaw().filter((e) => labelOf(e)).map((e) => ({ el: e, label: labelOf(e), disabled: e.getAttribute("aria-disabled") === "true" }));
  D.button = (label) => D.toolbarButtons().find((b) => b.label === label)?.el;
  D.toast = () => {
    const t = [...document.querySelectorAll("div.b8.UC, [role=alert]")].filter(vis).find((e) => txt(e));
    if (!t) return null;
    const undo = [...t.querySelectorAll("span,a,div")].find((e) => vis(e) && e.children.length === 0 && /^Undo$/.test(txt(e)));
    const text = txt(t).replace(/\s*(Undo|View message|Learn more|Dismiss)\b.*$/, "").trim();
    return { text, hasUndo: !!undo, undo };
  };
  D.nav = () => {
    const out = {};
    for (const a of document.querySelectorAll(".aim a[aria-label], .TK a[aria-label]")) {
      if (a.getClientRects().length === 0) continue;
      const m = a.getAttribute("aria-label").replace(/ (has menu|expanded|collapsed)/g, "").match(/^(.*?)(?: (\d[\d,]*) unread)?$/);
      if (m && m[2]) out[m[1].trim()] = Number(m[2].replace(/,/g, ""));
    }
    return out;
  };
  D.tabs = () => {
    const out = {};
    for (const t of document.querySelectorAll("[role=tab]")) {
      const name = t.getAttribute("aria-label");
      if (!vis(t) || !["Primary", "Promotions", "Social", "Updates", "Forums"].includes(name)) continue;
      const m = txt(t).match(/(\d[\d,]*) new/);
      out[name.toLowerCase()] = m ? Number(m[1].replace(/,/g, "")) : 0;
    }
    return out;
  };
  D.banner = () => {
    const el = [...document.querySelectorAll("td, div, span")].filter(vis).find((e) => e.children.length < 4 && /conversations? (on this page )?(in .*)?are selected/i.test(txt(e)) && txt(e).length < 200);
    if (!el) return null;
    const t = txt(el);
    const n = t.match(/All ([\d,]+) conversations/);
    const offer = t.match(/Select all ([\d,]+) conversations/);
    return { kind: /on this page/.test(t) ? "page" : "all", n: n ? Number(n[1].replace(/,/g, "")) : null, offer: offer ? Number(offer[1].replace(/,/g, "")) : null };
  };
  D.describeActive = () => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    return [a.tagName.toLowerCase(), a.getAttribute("role"), a.getAttribute("aria-label") || a.getAttribute("name") || ""].filter(Boolean).join(" ");
  };
  D.observe = (o) => {
    const rows = D.rows();
    const sub = rows.map((r) => D.mask(D.subject(r)));
    const state = {};
    rows.forEach((r, i) => {
      if (sub[i] === "(other)") return;
      state[sub[i]] = { unread: r.classList.contains("zE"), starred: D.starred(r), selected: D.checked(r), chips: D.chips(r) };
    });
    const t = D.toast();
    return {
      rows: sub.slice(0, 50),
      rowState: state,
      counts: { nav: D.nav(), tabs: D.tabs() },
      selection: rows.filter(D.checked).length,
      banner: D.banner(),
      toolbar: D.toolbarButtons().map((b) => b.label + (b.disabled ? " (disabled)" : "")),
      toast: t ? { text: t.text, hasUndo: t.hasUndo } : null,
      focus: { ...(o.cursor ? { cursor: null } : {}), active: D.describeActive() },
    };
  };
  return true;
})()`;

const KEYCODES = { Tab: 9, Enter: 13, Escape: 27, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32 };

export async function createWebEnv({ s, known, mailbox }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = async (expression) => {
    const { result, exceptionDetails } = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (what, expr, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(expr);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  await ev(PAGE);
  await ev(`window.__d.known = ${JSON.stringify(known)}`);

  /** Centre of the element an expression returns, scrolled into view; [x, y] or null. */
  const where = (elExpr) =>
    `(() => { const e = ${elExpr}; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`;
  const move = async (x, y) => {
    await s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(80);
  };
  const clickAt = async ([x, y], button = "left") => {
    await move(x, y);
    await s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    await s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
  };
  const click = async (what, elExpr, ms) => clickAt(await until(what, where(elExpr), ms));
  const hoverOver = async (what, elExpr) => {
    const p = await until(what, where(elExpr));
    await move(p[0], p[1]);
    return p;
  };
  const key = async (name, mods = 0) => {
    const printable = name.length === 1;
    const vk = KEYCODES[name] ?? name.toUpperCase().charCodeAt(0);
    const code = KEYCODES[name] ? name : printable && /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : name;
    await s("Input.dispatchKeyEvent", {
      type: printable && !mods ? "keyDown" : "rawKeyDown",
      key: name,
      code,
      windowsVirtualKeyCode: vk,
      modifiers: mods,
      text: printable && !mods ? name : undefined,
    });
    await s("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: vk, modifiers: mods });
  };
  const type = async (text) => {
    for (const ch of text) {
      await key(ch);
      await sleep(15);
    }
  };
  const J = JSON.stringify;
  /** Hovers each unlabelled toolbar button so Gmail names it. */
  const reveal = async () => {
    const spots = await ev("window.__d.unlabelled()");
    for (const [x, y] of spots) await move(x, y);
    return spots.length;
  };

  const env = {
    side: "web",
    keyboard: false,
    sleep,

    async reset() {
      await env.open("INBOX", "primary");
      // Spam, Trash and the rest show their unread counts once More is open, as in Courier's nav.
      const more = await ev(`document.querySelector("[aria-label='More labels']") && window.__d.vis(document.querySelector("[aria-label='More labels']"))`);
      if (more) await click("More labels", `document.querySelector("[aria-label='More labels']")`);
      await env.clearSelection();
    },

    async open(label, tab) {
      const hash =
        { INBOX: "inbox", STARRED: "starred", SNOOZED: "snoozed", SENT: "sent", DRAFT: "drafts", SPAM: "spam", TRASH: "trash", ALL: "all", IMPORTANT: "imp" }[
          label
        ] ?? `label/${encodeURIComponent(label).replace(/%2F/g, "/")}`;
      await ev(`location.hash = ${J(hash)}`);
      await sleep(900);
      if (label === "INBOX" && tab) {
        const name = tab[0].toUpperCase() + tab.slice(1);
        await click(
          `${name} tab`,
          `[...document.querySelectorAll("[role=tab]")].find((t) => window.__d.vis(t) && t.getAttribute("aria-label") === ${J(name)})`,
        );
      }
      await env.settle();
    },

    async search(q) {
      await click("the search box", `[...document.querySelectorAll("input[name=q]")].find(window.__d.vis)`);
      await ev(`(() => { const i = [...document.querySelectorAll("input[name=q]")].find(window.__d.vis); i.select(); return true; })()`);
      await key("Backspace");
      await type(q);
      await key("Enter");
      await sleep(900);
      await env.settle();
    },

    async select(subject) {
      const on = await ev(`window.__d.checked(window.__d.row(${J(subject)}))`);
      if (on) return;
      await click(`checkbox of ${subject}`, `window.__d.row(${J(subject)})?.querySelector("[role=checkbox]")`);
      await sleep(200);
    },

    async selectAll() {
      await click("the select-all box", `window.__d.toolbar()?.querySelector("[role=checkbox]")`);
      await sleep(300);
    },

    async selectAllMatching() {
      const sel = `[...document.querySelectorAll("span, a")].filter(window.__d.vis).find((e) => e.children.length === 0 && /^Select all [\\d,]+ conversations/.test(e.textContent.trim()))`;
      const present = await until("Select all N conversations", sel, 2500).catch(() => null);
      if (!present) return "not offered";
      await click("Select all N conversations", sel);
      await sleep(500);
      return "offered";
    },

    async clearSelection() {
      const had = await ev(`window.__d.rows().some(window.__d.checked)`);
      if (!had) return;
      await click("the select-all box", `window.__d.toolbar()?.querySelector("[role=checkbox]")`);
      const left = await ev(`window.__d.rows().some(window.__d.checked)`);
      if (left) await click("the select-all box", `window.__d.toolbar()?.querySelector("[role=checkbox]")`);
      await sleep(300);
    },

    async openConversation(subject) {
      await click(`row ${subject}`, `window.__d.row(${J(subject)})?.querySelector(".bog")`);
      await until("the conversation", `!window.__d.rows().length`, 6000);
      await sleep(600);
    },

    async back() {
      await click(
        "Back to Inbox",
        `[...document.querySelectorAll("[role=button]")].find((e) => window.__d.vis(e) && /^Back to /.test(e.getAttribute("aria-label") ?? ""))`,
      );
      await sleep(600);
    },

    /** A toolbar button by label; when it isn't there, the More menu's item if `moreItem` names one. Returns how it was done. */
    async toolbar(label, { moreItem } = {}) {
      await reveal();
      const present = await ev(`!!window.__d.button(${J(label)})`);
      if (present) {
        await click(`${label} button`, `window.__d.button(${J(label)})`);
        await sleep(250);
        return "toolbar";
      }
      if (!moreItem) throw new Error(`no ${label} button in the toolbar`);
      await env.more(moreItem);
      return `More > ${moreItem}`;
    },

    async more(item) {
      await reveal();
      await click("More email options", `window.__d.button("More email options")`);
      await sleep(300);
      await env.menuItem(item);
      return `More > ${item}`;
    },

    async menuItem(label) {
      await click(
        `menu item ${label}`,
        `[...document.querySelectorAll("[role=menuitem], [role=menuitemcheckbox], [role=option]")].filter(window.__d.vis).find((e) => e.textContent.replace(/\\s+/g, " ").trim().startsWith(${J(label)}))`,
      );
      await sleep(250);
    },

    async labelChoice(name, on) {
      const state = await ev(
        `(() => { const e = [...document.querySelectorAll("[role=menuitemcheckbox]")].filter(window.__d.vis).find((x) => x.textContent.replace(/\\s+/g, " ").trim() === ${J(name)}); return e ? e.getAttribute("aria-checked") : null; })()`,
      );
      if (state === null) throw new Error(`no label ${name} in the menu`);
      if ((state === "true") !== on) await env.menuItem(name);
      await click(
        "Apply",
        `[...document.querySelectorAll("[role=menuitem], [role=button]")].filter(window.__d.vis).find((e) => e.textContent.trim() === "Apply")`,
      );
      await sleep(300);
    },

    async hover(subject, label) {
      await hoverOver(`row ${subject}`, `window.__d.row(${J(subject)})`);
      await sleep(250);
      await click(
        `${label} on the row`,
        `[...(window.__d.row(${J(subject)})?.querySelectorAll("ul[role=toolbar] li[data-tooltip]") ?? [])].find((e) => e.getAttribute("data-tooltip") === ${J(label)})`,
      );
      await sleep(250);
    },

    async rowStar(subject, on) {
      const now = await ev(`window.__d.starred(window.__d.row(${J(subject)}))`);
      if (now === on) return;
      await click(`star of ${subject}`, `window.__d.row(${J(subject)})?.querySelector(".T-KT")`);
      await sleep(250);
    },

    async cursorTo() {
      throw new Error("keyboard shortcuts are off");
    },
    async keys() {
      throw new Error("keyboard shortcuts are off");
    },

    async undo() {
      await click("the toast's Undo", `window.__d.toast()?.undo`, 3000);
      await sleep(300);
    },

    async toastGone(t0) {
      const end = Date.now() + 30000;
      let seen = false;
      while (Date.now() < end) {
        const t = await ev(`!!window.__d.toast()`);
        if (t) seen = true;
        else if (seen) return Date.now() - t0;
        await sleep(50);
      }
      return null;
    },

    async compose({ to, subject, body }) {
      await click("Compose", `[...document.querySelectorAll("[role=button]")].find((e) => window.__d.vis(e) && e.textContent.trim() === "Compose")`);
      await until("the compose window", `[...document.querySelectorAll("div[role=dialog]")].some(window.__d.vis)`);
      await sleep(500);
      if (to) {
        await click(
          "To",
          `[...document.querySelectorAll("input[aria-label='To recipients'], input[peoplekit-id], textarea[aria-label='To recipients']")].find(window.__d.vis)`,
        );
        await type(to);
        await key("Enter");
      }
      if (subject) {
        await click("Subject", `[...document.querySelectorAll("input[name=subjectbox]")].find(window.__d.vis)`);
        await type(subject);
      }
      if (body) {
        await click("Body", `[...document.querySelectorAll("div[aria-label='Message Body']")].find(window.__d.vis)`);
        await type(body);
      }
      await sleep(2500);
    },

    async discardDraft() {
      await click(
        "Discard draft",
        `[...document.querySelectorAll("[role=button]")].find((e) => window.__d.vis(e) && /^Discard draft/.test(e.getAttribute("aria-label") ?? e.getAttribute("data-tooltip") ?? ""))`,
      );
      await sleep(800);
    },

    /** The chips and flags of one seeded conversation as a search in "Anywhere" lists it; comes back to `from` after. */
    async labelsOf(subject, from) {
      await env.search(`in:anywhere "${subject}"`);
      const r = await ev(
        `(() => { const tr = window.__d.row(${J(subject)}); return tr ? { found: true, unread: tr.classList.contains("zE"), starred: window.__d.starred(tr), chips: window.__d.chips(tr) } : { found: false }; })()`,
      );
      if (from?.q) await env.search(from.q);
      else await env.open(from?.label ?? "INBOX", from?.tab);
      return r;
    },

    async signature() {
      return ev(`JSON.stringify([window.__d.rows().map(window.__d.subject), window.__d.nav(), window.__d.tabs(), !!window.__d.toast()])`);
    },

    /** Waits until the list and the counts have stopped changing. */
    async settle() {
      await sleep(600);
      let last = await env.signature();
      let same = 0;
      for (let i = 0; i < 40 && same < 4; i++) {
        await sleep(150);
        const now = await env.signature();
        same = now === last ? same + 1 : 0;
        last = now;
      }
    },

    async observe(o) {
      await reveal();
      return ev(`window.__d.observe(${J(o)})`);
    },
  };
  void mailbox;
  return env;
}
