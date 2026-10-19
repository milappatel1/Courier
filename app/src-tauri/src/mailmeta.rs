//! Raw RFC 822 → cache row: headers, addresses, attachments, snippet and indexable text (mail-parser).
//! Display parsing happens in the webview (app/src/core/mime/parse.ts); this is for the index and lists.

use crate::db::{Addr, AttachmentMeta, MessageRow};
use mail_parser::{HeaderValue, MessageParser, MimeHeaders};

fn addrs(a: Option<&mail_parser::Address>) -> Vec<Addr> {
    let Some(a) = a else { return vec![] };
    a.iter()
        .filter_map(|x| {
            let email = x.address()?.trim().to_string();
            if email.is_empty() {
                return None;
            }
            Some(Addr { name: x.name().unwrap_or("").trim().to_string(), email })
        })
        .collect()
}

fn text_list(v: &HeaderValue) -> Vec<String> {
    match v {
        HeaderValue::Text(t) => vec![t.to_string()],
        HeaderValue::TextList(l) => l.iter().map(|s| s.to_string()).collect(),
        _ => vec![],
    }
}

fn angle(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.starts_with('<') { t.to_string() } else { format!("<{t}>") }
}

/// "Re: [list] Fwd: Lunch" → "lunch"
pub fn normalize_subject(s: &str) -> String {
    let mut cur = s.trim().to_string();
    loop {
        let lower = cur.to_lowercase();
        let mut stripped = None;
        for p in ["re:", "fw:", "fwd:", "aw:", "wg:", "sv:", "vs:", "antw:", "tr:", "rif:", "r:", "res:", "enc:", "odp:", "ynt:"] {
            if lower.starts_with(p) {
                stripped = Some(cur[p.len()..].trim().to_string());
                break;
            }
        }
        if stripped.is_none() && cur.starts_with('[') {
            if let Some(end) = cur.find(']') {
                if end <= 41 {
                    stripped = Some(cur[end + 1..].trim().to_string());
                }
            }
        }
        if stripped.is_none() {
            // "Re[2]:"
            if lower.starts_with("re[") {
                if let Some(i) = cur.find("]:") {
                    stripped = Some(cur[i + 2..].trim().to_string());
                }
            }
        }
        match stripped {
            Some(n) if n != cur => cur = n,
            _ => break,
        }
    }
    cur.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

pub fn is_reply_subject(s: &str) -> bool {
    let l = s.trim().to_lowercase();
    ["re:", "fw:", "fwd:", "aw:", "wg:", "sv:", "antw:", "re["].iter().any(|p| l.starts_with(p))
}

/// Strip tags/entities for indexing and snippets (block boundaries vanish, like the list's snippets).
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip <style>/<script>/<head> bodies entirely.
            for tag in ["style", "script", "head", "title"] {
                if lower[i..].starts_with(&format!("<{tag}")) {
                    if let Some(end) = lower[i..].find(&format!("</{tag}")) {
                        i += end;
                    }
                }
            }
            let is_br = lower[i..].starts_with("<br");
            match html[i..].find('>') {
                Some(e) => i += e + 1,
                None => break,
            }
            if is_br {
                out.push(' ');
            }
            continue;
        }
        let next = html[i..].find('<').map(|n| i + n).unwrap_or(bytes.len());
        out.push_str(&decode_entities(&html[i..next]));
        i = next;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        let tail = &rest[p..];
        let end = tail.find(';').filter(|&e| e <= 10);
        match end {
            Some(e) => {
                let ent = &tail[1..e];
                let rep = match ent {
                    "amp" => Some("&".to_string()),
                    "lt" => Some("<".to_string()),
                    "gt" => Some(">".to_string()),
                    "quot" => Some("\"".to_string()),
                    "apos" | "#39" => Some("'".to_string()),
                    "nbsp" => Some(" ".to_string()),
                    _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32).map(|c| c.to_string()),
                    _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string()),
                    _ => None,
                };
                match rep {
                    Some(r) => {
                        out.push_str(&r);
                        rest = &tail[e + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &tail[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// One-line snippet: quoted history dropped, ~200 chars.
pub fn snippet_of(text: &str) -> String {
    let mut kept = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('>') {
            continue;
        }
        if t.starts_with("On ") && t.ends_with("wrote:") {
            break;
        }
        if t.contains("Forwarded message") && t.starts_with("--") {
            break;
        }
        if !t.is_empty() {
            kept.push(t.to_string());
        }
    }
    let s = kept.join(" ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 200 { s.chars().take(200).collect::<String>() + "…" } else { s }
}

pub struct ParsedMeta {
    pub row: MessageRow,
    pub is_reply: bool,
}

/// Parse a raw message into a row (account/id/thread/labels/date are filled in by the caller).
pub fn parse_raw(raw: &[u8]) -> ParsedMeta {
    let mut row = MessageRow { size: raw.len() as i64, ..Default::default() };
    let Some(m) = MessageParser::default().parse(raw) else {
        row.subject = "(unreadable message)".into();
        return ParsedMeta { row, is_reply: false };
    };
    let from = addrs(m.from());
    if let Some(f) = from.first() {
        row.from_name = f.name.clone();
        row.from_email = f.email.clone();
    }
    row.to = addrs(m.to());
    row.cc = addrs(m.cc());
    row.bcc = addrs(m.bcc());
    row.reply_to = addrs(m.reply_to());
    row.delivered_to = m.header_raw("Delivered-To").map(|s| s.trim().to_string()).unwrap_or_default();
    row.subject = m.subject().unwrap_or("").trim().to_string();
    row.norm_subject = normalize_subject(&row.subject);
    row.message_id = m.message_id().map(angle).unwrap_or_default();
    row.in_reply_to = text_list(m.in_reply_to()).first().map(|s| angle(s)).unwrap_or_default();
    row.references = text_list(m.references()).iter().map(|s| angle(s)).collect();
    row.list_unsubscribe = m.header_raw("List-Unsubscribe").map(|s| s.trim().to_string()).unwrap_or_default();
    row.list_unsubscribe_post = m.header_raw("List-Unsubscribe-Post").map(|s| s.trim().to_string()).unwrap_or_default();
    row.list_id = m.header_raw("List-Id").map(|s| s.trim().to_string()).unwrap_or_default();
    if let Some(d) = m.date() {
        row.internal_date = d.to_timestamp() * 1000;
    }
    for a in m.attachments() {
        let name = a.attachment_name().map(str::to_string).unwrap_or_else(|| if a.is_message() { "message.eml".into() } else { "attachment".into() });
        let mime = a.content_type().map(|ct| format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("octet-stream"))).unwrap_or_else(|| "application/octet-stream".into());
        // Inline images referenced by cid aren't shown as attachments in lists.
        let inline = a.content_disposition().map(|d| d.ctype().eq_ignore_ascii_case("inline")).unwrap_or(false) && a.content_id().is_some() && mime.starts_with("image/");
        if inline {
            continue;
        }
        row.attachments.push(AttachmentMeta { name, mime: mime.to_lowercase(), size: a.len() as i64 });
    }
    let text = m.body_text(0).map(|t| t.to_string());
    let html_text = m.body_html(0).map(|h| html_to_text(&h));
    let body = match (&text, &html_text) {
        (Some(t), _) if !t.trim().is_empty() => t.clone(),
        (_, Some(h)) => h.clone(),
        _ => String::new(),
    };
    row.snippet = snippet_of(&body);
    row.body_text = body;
    let is_reply = !row.in_reply_to.is_empty() || !row.references.is_empty() || is_reply_subject(&row.subject);
    ParsedMeta { row, is_reply }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_metadata_and_text() {
        let raw = b"From: \"Ana Lima\" <ana@x.io>\r\nTo: Pat <pat@x.io>, bo@x.io\r\nSubject: =?UTF-8?B?UmU6IEx1bmNo?=\r\nDate: Sun, 18 Oct 2026 20:06:00 -0400\r\nMessage-ID: <b@x.io>\r\nIn-Reply-To: <a@x.io>\r\nReferences: <root@x.io> <a@x.io>\r\nList-Unsubscribe: <https://x.io/u>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<div>Sounds <b>good</b>.</div><div>See you</div><style>p{}</style>\r\n--b\r\nContent-Type: application/pdf; name=plan.pdf\r\nContent-Disposition: attachment; filename=plan.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--\r\n";
        let p = parse_raw(raw);
        let r = p.row;
        assert_eq!(r.from_name, "Ana Lima");
        assert_eq!(r.to.len(), 2);
        assert_eq!(r.subject, "Re: Lunch");
        assert_eq!(r.norm_subject, "lunch");
        assert_eq!(r.message_id, "<b@x.io>");
        assert_eq!(r.in_reply_to, "<a@x.io>");
        assert_eq!(r.references, vec!["<root@x.io>", "<a@x.io>"]);
        assert_eq!(r.internal_date, 1792368360000);
        assert_eq!(r.attachments, vec![AttachmentMeta { name: "plan.pdf".into(), mime: "application/pdf".into(), size: 5 }]);
        assert!(r.snippet.starts_with("Sounds good."), "{}", r.snippet);
        assert!(p.is_reply);
        assert_eq!(normalize_subject("Re: [team] FWD: Lunch  on Friday"), "lunch on friday");
        assert_eq!(html_to_text("<p>a&amp;b</p><br>c&#x41;"), "a&b cA");
    }
}
