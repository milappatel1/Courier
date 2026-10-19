//! The engine: one place that knows every account. It dispatches actions to the mail API or IMAP, lists
//! views from the cache (or the server for API accounts), runs a sync loop per account (history / UID
//! sync, IMAP IDLE), and runs the outbox (undo send, scheduled send, offline retry) and snooze workers.

use crate::db::{AccountRow, Db, ListFilter, OutboxRow, ThreadSummary};
use crate::error::{now_ms, Error, Result};
use crate::gmail::{self, Gmail};
use crate::imap::{self, ImapAccountConfig, Session};
use crate::oauth::{ClientCreds, Endpoints, TokenManager};
use crate::search;
use crate::secrets::{self, SecretStore};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Notify};

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

pub trait Notifier: Send + Sync {
    fn notify(&self, title: &str, body: &str, account_id: &str, thread_id: &str);
}

/// Opens URLs in the browser (OAuth sign-in, unsubscribe pages).
pub trait Opener: Send + Sync {
    fn open(&self, url: &str) -> Result<()>;
}

pub struct ImapAccount {
    pub id: String,
    pub email: String,
    pub cfg: ImapAccountConfig,
    pub password: String,
    pub smtp_password: String,
    pub session: tokio::sync::Mutex<Option<Session>>,
}

