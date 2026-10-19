// HTML ⇄ plain text without a DOM (used for text/plain alternatives, plain-text mode, snippets and the index).

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  laquo: "«",
  raquo: "»",
  deg: "°",
  zwnj: "\u200c",
  zwj: "\u200d",
  shy: "\u00ad",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v ?? m;
  });
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BLOCK = /^(p|div|section|article|header|footer|table|tr|h[1-6]|ul|ol|li|blockquote|pre|hr|address|center|dl|dt|dd|form|fieldset|figure|main|nav|aside)$/;

/** HTML → readable plain text: blocks become lines, lists get markers, quotes get "> ", links keep their URL. */
export function htmlToText(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(html|body)\b[^>]*>/gi, "");
  const out: string[] = [];
  let line = "";
  let quoteDepth = 0;
  const lists: { ordered: boolean; n: number }[] = [];
  let pendingHref: string | null = null;
  let linkText = "";
  let inLink = false;
  let pre = 0;
  const prefix = () => "> ".repeat(quoteDepth);
  const flush = (force = false) => {
    const t = pre ? line : line.replace(/[ \t\u00a0]+/g, " ").trim();
    if (t || force) out.push(prefix() + t);
    line = "";
  };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    if (m[4] !== undefined) {
      const text = decodeEntities(pre ? m[4] : m[4].replace(/\s+/g, " "));
      if (inLink) linkText += text;
      if (pre) {
        const parts = text.split("\n");
        line += parts[0];
        for (const p of parts.slice(1)) {
          flush(true);
          line = p;
        }
      } else line += text;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    if (tag === "br") {
      flush(true);
      continue;
    }
    if (tag === "a") {
      if (!closing) {
        const href = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        pendingHref = href ? decodeEntities(href[2] ?? href[3] ?? href[4] ?? "") : null;
        inLink = true;
        linkText = "";
      } else {
        if (pendingHref && /^https?:|^mailto:/i.test(pendingHref)) {
          const shown = linkText.trim();
          const bare = pendingHref.replace(/^mailto:/i, "");
          if (shown && shown !== pendingHref && shown !== bare) line += ` <${pendingHref}>`;
        }
        pendingHref = null;
        inLink = false;
      }
      continue;
    }
    if (tag === "img" && !closing) {
      const alt = attrs.match(/alt\s*=\s*("([^"]*)"|'([^']*)')/i);
      if (alt && (alt[2] ?? alt[3])) line += `[${decodeEntities(alt[2] ?? alt[3] ?? "")}]`;
      continue;
    }
    if (tag === "pre") {
      flush();
      pre += closing ? -1 : 1;
      if (pre < 0) pre = 0;
      continue;
    }
    if (tag === "blockquote") {
      flush();
      quoteDepth += closing ? -1 : 1;
      if (quoteDepth < 0) quoteDepth = 0;
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      if (closing) lists.pop();
      else lists.push({ ordered: tag === "ol", n: 0 });
      continue;
    }
    if (tag === "li" && !closing) {
      flush();
      const l = lists[lists.length - 1];
      const indent = "  ".repeat(Math.max(0, lists.length - 1));
      if (l) line = indent + (l.ordered ? `${++l.n}. ` : "- ");
      else line = "- ";
      continue;
    }
    if (tag === "td" || tag === "th") {
      if (closing) line += " ";
      continue;
    }
    if (tag === "hr") {
      flush();
      out.push(prefix() + "---");
      continue;
    }
    if (BLOCK.test(tag)) flush();
  }
  flush();
  // Collapse runs of blank lines.
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return text.replace(/^\n+|\n+$/g, "");
}

const URL_RE = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|\b([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

/** Plain text → HTML: escapes, keeps line breaks, turns "> " lines into blockquotes and links URLs. */
export function textToHtml(text: string, opts: { linkify?: boolean } = {}): string {
  const linkify = opts.linkify ?? true;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let depth = 0;
  for (const raw of lines) {
    const q = raw.match(/^(>\s?)+/);
    const d = q ? (q[0].match(/>/g) ?? []).length : 0;
    while (depth < d) (html += '<blockquote class="courier_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">'), depth++;
    while (depth > d) (html += "</blockquote>"), depth--;
    let line = escapeHtml(q ? raw.slice(q[0].length) : raw);
    if (linkify)
      line = line.replace(URL_RE, (m, url, email) =>
        url ? `<a href="${url}">${url}</a>` : `<a href="mailto:${email}">${email}</a>`,
      );
    html += `${line || "<br>"}`.replace(/^ /, "&nbsp;").replace(/  /g, " &nbsp;") + (line ? "<br>" : "");
  }
  while (depth-- > 0) html += "</blockquote>";
  return html.replace(/<br>$/, "");
}

/** One-line snippet like the list shows: whitespace collapsed, quoted history dropped, ~200 chars.
 * HTML-derived text joins block lines with no space (as the web client's snippets do); plain text uses a space. */
export function snippetOf(text: string, max = 200, joiner = " "): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const l of lines) {
    if (/^>/.test(l)) continue;
    if (/^On .{6,200} wrote:\s*$/.test(l.trim())) break;
    if (/^-{2,} ?(Original Message|Forwarded message) ?-{2,}/i.test(l.trim())) break;
    kept.push(l.trim());
  }
  const s = kept.filter(Boolean).join(joiner).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}
