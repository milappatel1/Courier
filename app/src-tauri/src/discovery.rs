//! Find IMAP/SMTP settings for an address: built-in table for big providers, then the domain's autoconfig,
//! the public ISP database, the MX host's provider, DNS SRV records, and finally common host names.
//! Only the domain is looked up; nothing about the mailbox leaves the machine.

use crate::imap::{ImapAccountConfig, Security, ServerConfig};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    /// "gmail" when the address should sign in with the mail API instead of IMAP.
    pub kind: String,
    pub provider: String,
    pub config: Option<ImapAccountConfig>,
    pub source: String,
    /// Shown next to the password field (where to make an app password).
    pub help: Option<String>,
}

fn cfg(imap: (&str, u16, Security), smtp: (&str, u16, Security), user: &str, save_sent: bool) -> ImapAccountConfig {
    ImapAccountConfig {
        imap: ServerConfig { host: imap.0.into(), port: imap.1, security: imap.2, username: user.into() },
        smtp: ServerConfig { host: smtp.0.into(), port: smtp.1, security: smtp.2, username: user.into() },
        save_sent,
        initial_window: 500,
    }
}

/// Built-in settings for the providers people use most.
pub fn builtin(email: &str) -> Option<Discovered> {
    let domain = email.rsplit('@').next()?.to_lowercase();
    let d = |provider: &str, c: ImapAccountConfig, help: &str| Some(Discovered { kind: "imap".into(), provider: provider.into(), config: Some(c), source: "built-in".into(), help: Some(help.into()) });
    use Security::*;
    match domain.as_str() {
        "gmail.com" | "googlemail.com" => Some(Discovered { kind: "gmail".into(), provider: "Gmail".into(), config: None, source: "built-in".into(), help: None }),
        "icloud.com" | "me.com" | "mac.com" => d("iCloud Mail", cfg(("imap.mail.me.com", 993, Tls), ("smtp.mail.me.com", 587, Starttls), email, true), "Use an app-specific password from account.apple.com ▸ Sign-In and Security."),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.co.uk" | "hotmail.co.uk" => d(
            "Outlook.com",
            cfg(("outlook.office365.com", 993, Tls), ("smtp-mail.outlook.com", 587, Starttls), email, false),
            "Microsoft has moved most Outlook.com mailboxes to its own sign-in for mail apps, which Courier doesn't support yet. An app password (account.microsoft.com ▸ Security) only works on accounts that still allow one.",
        ),
        "yahoo.com" | "ymail.com" | "rocketmail.com" | "yahoo.co.uk" | "yahoo.fr" | "yahoo.de" => d("Yahoo Mail", cfg(("imap.mail.yahoo.com", 993, Tls), ("smtp.mail.yahoo.com", 465, Tls), email, true), "Generate an app password in Yahoo Account Security."),
        "aol.com" => d("AOL Mail", cfg(("imap.aol.com", 993, Tls), ("smtp.aol.com", 465, Tls), email, true), "Generate an app password in AOL Account Security."),
        "fastmail.com" | "fastmail.fm" | "messagingengine.com" => d("Fastmail", cfg(("imap.fastmail.com", 993, Tls), ("smtp.fastmail.com", 465, Tls), email, true), "Create an app password in Fastmail ▸ Settings ▸ Privacy & Security."),
        "zoho.com" | "zohomail.com" => d("Zoho Mail", cfg(("imap.zoho.com", 993, Tls), ("smtp.zoho.com", 465, Tls), email, true), "Create an application-specific password in Zoho Accounts."),
        "gmx.com" | "gmx.net" | "gmx.de" => d("GMX", cfg(("imap.gmx.com", 993, Tls), ("mail.gmx.com", 587, Starttls), email, true), "Enable IMAP access in GMX settings first."),
        "yandex.com" | "yandex.ru" => d("Yandex Mail", cfg(("imap.yandex.com", 993, Tls), ("smtp.yandex.com", 465, Tls), email, true), "Create an app password in Yandex ID ▸ Security."),
        "proton.me" | "protonmail.com" | "pm.me" => d("Proton Mail (Bridge)", cfg(("127.0.0.1", 1143, Starttls), ("127.0.0.1", 1025, Starttls), email, true), "Proton needs the Bridge app running; use the password Bridge shows."),
        _ => None,
    }
}

