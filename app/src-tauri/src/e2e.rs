//! End-to-end run support (debug builds only, `COURIER_E2E=<report.json>`): starts the local fakes, seeds
//! two mailboxes, records notifications and opened links instead of showing them, and gives the in-app
//! runner (app/src/e2e/run.ts) controls to deliver mail, go offline and inspect the servers.

use crate::engine::Engine;
use crate::error::{Error, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;

#[cfg(debug_assertions)]
use crate::testsupport::{FakeGmail, FakeImap, FakeSmtp};

pub fn report_path() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        std::env::var("COURIER_E2E").ok().filter(|p| !p.is_empty())
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

pub struct E2e {
    pub report_path: String,
    #[cfg(debug_assertions)]
    pub gmail: FakeGmail,
    #[cfg(debug_assertions)]
    pub imap: FakeImap,
    #[cfg(debug_assertions)]
    pub smtp: FakeSmtp,
    pub notes: Mutex<Vec<Value>>,
    pub opened: Mutex<Vec<String>>,
    /// Times macOS made Courier the active app during the run (each one fails the run).
    pub activations: std::sync::atomic::AtomicU32,
}

pub const GMAIL_ADDR: &str = "pat@example.com";
pub const IMAP_ADDR: &str = "pat@example.org";
pub const IMAP_PASSWORD: &str = "test-app-password";
pub const CLIENT_ID: &str = "courier-test-client";

#[cfg(debug_assertions)]
fn mail(from: &str, to: &str, subject: &str, date: &str, body: &str, extra: &str) -> Vec<u8> {
    let id = crate::error::random_token(6);
    format!("From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{id}@seed.example>\r\n{extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n").into_bytes()
}

#[cfg(debug_assertions)]
fn html_mail(from: &str, to: &str, subject: &str, date: &str, html: &str, extra: &str) -> Vec<u8> {
    let id = crate::error::random_token(6);
    format!("From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{id}@seed.example>\r\n{extra}MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n").into_bytes()
}

#[cfg(debug_assertions)]
fn with_attachment(from: &str, to: &str, subject: &str, date: &str, body: &str, filename: &str, mime: &str, data_b64: &str) -> Vec<u8> {
    let id = crate::error::random_token(6);
    format!(
        "From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{id}@seed.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n--b1\r\nContent-Type: {mime}; name=\"{filename}\"\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{data_b64}\r\n--b1--\r\n"
    )
    .into_bytes()
}

impl E2e {
    #[cfg(debug_assertions)]
    pub async fn start(report_path: String) -> E2e {
        let gmail = FakeGmail::start(GMAIL_ADDR, "Pat Example").await;
        let imap = FakeImap::start(IMAP_ADDR, IMAP_PASSWORD).await;
        let smtp = FakeSmtp::start(IMAP_ADDR, IMAP_PASSWORD).await;
        let me = "Pat Example <pat@example.com>";
        let now = chrono::Local::now();
        let d = |days: i64, h: u32| (now - chrono::Duration::days(days)).with_hour(h).unwrap_or(now).to_rfc2822();
        use chrono::Timelike;
        let lunch = mail("Ana Lima <ana@friends.example>", me, "Lunch on Friday?", &d(0, 9), "Are you free for lunch on Friday? The new noodle place opened.", "");
        gmail.deliver(&lunch, &["INBOX", "UNREAD", "CATEGORY_PERSONAL", "IMPORTANT"]);
        let lunch_id = crate::mailmeta::parse_raw(&lunch).row.message_id;
        gmail.deliver(
            &mail("Bo Chen <bo@work.example>", me, "Re: Lunch on Friday?", &d(0, 10), "Count me in!\n\nOn Fri, Ana wrote:\n> Are you free?", &format!("In-Reply-To: {lunch_id}\r\nReferences: {lunch_id}\r\n")),
            &["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
        );
        gmail.deliver(&with_attachment("Cara Diaz <cara@work.example>", me, "Quarterly planning notes", &d(1, 15), "Attached are the planning notes for next quarter.", "quarterly-plan.pdf", "application/pdf", "JVBERi0xLjQKJSBzYW1wbGUK"), &["INBOX", "CATEGORY_PERSONAL"]);
        gmail.deliver(
            &html_mail("Daily Deals <news@deals.example>", me, "48 hours only: 30% off", &d(1, 8), "<h1>Big sale</h1><p>Save on everything.</p><img src=\"https://cdn.deals.example/banner.png\" width=\"600\" height=\"200\"><img src=\"https://t.deals.example/o.gif\" width=\"1\" height=\"1\">", "List-Unsubscribe: <mailto:unsub@deals.example?subject=stop>, <URL>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"),
            &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        );
        gmail.deliver(&mail("Social Site <notify@social.example>", me, "You have 3 new followers", &d(2, 12), "See who's following you.", ""), &["INBOX", "CATEGORY_SOCIAL"]);
        gmail.deliver(&mail("Billing <billing@shop.example>", me, "Invoice #1042 for October", &d(3, 11), "Your invoice #1042 is ready. Amount due: $240.00.", ""), &["INBOX", "CATEGORY_UPDATES"]);
        gmail.deliver(&mail(me, "Ana Lima <ana@friends.example>", "Photos from the trip", &d(4, 18), "Here are the photos.", ""), &["SENT"]);
        gmail.deliver(&mail("Old Friend <old@friends.example>", me, "Catching up", &d(40, 9), "Long time no see!", ""), &[]);
        // Fix the unsubscribe URL to point at the fake.
        {
            let mut s = gmail.state.lock();
            let base = format!("http://{}", gmail.addr);
            for m in s.messages.values_mut() {
                let text = String::from_utf8_lossy(&m.raw).replace("<URL>", &format!("<{base}/unsubscribe/deals>"));
                m.raw = text.into_bytes();
            }
            s.user_labels.push(json!({"id": "Label_1", "name": "Projects", "type": "user", "color": {"backgroundColor": "#16a766", "textColor": "#ffffff"}}));
            s.user_labels.push(json!({"id": "Label_2", "name": "Projects/Alpha", "type": "user"}));
        }
        imap.deliver("INBOX", &mail("Eli Park <eli@club.example>", "pat@example.org", "Club meeting Thursday", &d(0, 8), "Meeting moved to Thursday at 7.", ""), &[]);
        imap.deliver("INBOX", &mail("Fay Wong <fay@club.example>", "pat@example.org", "Train tickets", &d(2, 14), "Tickets for the trip are booked.", ""), &["\\Seen"]);
        imap.deliver("Sent", &mail("Pat <pat@example.org>", "eli@club.example", "Re: Club agenda", &d(5, 20), "Sounds good.", ""), &["\\Seen"]);
        E2e { report_path, gmail, imap, smtp, notes: Mutex::new(vec![]), opened: Mutex::new(vec![]), activations: Default::default() }
    }

    pub fn info(&self) -> Value {
        #[cfg(debug_assertions)]
        {
            json!({
                "gmailEmail": GMAIL_ADDR, "imapEmail": IMAP_ADDR, "imapPassword": IMAP_PASSWORD, "clientId": CLIENT_ID, "clientSecret": "e2e-secret",
                "imapHost": "127.0.0.1", "imapPort": self.imap.addr.port(), "smtpPort": self.smtp.addr.port(), "fakeBase": self.gmail.base(),
            })
        }
        #[cfg(not(debug_assertions))]
        json!({})
    }

    /// Discovery for the fake IMAP domain (so the add-account flow can be exercised end to end).
    pub fn discover(&self, email: &str) -> Option<crate::discovery::Discovered> {
        #[cfg(debug_assertions)]
        if email.to_lowercase().ends_with("@example.org") {
            use crate::imap::{ImapAccountConfig, Security, ServerConfig};
            return Some(crate::discovery::Discovered {
                kind: "imap".into(),
                provider: "Example Mail".into(),
                config: Some(ImapAccountConfig {
                    imap: ServerConfig { host: "127.0.0.1".into(), port: self.imap.addr.port(), security: Security::Plain, username: email.into() },
                    smtp: ServerConfig { host: "127.0.0.1".into(), port: self.smtp.addr.port(), security: Security::Plain, username: email.into() },
                    save_sent: true,
                    initial_window: 500,
                }),
                source: "test".into(),
                help: Some("Test server".into()),
            });
        }
        let _ = email;
        None
    }

    pub fn control(&self, engine: &Arc<Engine>, action: &str, args: &Value) -> Result<Value> {
        #[cfg(debug_assertions)]
        {
            let s = |k: &str| args[k].as_str().unwrap_or("").to_string();
            match action {
                "deliver-gmail" => {
                    let raw = mail(&s("from"), GMAIL_ADDR, &s("subject"), &chrono::Local::now().to_rfc2822(), &s("body"), &s("headers"));
                    let labels: Vec<String> = args["labels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_else(|| vec!["INBOX".into(), "UNREAD".into(), "CATEGORY_PERSONAL".into()]);
                    let refs: Vec<&str> = labels.iter().map(|x| x.as_str()).collect();
                    let id = self.gmail.deliver(&raw, &refs);
                    for a in engine.db.accounts()? {
                        engine.trigger(&a.id);
                    }
                    Ok(json!({"id": id}))
                }
                "deliver-imap" => {
                    let raw = mail(&s("from"), IMAP_ADDR, &s("subject"), &chrono::Local::now().to_rfc2822(), &s("body"), &s("headers"));
                    let uid = self.imap.deliver("INBOX", &raw, &[]);
                    Ok(json!({"uid": uid}))
                }
                "offline" => {
                    let on = args["on"].as_bool().unwrap_or(true);
                    self.gmail.state.lock().offline = on;
                    *self.smtp.reject.lock() = on;
                    Ok(json!({}))
                }
                "state" => {
                    let g = self.gmail.state.lock();
                    let sent: Vec<Value> = g
                        .sent
                        .iter()
                        .map(|m| {
                            let p = crate::mailmeta::parse_raw(&m.raw);
                            json!({"subject": p.row.subject, "to": p.row.to, "cc": p.row.cc, "attachments": p.row.attachments, "raw": String::from_utf8_lossy(&m.raw), "threadId": m.thread_id})
                        })
                        .collect();
                    let drafts = g.drafts.len();
                    let filters = g.filters.clone();
                    let unsub = g.unsubscribed.clone();
                    let vacation = g.vacation.clone();
                    let send_as = g.send_as.clone();
                    let labels: Vec<Value> = g.user_labels.clone();
                    let msgs: Vec<Value> = g.messages.values().map(|m| json!({"id": m.id, "threadId": m.thread_id, "labels": m.labels, "subject": crate::mailmeta::parse_raw(&m.raw).row.subject})).collect();
                    drop(g);
                    let smtp: Vec<Value> = self.smtp.sent.lock().iter().map(|m| json!({"from": m.from, "rcpts": m.rcpts, "raw": String::from_utf8_lossy(&m.data)})).collect();
                    let folders: Value = self.imap.state.lock().folders.iter().map(|(k, f)| (k.clone(), json!(f.msgs.len()))).collect::<serde_json::Map<_, _>>().into();
                    Ok(json!({
                        "appActive": crate::macos::app_is_active(),
                        "activations": self.activations.load(std::sync::atomic::Ordering::SeqCst),
                        "gmailSent": sent, "gmailDrafts": drafts, "filters": filters, "unsubscribed": unsub, "vacation": vacation, "sendAs": send_as,
                        "gmailLabels": labels, "gmailMessages": msgs, "smtpSent": smtp, "imapFolders": folders,
                        "notifications": *self.notes.lock(), "opened": *self.opened.lock(),
                    }))
                }
                "sync" => {
                    engine.trigger_all();
                    Ok(json!({}))
                }
                _ => Err(Error::msg(format!("unknown e2e action {action}"))),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = (engine, action, args);
            Err(Error::msg("unavailable"))
        }
    }
}
