//! Provider tests against the local fakes: OAuth + PKCE + refresh, mail API sync (initial + history),
//! drafts, send, labels, IMAP sync / flags / moves / APPEND / IDLE, SMTP, and the Keychain wrapper.

use courier_lib::db::Db;
use courier_lib::gmail::{self, Gmail};
use courier_lib::imap::{self, Security, ServerConfig};
use courier_lib::oauth::{self, ClientCreds, TokenManager};
use courier_lib::secrets::{MemoryStore, SecretStore};
use courier_lib::testsupport::{sample_mail, FakeGmail, FakeImap, FakeSmtp};
use std::sync::Arc;
use std::time::Duration;

fn creds() -> ClientCreds {
    ClientCreds { client_id: "courier-test-client".into(), client_secret: "test-secret".into() }
}

/// The browser step: fetch the authorization URL (the fake approves and redirects to our loopback).
fn fake_browser(http: reqwest::Client) -> impl FnOnce(String) -> courier_lib::error::Result<()> {
    move |url| {
        tokio::spawn(async move {
            let _ = http.get(url).send().await;
        });
        Ok(())
    }
}

async fn signed_in(fake: &FakeGmail, account: &str) -> (Gmail, Arc<MemoryStore>) {
    let http = reqwest::Client::new();
    let auth = oauth::authorize(&http, &fake.endpoints(), &creds(), Some("pat@example.com"), fake_browser(http.clone())).await.expect("authorize");
    let store = Arc::new(MemoryStore::default());
    let tm = TokenManager::new(account, fake.endpoints(), creds(), store.clone(), http.clone());
    tm.save(&auth.tokens).unwrap();
    (Gmail::new(http, Arc::new(tm)), store)
}

#[tokio::test]
async fn oauth_pkce_userinfo_and_token_refresh() {
    let fake = FakeGmail::start("pat@example.com", "Pat Example").await;
    let http = reqwest::Client::new();
    let auth = oauth::authorize(&http, &fake.endpoints(), &creds(), None, fake_browser(http.clone())).await.unwrap();
    assert!(auth.tokens.refresh_token.is_some());
    assert!(auth.redirect_uri.starts_with("http://127.0.0.1:"));
    let info = oauth::userinfo(&http, &fake.endpoints(), &auth.tokens.access_token).await.unwrap();
    assert_eq!(info.email, "pat@example.com");
    assert_eq!(info.name, "Pat Example");

    // A wrong verifier is rejected (PKCE is enforced by the fake).
    let bad = oauth::exchange_code(&http, &fake.endpoints(), &creds(), "code-nope", "verifier", &auth.redirect_uri).await;
    assert!(bad.is_err());

    // Refresh when the access token is near expiry, and after a 401.
    let store = Arc::new(MemoryStore::default());
    let tm = Arc::new(TokenManager::new("acc", fake.endpoints(), creds(), store.clone(), http.clone()));
    let mut t = auth.tokens.clone();
    t.expires_at = 0; // expired
    tm.save(&t).unwrap();
    let g = Gmail::new(http.clone(), tm.clone());
    assert_eq!(g.profile().await.unwrap()["emailAddress"], "pat@example.com");
    assert_eq!(fake.state.lock().refresh_count, 1);
    // Server revokes the current access token → 401 → refresh → retry succeeds.
    fake.state.lock().access.clear();
    assert!(g.labels().await.unwrap().len() >= 10);
    assert_eq!(fake.state.lock().refresh_count, 2);
    // The refreshed tokens were saved in the store.
    assert!(store.get("oauth:acc").unwrap().unwrap().contains("refresh_token"));
    // A revoked refresh token surfaces as an auth error.
    fake.state.lock().refresh.clear();
    fake.state.lock().access.clear();
    let err = g.labels().await.unwrap_err();
    assert!(err.is_auth(), "{err}");
}

