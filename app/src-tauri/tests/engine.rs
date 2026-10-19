//! Engine tests against the fakes: views (labels, categories, search, unified), actions on both account
//! kinds, undo send, scheduled send, the offline outbox, snooze, mute, block, local filters, notifications.

use courier_lib::db::{AccountRow, Db};
use courier_lib::engine::{Engine, EventSink, Notifier, Opener, ViewQuery};
use courier_lib::imap::{ImapAccountConfig, Security, ServerConfig};
use courier_lib::oauth::{self, ClientCreds, TokenManager};
use courier_lib::secrets::{self, MemoryStore, SecretStore};
use courier_lib::testsupport::{sample_mail, FakeGmail, FakeImap, FakeSmtp};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
struct Rec {
    events: Mutex<Vec<(String, Value)>>,
    notes: Mutex<Vec<(String, String)>>,
    badge: Mutex<i64>,
}
struct Sink(Arc<Rec>);
impl EventSink for Sink {
    fn emit(&self, e: &str, p: Value) {
        self.0.events.lock().push((e.into(), p));
    }
}
struct Note(Arc<Rec>);
impl Notifier for Note {
    fn notify(&self, title: &str, body: &str, _a: &str, _t: &str) {
        self.0.notes.lock().push((title.into(), body.into()));
    }
}
struct NoOpen;
impl Opener for NoOpen {
    fn open(&self, _url: &str) -> courier_lib::error::Result<()> {
        Ok(())
    }
}

struct World {
    engine: Arc<Engine>,
    rec: Arc<Rec>,
    gmail: FakeGmail,
    imap: FakeImap,
    smtp: FakeSmtp,
}

async fn world() -> World {
    let gmail = FakeGmail::start("pat@example.com", "Pat Example").await;
    let imap = FakeImap::start("pat@example.org", "app-password").await;
    let smtp = FakeSmtp::start("pat@example.org", "app-password").await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
    let rec = Arc::new(Rec::default());
    let r2 = rec.clone();
    let engine = Engine::new(db.clone(), store.clone(), Arc::new(Sink(rec.clone())), Arc::new(Note(rec.clone())), Arc::new(NoOpen), Arc::new(move |n| *r2.badge.lock() = n));
    *engine.google_endpoints.write() = gmail.endpoints();
    *engine.sync_interval.write() = Duration::from_millis(300);
    store.set(secrets::GOOGLE_CLIENT_KEY, &serde_json::to_string(&ClientCreds { client_id: "courier-test-client".into(), client_secret: "s".into() }).unwrap()).unwrap();
    // Mail-API account, signed in through the fake.
    let http = reqwest::Client::new();
    let h2 = http.clone();
    let auth = oauth::authorize(&http, &gmail.endpoints(), &engine.google_client().unwrap(), None, move |u| {
        tokio::spawn(async move {
            let _ = h2.get(u).send().await;
        });
        Ok(())
    })
    .await
    .unwrap();
    TokenManager::new("g1", gmail.endpoints(), engine.google_client().unwrap(), store.clone(), http).save(&auth.tokens).unwrap();
    db.insert_account(&AccountRow { id: "g1".into(), kind: "gmail".into(), email: "pat@example.com".into(), name: "Pat".into(), color: "#1a73e8".into(), position: 0, config: json!({"endpoints": gmail.endpoints()}), state: json!({}), ..Default::default() }).unwrap();
    // IMAP account.
    let cfg = ImapAccountConfig {
        imap: ServerConfig { host: "127.0.0.1".into(), port: imap.addr.port(), security: Security::Plain, username: "pat@example.org".into() },
        smtp: ServerConfig { host: "127.0.0.1".into(), port: smtp.addr.port(), security: Security::Plain, username: "pat@example.org".into() },
        save_sent: true,
        initial_window: 500,
    };
    store.set(&secrets::password_key("i1"), "app-password").unwrap();
    db.insert_account(&AccountRow { id: "i1".into(), kind: "imap".into(), email: "pat@example.org".into(), name: "Pat".into(), color: "#0b8043".into(), position: 1, config: serde_json::to_value(cfg).unwrap(), state: json!({}), ..Default::default() }).unwrap();
    World { engine, rec, gmail, imap, smtp }
}

fn view(account: &str, label: &str) -> ViewQuery {
    ViewQuery { account_id: account.into(), label: Some(label.into()), page_size: 50, conversations: true, ..Default::default() }
}