fn parse_autoconfig(xml: &str, email: &str) -> Option<ImapAccountConfig> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let local = email.split('@').next().unwrap_or("");
    let domain = email.rsplit('@').next().unwrap_or("");
    let fill = |s: &str| s.replace("%EMAILADDRESS%", email).replace("%EMAILLOCALPART%", local).replace("%EMAILDOMAIN%", domain);
    let server = |kind: &str, tag: &str| -> Option<ServerConfig> {
        let node = doc.descendants().find(|n| n.has_tag_name(tag) && n.attribute("type") == Some(kind))?;
        let text = |name: &str| node.children().find(|c| c.has_tag_name(name)).and_then(|c| c.text()).map(|t| t.trim().to_string());
        let sec = match text("socketType").as_deref() {
            Some("SSL") => Security::Tls,
            Some("STARTTLS") => Security::Starttls,
            _ => Security::Plain,
        };
        Some(ServerConfig { host: fill(&text("hostname")?), port: text("port")?.parse().ok()?, security: sec, username: fill(&text("username").unwrap_or_else(|| "%EMAILADDRESS%".into())) })
    };
    let imap = server("imap", "incomingServer")?;
    let smtp = server("smtp", "outgoingServer")?;
    Some(ImapAccountConfig { imap, smtp, save_sent: true, initial_window: 500 })
}

async fn fetch(http: &reqwest::Client, url: &str) -> Option<String> {
    let r = http.get(url).timeout(Duration::from_secs(6)).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.text().await.ok()
}

async fn mx_host(domain: &str) -> Option<String> {
    use hickory_resolver::proto::rr::RecordType;
    let resolver = hickory_resolver::TokioResolver::builder_tokio().ok()?.build().ok()?;
    let lookup = tokio::time::timeout(Duration::from_secs(5), resolver.lookup(domain, RecordType::MX)).await.ok()?.ok()?;
    let mut best: Option<(u16, String)> = None;
    for rec in lookup.answers() {
        if let hickory_resolver::proto::rr::RData::MX(mx) = &rec.data {
            let host = mx.exchange.to_utf8().trim_end_matches('.').to_lowercase();
            if best.as_ref().map(|(p, _)| mx.preference < *p).unwrap_or(true) {
                best = Some((mx.preference, host));
            }
        }
    }
    best.map(|(_, h)| h)
}

async fn srv(name: &str) -> Option<(String, u16)> {
    use hickory_resolver::proto::rr::RecordType;
    let resolver = hickory_resolver::TokioResolver::builder_tokio().ok()?.build().ok()?;
    let lookup = tokio::time::timeout(Duration::from_secs(5), resolver.lookup(name, RecordType::SRV)).await.ok()?.ok()?;
    let mut best: Option<(u16, String, u16)> = None;
    for rec in lookup.answers() {
        if let hickory_resolver::proto::rr::RData::SRV(s) = &rec.data {
            let host = s.target.to_utf8().trim_end_matches('.').to_string();
            if host.is_empty() || host == "." {
                continue;
            }
            if best.as_ref().map(|(p, _, _)| s.priority < *p).unwrap_or(true) {
                best = Some((s.priority, host, s.port));
            }
        }
    }
    best.map(|(_, h, p)| (h, p))
}

/// Registrable domain of a host ("mx1.mail.example.co.uk" → "example.co.uk", best effort).
fn base_domain(host: &str) -> String {
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    if parts.len() <= 2 {
        return parts.join(".");
    }
    let two_level = ["co.uk", "com.au", "co.jp", "com.br", "co.nz", "co.in", "org.uk"];
    let last2 = parts[parts.len() - 2..].join(".");
    if two_level.contains(&last2.as_str()) && parts.len() >= 3 {
        return parts[parts.len() - 3..].join(".");
    }
    last2
}

