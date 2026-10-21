//! Recon mode (debug builds only, `COURIER_RECON=<address>`): a debug build kept apart from the installed app (its
//! own data folder, log and Keychain item) that signs in only the throwaway recon account, logs how long each mail
//! API request takes, and with `COURIER_RECON_SEED=1` fills that account with invented test mail through
//! messages.insert, with explicit labels, so every count case exists. Nothing is sent and nothing leaves the account.

use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::gmail::Gmail;
use serde_json::{json, Value};
use std::sync::Arc;

pub const SERVICE: &str = "com.milappatel.courier.recon";

/// The recon account's address, when this is a debug build started in recon mode.
pub fn address() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        std::env::var("COURIER_RECON").ok().map(|s| s.trim().to_lowercase()).filter(|s| s.contains('@'))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

pub fn seed_requested() -> bool {
    address().is_some() && std::env::var("COURIER_RECON_SEED").is_ok_and(|v| v == "1")
}

/// Refuses any account but the recon one while in recon mode.
pub fn check_account(email: &str) -> Result<()> {
    match address() {
        Some(a) if !a.eq_ignore_ascii_case(email.trim()) => Err(Error::msg("This test build signs in only the recon account.")),
        _ => Ok(()),
    }
}

/// The installed app's Google sign-in client, read once (read-only) from its Keychain item; macOS asks first.
/// Only the client is taken: the item's other entries are dropped unread.
#[cfg(target_os = "macos")]
pub fn installed_google_client(installed_data_dir: &std::path::Path) -> Option<String> {
    use crate::secrets::RawKeychain;
    let state: Value = serde_json::from_slice(&std::fs::read(installed_data_dir.join("vault.json")).ok()?).ok()?;
    let generation = state["generation"].as_u64()?;
    let bytes = crate::secrets::LoginKeychain::new(crate::secrets::SERVICE).read(&format!("vault-{generation}")).ok()?;
    let map: serde_json::Map<String, Value> = serde_json::from_slice(&bytes).ok()?;
    map.get(crate::secrets::GOOGLE_CLIENT_KEY).and_then(|v| v.as_str()).map(String::from)
}

const CATEGORIES: [(&str, &str, &str); 5] = [
    ("CATEGORY_PERSONAL", "Primary", "Robin Reed <robin@reed.example>"),
    ("CATEGORY_SOCIAL", "Social", "Pinboard Friends <notify@pinboard-friends.example>"),
    ("CATEGORY_PROMOTIONS", "Promotions", "Lakeside Outfitters <deals@lakeside.example>"),
    ("CATEGORY_UPDATES", "Updates", "Northwind Billing <billing@northwind.example>"),
    ("CATEGORY_FORUMS", "Forums", "Hill Walkers List <list@hill-walkers.example>"),
];

/// One count case: a conversation of messages, each `(hours ago, labels)`. `I` Inbox, `U` unread, `S` starred,
/// `P` Important, `L` the Recon/Counts label, `X` Spam, `T` Trash; the category is added to every message.
const CASES: [(&str, &str, &[(i64, &str)]); 13] = [
    ("a", "one message, unread, in the Inbox", &[(2, "IU")]),
    ("b", "one message, read, in the Inbox", &[(5, "I")]),
    ("c", "one message, unread, archived", &[(8, "U")]),
    ("d", "one message, read, archived", &[(11, "")]),
    ("e", "three messages, all unread, in the Inbox", &[(30, "IU"), (29, "IU"), (28, "IU")]),
    ("f", "three messages, the last unread, in the Inbox", &[(50, "I"), (49, "I"), (48, "IU")]),
    ("g", "first unread and archived, reply read in the Inbox", &[(70, "U"), (69, "I")]),
    ("h", "first read in the Inbox, reply unread and archived", &[(90, "I"), (89, "U")]),
    ("i", "45 days old, unread, in the Inbox", &[(45 * 24, "IU")]),
    ("j", "46 days old, unread, archived", &[(46 * 24, "U")]),
    ("k", "47 days old, read, in the Inbox", &[(47 * 24, "I")]),
    ("l", "starred and unread, in the Inbox", &[(120, "IUS")]),
    ("m", "unread in the Inbox and labelled Recon/Counts", &[(140, "IUL")]),
];