async fn wait_until(mut f: impl FnMut() -> bool, what: &str) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn views_categories_search_and_unified() {
    let w = world().await;
    w.gmail.deliver(&sample_mail("Ana <ana@x.io>", "pat@example.com", "Lunch on Friday?", "noodles", ""), &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
    w.gmail.deliver(&sample_mail("Shop <news@shop.example>", "pat@example.com", "Sale", "50% off", ""), &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
    w.gmail.deliver(&sample_mail("Bo <bo@x.io>", "pat@example.com", "Old", "archived thing", ""), &["Label_9"]);
    w.imap.deliver("INBOX", &sample_mail("Cy <cy@x.io>", "pat@example.org", "Trip", "train tickets", ""), &[]);
    w.engine.sync_account("g1").await.unwrap();
    w.engine.sync_account("i1").await.unwrap();

    let mut primary = view("g1", "INBOX");
    primary.category = Some("primary".into());
    let r = w.engine.list(&primary).await.unwrap();
    assert_eq!(r.threads.iter().map(|t| t.subject.as_str()).collect::<Vec<_>>(), vec!["Lunch on Friday?"]);
    let mut promos = primary.clone();
    promos.category = Some("promotions".into());
    assert_eq!(w.engine.list(&promos).await.unwrap().threads[0].subject, "Sale");
    // Server mode returns the API's list (and caches it).
    let mut server = view("g1", "INBOX");
    server.mode = Some("server".into());
    let r = w.engine.list(&server).await.unwrap();
    assert_eq!(r.source, "server");
    assert_eq!(r.total, 2);
    // Local search with operators (IMAP accounts and offline).
    let mut q = view("i1", "");
    q.label = None;
    q.query = Some("from:cy train".into());
    assert_eq!(w.engine.list(&q).await.unwrap().threads.len(), 1);
    q.query = Some("from:cy -train".into());
    assert_eq!(w.engine.list(&q).await.unwrap().threads.len(), 0);
    // Unified inbox merges both accounts.
    let mut all = view("all", "INBOX");
    all.account_id = "all".into();
    let r = w.engine.list(&all).await.unwrap();
    assert_eq!(r.threads.len(), 3);
    assert!(r.threads.iter().any(|t| t.account_id == "i1") && r.threads.iter().any(|t| t.account_id == "g1"));
    // Badge counts unread Primary inbox conversations across accounts.
    w.engine.refresh_badge();
    assert_eq!(*w.rec.badge.lock(), 2);
}

#[tokio::test]
async fn gmail_actions_archive_undo_star_trash() {
    let w = world().await;
    let id = w.gmail.deliver(&sample_mail("Ana <ana@x.io>", "pat@example.com", "Lunch", "noodles", ""), &["INBOX", "UNREAD"]);
    w.engine.sync_account("g1").await.unwrap();
    let t = w.engine.db.message("g1", &id).unwrap().unwrap().thread_id;
    w.engine.modify_threads("g1", std::slice::from_ref(&t), &[], &["INBOX".into()]).await.unwrap(); // archive
    assert!(!w.gmail.message(&id).unwrap().labels.contains(&"INBOX".into()));
    assert!(w.engine.list(&view("g1", "INBOX")).await.unwrap().threads.is_empty());
    w.engine.modify_threads("g1", std::slice::from_ref(&t), &["INBOX".into()], &[]).await.unwrap(); // undo
    assert!(w.gmail.message(&id).unwrap().labels.contains(&"INBOX".into()));
    w.engine.modify_messages("g1", std::slice::from_ref(&id), &["STARRED".into()], &["UNREAD".into()]).await.unwrap();
    let labels = w.gmail.message(&id).unwrap().labels;
    assert!(labels.contains(&"STARRED".into()) && !labels.contains(&"UNREAD".into()));
    w.engine.modify_threads("g1", std::slice::from_ref(&t), &["TRASH".into()], &[]).await.unwrap();
    assert!(w.gmail.message(&id).unwrap().labels.contains(&"TRASH".into()));
    assert_eq!(w.engine.list(&view("g1", "TRASH")).await.unwrap().threads.len(), 1);
    w.engine.delete_forever("g1", std::slice::from_ref(&t)).await.unwrap();
    assert!(w.gmail.message(&id).is_none());
}

#[tokio::test]
async fn imap_actions_map_to_moves_flags_and_copies() {
    let w = world().await;
    w.imap.deliver("INBOX", &sample_mail("Cy <cy@x.io>", "pat@example.org", "Trip", "train", ""), &[]);
    w.engine.sync_account("i1").await.unwrap();
    let t = w.engine.list(&view("i1", "INBOX")).await.unwrap().threads[0].clone();
    // Star + read → flags.
    w.engine.modify_threads("i1", std::slice::from_ref(&t.thread_id), &["STARRED".into()], &["UNREAD".into()]).await.unwrap();
    let flags = w.imap.folder("INBOX").unwrap().msgs[0].flags.clone();
    assert!(flags.contains("\\Flagged") && flags.contains("\\Seen"));
    // Label as → copy into a folder.
    let label = w.engine.label_create("i1", "Travel", Some("#16a766"), Some("#ffffff")).await.unwrap();
    w.engine.modify_threads("i1", std::slice::from_ref(&t.thread_id), &[label.clone()], &[]).await.unwrap();
    assert_eq!(w.imap.folder("Travel").unwrap().msgs.len(), 1);
    assert_eq!(w.engine.db.label("i1", &label).unwrap().unwrap().bg.as_deref(), Some("#16a766"));
    // Archive → move INBOX → Archive; the conversation keeps its id.
    w.engine.modify_threads("i1", std::slice::from_ref(&t.thread_id), &[], &["INBOX".into()]).await.unwrap();
    assert!(w.imap.folder("INBOX").unwrap().msgs.is_empty());
    assert_eq!(w.imap.folder("Archive").unwrap().msgs.len(), 1);
    assert!(w.engine.list(&view("i1", "INBOX")).await.unwrap().threads.is_empty());
    let all = w.engine.list(&view("i1", "ALL")).await.unwrap();
    assert!(all.threads.iter().any(|x| x.thread_id == t.thread_id));
    // Trash, then empty trash.
    w.engine.modify_threads("i1", std::slice::from_ref(&t.thread_id), &["TRASH".into()], &[]).await.unwrap();
    assert!(w.imap.folder("Trash").unwrap().msgs.len() >= 1);
    w.engine.empty_label("i1", "TRASH").await.unwrap();
    assert!(w.imap.folder("Trash").unwrap().msgs.is_empty());
}

#[tokio::test]
async fn undo_send_scheduled_send_and_offline_outbox() {
    let w = world().await;
    w.engine.start();
    let raw = sample_mail("Pat <pat@example.com>", "ana@x.io", "Undo me", "oops", "");
    // Undo send: cancel inside the delay.
    let id = w.engine.queue_send("g1", &raw, courier_lib::error::now_ms() + 3000, false, None, None).unwrap();
    assert!(w.engine.cancel_send(id).unwrap().is_some());
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(w.gmail.state.lock().sent.is_empty());
    // Sends after the delay.
    w.engine.queue_send("g1", &sample_mail("Pat <pat@example.com>", "ana@x.io", "Hello", "hi", ""), courier_lib::error::now_ms() + 300, false, None, None).unwrap();
    wait_until(|| w.gmail.state.lock().sent.len() == 1, "sent via API").await;
    // Scheduled send appears under Scheduled until it's due.
    let when = courier_lib::error::now_ms() + 1500;
    w.engine.queue_send("g1", &sample_mail("Pat <pat@example.com>", "ana@x.io", "Later", "scheduled", ""), when, true, None, None).unwrap();
    let sched = w.engine.list(&view("g1", "SCHEDULED")).await.unwrap();
    assert_eq!(sched.threads.len(), 1);
    assert_eq!(sched.threads[0].scheduled_at, Some(when));
    wait_until(|| w.gmail.state.lock().sent.len() == 2, "scheduled send").await;
    assert!(w.engine.list(&view("g1", "SCHEDULED")).await.unwrap().threads.is_empty());
    // Offline: SMTP refuses (transient) → stays in Outbox, then goes out when it recovers.
    *w.smtp.reject.lock() = true;
    let bcc = "From: Pat <pat@example.org>\r\nTo: ana@x.io\r\nBcc: hidden@x.io\r\nSubject: Offline\r\nMessage-ID: <off@x>\r\n\r\nqueued\r\n";
    let oid = w.engine.queue_send("i1", bcc.as_bytes(), courier_lib::error::now_ms(), false, None, None).unwrap();
    wait_until(|| w.engine.db.outbox_item(oid).unwrap().map(|r| r.attempts >= 1).unwrap_or(false), "first failed attempt").await;
    assert_eq!(w.engine.list(&view("i1", "OUTBOX")).await.unwrap().threads.len(), 1);
    *w.smtp.reject.lock() = false;
    w.engine.send_soon(oid).unwrap();
    wait_until(|| w.smtp.sent.lock().len() == 1, "outbox flushed").await;
    let sent = w.smtp.sent.lock()[0].clone();
    assert!(sent.rcpts.contains(&"hidden@x.io".to_string()), "Bcc is in the envelope");
    assert!(!String::from_utf8_lossy(&sent.data).contains("hidden@x.io"), "…but not in the headers");
    wait_until(|| w.imap.folder("Sent").map(|f| f.msgs.len() == 1).unwrap_or(false), "saved to Sent").await;
    assert!(w.rec.events.lock().iter().any(|(e, _)| e == "message-sent"));
}

#[tokio::test]
async fn drafts_on_both_kinds() {
    let w = world().await;
    let raw1 = sample_mail("Pat <pat@example.com>", "ana@x.io", "Draft 1", "v1", "");
    let d = w.engine.draft_save("g1", None, &raw1, None).await.unwrap();
    let d2 = w.engine.draft_save("g1", Some(&d), &sample_mail("Pat <pat@example.com>", "ana@x.io", "Draft 1b", "v2", ""), None).await.unwrap();
    assert_eq!(d, d2);
    assert_eq!(w.engine.list(&view("g1", "DRAFT")).await.unwrap().threads[0].subject, "Draft 1b");
    w.engine.draft_delete("g1", &d).await.unwrap();
    assert!(w.engine.list(&view("g1", "DRAFT")).await.unwrap().threads.is_empty());

    w.engine.sync_account("i1").await.unwrap();
    let di = w.engine.draft_save("i1", None, &sample_mail("Pat <pat@example.org>", "ana@x.io", "IMAP draft", "v1", ""), None).await.unwrap();
    assert_eq!(w.imap.folder("Drafts").unwrap().msgs.len(), 1);
    let di2 = w.engine.draft_save("i1", Some(&di), &sample_mail("Pat <pat@example.org>", "ana@x.io", "IMAP draft 2", "v2", ""), None).await.unwrap();
    assert_ne!(di, di2);
    assert_eq!(w.imap.folder("Drafts").unwrap().msgs.len(), 1);
    w.engine.draft_delete("i1", &di2).await.unwrap();
    assert!(w.imap.folder("Drafts").unwrap().msgs.is_empty());
}

#[tokio::test]
async fn snooze_mute_block_filters_and_notifications() {
    let w = world().await;
    let id = w.gmail.deliver(&sample_mail("Ana <ana@x.io>", "pat@example.com", "Lunch", "noodles", ""), &["INBOX", "UNREAD"]);
    w.engine.sync_account("g1").await.unwrap();
    let t = w.engine.db.message("g1", &id).unwrap().unwrap().thread_id;
    // Snooze hides it (server loses INBOX), the worker brings it back with INBOX at the top.
    w.engine.snooze("g1", std::slice::from_ref(&t), courier_lib::error::now_ms() + 500).await.unwrap();
    assert!(!w.gmail.message(&id).unwrap().labels.contains(&"INBOX".into()));
    assert!(w.engine.list(&view("g1", "INBOX")).await.unwrap().threads.is_empty());
    assert_eq!(w.engine.list(&view("g1", "SNOOZED")).await.unwrap().threads.len(), 1);
    w.engine.start();
    wait_until(|| w.gmail.message(&id).unwrap().labels.contains(&"INBOX".into()), "unsnoozed").await;
    assert!(w.engine.list(&view("g1", "SNOOZED")).await.unwrap().threads.is_empty());
    assert!(w.rec.notes.lock().iter().any(|(title, _)| title.starts_with("Snoozed")));

    // Mute: later replies skip the inbox.
    w.engine.mute("g1", std::slice::from_ref(&t), true).await.unwrap();
    let parent = w.engine.db.message("g1", &id).unwrap().unwrap().message_id;
    let reply = w.gmail.deliver(&sample_mail("Ana <ana@x.io>", "pat@example.com", "Re: Lunch", "still on?", &format!("In-Reply-To: {parent}\r\n")), &["INBOX", "UNREAD"]);
    w.engine.trigger("g1");
    wait_until(|| !w.gmail.message(&reply).unwrap().labels.contains(&"INBOX".into()), "muted reply archived").await;

    // New mail notifies (Primary), promotions don't.
    w.gmail.deliver(&sample_mail("Bo <bo@x.io>", "pat@example.com", "Ping", "hello", ""), &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
    w.gmail.deliver(&sample_mail("Shop <s@shop.example>", "pat@example.com", "Deals", "buy", ""), &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
    w.engine.trigger("g1");
    wait_until(|| w.rec.notes.lock().iter().any(|(t, _)| t == "Bo"), "notification for Bo").await;
    assert!(!w.rec.notes.lock().iter().any(|(t, _)| t == "Shop"));

    // Block on the mail API = a server filter; IMAP = a local filter that moves to Junk.
    w.engine.block("g1", "spammer@x.io").await.unwrap();
    assert_eq!(w.gmail.state.lock().filters.len(), 1);
    w.engine.unblock("g1", "spammer@x.io").await.unwrap();
    assert!(w.gmail.state.lock().filters.is_empty());
    w.engine.sync_account("i1").await.unwrap();
    w.engine.block("i1", "spammer@x.io").await.unwrap();
    w.imap.deliver("INBOX", &sample_mail("Spam <spammer@x.io>", "pat@example.org", "Win", "prize", ""), &[]);
    w.engine.sync_account("i1").await.unwrap();
    assert_eq!(w.imap.folder("Junk").unwrap().msgs.len(), 1);
    assert!(w.imap.folder("INBOX").unwrap().msgs.is_empty());
}

#[tokio::test]
async fn one_click_unsubscribe_posts_and_refuses_plain_http() {
    let w = world().await;
    // RFC 8058: a POST with the one-click body to the sender's HTTPS link (the local fake stands in for it).
    w.engine.unsubscribe_one_click(&format!("{}/unsubscribe/deals", w.gmail.base())).await.unwrap();
    assert_eq!(w.gmail.state.lock().unsubscribed, vec!["deals".to_string()]);
    // Anything else that isn't HTTPS is refused.
    assert!(w.engine.unsubscribe_one_click("http://deals.example/u/1").await.is_err());
    assert!(w.engine.unsubscribe_one_click("ftp://deals.example/u/1").await.is_err());
}

#[tokio::test]
async fn old_unread_primary_mail_counts_toward_the_inbox() {
    let w = world().await;
    // Older than the window the first sync caches (30 days), still unread in Primary: Gmail counts it.
    let old = b"From: Old Friend <old@x.io>\r\nTo: pat@example.com\r\nSubject: From last spring\r\nDate: Mon, 4 May 2026 09:00:00 -0400\r\nMessage-ID: <old1@test.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nhello\r\n";
    let id = w.gmail.deliver(old, &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
    let promo = b"From: Deals <d@x.io>\r\nTo: pat@example.com\r\nSubject: Old sale\r\nDate: Mon, 4 May 2026 09:00:00 -0400\r\nMessage-ID: <old2@test.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nsale\r\n";
    let promo_id = w.gmail.deliver(promo, &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
    w.engine.sync_account("g1").await.unwrap();
    assert!(w.engine.db.has_message("g1", &id).unwrap(), "old unread Primary mail cached");
    assert!(!w.engine.db.has_message("g1", &promo_id).unwrap(), "old Promotions mail isn't needed for the count");
    let inbox = w.engine.labels_for_nav("g1").unwrap().into_iter().find(|l| l.id == "INBOX").unwrap();
    assert_eq!(inbox.threads_unread, 1);
}

#[tokio::test]
async fn a_burst_of_new_mail_gets_one_summary_and_forums_mail_notifies_while_its_tab_is_off() {
    let w = world().await;
    w.engine.sync_account("g1").await.unwrap(); // first sync: no notifications
    for i in 0..6 {
        w.gmail.deliver(&sample_mail(&format!("P{i} <p{i}@x.io>"), "pat@example.com", &format!("Hello {i}"), "hi", ""), &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
    }
    w.engine.sync_account("g1").await.unwrap();
    let notes = w.rec.notes.lock().clone();
    assert_eq!(notes.len(), 1, "one summary, not six banners: {notes:?}");
    assert_eq!(notes[0].0, "6 new messages");
    // Forums has no tab by default, so its mail is in Primary and notifies.
    w.gmail.deliver(&sample_mail("Club <club@x.io>", "pat@example.com", "Meetup", "Thursday", ""), &["INBOX", "UNREAD", "CATEGORY_FORUMS"]);
    w.engine.sync_account("g1").await.unwrap();
    assert!(w.rec.notes.lock().iter().any(|(t, _)| t == "Club"), "Forums mail notified");
}

#[tokio::test]
async fn new_mail_cached_early_still_notifies() {
    let w = world().await;
    w.engine.sync_account("g1").await.unwrap();
    let id = w.gmail.deliver(&sample_mail("Gil <gil@x.io>", "pat@example.com", "Dinner tonight?", "Around at 7?", ""), &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
    // Something else caches it before the history check runs (the unread backfill of a sync already under way).
    let g = w.engine.gmail("g1").unwrap();
    courier_lib::gmail::backfill_unread_inbox(&g, &w.engine.db, "g1", &[]).await.unwrap();
    assert!(w.engine.db.has_message("g1", &id).unwrap());
    w.engine.sync_account("g1").await.unwrap();
    assert!(w.rec.notes.lock().iter().any(|(t, _)| t == "Gil"), "new mail notified even though it was already cached");
}