pub async fn discover(http: &reqwest::Client, email: &str) -> Vec<Discovered> {
    let mut out = Vec::new();
    if let Some(b) = builtin(email) {
        let gmail = b.kind == "gmail";
        out.push(b);
        if gmail {
            return out;
        }
    }
    let Some(domain) = email.rsplit('@').next().map(|d| d.to_lowercase()) else { return out };
    let enc = crate::http::url_encode(email);
    for url in [
        format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={enc}"),
        format!("https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml"),
        format!("https://autoconfig.thunderbird.net/v1.1/{domain}"),
    ] {
        if let Some(xml) = fetch(http, &url).await {
            if let Some(c) = parse_autoconfig(&xml, email) {
                out.push(Discovered { kind: "imap".into(), provider: domain.clone(), config: Some(c), source: url.split('?').next().unwrap_or(&url).to_string(), help: None });
                return out;
            }
        }
    }
    if let Some(mx) = mx_host(&domain).await {
        if mx.ends_with("google.com") || mx.ends_with("googlemail.com") {
            out.push(Discovered { kind: "gmail".into(), provider: "Google Workspace".into(), config: None, source: "MX".into(), help: None });
            return out;
        }
        let base = base_domain(&mx);
        if let Some(xml) = fetch(http, &format!("https://autoconfig.thunderbird.net/v1.1/{base}")).await {
            if let Some(c) = parse_autoconfig(&xml, email) {
                out.push(Discovered { kind: "imap".into(), provider: base.clone(), config: Some(c), source: "MX + ISP database".into(), help: None });
                return out;
            }
        }
    }
    let imap = match srv(&format!("_imaps._tcp.{domain}")).await {
        Some((h, p)) => Some((h, p, Security::Tls)),
        None => srv(&format!("_imap._tcp.{domain}")).await.map(|(h, p)| (h, p, Security::Starttls)),
    };
    let smtp = match srv(&format!("_submissions._tcp.{domain}")).await {
        Some((h, p)) => Some((h, p, Security::Tls)),
        None => srv(&format!("_submission._tcp.{domain}")).await.map(|(h, p)| (h, p, Security::Starttls)),
    };
    if let (Some(i), Some(s)) = (&imap, &smtp) {
        out.push(Discovered { kind: "imap".into(), provider: domain.clone(), config: Some(cfg((&i.0, i.1, i.2), (&s.0, s.1, s.2), email, true)), source: "DNS SRV".into(), help: None });
        return out;
    }
    // Last resort: the usual names. The add-account screen tests these before saving.
    out.push(Discovered {
        kind: "imap".into(),
        provider: domain.clone(),
        config: Some(cfg((&format!("imap.{domain}"), 993, Security::Tls), (&format!("smtp.{domain}"), 465, Security::Tls), email, true)),
        source: "guess".into(),
        help: Some("These are common settings; check them with your provider if the connection fails.".into()),
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_and_autoconfig() {
        assert_eq!(builtin("a@gmail.com").unwrap().kind, "gmail");
        let icloud = builtin("pat@icloud.com").unwrap().config.unwrap();
        assert_eq!(icloud.imap.host, "imap.mail.me.com");
        assert_eq!(icloud.smtp.security, Security::Starttls);
        assert!(builtin("pat@example.org").is_none());
        let xml = r#"<clientConfig version="1.1"><emailProvider id="example.org">
          <incomingServer type="imap"><hostname>mail.example.org</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
          <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
        </emailProvider></clientConfig>"#;
        let c = parse_autoconfig(xml, "pat@example.org").unwrap();
        assert_eq!(c.imap.host, "mail.example.org");
        assert_eq!(c.imap.username, "pat");
        assert_eq!(c.smtp.port, 587);
        assert_eq!(c.smtp.username, "pat@example.org");
        assert_eq!(base_domain("mx1.mail.example.co.uk"), "example.co.uk");
        assert_eq!(base_domain("aspmx.l.google.com"), "google.com");
    }
}