/// Cases outside the category grid: `(key, subject, sender, [(hours ago, labels, category)])`.
const EXTRAS: [(&str, &str, &str, &[(i64, &str, &str)]); 9] = [
    (
        "x1",
        "Mixed: Updates first, Promotions reply",
        "Northwind Billing <billing@northwind.example>",
        &[(160, "IU", "CATEGORY_UPDATES"), (159, "I", "CATEGORY_PROMOTIONS")],
    ),
    ("x2", "Important and unread", "Robin Reed <robin@reed.example>", &[(170, "IUP", "CATEGORY_PERSONAL")]),
    ("x3", "Unread in Spam", "Prize Desk <winner@prize-desk.example>", &[(180, "UX", "CATEGORY_UPDATES")]),
    ("x4", "Unread in Trash", "Northwind Billing <billing@northwind.example>", &[(190, "UT", "CATEGORY_UPDATES")]),
    ("x5", "Archived, unread and labelled Recon/Counts", "Northwind Billing <billing@northwind.example>", &[(200, "UL", "CATEGORY_UPDATES")]),
    // Conversations whose first message is older than the 30 days Courier keeps: deleting one must take it all.
    (
        "x6",
        "Long thread: 60-day-old start, new reply",
        "Robin Reed <robin@reed.example>",
        &[(60 * 24, "I", "CATEGORY_PERSONAL"), (3, "IU", "CATEGORY_PERSONAL")],
    ),
    (
        "x7",
        "Long thread in Updates: 50-day-old start, new reply",
        "Northwind Billing <billing@northwind.example>",
        &[(50 * 24, "I", "CATEGORY_UPDATES"), (4, "IU", "CATEGORY_UPDATES")],
    ),
    // Kept for the consistency probe (trashed and put back), not for counting.
    ("p1", "Probe one", "Robin Reed <robin@reed.example>", &[(1, "I", "CATEGORY_PERSONAL")]),
    ("p2", "Probe two", "Northwind Billing <billing@northwind.example>", &[(1, "I", "CATEGORY_UPDATES")]),
];

struct Msg {
    key: String,
    subject: String,
    from: String,
    hours_ago: i64,
    labels: Vec<String>,
}

fn label_ids(flags: &str, category: &str, counts_label: &str) -> Vec<String> {
    let mut out = vec![category.to_string()];
    for f in flags.chars() {
        out.push(
            match f {
                'I' => "INBOX",
                'U' => "UNREAD",
                'S' => "STARRED",
                'P' => "IMPORTANT",
                'X' => "SPAM",
                'T' => "TRASH",
                'L' => counts_label,
                _ => continue,
            }
            .to_string(),
        );
    }
    out
}

/// Every conversation the seed makes, each a list of messages in order.
fn plan(counts_label: &str) -> Vec<Vec<Msg>> {
    let mut threads = Vec::new();
    for (ci, (category, name, from)) in CATEGORIES.iter().enumerate() {
        for (key, what, msgs) in CASES.iter() {
            threads.push(
                msgs.iter()
                    .enumerate()
                    .map(|(n, (h, flags))| Msg {
                        key: format!("{ci}{key}{n}"),
                        subject: format!("{name} {key}: {what}"),
                        from: from.to_string(),
                        hours_ago: *h + ci as i64,
                        labels: label_ids(flags, category, counts_label),
                    })
                    .collect(),
            );
        }
    }
    for (key, subject, from, msgs) in EXTRAS.iter() {
        threads.push(
            msgs.iter()
                .enumerate()
                .map(|(n, (h, flags, category))| Msg {
                    key: format!("{key}{n}"),
                    subject: subject.to_string(),
                    from: from.to_string(),
                    hours_ago: *h,
                    labels: label_ids(flags, category, counts_label),
                })
                .collect(),
        );
    }
    threads
}

fn message_id(key: &str) -> String {
    format!("<recon-{key}@courier.invalid>")
}

fn raw(m: &Msg, to: &str, first: Option<&Msg>, n: usize) -> Vec<u8> {
    let date = chrono::Utc::now() - chrono::Duration::hours(m.hours_ago);
    let subject = if first.is_some() { format!("Re: {}", m.subject) } else { m.subject.clone() };
    let mut h = format!("From: {}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {}\r\nMessage-ID: {}\r\n", m.from, date.to_rfc2822(), message_id(&m.key));
    if let Some(f) = first {
        let id = message_id(&f.key);
        h.push_str(&format!("In-Reply-To: {id}\r\nReferences: {id}\r\n"));
    }
    h.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n");
    h.push_str(&format!("Invented test message {} of this conversation, for checking counts.\r\n", n + 1));
    h.into_bytes()
}

async fn insert(g: &Gmail, raw: &[u8], labels: &[String], thread: Option<&str>) -> Result<Value> {
    let mut body = json!({"raw": crate::gmail::encode_raw(raw), "labelIds": labels});
    if let Some(t) = thread {
        body["threadId"] = json!(t);
    }
    g.post("/messages?internalDateSource=dateHeader", &body).await
}

/// Inserts every planned message that isn't on the server yet (by Message-ID), so it can run again safely.
pub async fn seed(engine: &Arc<Engine>, account: &str) -> Result<usize> {
    let a = engine.db.account(account)?;
    check_account(&a.email)?;
    if address().is_none() {
        return Err(Error::msg("not in recon mode"));
    }
    let g = engine.gmail(account)?;
    let labels = g.labels().await?;
    let counts_label = match labels.iter().find(|l| l["name"] == "Recon/Counts") {
        Some(l) => l["id"].as_str().unwrap_or_default().to_string(),
        None => {
            if !labels.iter().any(|l| l["name"] == "Recon") {
                g.label_create(&json!({"name": "Recon"})).await?;
            }
            g.label_create(&json!({"name": "Recon/Counts"})).await?["id"].as_str().unwrap_or_default().to_string()
        }
    };
    let mut made = 0;
    for thread in plan(&counts_label) {
        let mut thread_id: Option<String> = None;
        for (n, m) in thread.iter().enumerate() {
            let q = format!("rfc822msgid:{} in:anywhere", message_id(&m.key).trim_matches(|c| c == '<' || c == '>'));
            let found = g.messages_list(Some(&q), &[], None, 1).await?;
            if let Some(existing) = found["messages"][0].as_object() {
                thread_id = existing.get("threadId").and_then(|t| t.as_str()).map(String::from);
                continue;
            }
            let bytes = raw(m, &a.email, if n == 0 { None } else { Some(&thread[0]) }, n);
            let v = insert(&g, &bytes, &m.labels, thread_id.as_deref()).await?;
            thread_id = v["threadId"].as_str().map(String::from);
            made += 1;
        }
    }
    crate::applog::info(&format!("{account}: recon seed inserted {made} message(s)"));
    Ok(made)
}