#[tokio::test]
async fn gmail_initial_and_incremental_sync() {
    let fake = FakeGmail::start("pat@example.com", "Pat").await;
    let a = fake.deliver(&sample_mail("Ana <ana@x.io>", "pat@example.com", "Lunch on Friday?", "Are you free?", ""), &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
    fake.deliver(&sample_mail("Shop <news@shop.example>", "pat@example.com", "Sale", "Big savings", ""), &["INBOX", "CATEGORY_PROMOTIONS"]);
    let (g, _) = signed_in(&fake, "acc").await;
    let db = Db::open_in_memory().unwrap();
    db.insert_account(&courier_lib::db::AccountRow { id: "acc".into(), kind: "gmail".into(), email: "pat@example.com".into(), color: "#1a73e8".into(), ..Default::default() }).unwrap();
    gmail::initial_sync(&g, &db, "acc", 30, 1000).await.unwrap();
    let m = db.message("acc", &a).unwrap().unwrap();
    assert_eq!(m.subject, "Lunch on Friday?");
    assert!(m.has_raw && m.has("UNREAD"));
    let inbox = db.label("acc", "INBOX").unwrap().unwrap();
    assert_eq!(inbox.threads_total, 2);
    assert_eq!(inbox.threads_unread, 1);

    // New mail + a label change made by "another client" + a deletion arrive through history.
    let reply = sample_mail("Ana <ana@x.io>", "pat@example.com", "Re: Lunch on Friday?", "Noon works", &format!("In-Reply-To: {}\r\nReferences: {}\r\n", m.message_id, m.message_id));
    let b = fake.deliver(&reply, &["INBOX", "UNREAD"]);
    {
        let mut s = fake.state.lock();
        let msg = s.messages.get_mut(&a).unwrap();
        msg.labels.retain(|l| l != "UNREAD");
        msg.labels.push("STARRED".into());
        let m2 = msg.clone();
        s.history_id += 1;
        let hid = s.history_id;
        s.history.push((hid, serde_json::json!({"id": hid.to_string(), "labelsAdded": [{"message": {"id": m2.id, "threadId": m2.thread_id, "labelIds": m2.labels}, "labelIds": ["STARRED"]}]})));
    }
    let rep = gmail::incremental_sync(&g, &db, "acc").await.unwrap();
    assert_eq!(rep.new_messages.len(), 1);
    let rb = db.message("acc", &b).unwrap().unwrap();
    assert_eq!(rb.thread_id, m.thread_id, "reply threads with its parent");
    let ra = db.message("acc", &a).unwrap().unwrap();
    assert!(ra.has("STARRED") && !ra.has("UNREAD"));

    // Expired history ID → NotFound, the caller then runs a full sync.
    fake.state.lock().history_floor = u64::MAX;
    assert!(matches!(gmail::incremental_sync(&g, &db, "acc").await, Err(courier_lib::error::Error::NotFound(_))));
}

#[tokio::test]
async fn gmail_search_pages_threads_and_modify() {
    let fake = FakeGmail::start("pat@example.com", "Pat").await;
    for i in 0..7 {
        fake.deliver(&sample_mail("Ana <ana@x.io>", "pat@example.com", &format!("Report {i}"), "quarterly numbers attached", ""), &["INBOX"]);
    }
    fake.deliver(&sample_mail("Bo <bo@x.io>", "pat@example.com", "Hello", "nothing here", ""), &["INBOX"]);
    let (g, _) = signed_in(&fake, "acc").await;
    let db = Db::open_in_memory().unwrap();
    let (ids, next, est) = gmail::list_page(&g, &db.begin_read("acc"), &[], Some("from:ana quarterly"), None, 5, false).await.unwrap();
    assert_eq!(ids.len(), 5);
    assert_eq!(est, 7);
    let (more, next2, _) = gmail::list_page(&g, &db.begin_read("acc"), &[], Some("from:ana quarterly"), next.as_deref(), 5, false).await.unwrap();
    assert_eq!(more.len(), 2);
    assert!(next2.is_none());
    // Metadata was cached for the list.
    assert_eq!(db.thread_messages("acc", &ids[0]).unwrap()[0].from_email, "ana@x.io");
    // Opening a thread fetches the full message.
    gmail::ensure_thread(&g, &db, "acc", &ids[0]).await.unwrap();
    assert!(db.thread_messages("acc", &ids[0]).unwrap()[0].has_raw);
    // Archive + mark read on the server.
    let mid = db.thread_messages("acc", &ids[0]).unwrap()[0].id.clone();
    g.batch_modify(std::slice::from_ref(&mid), &[], &["INBOX".into()]).await.unwrap();
    assert!(!fake.message(&mid).unwrap().labels.contains(&"INBOX".into()));
    g.thread_trash(&ids[1]).await.unwrap();
    let (trash, _, _) = gmail::list_page(&g, &db.begin_read("acc"), &["TRASH".into()], None, None, 50, true).await.unwrap();
    assert_eq!(trash, vec![ids[1].clone()]);
}

#[tokio::test]
async fn gmail_drafts_send_and_labels() {
    let fake = FakeGmail::start("pat@example.com", "Pat").await;
    let (g, _) = signed_in(&fake, "acc").await;
    let db = Db::open_in_memory().unwrap();
    let raw1 = sample_mail("Pat <pat@example.com>", "ana@x.io", "Draft v1", "first", "");
    let d = g.draft_create(&raw1, None).await.unwrap();
    let did = d["id"].as_str().unwrap().to_string();
    let raw2 = sample_mail("Pat <pat@example.com>", "ana@x.io", "Draft v2", "second", "");
    let d2 = g.draft_update(&did, &raw2, None).await.unwrap();
    assert_ne!(d["message"]["id"], d2["message"]["id"]);
    gmail::sync_drafts(&g, &db, "acc").await.unwrap();
    let (mid, _) = db.draft_message("acc", &did).unwrap().unwrap();
    assert_eq!(db.message("acc", &mid).unwrap().unwrap().subject, "Draft v2");
    g.draft_delete(&did).await.unwrap();
    gmail::sync_drafts(&g, &db, "acc").await.unwrap();
    assert!(db.draft_message("acc", &did).unwrap().is_none());

    let sent = g.send(&sample_mail("Pat <pat@example.com>", "ana@x.io", "Hi", "hello", ""), None).await.unwrap();
    assert!(sent["labelIds"].as_array().unwrap().iter().any(|l| l == "SENT"));
    assert_eq!(fake.state.lock().sent.len(), 1);

    let l = g.label_create(&serde_json::json!({"name": "Projects/Alpha", "color": {"backgroundColor": "#16a766", "textColor": "#ffffff"}})).await.unwrap();
    let id = l["id"].as_str().unwrap().to_string();
    g.label_patch(&id, &serde_json::json!({"name": "Projects/Beta"})).await.unwrap();
    gmail::refresh_labels(&g, &db, "acc").await.unwrap();
    assert_eq!(db.label("acc", &id).unwrap().unwrap().name, "Projects/Beta");
    g.label_delete(&id).await.unwrap();
    gmail::refresh_labels(&g, &db, "acc").await.unwrap();
    assert!(db.label("acc", &id).unwrap().is_none());
    // People API contacts.
    assert!(gmail::sync_people(&g, &db, "acc").await.unwrap() >= 2);
    assert_eq!(db.search_contacts(None, "dana", 5).unwrap()[0].email, "dana@contacts.example");
}

fn imap_cfg(fake: &FakeImap) -> ServerConfig {
    ServerConfig { host: "127.0.0.1".into(), port: fake.addr.port(), security: Security::Plain, username: "pat@example.org".into() }
}

#[tokio::test]
async fn imap_sync_flags_moves_append_and_idle() {
    let fake = FakeImap::start("pat@example.org", "app-password").await;
    let parent = sample_mail("Ana <ana@x.io>", "pat@example.org", "Trip plans", "Let's go", "");
    fake.deliver("INBOX", &parent, &[]);
    fake.deliver("INBOX", &sample_mail("Bo <bo@x.io>", "pat@example.org", "Invoice", "€240 due", ""), &["\\Seen", "\\Flagged"]);
    // Wrong password → auth error.
    let bad = imap::connect(&imap_cfg(&fake), "nope").await;
    assert!(matches!(bad, Err(e) if e.is_auth()));
    let mut s = imap::connect(&imap_cfg(&fake), "app-password").await.unwrap();
    let db = Db::open_in_memory().unwrap();
    let r = imap::sync_all(&mut s, &db, "acc", 500).await.unwrap();
    assert_eq!(r.new_messages.len(), 2);
    let labels: Vec<String> = db.labels("acc").unwrap().into_iter().map(|l| l.id).collect();
    for want in ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "ALL"] {
        assert!(labels.contains(&want.to_string()), "{want} in {labels:?}");
    }
    let inv = db.messages_where("acc", "m.subject = 'Invoice'", vec![], 1).unwrap().remove(0);
    assert!(inv.has("STARRED") && !inv.has("UNREAD"));
    let trip = db.messages_where("acc", "m.subject = 'Trip plans'", vec![], 1).unwrap().remove(0);
    assert!(trip.has("UNREAD"));

    // A reply delivered later joins the thread by references.
    let pid = courier_lib::mailmeta::parse_raw(&parent).row.message_id;
    fake.deliver("INBOX", &sample_mail("Ana <ana@x.io>", "pat@example.org", "Re: Trip plans", "Booked", &format!("In-Reply-To: {pid}\r\n")), &[]);
    let info = imap::sync_folder_list(&mut s, &db, "acc").await.unwrap();
    let inbox = info.iter().find(|i| i.label_id == "INBOX").unwrap();
    let r2 = imap::sync_folder(&mut s, &db, "acc", inbox, 500).await.unwrap();
    assert_eq!(r2.new_messages.len(), 1);
    assert_eq!(r2.new_messages[0].thread_id, trip.thread_id);

    // Flags changed on the server are picked up; moves reconcile both folders.
    let (_, _, uid) = imap::parse_message_id(&trip.id).unwrap();
    imap::store_flags(&mut s, "INBOX", &[uid], true, "\\Seen").await.unwrap();
    imap::sync_folder(&mut s, &db, "acc", inbox, 500).await.unwrap();
    assert!(!db.message("acc", &trip.id).unwrap().unwrap().has("UNREAD"));
    imap::move_uids(&mut s, "INBOX", &[uid], "Archive").await.unwrap();
    imap::sync_all(&mut s, &db, "acc", 500).await.unwrap();
    assert!(db.message("acc", &trip.id).unwrap().is_none());
    let archived = db.messages_where("acc", "m.labels LIKE '% ALL %'", vec![], 5).unwrap();
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].thread_id, trip.thread_id, "the archived copy keeps its conversation");

    // APPEND to Sent, then find it by Message-ID.
    let sent = sample_mail("Pat <pat@example.org>", "ana@x.io", "Sent copy", "hi", "");
    imap::append(&mut s, "Sent", "(\\Seen)", &sent).await.unwrap();
    let mid = courier_lib::mailmeta::parse_raw(&sent).row.message_id;
    assert!(imap::find_by_message_id(&mut s, "Sent", &mid).await.unwrap().is_some());

    // Folders as labels: create, rename, delete.
    imap::create_folder(&mut s, "Receipts").await.unwrap();
    imap::rename_folder(&mut s, "Receipts", "Receipts 2026").await.unwrap();
    imap::sync_folder_list(&mut s, &db, "acc").await.unwrap();
    assert!(db.label("acc", "F:Receipts 2026").unwrap().is_some());
    imap::delete_folder(&mut s, "Receipts 2026").await.unwrap();
    imap::sync_folder_list(&mut s, &db, "acc").await.unwrap();
    assert!(db.label("acc", "F:Receipts 2026").unwrap().is_none());

    // IDLE wakes up on new mail.
    let idle_sess = imap::connect(&imap_cfg(&fake), "app-password").await.unwrap();
    let (_tx, mut rx) = tokio::sync::watch::channel(false);
    let f2 = fake.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        f2.deliver("INBOX", &sample_mail("Cy <cy@x.io>", "pat@example.org", "Ping", "new", ""), &[]);
    });
    let (_s, changed) = tokio::time::timeout(Duration::from_secs(10), imap::idle_once(idle_sess, Duration::from_secs(8), &mut rx)).await.unwrap().unwrap();
    assert!(changed, "IDLE reported the new message");
}

