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

/// When the kernel started this process (ms since the epoch, to the microsecond): `sysctl` KERN_PROC_PID gives a
/// `kinfo_proc`, whose first field (`kp_proc.p_un`) holds `p_starttime`, a timeval.
#[cfg(target_os = "macos")]
fn process_start_ms() -> f64 {
    unsafe extern "C" {
        fn sysctl(name: *mut i32, namelen: u32, oldp: *mut std::ffi::c_void, oldlenp: *mut usize, newp: *mut std::ffi::c_void, newlen: usize) -> i32;
    }
    let mut mib = [1, 14, 1, std::process::id() as i32];
    let mut buf = [0u8; 1024];
    let mut len = buf.len();
    // SAFETY: `buf` is larger than a kinfo_proc (648 bytes on arm64) and `len` says how large it is.
    let r = unsafe { sysctl(mib.as_mut_ptr(), 4, buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    if r != 0 || len < 16 {
        return 0.0;
    }
    let sec = i64::from_ne_bytes(buf[0..8].try_into().unwrap_or_default());
    let usec = i32::from_ne_bytes(buf[8..12].try_into().unwrap_or_default());
    sec as f64 * 1000.0 + usec as f64 / 1000.0
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
    /// Extra mail-API accounts with busy mailboxes (`big-accounts`), syncing alongside the others.
    #[cfg(debug_assertions)]
    pub extra: Mutex<Vec<FakeGmail>>,
    /// Background mail arriving in the extra accounts (`traffic`): bumped to stop the current stream.
    pub traffic: Arc<std::sync::atomic::AtomicU64>,
    /// When `start` began and finished (ms since the epoch): the fakes' share of a launch, for the perf run.
    pub boot_ms: (i64, i64),
}

/// An end-to-end run of the perf steps (scripts/perf.sh): COURIER_E2E_ONLY names "perf:" steps.
pub fn perf_run() -> bool {
    report_path().is_some() && std::env::var("COURIER_E2E_ONLY").is_ok_and(|o| o.contains("perf:"))
}

/// WebKit renders no frames for a page whose window is covered or on another Space, and the end-to-end window sits
/// behind the others. The perf run times frames, so it tells WebKit to render the page as if it were in front.
#[cfg(target_os = "macos")]
pub fn keep_rendering(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|pv| {
        let wk = pv.inner() as *mut objc2::runtime::AnyObject;
        // SAFETY: on macOS `inner()` is the live WKWebView, and this runs on the main thread. The setter is WebKit SPI,
        // so it is asked for first.
        unsafe {
            let known: bool = !wk.is_null() && objc2::msg_send![&*wk, respondsToSelector: objc2::sel!(_setWindowOcclusionDetectionEnabled:)];
            if known {
                let _: () = objc2::msg_send![&*wk, _setWindowOcclusionDetectionEnabled: false];
                // WebKit decides whether the page is visible again only when the view or its window changes.
                let _: () = objc2::msg_send![&*wk, setHidden: true];
                let _: () = objc2::msg_send![&*wk, setHidden: false];
            }
        }
    });
}

/// Runs before the main window's page in perf runs: notes (`performance.now()`, ms) when the first
/// conversation rows reach the page and when the frame showing them has rendered, for the perf run's launch time.
pub const FIRST_ROWS_SCRIPT: &str = r#"(() => {
  const t = (window.__firstRows = { dom: 0, painted: 0 });
  const mo = new MutationObserver(() => {
    if (!document.querySelector('[data-testid="thread-row"]')) return;
    mo.disconnect();
    t.dom = performance.now();
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => (t.painted = performance.now());
      ch.port2.postMessage(0);
    });
  });
  mo.observe(document, { childList: true, subtree: true });
})();"#;

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
        let begun = crate::error::now_ms();
        crate::db::TRACE_INBOX.store(true, std::sync::atomic::Ordering::Relaxed);
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
        // Real-world shapes: encoded headers, no subject, a long thread, a styled newsletter, an accented file name.
        gmail.deliver(
            format!("From: =?UTF-8?Q?Jos=C3=A9_=C3=91=C3=BA=C3=B1ez?= <jose@example.net>\r\nTo: {me}\r\nSubject: =?UTF-8?B?Q2Fmw6kg4piVIG1lZXRpbmcg4oCUIHLDqXN1bcOp?=\r\nDate: {}\r\nMessage-ID: <u1@seed.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOn se voit =C3=A0 10h au caf=C3=A9 ?\r\n", d(2, 9)).as_bytes(),
            &["INBOX", "CATEGORY_PERSONAL"],
        );
        gmail.deliver(&mail("Quiet Person <quiet@example.net>", me, "", &d(2, 10), "A message with no subject line.", ""), &["INBOX", "CATEGORY_PERSONAL"]);
        let mut prev = String::new();
        for i in 0..12 {
            let id = format!("<offsite{i}@seed.example>");
            let refs = if prev.is_empty() { String::new() } else { format!("In-Reply-To: {prev}\r\nReferences: {prev}\r\n") };
            let subject = if i == 0 { "Planning the offsite".to_string() } else { "Re: Planning the offsite".to_string() };
            let from = if i % 2 == 0 { "Ana Lima <ana@friends.example>" } else { "Bo Chen <bo@work.example>" };
            let raw = format!("From: {from}\r\nTo: {me}\r\nSubject: {subject}\r\nDate: {}\r\nMessage-ID: {id}\r\n{refs}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOffsite note number {}.\r\n", (now - chrono::Duration::days(3) + chrono::Duration::minutes(i * 7)).to_rfc2822(), i + 1);
            gmail.deliver(raw.as_bytes(), if i < 10 { &["INBOX", "CATEGORY_PERSONAL"][..] } else { &["INBOX", "UNREAD", "CATEGORY_PERSONAL"][..] });
            prev = id;
        }
        gmail.deliver(
            &html_mail(
                "Weekly Digest <digest@news.example>",
                me,
                "This week in gardening",
                &d(1, 7),
                "<style>.hero{color:#0a0} body{font-family:Georgia}</style><table width=\"600\"><tr><td class=\"hero\"><h2>Spring planting</h2><p>Five easy herbs for a sunny window.</p><img src=\"https://img.news.example/herbs.jpg\" width=\"560\"></td></tr></table><script>alert(1)</script><a href=\"https://news.example/read\" onclick=\"steal()\">Read more</a><img src=\"https://px.news.example/open.gif\" width=\"1\" height=\"1\">",
                "",
            ),
            &["INBOX", "CATEGORY_PERSONAL"],
        );
        gmail.deliver(
            format!("From: Recruiter <jobs@example.net>\r\nTo: {me}\r\nSubject: Your application\r\nDate: {}\r\nMessage-ID: <cv1@seed.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b2\"\r\n\r\n--b2\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThanks, we received it.\r\n--b2\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''R%C3%A9sum%C3%A9%202026.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQKJSByZXN1bWUK\r\n--b2--\r\n", d(1, 16)).as_bytes(),
            &["INBOX", "CATEGORY_PERSONAL"],
        );
        // Shapes that used to break the message frame: a page-height layout (grew forever), a fixed-width one
        // (cut off on the right) and a very long one (cut off at the bottom).
        gmail.deliver(
            &html_mail("Full Height News <hello@tall.example>", me, "Full-height newsletter", &d(1, 6), "<style>html,body{height:100%;margin:0}.wrap{min-height:100vh}</style><div class=\"wrap\"><table height=\"100%\" width=\"100%\"><tr><td><h2>Autumn issue</h2><p>A short body inside a page-height layout.</p><p>TALL-END</p></td></tr></table></div>", ""),
            &["INBOX", "CATEGORY_PERSONAL"],
        );
        gmail.deliver(
            &html_mail("Wide Layout Co <hello@wide.example>", me, "Fixed-width newsletter", &d(1, 5), "<table width=\"1400\" style=\"width:1400px\"><tr><td width=\"700\">Left column of a fixed-width layout.</td><td width=\"700\" align=\"right\">WIDE-RIGHT-END</td></tr></table>", ""),
            &["INBOX", "CATEGORY_PERSONAL"],
        );
        let long: String = "<p><a href=\"#last\" id=\"jump\">Jump to the end</a></p>".to_string() + &(1..=150).map(|i| format!("<p>Paragraph {i} of a long letter, long enough to need scrolling.</p>")).collect::<String>() + "<p id=\"last\">LONG-LAST-LINE</p>";
        gmail.deliver(&html_mail("Long Letter <hello@long.example>", me, "A very long message", &d(1, 4), &long, ""), &["INBOX", "CATEGORY_PERSONAL"]);
        // A sender that failed its checks, and a message in Spam.
        gmail.deliver(
            &mail("Your Bank <security@bank.example>", me, "Confirm your account now", &d(0, 6), "Click the link to keep your account.", "Authentication-Results: mx.example.com; spf=fail smtp.mailfrom=bank.example; dkim=none; dmarc=fail header.from=bank.example\r\n"),
            &["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
        );
        gmail.deliver(&mail("Prize Desk <win@prize.example>", me, "You won a cruise", &d(1, 6), "Claim it today.", ""), &["SPAM", "UNREAD"]);
        // Awkward shapes for the layout checks: a 300-character subject, a long sender name, an unbroken word,
        // right-to-left text, and a message to 60 people.
        let long_subject = format!("Awkward subject {}", "that keeps going and going ".repeat(10)).trim().to_string();
        let long_name = format!("{} <very.long.sender.name@awkward.example>", "Bartholomew Maximilian Featherstonehaugh-Worthington III");
        gmail.deliver(
            &mail(&long_name, me, &long_subject, &d(1, 2), &format!("Supercalifragilistic{}expialidocious", "x".repeat(200)), ""),
            &["INBOX", "CATEGORY_PERSONAL", "Label_1"],
        );
        gmail.deliver(&mail("سارا <sara@rtl.example>", me, "سلام، جلسه فردا ساعت ده است", &d(1, 2), "لطفاً یادداشت‌ها را بیاورید.", ""), &["INBOX", "CATEGORY_PERSONAL"]);
        let crowd: Vec<String> = (1..=60).map(|i| format!("Person {i} <p{i}@crowd.example>")).collect();
        gmail.deliver(&mail("Big List <host@crowd.example>", &format!("{me}, {}", crowd.join(", ")), "Party for everyone", &d(1, 2), "You're all invited.", ""), &["INBOX", "CATEGORY_PERSONAL"]);
        gmail.deliver(
            &html_mail("Link Sender <links@example.org>", me, "Links to open", &d(1, 3), "<p><a href=\"https://example.org/e2e-target\">Open the page</a></p><p><a href=\"mailto:links@example.org?subject=Hello\">Write to us</a></p>", ""),
            &["INBOX", "CATEGORY_PERSONAL"],
        );
        // A calendar invitation (iCalendar REQUEST) to answer.
        {
            let start = (now + chrono::Duration::days(2)).with_timezone(&chrono::Utc).format("%Y%m%dT150000Z").to_string();
            let end = (now + chrono::Duration::days(2)).with_timezone(&chrono::Utc).format("%Y%m%dT160000Z").to_string();
            let ics = format!(
                "BEGIN:VCALENDAR\r\nPRODID:-//Example//Cal//EN\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nDTSTART:{start}\r\nDTEND:{end}\r\nUID:design-review-1@cal.example\r\nSEQUENCE:0\r\nORGANIZER;CN=Ana Lima:mailto:ana@cal.example\r\nATTENDEE;CN=Pat Example;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:pat@example.com\r\nSUMMARY:Design review\r\nLOCATION:Room 4\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            );
            let raw = format!(
                "From: Ana Lima <ana@cal.example>\r\nTo: {me}\r\nSubject: Invitation: Design review\r\nDate: {}\r\nMessage-ID: <invite1@seed.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"m1\"\r\n\r\n--m1\r\nContent-Type: multipart/alternative; boundary=\"a1\"\r\n\r\n--a1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYou're invited to the design review.\r\n--a1\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\n{ics}--a1--\r\n--m1\r\nContent-Type: application/ics; name=\"invite.ics\"\r\nContent-Disposition: attachment; filename=\"invite.ics\"\r\n\r\n{ics}--m1--\r\n",
                d(0, 7)
            );
            gmail.deliver(raw.as_bytes(), &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
        }
        // A label with more than a page of mail, a third of it older than the offline window (never cached),
        // for "select all conversations in this view"; and a small one for "delete all except selected".
        for i in 0..60 {
            let date = if i < 20 { d(60 + i, 9) } else { d(i % 5, 9) };
            gmail.deliver(&mail("Bulk Sender <bulk@lists.example>", me, &format!("Bulk note {i}"), &date, "One of many.", ""), &["Label_3", "UNREAD"]);
        }
        for i in 0..8 {
            gmail.deliver(&mail("Keeper <keep@lists.example>", me, &format!("Keep or not {i}"), &d(1, 9 + i as u32), "Pick the ones to keep.", ""), &["Label_4", "UNREAD"]);
        }
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
            s.user_labels.push(json!({"id": "Label_3", "name": "Bulk", "type": "user"}));
            s.user_labels.push(json!({"id": "Label_4", "name": "Keep", "type": "user"}));
        }
        imap.deliver("INBOX", &mail("Eli Park <eli@club.example>", "pat@example.org", "Club meeting Thursday", &d(0, 8), "Meeting moved to Thursday at 7.", ""), &[]);
        imap.deliver("INBOX", &mail("Fay Wong <fay@club.example>", "pat@example.org", "Train tickets", &d(2, 14), "Tickets for the trip are booked.", ""), &["\\Seen"]);
        imap.deliver("Sent", &mail("Pat <pat@example.org>", "eli@club.example", "Re: Club agenda", &d(5, 20), "Sounds good.", ""), &["\\Seen"]);
        let boot_ms = (begun, crate::error::now_ms());
        E2e { report_path, gmail, imap, smtp, notes: Mutex::new(vec![]), opened: Mutex::new(vec![]), activations: Default::default(), extra: Mutex::new(vec![]), traffic: Default::default(), boot_ms }
    }

    pub fn info(&self) -> Value {
        #[cfg(debug_assertions)]
        {
            json!({
                "gmailEmail": GMAIL_ADDR, "imapEmail": IMAP_ADDR, "imapPassword": IMAP_PASSWORD, "clientId": CLIENT_ID, "clientSecret": "e2e-secret",
                "imapHost": "127.0.0.1", "imapPort": self.imap.addr.port(), "smtpPort": self.smtp.addr.port(), "fakeBase": self.gmail.base(),
                "only": std::env::var("COURIER_E2E_ONLY").unwrap_or_default(),
            })
        }
        #[cfg(not(debug_assertions))]
        json!({})
    }

    /// For the perf run: when the kernel started this process and when `start` (the fakes) began and ended, all in
    /// ms since the epoch, and WebKit's processes for the window (the page's, the GPU's and the network's), whose
    /// memory and CPU are Courier's too.
    pub async fn perf_info(&self, app: &tauri::AppHandle) -> Result<Value> {
        #[cfg(target_os = "macos")]
        {
            use tauri::Manager;
            let w = app.get_webview_window("main").ok_or_else(|| Error::msg("no main window"))?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            let _ = w.with_webview(move |pv| {
                let wk = pv.inner() as *mut objc2::runtime::AnyObject;
                // SAFETY: on macOS `inner()` is the live WKWebView, and this runs on the main thread. The selectors are
                // WebKit SPI, so each is asked for first.
                macro_rules! pid {
                    ($sel:ident) => {
                        unsafe {
                            let known: bool = !wk.is_null() && objc2::msg_send![&*wk, respondsToSelector: objc2::sel!($sel)];
                            if known {
                                let p: i32 = objc2::msg_send![&*wk, $sel];
                                p
                            } else {
                                0
                            }
                        }
                    };
                }
                let _ = tx.send((pid!(_webProcessIdentifier), pid!(_gpuProcessIdentifier), pid!(_networkProcessIdentifier)));
            });
            let (web, gpu, net) = rx.await.unwrap_or_default();
            Ok(json!({
                "pid": std::process::id(), "processStartMs": process_start_ms(), "fakesMs": [self.boot_ms.0, self.boot_ms.1],
                "webContentPid": web, "gpuPid": gpu, "networkPid": net,
            }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = app;
            Ok(json!({"pid": std::process::id(), "fakesMs": [self.boot_ms.0, self.boot_ms.1]}))
        }
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

    /// Mail-API accounts with busy mailboxes, signed in and syncing like the user's own (`big-accounts`).
    #[cfg(debug_assertions)]
    pub async fn big_accounts(&self, engine: &Arc<Engine>, args: &Value) -> Result<Value> {
        let count = args["count"].as_u64().unwrap_or(3) as usize;
        let spec = crate::testsupport::mailbox::Spec { seed: args["seed"].as_u64().unwrap_or(1), conversations: args["conversations"].as_u64().unwrap_or(3000) as usize, ..Default::default() };
        let creds = engine.google_client()?;
        let mut out = Vec::new();
        for i in 0..count {
            let email = format!("busy{i}@example.net");
            let fake = FakeGmail::start(&email, &format!("Busy {i}")).await;
            let n = crate::testsupport::mailbox::fill(&fake, &crate::testsupport::mailbox::Spec { seed: spec.seed + i as u64, ..spec.clone() });
            let access = format!("busy-access-{i}");
            fake.state.lock().access.insert(access.clone(), crate::error::now_ms() / 1000 + 86_400);
            let id = format!("g-busy{i}");
            let ep = fake.endpoints();
            let tokens = crate::oauth::Tokens { access_token: access, refresh_token: None, expires_at: crate::error::now_ms() / 1000 + 86_400, scope: String::new() };
            crate::oauth::TokenManager::new(&id, ep.clone(), creds.clone(), engine.secrets.clone(), engine.http.clone()).save(&tokens)?;
            let position = engine.db.accounts()?.len() as i64;
            engine.db.insert_account(&crate::db::AccountRow {
                id: id.clone(),
                kind: "gmail".into(),
                email: email.clone(),
                name: format!("Busy {i}"),
                color: ["#e8710a", "#9334e6", "#188038", "#d93025"][i % 4].into(),
                position,
                config: json!({"endpoints": ep}),
                state: json!({}),
                photo: None,
                created_at: crate::error::now_ms(),
                needs_reauth: false,
            })?;
            engine.start_account(&id);
            self.extra.lock().push(fake);
            out.push(json!({"id": id, "email": email, "messages": n}));
        }
        engine.emit("accounts-changed", json!({}));
        Ok(json!({"accounts": out}))
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
                // Mail that has long been in the mailbox, older than Courier's offline window and never cached: the
                // server has it, the history doesn't mention it. An optional new label is made for it.
                // Each listed conversation's labels (all its messages together) on extra account `account`.
                "extra-labels" => {
                    let fakes = self.extra.lock();
                    let f = fakes.get(args["account"].as_u64().unwrap_or(0) as usize).ok_or_else(|| Error::msg("no such extra account"))?;
                    let st = f.state.lock();
                    let mut out = serde_json::Map::new();
                    for t in args["threads"].as_array().cloned().unwrap_or_default() {
                        let t = t.as_str().unwrap_or("").to_string();
                        let mut labels: Vec<String> = st.messages.values().filter(|m| m.thread_id == t).flat_map(|m| m.labels.clone()).collect();
                        labels.sort();
                        labels.dedup();
                        out.insert(t, json!(labels));
                    }
                    Ok(Value::Object(out))
                }
                // New mail arriving in the extra accounts every `everyMs` (0 stops it), as on a busy day.
                "traffic" => {
                    let stream = self.traffic.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let every = args["everyMs"].as_u64().unwrap_or(0);
                    if every > 0 {
                        // `accounts`: which extra accounts get mail (indexes; all when left out).
                        let all = self.extra.lock().clone();
                        let pick: Vec<usize> = args["accounts"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|x| x as usize)).collect()).unwrap_or_else(|| (0..all.len()).collect());
                        let fakes: Vec<(usize, FakeGmail)> = pick.into_iter().filter_map(|i| all.get(i).cloned().map(|f| (i, f))).collect();
                        let stop = self.traffic.clone();
                        let e = engine.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut n = 0u64;
                            while stop.load(std::sync::atomic::Ordering::SeqCst) == stream && !fakes.is_empty() {
                                tokio::time::sleep(std::time::Duration::from_millis(every)).await;
                                let (i, f) = &fakes[(n as usize) % fakes.len()];
                                let email = f.state.lock().email.clone();
                                let raw = mail("Build Bot <ci@builds.example>", &email, &format!("Build {n} finished"), &chrono::Local::now().to_rfc2822(), "All green.", "");
                                f.deliver(&raw, &["INBOX", "UNREAD", "CATEGORY_UPDATES"]);
                                e.trigger(&format!("g-busy{i}"));
                                n += 1;
                            }
                        });
                    }
                    Ok(json!({}))
                }
                "seed-gmail-old" => {
                    let date = (chrono::Local::now() - chrono::Duration::days(args["daysAgo"].as_i64().unwrap_or(400))).to_rfc2822();
                    let raw = mail(&s("from"), GMAIL_ADDR, &s("subject"), &date, &s("body"), "");
                    let mut g = self.gmail.state.lock();
                    let mut labels: Vec<String> = args["labels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    if let Some(name) = args["newLabel"].as_str() {
                        let id = format!("Label_{}", 100 + g.user_labels.len());
                        if !g.user_labels.iter().any(|l| l["name"] == name) {
                            g.user_labels.push(json!({"id": id, "name": name, "type": "user"}));
                        }
                        labels.push(g.user_labels.iter().find(|l| l["name"] == name).and_then(|l| l["id"].as_str()).unwrap_or(&id).to_string());
                    }
                    let id = crate::testsupport::fake_gmail::new_id(&mut g);
                    let internal_date = crate::mailmeta::parse_raw(&raw).row.internal_date;
                    g.messages.insert(id.clone(), crate::testsupport::fake_gmail::FMsg { id: id.clone(), thread_id: id.clone(), labels: labels.clone(), raw, internal_date });
                    Ok(json!({"id": id, "labels": labels}))
                }
                "deliver-imap" => {
                    let raw = mail(&s("from"), IMAP_ADDR, &s("subject"), &chrono::Local::now().to_rfc2822(), &s("body"), &s("headers"));
                    let folder = args["folder"].as_str().unwrap_or("INBOX");
                    let uid = self.imap.deliver(folder, &raw, &[]);
                    Ok(json!({"uid": uid}))
                }
                "gmail-behaviour" => {
                    // The extra accounts stand for the same real server: they take the same timings.
                    for f in self.extra.lock().iter() {
                        let mut g = f.state.lock();
                        if let Some(l) = args["latency"].as_object() {
                            g.latency = l.iter().filter_map(|(k, v)| v.as_u64().map(|ms| (k.clone(), ms))).collect();
                        }
                        if let Some(ms) = args["searchLag"].as_u64() {
                            g.search_lag_ms = ms;
                        }
                        if let Some(ms) = args["labelLag"].as_u64() {
                            g.label_lag_ms = ms;
                        }
                        if let Some(l) = args["tail"].as_object() {
                            g.tail_latency = l.iter().filter_map(|(k, v)| v.as_u64().map(|ms| (k.clone(), ms))).collect();
                        }
                    }
                    let mut g = self.gmail.state.lock();
                    if let Some(l) = args["latency"].as_object() {
                        g.latency = l.iter().filter_map(|(k, v)| v.as_u64().map(|ms| (k.clone(), ms))).collect();
                    }
                    if let Some(n) = args["preconditionNext"].as_u64() {
                        g.precondition_next = n as u32;
                    }
                    if let Some(f) = args["failRoutes"].as_object() {
                        g.fail_routes = f.iter().filter_map(|(k, v)| v.as_u64().map(|c| (k.clone(), c as u16))).collect();
                    }
                    if let Some(ids) = args["preconditionIds"].as_array() {
                        g.precondition_ids = ids.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
                    }
                    if let Some(ms) = args["searchLag"].as_u64() {
                        g.search_lag_ms = ms;
                    }
                    if let Some(ms) = args["labelLag"].as_u64() {
                        g.label_lag_ms = ms;
                    }
                    if let Some(l) = args["tail"].as_object() {
                        g.tail_latency = l.iter().filter_map(|(k, v)| v.as_u64().map(|ms| (k.clone(), ms))).collect();
                    }
                    drop(g);
                    if let Some(ms) = args["imapMoveLatency"].as_u64() {
                        self.imap.state.lock().move_latency = ms;
                    }
                    Ok(json!({}))
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
                    let unsub_requests = g.unsubscribe_requests.clone();
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
                        "gmailSent": sent, "gmailDrafts": drafts, "filters": filters, "unsubscribed": unsub, "unsubscribeRequests": unsub_requests, "vacation": vacation, "sendAs": send_as,
                        "gmailLabels": labels, "gmailMessages": msgs, "smtpSent": smtp, "imapFolders": folders,
                        "notifications": *self.notes.lock(), "opened": *self.opened.lock(),
                    }))
                }
                "sync" => {
                    engine.trigger_all();
                    Ok(json!({}))
                }
                // What the fake mail APIs spent answering, by route, since the last `reset` (perf runs check that the
                // fakes, which run inside the app, aren't what they measured).
                "fake-stats" => {
                    let mut fakes = vec![self.gmail.clone()];
                    fakes.extend(self.extra.lock().iter().cloned());
                    let mut routes: std::collections::BTreeMap<String, crate::testsupport::fake_gmail::Served> = Default::default();
                    for f in &fakes {
                        let mut st = f.state.lock();
                        for (route, s) in &st.served {
                            let r = routes.entry(route.clone()).or_default();
                            r.count += s.count;
                            r.total_ms += s.total_ms;
                            r.max_ms = r.max_ms.max(s.max_ms);
                        }
                        if args["reset"].as_bool() == Some(true) {
                            st.served.clear();
                        }
                    }
                    let total: f64 = routes.values().map(|r| r.total_ms).sum();
                    let routes: serde_json::Map<String, Value> = routes.into_iter().map(|(k, r)| (k, json!({"count": r.count, "totalMs": r.total_ms, "maxMs": r.max_ms}))).collect();
                    Ok(json!({"totalMs": total, "routes": routes}))
                }
                // End-to-end runs log every cache write that moves a message into or out of the Inbox (an extra read and
                // a log line each); perf runs turn it off, as it is in the app people use.
                "trace-inbox" => {
                    crate::db::TRACE_INBOX.store(args["on"].as_bool().unwrap_or(true), std::sync::atomic::Ordering::Relaxed);
                    Ok(json!({}))
                }
                // End-to-end runs sync every 2 s; perf runs time the views at the app's own 60 s (from the next cycle).
                "sync-interval" => {
                    *engine.sync_interval.write() = std::time::Duration::from_secs(args["seconds"].as_u64().unwrap_or(2).max(1));
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