/// Waits for the recon account's first sync, then seeds it (`COURIER_RECON_SEED=1`) and runs the consistency
/// probe (`COURIER_RECON_PROBE=<rounds>`).
pub async fn when_ready(engine: Arc<Engine>) {
    let Some(addr) = address() else { return };
    let rounds: usize = std::env::var("COURIER_RECON_PROBE").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    if !seed_requested() && rounds == 0 {
        return;
    }
    let account = loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let found = engine.db.accounts().unwrap_or_default().into_iter().find(|a| a.kind == "gmail" && a.email.eq_ignore_ascii_case(&addr));
        if let Some(a) = found.filter(|a| a.state["initialSyncDone"] == json!(true)) {
            break a.id;
        }
    };
    if seed_requested() {
        loop {
            match seed(&engine, &account).await {
                Ok(_) => break,
                Err(e) => {
                    crate::applog::warn(&format!("{account}: recon seed failed: {e}"));
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                }
            }
        }
        engine.trigger(&account);
    }
    if rounds > 0 {
        if let Err(e) = probe(&engine, &account, rounds).await {
            crate::applog::warn(&format!("{account}: probe failed: {e}"));
        }
    }
}

/// How long the mail API's listings take to reflect a change, measured on the probe conversations: each is moved
/// to Trash, three listings are polled until it's gone, then it's put back and polled until it returns. Logs
/// times only. `COURIER_RECON_PROBE=<rounds>`.
pub async fn probe(engine: &Arc<Engine>, account: &str, rounds: usize) -> Result<()> {
    let a = engine.db.account(account)?;
    check_account(&a.email)?;
    let g = engine.gmail(account)?;
    for (key, category) in [("p10", "primary"), ("p20", "updates")] {
        let q = format!("rfc822msgid:{} in:anywhere", message_id(key).trim_matches(|c| c == '<' || c == '>'));
        let found = g.messages_list(Some(&q), &[], None, 1).await?;
        let (Some(mid), Some(tid)) = (found["messages"][0]["id"].as_str().map(String::from), found["messages"][0]["threadId"].as_str().map(String::from))
        else {
            crate::applog::warn(&format!("{account}: probe conversation {key} isn't there; seed first"));
            continue;
        };
        let cat_label = format!("CATEGORY_{}", if category == "primary" { "PERSONAL" } else { "UPDATES" }).to_string();
        let listings: [(&str, Vec<String>, String); 3] = [
            ("labelIds=INBOX", vec!["INBOX".into()], String::new()),
            ("labelIds=INBOX q=category", vec!["INBOX".into()], format!("category:{category}")),
            ("labelIds=INBOX+category", vec!["INBOX".into(), cat_label], String::new()),
        ];
        for round in 0..rounds {
            for (step, add, remove, want) in [
                ("trash", vec!["TRASH".to_string()], vec!["INBOX".to_string()], false),
                ("restore", vec!["INBOX".to_string()], vec!["TRASH".to_string()], true),
            ] {
                let t0 = std::time::Instant::now();
                g.batch_modify(&[mid.clone()], &add, &remove).await?;
                let done_ms = t0.elapsed().as_millis();
                let mut settled: Vec<Option<u128>> = vec![None; listings.len()];
                let mut polls = 0;
                while settled.iter().any(|s| s.is_none()) && t0.elapsed() < std::time::Duration::from_secs(30) {
                    polls += 1;
                    for (i, (_, ids, q)) in listings.iter().enumerate() {
                        if settled[i].is_some() {
                            continue;
                        }
                        let v = g.threads_list(ids, Some(q), None, 100, false).await?;
                        let listed = v["threads"].as_array().map(|a| a.iter().any(|t| t["id"] == json!(tid))).unwrap_or(false);
                        if listed == want {
                            settled[i] = Some(t0.elapsed().as_millis());
                        }
                    }
                }
                let parts: Vec<String> = listings
                    .iter()
                    .zip(&settled)
                    .map(|((name, _, _), s)| format!("{name} {}", s.map(|ms| format!("{ms} ms")).unwrap_or("never".into())))
                    .collect();
                crate::applog::info(&format!(
                    "probe {category} round {round} {step}: change took {done_ms} ms; listing agreed after: {} ({polls} polls)",
                    parts.join(", ")
                ));
            }
        }
    }
    Ok(())
}
