// Message HTML sanitiser. Output goes into a sandboxed <iframe srcdoc> (no allow-scripts) with a CSP, so this is
// defence in depth: no scripts or active content, no remote loads until "Display images", tracking pixels
// removed, links forced to open outside, and trailing quoted history wrapped so the UI can fold it ("•••").

export interface SanitizeOptions {
  allowRemote: boolean;
  /** cid → URL (blob:/data:) for inline images that came with the message. */
  cid?: Record<string, string>;
}

export interface SanitizeResult {
  html: string;
  remoteBlocked: number;
  trackersRemoved: number;
  hasRemote: boolean;
  quoted: boolean;
}

type DomParserLike = { parseFromString(s: string, type: "text/html"): Document };

const DROP = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "template",
  "portal",
  "audio",
  "video",
  "source",
  "track",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "dialog",
  "slot",
  "foreignobject",
  "animate",
  "set",
]);
const UNWRAP = new Set(["form", "html", "body", "head"]);
const URL_ATTRS = [
  "href",
  "src",
  "background",
  "action",
  "formaction",
  "poster",
  "cite",
  "xlink:href",
  "srcset",
  "dynsrc",
  "lowsrc",
  "longdesc",
  "usemap",
  "data",
  "codebase",
  "ping",
];

/** Hosts and paths used for open tracking (our own list of well-known patterns). */
const TRACKER_PATTERNS = [
  /\/(open|opened|track|tracking|pixel|beacon|wf\/open|e\/o|o\.gif|t\.gif|blank\.gif|spacer\.gif)(\b|\/|\?|$)/i,
  /mailtrack\.io|mailtrack\.com|mixmax\.com\/api\/track|yesware\.com\/t\/|bananatag|getnotify|streak\.com\/.*track|superhuman\.com\/.*track|mandrillapp\.com\/track|list-manage\.com\/track\/open|sendgrid\.net\/wf\/open|sparkpostmail\.com\/q\/|mailgun\.org\/o\/|hubspot(email)?\.(com|net)\/.*(open|track)|exacttarget\.com\/.*open|mktoresp\.com|cmail\d*\.com\/t\/|createsend\d*\.com\/t\/|emltrk\.com|pixel\.watch|trk\.klaviyomail\.com\/.*open/i,
];

export function isTrackerUrl(url: string): boolean {
  return TRACKER_PATTERNS.some((r) => r.test(url));
}

const isRemote = (u: string) => /^(https?:)?\/\//i.test(u.trim());
const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i;

function cssSanitize(css: string, opts: SanitizeOptions, counters: { blocked: number; remote: boolean }): string {
  let out = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "x(")
    .replace(/behaviou?r\s*:/gi, "x:")
    .replace(/-moz-binding\s*:/gi, "x:")
    .replace(/javascript\s*:/gi, "x:")
    .replace(/position\s*:\s*fixed/gi, "position:static");
  out = out.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, u: string) => {
    const url = u.trim();
    if (/^data:image\//i.test(url)) return m;
    if (/^cid:/i.test(url)) {
      const mapped = opts.cid?.[url.slice(4).replace(/^<|>$/g, "")];
      return mapped ? `url("${mapped}")` : "none";
    }
    if (isRemote(url)) {
      counters.remote = true;
      if (opts.allowRemote && !isTrackerUrl(url)) return m;
      counters.blocked++;
      return "none";
    }
    return "none";
  });
  return out;
}

function pxValue(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)(px)?$/i);
  return m ? parseFloat(m[1]) : null;
}

function styleDim(style: string, prop: "width" | "height"): number | null {
  const m = style.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i"));
  return m ? parseFloat(m[1]) : null;
}

