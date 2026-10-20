// One message body in a sandboxed iframe: sanitised HTML, remote images off until allowed, trailing quotes
// folded, links opened outside (mailto: opens a compose window).
import { useEffect, useMemo, useRef, useState } from "react";
import { frameDocument, sanitizeHtml } from "../core/sanitize";
import { textToHtml } from "../core/text";
import type { ParsedMessage } from "../core/mime/parse";
import { api } from "../ipc/api";
import { openMailto } from "../state/compose";

export interface FrameState {
  hasRemote: boolean;
  blocked: number;
  quoted: boolean;
}

export function useCidMap(parsed: ParsedMessage | null) {
  return useMemo(() => {
    const map: Record<string, string> = {};
    if (!parsed) return map;
    for (const a of parsed.attachments) if (a.contentId) map[a.contentId] = URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.mimeType }));
    return map;
  }, [parsed]);
}

export function MessageFrame({
  parsed,
  allowRemote,
  showQuoted,
  onState,
  testId,
}: {
  parsed: ParsedMessage;
  allowRemote: boolean;
  showQuoted: boolean;
  onState?: (s: FrameState) => void;
  testId?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(40);
  const cid = useCidMap(parsed);
  const result = useMemo(() => {
    const plain = parsed.html == null;
    const html = plain ? `<div style="white-space:normal">${textToHtml(parsed.text ?? "")}</div>` : parsed.html!;
    return { ...sanitizeHtml(html, { allowRemote, cid }, new DOMParser()), plain };
  }, [parsed, allowRemote, cid]);
  useEffect(() => {
    onState?.({ hasRemote: result.hasRemote, blocked: result.remoteBlocked, quoted: result.quoted });
  }, [result.hasRemote, result.remoteBlocked, result.quoted]);
  const doc = useMemo(() => frameDocument(result.html, { allowRemote, plain: result.plain }), [result, allowRemote]);
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    let ro: ResizeObserver | null = null;
    const setup = () => {
      const d = f.contentDocument;
      if (!d?.body) return;
      d.body.classList.toggle("courier-show-quoted", showQuoted);
      // Exact content height (plus a horizontal scrollbar when the email is wider than the pane). If it keeps
      // growing on its own, something in the email is sizing itself to the frame: stop following it.
      let grows = 0;
      let last = 0;
      let since = Date.now();
      const measure = () => {
        const b = d.body;
        const bar = Math.max(0, b.offsetHeight - b.clientHeight);
        const h = Math.max(20, Math.ceil(Math.max(b.scrollHeight, b.getBoundingClientRect().bottom)) + bar);
        if (h > last) {
          if (Date.now() - since > 3000) {
            since = Date.now();
            grows = 0;
          }
          if (++grows > 60) {
            ro?.disconnect();
            return;
          }
        }
        last = h;
        setHeight(h);
      };
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      ro.observe(d.body);
      for (const img of Array.from(d.images)) img.addEventListener("load", measure);
      // One listener per document (setup can run twice for the same one). WebKit doesn't call it in a
      // script-free frame; the app's new-window and navigation handlers take those clicks instead.
      const marked = d as Document & { __courierLinks?: boolean };
      if (marked.__courierLinks) return;
      marked.__courierLinks = true;
      d.addEventListener("click", (e) => {
        const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (href.startsWith("#")) {
          d.getElementById(href.slice(1))?.scrollIntoView();
          return;
        }
        if (/^mailto:/i.test(href)) void openMailto(href);
        else if (/^(https?|tel):/i.test(href)) void api.openExternal(href);
      });
    };
    f.addEventListener("load", setup);
    if (f.contentDocument?.readyState === "complete") setup();
    return () => {
      f.removeEventListener("load", setup);
      ro?.disconnect();
    };
  }, [doc, showQuoted]);
  return (
    <iframe
      ref={ref}
      className="msg-frame"
      title="Message"
      // No scripts, ever. Popups are allowed so a link click reaches the app, which sends it to the default browser
      // (WebKit doesn't run the app's click listener inside a script-free frame).
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      style={{ height }}
      data-testid={testId ?? "message-frame"}
    />
  );
}