#[tokio::test]
async fn smtp_send_with_auth() {
    let smtp = FakeSmtp::start("pat@example.org", "app-password").await;
    let cfg = ServerConfig { host: "127.0.0.1".into(), port: smtp.addr.port(), security: Security::Plain, username: "pat@example.org".into() };
    imap::smtp_test(&cfg, "app-password").await.unwrap();
    let raw = sample_mail("Pat <pat@example.org>", "ana@x.io", "Hello", "line\r\n.starts with a dot", "");
    imap::smtp_send(&cfg, "app-password", "pat@example.org", &["ana@x.io".into(), "bcc@x.io".into()], &raw).await.unwrap();
    let sent = smtp.sent.lock().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].rcpts, vec!["ana@x.io", "bcc@x.io"]);
    assert!(String::from_utf8_lossy(&sent[0].data).contains(".starts with a dot"));
    let bad = imap::smtp_send(&cfg, "wrong", "pat@example.org", &["ana@x.io".into()], &raw).await;
    assert!(bad.is_err());
}

#[test]
fn keychain_wrapper_round_trip() {
    let mem = MemoryStore::default();
    mem.set("k", "v").unwrap();
    assert_eq!(mem.get("k").unwrap().as_deref(), Some("v"));
    mem.delete("k").unwrap();
    assert_eq!(mem.get("k").unwrap(), None);
    #[cfg(target_os = "macos")]
    {
        // Real Keychain through the vault, under a throwaway service name (made and removed by this test binary,
        // so macOS never asks); the vault's state file goes to a temp folder.
        use courier_lib::secrets::{LoginKeychain, SecretStore, VaultStore};
        let service = format!("com.milappatel.courier.test.{}", courier_lib::error::random_token(6));
        let dir = std::env::temp_dir().join(format!("courier-vault-live-{}", courier_lib::error::random_token(6)));
        let open = || VaultStore::new(Box::new(LoginKeychain::new(service.clone())), dir.join("vault.json"), "test-build", vec![]);
        let v = open();
        match v.set("oauth:test", "{\"refresh_token\":\"x\"}") {
            Ok(()) => {
                v.set("google-client", "client").unwrap();
                // Its own item reads fine with prompts switched off.
                use courier_lib::secrets::RawKeychain;
                assert!(LoginKeychain::new(service.clone()).read_quiet("vault-1").is_ok());
                let again = open();
                assert_eq!(again.get("oauth:test").unwrap().as_deref(), Some("{\"refresh_token\":\"x\"}"));
                assert_eq!(again.get("google-client").unwrap().as_deref(), Some("client"));
                assert_eq!(again.notice(), None);
                again.delete("oauth:test").unwrap();
                again.delete("google-client").unwrap();
                assert_eq!(open().get("oauth:test").unwrap(), None);
                // Clean up the (now empty) vault item.
                LoginKeychain::new(service.clone()).remove("vault-1").unwrap();
            }
            Err(e) => eprintln!("Keychain not available in this environment, skipped the live part: {e}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