function looksLikePixel(img: Element): boolean {
  const style = img.getAttribute("style") ?? "";
  const w = pxValue(img.getAttribute("width")) ?? styleDim(style, "width");
  const h = pxValue(img.getAttribute("height")) ?? styleDim(style, "height");
  if (w != null && h != null && w <= 2 && h <= 2) return true;
  if ((w != null && w <= 1) || (h != null && h <= 1)) return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?(;|$)/i.test(style)) return true;
  return false;
}

export function sanitizeHtml(html: string, opts: SanitizeOptions, parser: DomParserLike): SanitizeResult {
  const doc = parser.parseFromString(html, "text/html");
  const counters = { blocked: 0, remote: false };
  let trackers = 0;

  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toLowerCase();
      if (DROP.has(tag)) {
        child.remove();
        continue;
      }
      walk(child);
      if (UNWRAP.has(tag) && tag !== "html" && tag !== "body" && tag !== "head") {
        child.replaceWith(...[...child.childNodes]);
        continue;
      }
      cleanAttributes(child);
    }
  };

  const cleanAttributes = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "formaction" ||
        name === "action" ||
        name === "ping" ||
        name === "autofocus" ||
        name === "contenteditable" ||
        name === "http-equiv"
      ) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        el.setAttribute("style", cssSanitize(attr.value, opts, counters));
        continue;
      }
      if (URL_ATTRS.includes(name) && !(tag === "img" && (name === "src" || name === "srcset")) && !(tag === "a" && name === "href")) {
        const v = attr.value.trim();
        if (name === "background" && isRemote(v)) {
          counters.remote = true;
          if (!opts.allowRemote || isTrackerUrl(v)) {
            counters.blocked++;
            el.removeAttribute(attr.name);
          }
          continue;
        }
        if (name !== "cite" || !SAFE_LINK.test(v)) el.removeAttribute(attr.name);
      }
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href != null && !SAFE_LINK.test(href.trim())) el.removeAttribute("href");
      if (el.getAttribute("href") && !el.getAttribute("href")!.startsWith("#")) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (tag === "img") {
      el.removeAttribute("srcset");
      const src = (el.getAttribute("src") ?? "").trim();
      if (/^data:image\//i.test(src)) return;
      if (/^cid:/i.test(src)) {
        const mapped = opts.cid?.[src.slice(4).replace(/^<|>$/g, "")];
        if (mapped) el.setAttribute("src", mapped);
        else el.removeAttribute("src");
        return;
      }
      if (isRemote(src)) {
        counters.remote = true;
        if (isTrackerUrl(src) || looksLikePixel(el)) {
          trackers++;
          el.remove();
          return;
        }
        if (!opts.allowRemote) {
          counters.blocked++;
          el.setAttribute("data-courier-src", src);
          el.removeAttribute("src");
          el.setAttribute("data-courier-blocked", "");
        }
        return;
      }
      if (src) el.removeAttribute("src");
    }
  };

  // <style> blocks: sanitise their text, keep them.
  const styles: string[] = [];
  for (const s of [...doc.querySelectorAll("style")]) {
    styles.push(cssSanitize(s.textContent ?? "", opts, counters));
    s.remove();
  }
  const body = doc.body ?? doc.documentElement;
  walk(body);
  for (const el of [...body.querySelectorAll("*")]) if (el.tagName.toLowerCase() === "form") el.replaceWith(...[...el.childNodes]);

  const quoted = markQuoted(doc, body);

  // Body-level presentation (bgcolor/text/style) moves onto a wrapper so it survives.
  const bodyStyle: string[] = [];
  const bg = body.getAttribute("bgcolor");
  if (bg && /^#?[\w]+$/.test(bg)) bodyStyle.push(`background-color:${bg}`);
  const text = body.getAttribute("text");
  if (text && /^#?[\w]+$/.test(text)) bodyStyle.push(`color:${text}`);
  const bs = body.getAttribute("style");
  if (bs) bodyStyle.push(cssSanitize(bs, opts, counters));
  const inner = body.innerHTML;
  const out =
    (styles.length ? `<style>${styles.join("\n")}</style>` : "") +
    (bodyStyle.length ? `<div class="courier-body" style="${bodyStyle.join(";").replace(/"/g, "'")}">${inner}</div>` : inner);
  return { html: out, remoteBlocked: counters.blocked, trackersRemoved: trackers, hasRemote: counters.remote, quoted };
}

const QUOTE_SELECTORS = [
  ".gmail_quote",
  "blockquote[type='cite']",
  ".moz-cite-prefix",
  "#divRplyFwdMsg",
  "#appendonsend",
  ".yahoo_quoted",
  "#reply-intro",
  ".courier_quote",
  "blockquote.courier_quote",
];

/** Wrap trailing quoted history in <div class="courier-quoted"> (hidden until "•••" is clicked). */
export function markQuoted(doc: Document, body: Element): boolean {
  let start: Element | null = null;
  for (const sel of QUOTE_SELECTORS) {
    const found = body.querySelector(sel);
    if (found && (!start || start.compareDocumentPosition(found) & 2) /* PRECEDING */) start = found;
  }
  // "On <date>, <name> wrote:" line directly before a blockquote.
  if (!start) {
    for (const bq of [...body.querySelectorAll("blockquote")]) {
      const prev = bq.previousElementSibling;
      const prevText = (prev?.textContent ?? "").trim();
      if (/^On .{4,200} wrote:$/.test(prevText) || /wrote:$/.test(prevText)) {
        start = prev;
        break;
      }
    }
  }
  if (!start) {
    // Outlook-style "-----Original Message-----" separator.
    const walker = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
    while (walker.nextNode()) {
      const t = walker.currentNode.nodeValue ?? "";
      if (/^-{3,}\s*(Original Message|Forwarded message)\s*-{3,}/i.test(t.trim())) {
        start = walker.currentNode.parentElement;
        break;
      }
    }
  }
  if (!start || start === body) return false;
  // Climb to a direct child of body so everything after it is folded as one block.
  let top: Element = start;
  while (top.parentElement && top.parentElement !== body) top = top.parentElement;
  // Only fold if the quote is trailing (no substantial content after it).
  let after = top.nextSibling;
  let trailing = true;
  while (after) {
    if (after.nodeType === 1 && (after as Element).matches?.(QUOTE_SELECTORS.join(","))) {
      after = after.nextSibling;
      continue;
    }
    if ((after.textContent ?? "").trim()) {
      trailing = false;
      break;
    }
    after = after.nextSibling;
  }
  if (!trailing) return false;
  const wrap = doc.createElement("div");
  wrap.className = "courier-quoted";
  top.before(wrap);
  let n: ChildNode | null = top;
  while (n) {
    const next: ChildNode | null = n.nextSibling;
    wrap.appendChild(n);
    n = next;
  }
  return true;
}

/** The document that goes into the iframe: CSP first, our base styles, then the sanitised message. */
export function frameDocument(body: string, opts: { allowRemote: boolean; dark?: boolean; plain?: boolean }): string {
  const img = opts.allowRemote ? "data: blob: https: http:" : "data: blob:";
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline' ${opts.allowRemote ? "https:" : ""}; font-src data: ${opts.allowRemote ? "https:" : ""}; media-src 'none'; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
html,body{margin:0;padding:0;background:transparent}
body{font:13px/1.5 Arial,Helvetica,sans-serif;color:#222;word-wrap:break-word;overflow-wrap:anywhere;overflow:hidden}
${opts.plain ? "body{white-space:normal}" : ""}
img{max-width:100%;height:auto}
img[data-courier-blocked]{display:inline-block;min-width:16px;min-height:16px;background:#f1f3f4}
.courier-quoted{display:none}
body.courier-show-quoted .courier-quoted{display:block}
a{color:#1a0dab}
blockquote.courier_quote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex}
pre{white-space:pre-wrap}
table{max-width:100%}
</style></head><body>${body}</body></html>`;
}
