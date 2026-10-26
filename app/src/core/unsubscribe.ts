// List-Unsubscribe (RFC 2369) and one-click List-Unsubscribe-Post (RFC 8058), taken in the web client's order,
// and the Unsubscribe dialog in its words.
import { decodeWords } from "./mime/headers";

export type UnsubscribeMethod =
  | { kind: "one-click"; url: string } // POST "List-Unsubscribe=One-Click" to url, in the background
  | { kind: "mailto"; to: string; subject: string; body: string } // an unsubscribe email from the account
  | { kind: "website"; url: string }; // the sender's page, in the browser

/**
 * One-click when the sender offers it over https, else an email to the listed address, else the sender's page.
 * `localOk` lets the end-to-end run's fake sender (http on 127.0.0.1) stand in for an https one.
 */
export function parseListUnsubscribe(header: string | null, post: string | null, opts: { localOk?: boolean } = {}): UnsubscribeMethod | null {
  if (!header) return null;
  const urls = [...decodeWords(header).matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const https = urls.find((u) => /^https:\/\//i.test(u) || (opts.localOk && /^http:\/\/127\.0\.0\.1[:/]/i.test(u)));
  const http = urls.find((u) => /^http:\/\//i.test(u));
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  if (https && post && /List-Unsubscribe\s*=\s*One-Click/i.test(post)) return { kind: "one-click", url: https };
  // Only one plain address, and a subject on one line: the header comes from the sender, and a line break or a
  // second address would add recipients or headers to the email sent from the account.
  const plain = (to: string) => /^[^\s,;<>"\x00-\x1f\x7f]+@[^\s,;<>"\x00-\x1f\x7f]+$/.test(to);
  const to = mailto ? safeDecode(mailto.slice(7).split("?")[0]) : null;
  if (mailto && to && plain(to)) {
    const params = new URLSearchParams(mailto.slice(7).split("?")[1] ?? "");
    const subject = (params.get("subject") ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    return { kind: "mailto", to, subject, body: params.get("body") ?? "" };
  }
  const page = https ?? http;
  return page ? { kind: "website", url: page } : null;
}

export interface UnsubscribeDialog {
  title: string;
  body: string;
  /** From a message: where the sender's other lists are handled. */
  note?: string;
  ok: "Unsubscribe" | "Go to website";
}

/**
 * The confirmation, as the web client asks it. From a message ("list") it's about that mailing list; from
 * Manage subscriptions ("sender") it's about every list from the sender. An email says from which account it
 * goes and to whom; a website-only list sends you to the website.
 */
export function unsubscribeDialog(
  m: UnsubscribeMethod,
  o: { scope: "list" | "sender"; sender: { name: string; email: string }; account: string; mailTo?: string[] },
): UnsubscribeDialog {
  const name = o.sender.name || o.sender.email;
  const which = o.scope === "list" ? `this mailing list (${name})` : `all mailing lists from ${name} (${o.sender.email})`;
  const note = o.scope === "list" ? "To unsubscribe from this sender's other mailing lists, go to Manage subscriptions." : undefined;
  if (m.kind === "website")
    return { title: "Unsubscribe", body: `To stop getting messages from ${which}, go to their website to unsubscribe.`, note, ok: "Go to website" };
  const to = o.mailTo ?? (m.kind === "mailto" ? [m.to] : []);
  const mail = to.length ? ` Courier will unsubscribe for you by sending an email from ${o.account} to ${to.join(" and ")}.` : "";
  return { title: "Unsubscribe", body: `Do you want to stop getting messages from ${which}?${mail}`, note, ok: "Unsubscribe" };
}

/** Parse a mailto: URL (for the mailto handler and the "unsubscribe by email" path). */
export function parseMailto(url: string): { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } {
  const rest = url.replace(/^mailto:/i, "");
  const q = rest.indexOf("?");
  const addr = q >= 0 ? rest.slice(0, q) : rest;
  const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
  const list = (s: string | null) =>
    (s ?? "")
      .split(",")
      .map((x) => decodeURIComponent(x).trim())
      .filter(Boolean);
  const get = (k: string) => {
    for (const [key, v] of params) if (key.toLowerCase() === k) return v;
    return null;
  };
  return { to: list(addr).concat(list(get("to"))), cc: list(get("cc")), bcc: list(get("bcc")), subject: get("subject") ?? "", body: get("body") ?? "" };
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