impl ImapAccount {
    pub async fn session(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Session>>> {
        let mut g = self.session.lock().await;
        if g.is_none() {
            *g = Some(imap::connect(&self.cfg.imap, &self.password).await?);
        }
        Ok(g)
    }
}

struct Runtime {
    trigger: Arc<Notify>,
    stop: watch::Sender<bool>,
}

pub struct Engine {
    pub db: Arc<Db>,
    pub secrets: Arc<dyn SecretStore>,
    pub http: reqwest::Client,
    pub events: Arc<dyn EventSink>,
    pub notifier: Arc<dyn Notifier>,
    pub opener: Arc<dyn Opener>,
    pub badge: Arc<dyn Fn(i64) + Send + Sync>,
    /// Endpoints new mail-API accounts sign in with (the fakes in end-to-end runs).
    pub google_endpoints: RwLock<Endpoints>,
    pub online: AtomicBool,
    runtimes: Mutex<HashMap<String, Runtime>>,
    gmail: Mutex<HashMap<String, Arc<Gmail>>>,
    imap: Mutex<HashMap<String, Arc<ImapAccount>>>,
    pub sync_interval: RwLock<Duration>,
    outbox_kick: Notify,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewQuery {
    pub account_id: String, // or "all"
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub page: i64,
    #[serde(default = "page_size")]
    pub page_size: i64,
    #[serde(default)]
    pub page_token: Option<String>,
    /// "cache" (fast, local) or "server" (authoritative for API accounts when online).
    #[serde(default)]
    pub mode: Option<String>,
    /// false = one row per message (conversation view off).
    #[serde(default = "yes")]
    pub conversations: bool,
}

fn page_size() -> i64 {
    50
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewResult {
    pub threads: Vec<ThreadSummary>,
    pub total: i64,
    pub estimate: bool,
    pub has_more: bool,
    pub next_page_token: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub kind: String,
    pub email: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub photo: Option<String>,
    pub needs_reauth: bool,
    pub aliases: Vec<String>,
    pub config: Value,
}

pub fn account_info(a: &AccountRow) -> AccountInfo {
    let aliases = a.state["aliases"].as_array().map(|x| x.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let mut config = a.config.clone();
    // Never hand server passwords or tokens to the web view (they aren't in config anyway).
    if let Some(o) = config.as_object_mut() {
        o.remove("password");
    }
    AccountInfo { id: a.id.clone(), kind: a.kind.clone(), email: a.email.clone(), name: a.name.clone(), color: a.color.clone(), position: a.position, photo: a.photo.clone(), needs_reauth: a.needs_reauth, aliases, config }
}

struct Labels(Vec<crate::db::LabelRow>);

impl search::LabelResolver for Labels {
    fn resolve(&self, key: &str) -> Vec<String> {
        self.0
            .iter()
            .filter(|l| {
                let k = search::label_key(&l.name);
                k == key || k.starts_with(&format!("{key}-")) || search::label_key(&l.id) == key
            })
            .map(|l| l.id.clone())
            .collect()
    }
}

const CATEGORY_LABELS: &[(&str, &str)] = &[("social", "CATEGORY_SOCIAL"), ("promotions", "CATEGORY_PROMOTIONS"), ("updates", "CATEGORY_UPDATES"), ("forums", "CATEGORY_FORUMS")];

impl Engine {
    pub fn new(db: Arc<Db>, secrets: Arc<dyn SecretStore>, events: Arc<dyn EventSink>, notifier: Arc<dyn Notifier>, opener: Arc<dyn Opener>, badge: Arc<dyn Fn(i64) + Send + Sync>) -> Arc<Engine> {
        let http = reqwest::Client::builder().user_agent("Courier/1.0").timeout(Duration::from_secs(60)).connect_timeout(Duration::from_secs(15)).build().expect("http client");
        Arc::new(Engine {
            db,
            secrets,
            http,
            events,
            notifier,
            opener,
            badge,
            google_endpoints: RwLock::new(Endpoints::default()),
            online: AtomicBool::new(true),
            runtimes: Mutex::new(HashMap::new()),
            gmail: Mutex::new(HashMap::new()),
            imap: Mutex::new(HashMap::new()),
            sync_interval: RwLock::new(Duration::from_secs(60)),
            outbox_kick: Notify::new(),
        })
    }

    pub fn emit(&self, event: &str, payload: Value) {
        self.events.emit(event, payload);
    }

    fn changed(&self, account: &str, reason: &str) {
        self.emit("mail-changed", json!({"accountId": account, "reason": reason}));
        self.refresh_badge();
    }

    pub fn refresh_badge(&self) {
        let cfg = self.db.kv_get("badge").ok().flatten().unwrap_or(json!({"enabled": true, "primaryOnly": true}));
        let n = if cfg["enabled"].as_bool().unwrap_or(true) { self.db.unread_inbox_total(cfg["primaryOnly"].as_bool().unwrap_or(true)).unwrap_or(0) } else { 0 };
        (self.badge)(n);
    }

    fn set_online(&self, on: bool) {
        let was = self.online.swap(on, Ordering::SeqCst);
        if was != on {
            self.emit("online", json!({"online": on}));
            if on {
                self.outbox_kick.notify_one();
            }
        }
    }

    pub fn google_client(&self) -> Result<ClientCreds> {
        let raw = self.secrets.get(secrets::GOOGLE_CLIENT_KEY)?.ok_or_else(|| Error::msg("Set up Google sign-in first (Settings ▸ Accounts)."))?;
        Ok(serde_json::from_str(&raw)?)
    }

    // ---- providers ----

    pub fn kind(&self, account: &str) -> Result<String> {
        Ok(self.db.account(account)?.kind)
    }

    pub fn gmail(&self, account: &str) -> Result<Arc<Gmail>> {
        if let Some(g) = self.gmail.lock().get(account) {
            return Ok(g.clone());
        }
        let a = self.db.account(account)?;
        let ep: Endpoints = serde_json::from_value(a.config["endpoints"].clone()).unwrap_or_else(|_| self.google_endpoints.read().clone());
        let tm = TokenManager::new(account, ep, self.google_client()?, self.secrets.clone(), self.http.clone());
        let g = Arc::new(Gmail::new(self.http.clone(), Arc::new(tm)));
        self.gmail.lock().insert(account.into(), g.clone());
        Ok(g)
    }

    pub fn imap_account(&self, account: &str) -> Result<Arc<ImapAccount>> {
        if let Some(a) = self.imap.lock().get(account) {
            return Ok(a.clone());
        }
        let a = self.db.account(account)?;
        let cfg: ImapAccountConfig = serde_json::from_value(a.config.clone()).map_err(|e| Error::msg(format!("account settings: {e}")))?;
        let password = self.secrets.get(&secrets::password_key(account))?.ok_or_else(|| Error::Auth("Enter the password again.".into()))?;
        let smtp_password = self.secrets.get(&secrets::smtp_password_key(account))?.unwrap_or_else(|| password.clone());
        let acc = Arc::new(ImapAccount { id: account.into(), email: a.email.clone(), cfg, password, smtp_password, session: tokio::sync::Mutex::new(None) });
        self.imap.lock().insert(account.into(), acc.clone());
        Ok(acc)
    }

    pub fn forget_provider(&self, account: &str) {
        self.gmail.lock().remove(account);
        self.imap.lock().remove(account);
    }

    // ---- lifecycle ----

    pub fn start(self: &Arc<Self>) {
        let _ = self.db.outbox_reset_sending();
        for a in self.db.accounts().unwrap_or_default() {
            self.start_account(&a.id);
        }
        let e = self.clone();
        tokio::spawn(async move { e.outbox_loop().await });
        let e = self.clone();
        tokio::spawn(async move { e.snooze_loop().await });
        self.refresh_badge();
    }

    pub fn start_account(self: &Arc<Self>, account: &str) {
        let (tx, rx) = watch::channel(false);
        let trigger = Arc::new(Notify::new());
        if let Some(old) = self.runtimes.lock().insert(account.into(), Runtime { trigger: trigger.clone(), stop: tx }) {
            let _ = old.stop.send(true);
        }
        let e = self.clone();
        let id = account.to_string();
        let t = trigger.clone();
        let rx2 = rx.clone();
        tokio::spawn(async move { e.sync_loop(id, t, rx2).await });
        if self.kind(account).map(|k| k == "imap").unwrap_or(false) {
            let e = self.clone();
            let id = account.to_string();
            tokio::spawn(async move { e.idle_loop(id, trigger, rx).await });
        }
    }

    pub fn stop_account(&self, account: &str) {
        if let Some(r) = self.runtimes.lock().remove(account) {
            let _ = r.stop.send(true);
        }
        self.forget_provider(account);
    }

    pub fn trigger(&self, account: &str) {
        if let Some(r) = self.runtimes.lock().get(account) {
            r.trigger.notify_one();
        }
    }

    pub fn trigger_all(&self) {
        for r in self.runtimes.lock().values() {
            r.trigger.notify_one();
        }
    }

    /// After waking from sleep: drop IMAP connections (they're dead) and sync everything.
    pub fn on_wake(&self) {
        for a in self.imap.lock().values() {
            if let Ok(mut g) = a.session.try_lock() {
                *g = None;
            }
        }
        self.trigger_all();
        self.outbox_kick.notify_one();
    }

    async fn sync_loop(self: Arc<Self>, account: String, trigger: Arc<Notify>, mut stop: watch::Receiver<bool>) {
        let mut first = true;
        let mut backoff = Duration::from_secs(15);
        loop {
            if !first {
                let wait = if self.online.load(Ordering::SeqCst) { *self.sync_interval.read() } else { backoff };
                tokio::select! {
                    _ = trigger.notified() => {}
                    _ = tokio::time::sleep(wait) => {}
                    _ = stop.changed() => return,
                }
            }
            first = false;
            if *stop.borrow() {
                return;
            }
            self.emit("sync-status", json!({"accountId": account, "state": "syncing"}));
            match self.sync_account(&account).await {
                Ok(()) => {
                    self.set_online(true);
                    backoff = Duration::from_secs(15);
                    self.emit("sync-status", json!({"accountId": account, "state": "idle"}));
                }
                Err(e) if e.is_offline() => {
                    self.set_online(false);
                    backoff = (backoff * 2).min(Duration::from_secs(120));
                    self.emit("sync-status", json!({"accountId": account, "state": "offline"}));
                }
                Err(e) if e.is_auth() => {
                    let _ = self.db.set_needs_reauth(&account, true);
                    self.emit("sync-status", json!({"accountId": account, "state": "auth", "error": e.to_string()}));
                    self.emit("accounts-changed", json!({}));
                    // Wait for a re-sign-in (which restarts the runtime).
                    let _ = stop.changed().await;
                    return;
                }
                Err(Error::NotFound(_)) => {}
                Err(e) => {
                    self.emit("sync-status", json!({"accountId": account, "state": "error", "error": e.to_string()}));
                }
            }
        }
    }

    async fn idle_loop(self: Arc<Self>, account: String, trigger: Arc<Notify>, mut stop: watch::Receiver<bool>) {
        loop {
            if *stop.borrow() {
                return;
            }
            let acc = match self.imap_account(&account) {
                Ok(a) => a,
                Err(_) => return,
            };
            match imap::connect(&acc.cfg.imap, &acc.password).await {
                Ok(mut s) => loop {
                    match imap::idle_once(s, Duration::from_secs(20 * 60), &mut stop).await {
                        Ok((next, changed)) => {
                            if changed {
                                trigger.notify_one();
                            }
                            if *stop.borrow() {
                                return;
                            }
                            s = next;
                        }
                        Err(_) => break,
                    }
                },
                Err(_) => {}
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                _ = stop.changed() => return,
            }
        }
    }

    /// One sync step for an account (initial window first time, then incremental).
    pub async fn sync_account(&self, account: &str) -> Result<()> {
        let a = self.db.account(account)?;
        let days = self.db.kv_get("offline").ok().flatten().and_then(|v| v["days"].as_u64()).unwrap_or(30) as u32;
        let new_messages = if a.kind == "gmail" {
            let g = self.gmail(account)?;
            if a.state["initialSyncDone"].as_bool() != Some(true) {
                gmail::initial_sync(&g, &self.db, account, days, 2000).await?;
                self.changed(account, "sync");
                self.refresh_aliases(account).await.ok();
                if gmail::sync_people(&g, &self.db, account).await.is_ok() {
                    self.db.set_account_state(account, "peopleSynced", json!(now_ms()))?;
                }
                vec![]
            } else {
                match gmail::incremental_sync(&g, &self.db, account).await {
                    Ok(r) => {
                        if r.changed {
                            self.changed(account, "sync");
                        }
                        r.new_messages
                    }
                    Err(Error::NotFound(_)) => {
                        self.db.set_account_state(account, "initialSyncDone", json!(false))?;
                        gmail::initial_sync(&g, &self.db, account, days, 2000).await?;
                        self.changed(account, "resync");
                        vec![]
                    }
                    Err(e) => return Err(e),
                }
            }
        } else {
            let acc = self.imap_account(account)?;
            let first = a.state["initialSyncDone"].as_bool() != Some(true);
            let mut g = acc.session().await?;
            let r = imap::sync_all(g.as_mut().unwrap(), &self.db, account, acc.cfg.initial_window).await;
            let r = match r {
                Ok(r) => r,
                Err(e) => {
                    *g = None;
                    return Err(e);
                }
            };
            drop(g);
            if first {
                self.db.set_account_state(account, "initialSyncDone", json!(true))?;
            }
            if r.changed {
                self.changed(account, "sync");
            }
            if first { vec![] } else { r.new_messages }
        };
        if !new_messages.is_empty() {
            self.after_new_mail(account, &a, new_messages).await;
        }
        Ok(())
    }

    async fn refresh_aliases(&self, account: &str) -> Result<()> {
        let g = self.gmail(account)?;
        let v = g.get("/settings/sendAs", &[]).await?;
        let list: Vec<String> = v["sendAs"].as_array().map(|a| a.iter().filter(|x| x["verificationStatus"] != "pending").filter_map(|x| x["sendAsEmail"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        self.db.set_account_state(account, "aliases", json!(list))?;
        Ok(())
    }

    /// New mail: contacts, muted threads, local filters (IMAP), notifications.
    async fn after_new_mail(&self, account: &str, a: &AccountRow, msgs: Vec<crate::db::MessageRow>) {
        let me = a.email.to_lowercase();
        let mut notify = Vec::new();
        for m in &msgs {
            if !m.from_email.is_empty() && m.from_email.to_lowercase() != me {
                let _ = self.db.touch_contact(account, &m.from_email, &m.from_name, false, m.internal_date);
            }
            if m.has("INBOX") && self.db.is_muted(account, &m.thread_id).unwrap_or(false) {
                let _ = self.modify_messages(account, std::slice::from_ref(&m.id), &[], &["INBOX".into()]).await;
                continue;
            }
            if a.kind == "imap" && m.has("INBOX") {
                if self.apply_local_filters(account, m).await.unwrap_or(false) {
                    continue;
                }
            }
            if m.has("INBOX") && m.has("UNREAD") && m.from_email.to_lowercase() != me {
                notify.push(m.clone());
            }
        }
        let settings = self.db.kv_get("notifications").ok().flatten().unwrap_or(json!({"mode": "all"}));
        let mode = settings["mode"].as_str().unwrap_or("all");
        let account_on = settings["accounts"][account].as_bool().unwrap_or(true);
        if mode == "off" || !account_on {
            return;
        }
        let label_rules = settings["labels"][account].as_object().cloned().unwrap_or_default();
        for m in notify {
            let primary = !m.labels.iter().any(|l| CATEGORY_LABELS.iter().any(|(_, id)| id == l));
            let important = m.has("IMPORTANT");
            let by_label = m.labels.iter().any(|l| label_rules.get(l).and_then(|v| v.as_bool()).unwrap_or(false));
            let ok = match mode {
                "important" => important || by_label,
                _ => primary || by_label,
            };
            if ok {
                let who = if m.from_name.is_empty() { m.from_email.clone() } else { m.from_name.clone() };
                let body = if m.subject.is_empty() { m.snippet.clone() } else { format!("{}\n{}", m.subject, m.snippet) };
                self.notifier.notify(&who, &body, account, &m.thread_id);
            }
        }
        self.emit("new-mail", json!({"accountId": account, "count": msgs.len()}));
    }

    /// Local filters for IMAP accounts (criteria → query; actions → label/move/flags). Returns true when
    /// the message left the inbox.
    async fn apply_local_filters(&self, account: &str, m: &crate::db::MessageRow) -> Result<bool> {
        let filters = self.db.local_filters(account)?;
        if filters.is_empty() {
            return Ok(false);
        }
        let s = searchable(&self.db, account, m);
        let mut left_inbox = false;
        for f in filters {
            let q = criteria_query(&f["criteria"]);
            if q.trim().is_empty() || !search::matches(&q, &s, now_ms()) {
                continue;
            }
            let add: Vec<String> = f["action"]["addLabelIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let remove: Vec<String> = f["action"]["removeLabelIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if remove.contains(&"INBOX".to_string()) || add.iter().any(|l| l == "TRASH" || l == "SPAM") {
                left_inbox = true;
            }
            self.modify_messages(account, std::slice::from_ref(&m.id), &add, &remove).await?;
        }
        Ok(left_inbox)
    }

    // ---- listing ----

    fn filter_for(&self, account: &str, v: &ViewQuery) -> Result<(ListFilter, bool)> {
        let label = v.label.clone().unwrap_or_default();
        let mut parts: Vec<String> = Vec::new();
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        let mut exclude_trash_spam = true;
        let mut exclude_snoozed = false;
        let has = |id: &str, parts: &mut Vec<String>, params: &mut Vec<rusqlite::types::Value>| {
            parts.push("m.labels LIKE ?".into());
            params.push(format!("% {id} %").into());
        };
        match label.as_str() {
            "" => {}
            "ALL" => parts.push("m.labels NOT LIKE '% DRAFT %' OR m.labels LIKE '% SENT %'".into()),
            "INBOX" => {
                has("INBOX", &mut parts, &mut params);
                exclude_snoozed = true;
            }
            "TRASH" | "SPAM" => {
                has(&label, &mut parts, &mut params);
                exclude_trash_spam = false;
            }
            other => has(other, &mut parts, &mut params),
        }
        if let Some(cat) = v.category.as_deref().filter(|c| !c.is_empty()) {
            let enabled = self.enabled_categories();
            if cat == "primary" {
                let others: Vec<String> = CATEGORY_LABELS.iter().filter(|(k, _)| enabled.contains(&k.to_string())).map(|(_, id)| format!("m.labels LIKE '% {id} %'")).collect();
                if !others.is_empty() {
                    parts.push(format!("NOT ({})", others.join(" OR ")));
                }
            } else if let Some((_, id)) = CATEGORY_LABELS.iter().find(|(k, _)| *k == cat) {
                parts.push(format!("m.labels LIKE '% {id} %'"));
            }
        }
        let mut mentions = false;
        if let Some(q) = v.query.as_deref().filter(|q| !q.trim().is_empty()) {
            if let Some(node) = search::parse(q) {
                mentions = search::mentions_spam_trash(&node);
                let sql = search::compile(&node, &Labels(self.db.labels(account)?), now_ms());
                parts.push(sql.clause);
                params.extend(sql.params);
                if mentions {
                    exclude_trash_spam = false;
                }
            }
        }
        let clause = parts.iter().map(|p| format!("({p})")).collect::<Vec<_>>().join(" AND ");
        Ok((ListFilter { clause, params, exclude_trash_spam, exclude_snoozed }, !exclude_trash_spam || mentions))
    }

    pub fn enabled_categories(&self) -> Vec<String> {
        self.db
            .kv_get("categories")
            .ok()
            .flatten()
            .and_then(|v| v.as_object().map(|o| o.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect()))
            .unwrap_or_else(|| vec!["promotions".into(), "social".into(), "updates".into()])
    }

    fn local_list(&self, account: &str, v: &ViewQuery, offset: i64, limit: i64) -> Result<(Vec<ThreadSummary>, i64)> {
        let label = v.label.clone().unwrap_or_default();
        if label == "SNOOZED" {
            let ids = self.db.snoozed_thread_ids(account)?;
            let total = ids.len() as i64;
            let page: Vec<(String, i64)> = ids.into_iter().skip(offset as usize).take(limit as usize).collect();
            return Ok((self.db.thread_summaries(account, &page, false)?, total));
        }
        if label == "SCHEDULED" || label == "OUTBOX" {
            let rows: Vec<OutboxRow> = self.db.outbox()?.into_iter().filter(|r| r.account_id == account && (r.scheduled == (label == "SCHEDULED"))).collect();
            let total = rows.len() as i64;
            let threads = rows.into_iter().skip(offset as usize).take(limit as usize).map(|r| outbox_summary(&r)).collect();
            return Ok((threads, total));
        }
        let (f, in_trash) = self.filter_for(account, v)?;
        if v.conversations {
            let (ids, total) = self.db.list_thread_ids(account, &f, offset, limit)?;
            Ok((self.db.thread_summaries(account, &ids, in_trash)?, total))
        } else {
            // One row per message: list message ids, summarise each on its own.
            let mut q = f.clone();
            if q.clause.is_empty() {
                q.clause = "1".into();
            }
            let rows = self.db.messages_where(account, &format!("({}){}{}", q.clause, if q.exclude_trash_spam { " AND m.labels NOT LIKE '% TRASH %' AND m.labels NOT LIKE '% SPAM %'" } else { "" }, if q.exclude_snoozed { " AND m.thread_id NOT IN (SELECT thread_id FROM snoozes s WHERE s.account_id = m.account_id)" } else { "" }), q.params.clone(), offset + limit + 1)?;
            let total = rows.len() as i64;
            let mut out = Vec::new();
            for m in rows.into_iter().skip(offset as usize).take(limit as usize) {
                let mut s = self.db.thread_summaries(account, &[(m.thread_id.clone(), m.internal_date)], in_trash)?.pop().unwrap_or_default();
                s.thread_id = m.thread_id.clone();
                s.subject = m.subject.clone();
                s.snippet = m.snippet.clone();
                s.last_date = m.internal_date;
                s.message_count = 1;
                s.unread = m.has("UNREAD");
                s.starred = m.has("STARRED");
                s.important = m.has("IMPORTANT");
                s.labels = m.labels.clone();
                s.participants = vec![crate::db::Participant { name: m.from_name.clone(), email: m.from_email.clone(), unread: m.has("UNREAD"), draft: m.has("DRAFT") }];
                s.has_attachments = !m.attachments.is_empty();
                s.attachments = m.attachments.clone();
                s.message_ids = vec![m.id.clone()];
                out.push(s);
            }
            Ok((out, total))
        }
    }

    pub async fn list(&self, v: &ViewQuery) -> Result<ViewResult> {
        let limit = v.page_size.clamp(1, 200);
        let offset = v.page.max(0) * limit;
        if v.account_id == "all" {
            // Unified inboxes: merge each account's newest threads.
            let mut all = Vec::new();
            let mut total = 0;
            for a in self.db.accounts()? {
                let mut q = v.clone();
                q.account_id = a.id.clone();
                let (t, n) = self.local_list(&a.id, &q, 0, offset + limit)?;
                total += n;
                all.extend(t);
            }
            all.sort_by(|a, b| b.last_date.cmp(&a.last_date));
            let threads: Vec<ThreadSummary> = all.into_iter().skip(offset as usize).take(limit as usize).collect();
            return Ok(ViewResult { has_more: offset + limit < total, total, threads, source: "cache".into(), ..Default::default() });
        }
        let account = v.account_id.as_str();
        let label = v.label.clone().unwrap_or_default();
        let kind = self.kind(account)?;
        let local_only = matches!(label.as_str(), "SNOOZED" | "SCHEDULED" | "OUTBOX") || !v.conversations;
        if kind == "gmail" && v.mode.as_deref() == Some("server") && !local_only && self.online.load(Ordering::SeqCst) {
            match self.server_list(account, v, limit).await {
                Ok(r) => return Ok(r),
                Err(e) if e.is_offline() => self.set_online(false),
                Err(e) => return Err(e),
            }
        }
        let (threads, total) = self.local_list(account, v, offset, limit)?;
        Ok(ViewResult { has_more: offset + limit < total, total, threads, source: "cache".into(), ..Default::default() })
    }

    async fn server_list(&self, account: &str, v: &ViewQuery, limit: i64) -> Result<ViewResult> {
        let g = self.gmail(account)?;
        let label = v.label.clone().unwrap_or_default();
        let mut label_ids = Vec::new();
        let mut q_parts = Vec::new();
        match label.as_str() {
            "" => {}
            "ALL" => {}
            other => label_ids.push(other.to_string()),
        }
        if let Some(cat) = v.category.as_deref().filter(|c| !c.is_empty()) {
            q_parts.push(format!("category:{cat}"));
        }
        if let Some(q) = v.query.as_deref().filter(|q| !q.trim().is_empty()) {
            q_parts.push(q.to_string());
        }
        let q = q_parts.join(" ");
        let include_spam_trash = label == "TRASH" || label == "SPAM";
        let (ids, next, estimate) = gmail::list_page(&g, &self.db, account, &label_ids, Some(&q), v.page_token.as_deref(), limit as u32, include_spam_trash).await?;
        // Locally snoozed threads stay hidden from the inbox.
        let snoozed: HashSet<String> = if label == "INBOX" { self.db.snoozed_thread_ids(account)?.into_iter().map(|x| x.0).collect() } else { HashSet::new() };
        let ids: Vec<(String, i64)> = ids.into_iter().filter(|i| !snoozed.contains(i)).map(|i| (i, 0)).collect();
        let threads = self.db.thread_summaries(account, &ids, include_spam_trash || search::parse(&q).map(|n| search::mentions_spam_trash(&n)).unwrap_or(false))?;
        let (total, est) = if v.category.is_none() && v.query.as_deref().map(|q| q.trim().is_empty()).unwrap_or(true) && !label.is_empty() && label != "ALL" {
            (self.db.label(account, &label)?.map(|l| l.threads_total).unwrap_or(estimate), false)
        } else {
            (estimate, true)
        };
        Ok(ViewResult { has_more: next.is_some(), next_page_token: next, total, estimate: est, threads, source: "server".into() })
    }

    // ---- reading ----

    pub async fn open_thread(&self, account: &str, thread_id: &str) -> Result<()> {
        if self.kind(account)? == "gmail" && self.online.load(Ordering::SeqCst) {
            let g = self.gmail(account)?;
            match gmail::ensure_thread(&g, &self.db, account, thread_id).await {
                Ok(()) => {}
                Err(e) if e.is_offline() => self.set_online(false),
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    pub async fn raw(&self, account: &str, message_id: &str) -> Result<Vec<u8>> {
        if let Some(r) = self.db.raw(account, message_id)? {
            return Ok(r);
        }
        if self.kind(account)? == "gmail" {
            let g = self.gmail(account)?;
            return gmail::ensure_raw(&g, &self.db, account, message_id).await;
        }
        let (path, _uv, uid) = imap::parse_message_id(message_id).ok_or_else(|| Error::NotFound(message_id.into()))?;
        let acc = self.imap_account(account)?;
        let mut g = acc.session().await?;
        let s = g.as_mut().unwrap();
        s.select(&path).await?;
        use futures::TryStreamExt;
        let f: Vec<async_imap::types::Fetch> = s.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])").await?.try_collect().await?;
        let body = f.first().and_then(|x| x.body()).map(|b| b.to_vec()).ok_or_else(|| Error::NotFound(message_id.into()))?;
        self.db.set_raw(account, message_id, &body)?;
        Ok(body)
    }

    // ---- actions ----

    fn thread_message_ids(&self, account: &str, thread_ids: &[String]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for t in thread_ids {
            for m in self.db.thread_messages(account, t)? {
                out.push(m.id);
            }
        }
        Ok(out)
    }

    pub async fn modify_threads(&self, account: &str, thread_ids: &[String], add: &[String], remove: &[String]) -> Result<()> {
        // Trash/spam actions apply to the whole conversation; label removal from the inbox too.
        let ids = self.thread_message_ids(account, thread_ids)?;
        let ids: Vec<String> = if add.iter().any(|l| l == "TRASH" || l == "SPAM") || remove.iter().any(|l| l == "TRASH" || l == "SPAM") {
            ids
        } else {
            // Don't pull trashed messages back when labelling a conversation.
            ids.into_iter().filter(|id| self.db.message(account, id).ok().flatten().map(|m| !m.has("TRASH") && !m.has("SPAM")).unwrap_or(true)).collect()
        };
        self.modify_messages(account, &ids, add, remove).await
    }

    pub async fn modify_messages(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let add = expand_label_rules(add, remove);
        let (add, remove) = (add.0, add.1);
        // Optimistic local change first so the UI updates immediately.
        self.db.modify_labels(account, ids, &add, &remove)?;
        self.changed(account, "modify");
        let result = if self.kind(account)? == "gmail" {
            let g = self.gmail(account)?;
            let r = g.batch_modify(ids, &add, &remove).await;
            if r.is_ok() {
                // Removing INBOX from a snoozed thread that the user then un-archives clears the snooze, etc.
                if add.iter().any(|l| l == "INBOX") {
                    for t in self.thread_ids_of(account, ids) {
                        let _ = self.db.unsnooze(account, &t);
                    }
                }
            }
            r
        } else {
            self.imap_modify(account, ids, &add, &remove).await
        };
        match result {
            Ok(()) => {
                self.db.recount_labels(account).ok();
                self.trigger(account);
                self.changed(account, "modify");
                Ok(())
            }
            Err(e) => {
                // Roll back the optimistic change.
                self.db.modify_labels(account, ids, &remove, &add)?;
                self.changed(account, "modify-failed");
                Err(e)
            }
        }
    }

    fn thread_ids_of(&self, account: &str, ids: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        for id in ids {
            if let Ok(Some(m)) = self.db.message(account, id) {
                if !out.contains(&m.thread_id) {
                    out.push(m.thread_id);
                }
            }
        }
        out
    }

    fn folder_path(&self, account: &str, label_id: &str) -> Result<Option<String>> {
        Ok(self.db.label(account, label_id)?.and_then(|l| l.imap_path))
    }

    async fn ensure_archive_folder(&self, account: &str, s: &mut Session) -> Result<String> {
        if let Some(p) = self.folder_path(account, "ALL")? {
            return Ok(p);
        }
        let _ = imap::create_folder(s, "Archive").await;
        imap::sync_folder_list(s, &self.db, account).await?;
        Ok(self.folder_path(account, "ALL")?.unwrap_or_else(|| "Archive".into()))
    }

    /// Label changes on IMAP: flags for read/star, moves for inbox/archive/trash/spam, copies for labels.
    async fn imap_modify(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<()> {
        let acc = self.imap_account(account)?;
        let mut g = acc.session().await?;
        let res = async {
            let s = g.as_mut().unwrap();
            let mut by_folder: HashMap<String, Vec<u32>> = HashMap::new();
            for id in ids {
                if let Some((path, _, uid)) = imap::parse_message_id(id) {
                    by_folder.entry(path).or_default().push(uid);
                }
            }
            let inbox = self.folder_path(account, "INBOX")?.unwrap_or_else(|| "INBOX".into());
            let mut touched: Vec<String> = Vec::new();
            for (folder, uids) in &by_folder {
                touched.push(folder.clone());
                if add.iter().any(|l| l == "UNREAD") {
                    imap::store_flags(s, folder, uids, false, "\\Seen").await?;
                }
                if remove.iter().any(|l| l == "UNREAD") {
                    imap::store_flags(s, folder, uids, true, "\\Seen").await?;
                }
                if add.iter().any(|l| l == "STARRED") {
                    imap::store_flags(s, folder, uids, true, "\\Flagged").await?;
                }
                if remove.iter().any(|l| l == "STARRED") {
                    imap::store_flags(s, folder, uids, false, "\\Flagged").await?;
                }
                // Copies for user labels.
                for l in add.iter().filter(|l| l.starts_with("F:")) {
                    let to = &l[2..];
                    if to != folder {
                        imap::copy_uids(s, folder, uids, to).await?;
                        touched.push(to.to_string());
                    }
                }
                // One move at most.
                let mut dest: Option<String> = None;
                if add.iter().any(|l| l == "TRASH") {
                    dest = self.folder_path(account, "TRASH")?;
                } else if add.iter().any(|l| l == "SPAM") {
                    dest = self.folder_path(account, "SPAM")?;
                } else if remove.iter().any(|l| l == "TRASH" || l == "SPAM") || (add.iter().any(|l| l == "INBOX") && *folder != inbox) {
                    dest = Some(inbox.clone());
                } else if remove.iter().any(|l| l == "INBOX") && *folder == inbox {
                    dest = Some(self.ensure_archive_folder(account, s).await?);
                } else if remove.iter().any(|l| l.strip_prefix("F:") == Some(folder.as_str())) {
                    dest = Some(self.ensure_archive_folder(account, s).await?);
                }
                if let Some(d) = dest.filter(|d| d != folder) {
                    imap::move_uids(s, folder, uids, &d).await?;
                    touched.push(d);
                }
            }
            // Resync destinations first so moved copies keep their conversations, then the sources.
            let infos = imap::sync_folder_list(s, &self.db, account).await?;
            touched.dedup();
            let order: Vec<&imap::FolderInfo> = infos.iter().filter(|i| touched.contains(&i.folder.path) && !by_folder.contains_key(&i.folder.path)).chain(infos.iter().filter(|i| by_folder.contains_key(&i.folder.path))).collect();
            for info in order {
                imap::sync_folder(s, &self.db, account, info, acc.cfg.initial_window).await?;
            }
            Ok::<(), Error>(())
        }
        .await;
        if res.is_err() {
            *g = None;
        }
        res
    }

    pub async fn delete_forever(&self, account: &str, thread_ids: &[String]) -> Result<()> {
        let ids = self.thread_message_ids(account, thread_ids)?;
        let ids: Vec<String> = ids.into_iter().filter(|id| self.db.message(account, id).ok().flatten().map(|m| m.has("TRASH") || m.has("SPAM") || m.has("DRAFT")).unwrap_or(false)).collect();
        if ids.is_empty() {
            return Ok(());
        }
        if self.kind(account)? == "gmail" {
            self.gmail(account)?.batch_delete(&ids).await?;
        } else {
            let acc = self.imap_account(account)?;
            let mut g = acc.session().await?;
            let mut by_folder: HashMap<String, Vec<u32>> = HashMap::new();
            for id in &ids {
                if let Some((path, _, uid)) = imap::parse_message_id(id) {
                    by_folder.entry(path).or_default().push(uid);
                }
            }
            for (folder, uids) in by_folder {
                if let Err(e) = imap::expunge_uids(g.as_mut().unwrap(), &folder, &uids).await {
                    *g = None;
                    return Err(e);
                }
            }
        }
        for id in &ids {
            self.db.delete_message(account, id)?;
        }
        self.db.recount_labels(account).ok();
        self.changed(account, "delete");
        Ok(())
    }

    pub async fn empty_label(&self, account: &str, label: &str) -> Result<usize> {
        if label != "TRASH" && label != "SPAM" {
            return Err(Error::msg("Only Trash and Spam can be emptied."));
        }
        let rows = self.db.messages_where(account, "m.labels LIKE ?", vec![format!("% {label} %").into()], 100_000)?;
        let mut threads: Vec<String> = rows.iter().map(|m| m.thread_id.clone()).collect();
        threads.dedup();
        self.delete_forever(account, &threads).await?;
        Ok(rows.len())
    }

    // ---- snooze / mute / block ----

    pub async fn snooze(&self, account: &str, thread_ids: &[String], until: i64) -> Result<()> {
        for t in thread_ids {
            self.db.snooze(account, t, until)?;
        }
        if self.kind(account)? == "gmail" {
            // The server copy leaves the inbox; the local record brings it back at `until`.
            let ids = self.thread_message_ids(account, thread_ids)?;
            self.db.modify_labels(account, &ids, &[], &["INBOX".into()])?;
            if let Err(e) = self.gmail(account)?.batch_modify(&ids, &[], &["INBOX".into()]).await {
                if !e.is_offline() {
                    return Err(e);
                }
            }
        }
        self.changed(account, "snooze");
        Ok(())
    }

    pub async fn unsnooze(&self, account: &str, thread_ids: &[String]) -> Result<()> {
        for t in thread_ids {
            self.db.unsnooze(account, t)?;
            self.db.bump(account, t, now_ms())?;
        }
        if self.kind(account)? == "gmail" {
            let ids: Vec<String> = self.thread_message_ids(account, thread_ids)?.into_iter().filter(|id| self.db.message(account, id).ok().flatten().map(|m| !m.has("TRASH") && !m.has("SPAM") && !m.has("SENT") || m.has("INBOX")).unwrap_or(false)).collect();
            let ids = if ids.is_empty() { self.thread_message_ids(account, thread_ids)? } else { ids };
            self.db.modify_labels(account, &ids, &["INBOX".into()], &[])?;
            self.gmail(account)?.batch_modify(&ids, &["INBOX".into()], &[]).await?;
        }
        self.changed(account, "unsnooze");
        Ok(())
    }

    async fn snooze_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let due = self.db.due_snoozes(now_ms()).unwrap_or_default();
            for (account, thread) in due {
                match self.unsnooze(&account, std::slice::from_ref(&thread)).await {
                    Ok(()) => {
                        if let Ok(msgs) = self.db.thread_messages(&account, &thread) {
                            if let Some(m) = msgs.last() {
                                self.notifier.notify(&format!("Snoozed: {}", if m.from_name.is_empty() { &m.from_email } else { &m.from_name }), &m.subject, &account, &thread);
                            }
                        }
                    }
                    Err(e) if e.is_offline() => {
                        // Keep it hidden until we're back online; retry next round.
                        let _ = self.db.snooze(&account, &thread, now_ms());
                    }
                    Err(_) => {}
                }
            }
        }
    }

    pub async fn mute(&self, account: &str, thread_ids: &[String], on: bool) -> Result<()> {
        for t in thread_ids {
            self.db.set_muted(account, t, on)?;
        }
        if on {
            self.modify_threads(account, thread_ids, &[], &["INBOX".into()]).await?;
        }
        self.changed(account, "mute");
        Ok(())
    }

    pub async fn block(&self, account: &str, email: &str) -> Result<()> {
        let email = email.trim().to_lowercase();
        let filter_id = if self.kind(account)? == "gmail" {
            let f = self.gmail(account)?.post("/settings/filters", &json!({"criteria": {"from": email}, "action": {"addLabelIds": ["TRASH"]}})).await?;
            f["id"].as_str().map(str::to_string)
        } else {
            let id = format!("lf-{}", crate::error::random_token(6));
            self.db.add_local_filter(&id, account, &json!({"from": email}), &json!({"addLabelIds": ["SPAM"]}))?;
            Some(id)
        };
        self.db.set_blocked(account, &email, filter_id.as_deref())?;
        Ok(())
    }

    pub async fn unblock(&self, account: &str, email: &str) -> Result<()> {
        if let Some(fid) = self.db.unblock(account, email)? {
            if self.kind(account)? == "gmail" {
                let _ = self.gmail(account)?.delete(&format!("/settings/filters/{}", gmail::enc(&fid))).await;
            } else {
                self.db.delete_local_filter(&fid)?;
            }
        }
        Ok(())
    }

    // ---- labels ----

    pub async fn label_create(&self, account: &str, name: &str, bg: Option<&str>, fg: Option<&str>) -> Result<String> {
        if self.kind(account)? == "gmail" {
            let mut body = json!({"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"});
            if let (Some(b), Some(f)) = (bg, fg) {
                body["color"] = json!({"backgroundColor": b, "textColor": f});
            }
            let l = self.gmail(account)?.label_create(&body).await?;
            self.db.upsert_label(&gmail::label_row(account, &l))?;
            self.changed(account, "labels");
            return Ok(l["id"].as_str().unwrap_or("").to_string());
        }
        let acc = self.imap_account(account)?;
        let mut g = acc.session().await?;
        let s = g.as_mut().unwrap();
        let delim = self.db.labels(account)?.iter().find_map(|l| l.imap_delimiter.clone()).unwrap_or_else(|| "/".into());
        let path = imap::path_for_label_name(name, &delim);
        if let Err(e) = imap::create_folder(s, &path).await {
            *g = None;
            return Err(e);
        }
        imap::sync_folder_list(s, &self.db, account).await?;
        if let (Some(b), Some(f)) = (bg, fg) {
            self.set_local_label_color(account, &format!("F:{path}"), b, f)?;
        }
        self.changed(account, "labels");
        Ok(format!("F:{path}"))
    }

    fn set_local_label_color(&self, account: &str, id: &str, bg: &str, fg: &str) -> Result<()> {
        if let Some(mut l) = self.db.label(account, id)? {
            l.bg = Some(bg.into());
            l.fg = Some(fg.into());
            self.db.upsert_label(&l)?;
        }
        Ok(())
    }

    pub async fn label_update(&self, account: &str, id: &str, patch: &Value) -> Result<()> {
        if self.kind(account)? == "gmail" {
            let mut body = json!({});
            for k in ["name", "labelListVisibility", "messageListVisibility"] {
                if !patch[k].is_null() {
                    body[k] = patch[k].clone();
                }
            }
            if patch["color"].is_object() {
                body["color"] = patch["color"].clone();
            }
            let l = self.gmail(account)?.label_patch(id, &body).await?;
            let mut row = gmail::label_row(account, &l);
            if let Some(old) = self.db.label(account, id)? {
                row.threads_total = old.threads_total;
                row.threads_unread = old.threads_unread;
                row.messages_total = old.messages_total;
                row.messages_unread = old.messages_unread;
            }
            self.db.upsert_label(&row)?;
            // Renaming a parent renames its children on the server; refresh everything.
            if !patch["name"].is_null() {
                gmail::refresh_labels(&*self.gmail(account)?, &self.db, account).await?;
            }
        } else {
            let mut l = self.db.label(account, id)?.ok_or_else(|| Error::NotFound(id.into()))?;
            if let Some(name) = patch["name"].as_str() {
                let acc = self.imap_account(account)?;
                let mut g = acc.session().await?;
                let s = g.as_mut().unwrap();
                let delim = l.imap_delimiter.clone().unwrap_or_else(|| "/".into());
                let new_path = imap::path_for_label_name(name, &delim);
                let old_path = l.imap_path.clone().unwrap_or_default();
                if let Err(e) = imap::rename_folder(s, &old_path, &new_path).await {
                    *g = None;
                    return Err(e);
                }
                self.db.delete_folder_messages(account, &old_path)?;
                self.db.delete_label(account, id)?;
                let infos = imap::sync_folder_list(s, &self.db, account).await?;
                if let Some(info) = infos.iter().find(|i| i.folder.path == new_path) {
                    imap::sync_folder(s, &self.db, account, info, acc.cfg.initial_window).await?;
                }
                l = self.db.label(account, &format!("F:{new_path}"))?.unwrap_or(l);
            }
            if patch["color"].is_object() {
                l.bg = patch["color"]["backgroundColor"].as_str().map(str::to_string);
                l.fg = patch["color"]["textColor"].as_str().map(str::to_string);
            }
            for k in ["labelListVisibility", "messageListVisibility"] {
                if let Some(v) = patch[k].as_str() {
                    if k == "labelListVisibility" {
                        l.label_list_visibility = Some(v.into());
                    } else {
                        l.message_list_visibility = Some(v.into());
                    }
                }
            }
            self.db.upsert_label(&l)?;
        }
        self.changed(account, "labels");
        Ok(())
    }

    pub async fn label_delete(&self, account: &str, id: &str) -> Result<()> {
        if self.kind(account)? == "gmail" {
            self.gmail(account)?.label_delete(id).await?;
        } else if let Some(l) = self.db.label(account, id)? {
            let acc = self.imap_account(account)?;
            let mut g = acc.session().await?;
            if let Err(e) = imap::delete_folder(g.as_mut().unwrap(), l.imap_path.as_deref().unwrap_or("")).await {
                *g = None;
                return Err(e);
            }
            self.db.delete_folder_messages(account, l.imap_path.as_deref().unwrap_or(""))?;
        }
        self.db.delete_label(account, id)?;
        self.changed(account, "labels");
        Ok(())
    }

    // ---- drafts ----

    /// Save (create or replace) a draft; returns its draft id.
    pub async fn draft_save(&self, account: &str, draft_id: Option<&str>, raw: &[u8], thread_id: Option<&str>) -> Result<String> {
        if self.kind(account)? == "gmail" {
            let g = self.gmail(account)?;
            let r = match draft_id {
                Some(d) => g.draft_update(d, raw, thread_id).await?,
                None => g.draft_create(raw, thread_id).await?,
            };
            let did = r["id"].as_str().unwrap_or("").to_string();
            let mid = r["message"]["id"].as_str().unwrap_or("").to_string();
            let tid = r["message"]["threadId"].as_str().map(str::to_string);
            if let Some(d) = draft_id {
                if let Some((old_mid, _)) = self.db.draft_message(account, d)? {
                    if old_mid != mid {
                        self.db.delete_message(account, &old_mid)?;
                    }
                }
            }
            let mut row = crate::mailmeta::parse_raw(raw).row;
            row.account_id = account.into();
            row.id = mid.clone();
            row.thread_id = tid.clone().unwrap_or_else(|| mid.clone());
            row.labels = vec!["DRAFT".into()];
            row.internal_date = now_ms();
            row.has_raw = true;
            self.db.upsert_message(&row, Some(raw))?;
            self.db.set_draft(account, &did, &mid, tid.as_deref())?;
            self.changed(account, "draft");
            return Ok(did);
        }
        let acc = self.imap_account(account)?;
        let drafts = self.folder_path(account, "DRAFT")?.unwrap_or_else(|| "Drafts".into());
        let mut g = acc.session().await?;
        let res = async {
            let s = g.as_mut().unwrap();
            if let Some(old) = draft_id {
                if let Some((path, _, uid)) = imap::parse_message_id(old) {
                    imap::expunge_uids(s, &path, &[uid]).await?;
                    self.db.delete_message(account, old)?;
                }
            }
            imap::append(s, &drafts, "(\\Draft \\Seen)", raw).await?;
            let infos = imap::sync_folder_list(s, &self.db, account).await?;
            if let Some(info) = infos.iter().find(|i| i.folder.path == drafts) {
                imap::sync_folder(s, &self.db, account, info, acc.cfg.initial_window).await?;
            }
            let mid = crate::mailmeta::parse_raw(raw).row.message_id;
            let found = self.db.messages_where(account, "m.message_id = ? AND m.imap_folder = ?", vec![mid.into(), drafts.clone().into()], 1)?;
            let row = found.into_iter().next().ok_or_else(|| Error::msg("The draft was saved but couldn't be found again."))?;
            self.db.set_draft(account, &row.id, &row.id, Some(&row.thread_id))?;
            Ok::<String, Error>(row.id)
        }
        .await;
        if res.is_err() {
            *g = None;
        }
        self.changed(account, "draft");
        res
    }

    pub async fn draft_delete(&self, account: &str, draft_id: &str) -> Result<()> {
        if self.kind(account)? == "gmail" {
            match self.gmail(account)?.draft_delete(draft_id).await {
                Ok(()) | Err(Error::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
            if let Some((mid, _)) = self.db.draft_message(account, draft_id)? {
                self.db.delete_message(account, &mid)?;
            }
        } else if let Some((path, _, uid)) = imap::parse_message_id(draft_id) {
            let acc = self.imap_account(account)?;
            let mut g = acc.session().await?;
            if let Err(e) = imap::expunge_uids(g.as_mut().unwrap(), &path, &[uid]).await {
                *g = None;
                return Err(e);
            }
            self.db.delete_message(account, draft_id)?;
        }
        self.db.delete_draft(account, draft_id)?;
        self.changed(account, "draft");
        Ok(())
    }

    // ---- sending ----

    /// Queue a message: `send_at` = now + undo delay (undo send) or a scheduled time.
    #[allow(clippy::too_many_arguments)]
    pub fn queue_send(&self, account: &str, raw: &[u8], send_at: i64, scheduled: bool, thread_id: Option<&str>, draft_id: Option<&str>) -> Result<i64> {
        let meta = crate::mailmeta::parse_raw(raw).row;
        let mut recipients: Vec<String> = meta.to.iter().chain(&meta.cc).chain(&meta.bcc).map(|a| a.email.clone()).collect();
        recipients.dedup();
        let id = self.db.outbox_add(account, raw, send_at, scheduled, thread_id, draft_id, &meta.subject, &recipients, &meta.from_email, &meta.snippet)?;
        self.emit("outbox-changed", json!({"accountId": account}));
        self.outbox_kick.notify_one();
        Ok(id)
    }

    pub fn cancel_send(&self, id: i64) -> Result<Option<OutboxRow>> {
        let r = self.db.outbox_take(id)?;
        if let Some(row) = &r {
            self.emit("outbox-changed", json!({"accountId": row.account_id}));
            self.changed(&row.account_id, "outbox");
        }
        Ok(r)
    }

    pub fn send_soon(&self, id: i64) -> Result<()> {
        self.db.outbox_reschedule(id, now_ms())?;
        self.outbox_kick.notify_one();
        Ok(())
    }

    async fn outbox_loop(self: Arc<Self>) {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                _ = self.outbox_kick.notified() => {}
            }
            let due = match self.db.outbox_claim_due(now_ms()) {
                Ok(d) => d,
                Err(_) => continue,
            };
            for row in due {
                match self.send_now(&row).await {
                    Ok(()) => {
                        let _ = self.db.outbox_done(row.id);
                        self.set_online(true);
                        self.emit("outbox-changed", json!({"accountId": row.account_id, "sent": row.id}));
                        self.emit("message-sent", json!({"accountId": row.account_id, "outboxId": row.id, "scheduled": row.scheduled}));
                        self.changed(&row.account_id, "sent");
                        self.trigger(&row.account_id);
                    }
                    Err(e) if e.is_offline() || matches!(e, Error::Network(_)) => {
                        self.set_online(false);
                        let delay = 15_000 * (1i64 << row.attempts.min(5));
                        let _ = self.db.outbox_retry(row.id, now_ms() + delay.min(600_000), &e.to_string());
                        self.emit("outbox-changed", json!({"accountId": row.account_id, "error": e.to_string()}));
                    }
                    Err(e) if e.is_auth() => {
                        let _ = self.db.outbox_retry(row.id, now_ms() + 300_000, &e.to_string());
                        let _ = self.db.set_needs_reauth(&row.account_id, true);
                        self.emit("accounts-changed", json!({}));
                    }
                    Err(e) => {
                        let _ = self.db.outbox_fail(row.id, &e.to_string());
                        self.emit("outbox-changed", json!({"accountId": row.account_id, "error": e.to_string()}));
                    }
                }
            }
        }
    }

    pub async fn send_now(&self, row: &OutboxRow) -> Result<()> {
        let a = self.db.account(&row.account_id)?;
        if a.kind == "gmail" {
            let g = self.gmail(&row.account_id)?;
            let sent = g.send(&row.raw, row.thread_id.as_deref()).await?;
            if let Some(did) = &row.draft_id {
                let _ = self.draft_delete(&row.account_id, did).await;
            }
            // Cache the sent copy right away.
            if let Some(id) = sent["id"].as_str() {
                let mut m = crate::mailmeta::parse_raw(&row.raw).row;
                m.account_id = row.account_id.clone();
                m.id = id.into();
                m.thread_id = sent["threadId"].as_str().unwrap_or(id).into();
                m.labels = sent["labelIds"].as_array().map(|x| x.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_else(|| vec!["SENT".into()]);
                m.internal_date = now_ms();
                m.has_raw = true;
                let _ = self.db.upsert_message(&m, Some(&row.raw));
            }
        } else {
            let acc = self.imap_account(&row.account_id)?;
            // Bcc must not travel in the headers over SMTP.
            let data = strip_bcc(&row.raw);
            imap::smtp_send(&acc.cfg.smtp, &acc.smtp_password, &row.from_email, &row.recipients, &data).await?;
            if acc.cfg.save_sent {
                if let Some(sent) = self.folder_path(&row.account_id, "SENT")? {
                    let mut g = acc.session().await?;
                    if imap::append(g.as_mut().unwrap(), &sent, "(\\Seen)", &row.raw).await.is_err() {
                        *g = None;
                    }
                }
            }
            if let Some(did) = &row.draft_id {
                let _ = self.draft_delete(&row.account_id, did).await;
            }
        }
        for r in &row.recipients {
            let _ = self.db.touch_contact(&row.account_id, r, "", true, now_ms());
        }
        Ok(())
    }

    // ---- unsubscribe ----

    /// RFC 8058 one-click (POST) when offered; otherwise the caller handles mailto/link.
    pub async fn unsubscribe_one_click(&self, url: &str) -> Result<()> {
        if !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") {
            return Err(Error::msg("Only https unsubscribe links can be used."));
        }
        let r = self.http.post(url).header("Content-Type", "application/x-www-form-urlencoded").body("List-Unsubscribe=One-Click").send().await?;
        if r.status().is_success() { Ok(()) } else { Err(Error::Server(format!("unsubscribe {}", r.status()))) }
    }
}

/// Bcc travels only in the envelope over SMTP.
pub fn strip_bcc(raw: &[u8]) -> Vec<u8> {
    let s = raw;
    let end = s.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 2).unwrap_or(s.len());
    let head = String::from_utf8_lossy(&s[..end]).to_string();
    let mut out = String::new();
    let mut skipping = false;
    for line in head.split_inclusive("\r\n") {
        if line.starts_with(' ') || line.starts_with('\t') {
            if !skipping {
                out.push_str(line);
            }
            continue;
        }
        skipping = line.to_ascii_lowercase().starts_with("bcc:");
        if !skipping {
            out.push_str(line);
        }
    }
    let mut v = out.into_bytes();
    v.extend_from_slice(&s[end..]);
    v
}

/// Archiving/trash/spam rules: trash ↔ inbox exclusivity like the web client.
fn expand_label_rules(add: &[String], remove: &[String]) -> (Vec<String>, Vec<String>) {
    let mut add = add.to_vec();
    let mut remove = remove.to_vec();
    let push = |v: &mut Vec<String>, x: &str| {
        if !v.iter().any(|l| l == x) {
            v.push(x.into());
        }
    };
    if add.iter().any(|l| l == "TRASH") {
        push(&mut remove, "INBOX");
        push(&mut remove, "SPAM");
    }
    if add.iter().any(|l| l == "SPAM") {
        push(&mut remove, "INBOX");
        push(&mut remove, "TRASH");
    }
    if remove.iter().any(|l| l == "SPAM" || l == "TRASH") && !add.iter().any(|l| l == "INBOX") && !remove.iter().any(|l| l == "INBOX") {
        push(&mut add, "INBOX");
    }
    add.retain(|l| !remove.contains(l));
    (add, remove)
}

pub fn outbox_summary(r: &OutboxRow) -> ThreadSummary {
    ThreadSummary {
        account_id: r.account_id.clone(),
        thread_id: format!("outbox:{}", r.id),
        subject: r.subject.clone(),
        snippet: r.snippet.clone(),
        last_date: r.send_at,
        message_count: 1,
        labels: vec![if r.scheduled { "SCHEDULED".into() } else { "OUTBOX".into() }],
        participants: r.recipients.iter().map(|e| crate::db::Participant { name: String::new(), email: e.clone(), unread: false, draft: false }).collect(),
        outbox_id: Some(r.id),
        scheduled_at: if r.scheduled { Some(r.send_at) } else { None },
        ..Default::default()
    }
}

fn searchable(db: &Db, account: &str, m: &crate::db::MessageRow) -> search::Searchable {
    let addrs = |l: &[crate::db::Addr]| l.iter().map(|a| format!("{} {}", a.name, a.email)).collect::<Vec<_>>().join(" ").to_lowercase();
    let names: HashMap<String, String> = db.labels(account).unwrap_or_default().into_iter().map(|l| (l.id, l.name)).collect();
    let body = db.with(|c| c.query_row("SELECT body FROM fts WHERE rowid = (SELECT rowid FROM messages WHERE account_id=? AND id=?)", [account, &m.id], |r| r.get::<_, String>(0))).unwrap_or_default();
    search::Searchable {
        from: format!("{} {}", m.from_name, m.from_email).to_lowercase(),
        to: addrs(&m.to),
        cc: addrs(&m.cc),
        bcc: addrs(&m.bcc),
        delivered_to: m.delivered_to.clone(),
        subject: m.subject.clone(),
        body,
        labels: m.labels.clone(),
        label_names: m.labels.iter().filter_map(|l| names.get(l).cloned()).collect(),
        attachment_names: m.attachments.iter().map(|a| a.name.clone()).collect(),
        size: m.size,
        date_ms: m.internal_date,
        list_id: m.list_id.clone(),
        message_id: m.message_id.clone(),
        ..Default::default()
    }
}

/// Filter criteria (mail API shape) → query string.
pub fn criteria_query(c: &Value) -> String {
    let mut parts = Vec::new();
    let wrap = |f: &str, v: &str| if v.contains(' ') { format!("{f}:({v})") } else { format!("{f}:{v}") };
    if let Some(v) = c["from"].as_str().filter(|s| !s.is_empty()) {
        parts.push(wrap("from", v));
    }
    if let Some(v) = c["to"].as_str().filter(|s| !s.is_empty()) {
        parts.push(wrap("to", v));
    }
    if let Some(v) = c["subject"].as_str().filter(|s| !s.is_empty()) {
        parts.push(wrap("subject", v));
    }
    if let Some(v) = c["query"].as_str().filter(|s| !s.is_empty()) {
        parts.push(v.to_string());
    }
    if let Some(v) = c["negatedQuery"].as_str().filter(|s| !s.is_empty()) {
        parts.push(if v.contains(' ') { format!("-{{{v}}}") } else { format!("-{v}") });
    }
    if c["hasAttachment"].as_bool() == Some(true) {
        parts.push("has:attachment".into());
    }
    if let (Some(n), Some(cmp)) = (c["size"].as_i64(), c["sizeComparison"].as_str()) {
        parts.push(format!("{cmp}:{n}"));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bcc_is_stripped_and_rules_expand() {
        let raw = b"From: a@x\r\nBcc: secret@x,\r\n other@x\r\nTo: b@x\r\nSubject: s\r\n\r\nBody\r\nBcc: not-a-header\r\n";
        let out = String::from_utf8(strip_bcc(raw)).unwrap();
        assert!(!out.contains("secret@x") && !out.contains("other@x"));
        assert!(out.contains("To: b@x") && out.contains("Bcc: not-a-header"));
        let (a, r) = expand_label_rules(&["TRASH".into()], &[]);
        assert_eq!(a, vec!["TRASH"]);
        assert!(r.contains(&"INBOX".to_string()) && r.contains(&"SPAM".to_string()));
        let (a, _) = expand_label_rules(&[], &["SPAM".into()]);
        assert_eq!(a, vec!["INBOX"]);
        assert_eq!(criteria_query(&json!({"from": "news@shop", "query": "sale now", "hasAttachment": true})), "from:news@shop sale now has:attachment");
    }
}
