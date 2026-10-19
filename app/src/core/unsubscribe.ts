// List-Unsubscribe (RFC 2369) and one-click List-Unsubscribe-Post (RFC 8058).

export type UnsubscribeMethod =
  | { kind: "one-click"; url: string } // POST "List-Unsubscribe=One-Click" to url
  | { kind: "mailto"; to: string; subject: string; body: string }
  | { kind: "link"; url: string } // open in the browser
  | null;

export function parseListUnsubscribe(header: string | null, post: string | null): UnsubscribeMethod {
  if (!header) return null;
  const urls = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const https = urls.find((u) => /^https:\/\//i.test(u));
  const http = urls.find((u) => /^http:\/\//i.test(u));
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  if (https && post && /List-Unsubscribe\s*=\s*One-Click/i.test(post)) return { kind: "one-click", url: https };
  if (mailto) {
    const [addr, query = ""] = mailto.slice(7).split("?");
    const params = new URLSearchParams(query);
    return { kind: "mailto", to: decodeURIComponent(addr), subject: params.get("subject") ?? "unsubscribe", body: params.get("body") ?? "" };
  }
  if (https ?? http) return { kind: "link", url: (https ?? http)! };
  return null;
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
