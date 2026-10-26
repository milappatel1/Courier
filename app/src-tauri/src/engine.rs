//! The engine: one place that knows every account. It dispatches actions to the mail API or IMAP, lists
//! views from the cache (or the server for API accounts), runs a sync loop per account (history / UID
//! sync, IMAP IDLE), and runs the outbox (undo send, scheduled send, offline retry) and snooze workers.

use crate::db::{AccountRow, Db, LabelRow, ListFilter, OutboxRow, ThreadSummary};
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

/// What's new in one Inbox tab since it was last opened (`Engine::tab_news`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TabNews {
    pub tab: String,
    pub count: i64,
    pub names: Vec<String>,
}

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
    /// One flush of the queued label changes at a time per account, so they go out in order.
    flushing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Recent changes made here, for Undo: what each message had before, for the labels the change touched.
    made: Mutex<std::collections::VecDeque<Made>>,
    next_made: std::sync::atomic::AtomicU64,
}

/// A change made here, as Undo needs it.
#[derive(Clone)]
struct Made {
    id: u64,
    account: String,
    add: Vec<String>,
    remove: Vec<String>,
    /// Each changed message's labels before the change (messages this Mac didn't have included, as the server had
    /// them when the change went out).
    prior: HashMap<String, Vec<String>>,
    /// It waited for the connection when it was made, and these conversations' change with it.
    queued: bool,
    queued_threads: Vec<String>,
}

/// A change made, and how Undo finds it.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub result: Changed,
    pub change: u64,
}

/// Where a label change went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Changed {
    /// The server has it.
    Done,
    /// The server couldn't be reached: it's made here and goes out when the connection is back.
    Queued,
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
    /// The newest change made here that this listing reflects (change ids from `change`).
    pub ledger: u64,
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
                // Exact label only: as in the web client, `label:projects` leaves out Projects/Alpha.
                search::label_key(&l.name) == key || search::label_key(&l.id) == key
            })
            .map(|l| l.id.clone())
            .collect()
    }
}

/// More new messages than this at once get one summary notification.
const MAX_NOTIFICATIONS: usize = 4;

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
            flushing: Mutex::new(HashMap::new()),
            made: Mutex::new(std::collections::VecDeque::new()),
            next_made: std::sync::atomic::AtomicU64::new(1),
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
        let skip = if cfg["primaryOnly"].as_bool().unwrap_or(true) { self.tab_categories() } else { vec![] };
        let n = if cfg["enabled"].as_bool().unwrap_or(true) { self.db.inbox_unread(None, &skip, !skip.is_empty() && self.starred_in_primary()).unwrap_or(0) } else { 0 };
        (self.badge)(n);
    }

    /// Category labels shown as their own Inbox tabs (Settings ▸ Inbox; Forums is off by default).
    pub fn tab_categories(&self) -> Vec<&'static str> {
        let cfg = self.db.kv_get("categories").ok().flatten().unwrap_or(Value::Null);
        let on = |k: &str, def: bool| cfg.get(k).and_then(Value::as_bool).unwrap_or(def);
        let mut out = vec![];
        for (key, label, def) in [("promotions", "CATEGORY_PROMOTIONS", true), ("social", "CATEGORY_SOCIAL", true), ("updates", "CATEGORY_UPDATES", true), ("forums", "CATEGORY_FORUMS", false)] {
            if on(key, def) {
                out.push(label);
            }
        }
        out
    }

    /// What's new in each Inbox tab (other than Primary) since the user last opened it, as the web client shows
    /// under the tab names: unread conversations that arrived since, and their senders. A tab never opened on this
    /// Mac starts from now, so mail that was already there isn't news.
    pub fn tab_news(&self, account: &str) -> Result<Vec<TabNews>> {
        let mut seen = self.db.kv_get("tabSeen")?.unwrap_or(json!({}));
        let now = now_ms();
        let mut out = Vec::new();
        let mut started = false;
        for label in self.tab_categories() {
            let tab = label.trim_start_matches("CATEGORY_").to_lowercase();
            let since = match seen[account][&tab].as_i64() {
                Some(ms) => ms,
                None => {
                    seen[account][&tab] = json!(now);
                    started = true;
                    now
                }
            };
            let (count, names) = self.db.tab_news(account, label, since)?;
            out.push(TabNews { tab, count, names });
        }
        if started {
            self.db.kv_set("tabSeen", &seen)?;
        }
        Ok(out)
    }

    /// The user opened (or left) an Inbox tab: what's in it now is no longer new.
    pub fn tab_seen(&self, account: &str, tab: &str) -> Result<()> {
        let mut seen = self.db.kv_get("tabSeen")?.unwrap_or(json!({}));
        seen[account][tab] = json!(now_ms());
        self.db.kv_set("tabSeen", &seen)
    }

    /// Labels with the Inbox count Gmail shows: unread conversations in Primary when tabs are on.
    pub fn labels_for_nav(&self, account: &str) -> Result<Vec<LabelRow>> {
        let mut labels = self.db.labels(account)?;
        let gmail = self.db.account(account).map(|a| a.kind == "gmail").unwrap_or(false);
        let inbox_type = self.db.kv_get("inboxType").ok().flatten().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "default".into());
        if gmail && inbox_type == "default" {
            let skip = self.tab_categories();
            if !skip.is_empty() {
                let n = self.db.inbox_unread(Some(account), &skip, self.starred_in_primary())?;
                if let Some(l) = labels.iter_mut().find(|l| l.id == "INBOX") {
                    l.threads_unread = n;
                }
            }
        }
        Ok(labels)
    }

    fn set_online(&self, on: bool) {
        let was = self.online.swap(on, Ordering::SeqCst);
        if was != on {
            self.emit("online", json!({"online": on}));
            if on {
                let _ = self.db.outbox_retry_now(now_ms());
                self.outbox_kick.notify_one();
                // Label changes made offline go out with their account's next sync: now.
                for a in self.db.queued_accounts().unwrap_or_default() {
                    self.trigger(&a);
                }
            }
        }
    }

    pub fn google_client(&self) -> Result<ClientCreds> {
        // Missing (never set up, or the Keychain refused): the account asks to sign in again, which sets it up.
        let raw = self.secrets.get(secrets::GOOGLE_CLIENT_KEY)?.ok_or_else(|| Error::Auth("Set up Google sign-in (Settings ▸ Accounts) and sign in again.".into()))?;
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
        let mut last_logged = String::new();
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
            let result = self.sync_account(&account).await;
            // Log changes of state, not every cycle.
            let now_state = match &result {
                Ok(()) => "ok".to_string(),
                Err(e) => e.to_string(),
            };
            if now_state != last_logged {
                match &result {
                    Ok(()) if !last_logged.is_empty() => crate::applog::info(&format!("{account}: syncing again")),
                    Ok(()) => {}
                    Err(e) if e.is_offline() || e.is_rate_limited() => crate::applog::warn(&format!("{account}: {e}")),
                    Err(e) => crate::applog::error(&format!("{account}: sync failed: {e}")),
                }
                last_logged = if result.is_ok() { String::new() } else { now_state };
            }
            match result {
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
                Err(e) if e.is_rate_limited() => {
                    // Still online; the next cycle carries on where this one stopped.
                    self.emit("sync-status", json!({"accountId": account, "state": "busy", "error": e.to_string()}));
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
        // Changes made offline first, so the server has them before it's asked what changed.
        self.flush_queue(account).await?;
        let days = self.db.kv_get("offline").ok().flatten().and_then(|v| v["days"].as_u64()).unwrap_or(30) as u32;
        let new_messages = if a.kind == "gmail" {
            let g = self.gmail(account)?;
            let new = if a.state["initialSyncDone"].as_bool() != Some(true) {
                crate::applog::info(&format!("{account}: first sync starting (last {days} days)"));
                gmail::initial_sync(&g, &self.db, account, days, 2000).await?;
                crate::applog::info(&format!("{account}: first sync done"));
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
                        crate::applog::info(&format!("{account}: the server's history doesn't reach back to the last sync; syncing again in full"));
                        self.db.set_account_state(account, "initialSyncDone", json!(false))?;
                        gmail::initial_sync(&g, &self.db, account, days, 2000).await?;
                        let n = gmail::reconcile_cache(&g, &self.db, account, 5000).await?;
                        crate::applog::info(&format!("{account}: full sync done; {n} cached message(s) were out of date"));
                        self.changed(account, "resync");
                        vec![]
                    }
                    Err(e) => return Err(e),
                }
            };
            // Older unread conversations count toward the Inbox badge too; cache any that are missing.
            match gmail::backfill_unread_inbox(&g, &self.db, account, &self.tab_categories()).await {
                Ok(n) if n > 0 => self.changed(account, "sync"),
                Ok(_) => {}
                Err(e) if e.is_offline() || e.is_rate_limited() => return Err(e),
                Err(_) => {}
            }
            new
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

    /// Settings ▸ General ▸ Create contacts for auto-complete (on unless turned off).
    fn auto_contacts(&self) -> bool {
        self.db.kv_get("autoContacts").ok().flatten().and_then(|v| v.as_bool()).unwrap_or(true)
    }

    /// Remember someone for auto-complete: anyone when that's on, otherwise only people already known.
    fn note_contact(&self, account: &str, email: &str, name: &str, sent_to: bool, at: i64) {
        if self.auto_contacts() || self.db.has_contact(account, email).unwrap_or(false) {
            let _ = self.db.touch_contact(account, email, name, sent_to, at);
        }
    }

    /// New mail: contacts, muted threads, local filters (IMAP), notifications.
    async fn after_new_mail(&self, account: &str, a: &AccountRow, msgs: Vec<crate::db::MessageRow>) {
        let me = a.email.to_lowercase();
        let mut notify = Vec::new();
        for m in &msgs {
            if !m.from_email.is_empty() && m.from_email.to_lowercase() != me {
                self.note_contact(account, &m.from_email, &m.from_name, false, m.internal_date);
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
        // Primary = not in a category that has its own tab (Forums mail stays in Primary while its tab is off).
        let tabs = if a.kind == "gmail" { self.tab_categories() } else { vec![] };
        let chosen: Vec<_> = notify
            .into_iter()
            .filter(|m| {
                let primary = !m.labels.iter().any(|l| tabs.contains(&l.as_str()));
                let important = m.has("IMPORTANT");
                let by_label = m.labels.iter().any(|l| label_rules.get(l).and_then(|v| v.as_bool()).unwrap_or(false));
                match mode {
                    "important" => important || by_label,
                    _ => primary || by_label,
                }
            })
            .collect();
        if chosen.len() > MAX_NOTIFICATIONS {
            // Back after a while offline: one summary instead of a pile of banners.
            let who: Vec<String> = chosen.iter().map(|m| if m.from_name.is_empty() { m.from_email.clone() } else { m.from_name.clone() }).collect::<std::collections::BTreeSet<_>>().into_iter().take(3).collect();
            self.notifier.notify(&format!("{} new messages", chosen.len()), &format!("From {}{}", who.join(", "), if chosen.len() > who.len() { " and others" } else { "" }), account, "");
        } else {
            for m in chosen {
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
                    // Settings ▸ Inbox ▸ Include starred in Primary.
                    let starred = if self.starred_in_primary() { " OR m.labels LIKE '% STARRED %'" } else { "" };
                    parts.push(format!("(NOT ({}){starred})", others.join(" OR ")));
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
        let ledger = self.next_made.load(Ordering::SeqCst) - 1;
        let mut r = self.list_view(v).await?;
        r.ledger = ledger;
        Ok(r)
    }

    async fn list_view(&self, v: &ViewQuery) -> Result<ViewResult> {
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
        // While changes made offline wait to go out, the server's listing is out of date: the cache has them.
        if kind == "gmail" && v.mode.as_deref() == Some("server") && !local_only && self.online.load(Ordering::SeqCst) && self.flush_queue(account).await.is_ok() && !self.db.has_queued(account)? {
            match self.server_list(account, v, limit).await {
                Ok(r) => return Ok(r),
                Err(e) if e.is_offline() => self.set_online(false),
                Err(e) => return Err(e),
            }
        }
        let (threads, total) = self.local_list(account, v, offset, limit)?;
        Ok(ViewResult { has_more: offset + limit < total, total, threads, source: "cache".into(), ..Default::default() })
    }

    pub fn starred_in_primary(&self) -> bool {
        self.db.kv_get("includeStarredInPrimary").ok().flatten().and_then(|v| v.as_bool()).unwrap_or(true)
    }

    /// A view as a Gmail API listing, with Settings ▸ Inbox ▸ Include starred in Primary applied.
    /// The Primary tab is the Inbox minus the enabled tabs' categories (Forums mail is in Primary while its tab is
    /// off), as the cache lists it; the search operator `category:primary` would leave out mail of disabled tabs.
    fn gmail_view_query_for(&self, v: &ViewQuery) -> (Vec<String>, String) {
        let (ids, q) = Self::gmail_view_query(v);
        if v.category.as_deref() != Some("primary") {
            return (ids, q);
        }
        let others: Vec<String> = self.tab_categories().iter().map(|c| format!("category:{}", c.trim_start_matches("CATEGORY_").to_lowercase())).collect();
        let primary = if others.is_empty() {
            String::new()
        } else if self.starred_in_primary() {
            format!("{{is:starred -{{{}}}}}", others.join(" "))
        } else {
            others.iter().map(|c| format!("-{c}")).collect::<Vec<_>>().join(" ")
        };
        (ids, q.replacen("category:primary", &primary, 1).trim().to_string())
    }

    /// A view as a Gmail API listing: label ids and a search query.
    fn gmail_view_query(v: &ViewQuery) -> (Vec<String>, String) {
        let label = v.label.clone().unwrap_or_default();
        let mut label_ids = Vec::new();
        let mut q_parts = Vec::new();
        match label.as_str() {
            "" | "ALL" => {}
            other => label_ids.push(other.to_string()),
        }
        if let Some(cat) = v.category.as_deref().filter(|c| !c.is_empty()) {
            q_parts.push(format!("category:{cat}"));
        }
        if let Some(q) = v.query.as_deref().filter(|q| !q.trim().is_empty()) {
            q_parts.push(q.to_string());
        }
        (label_ids, q_parts.join(" "))
    }

    async fn server_list(&self, account: &str, v: &ViewQuery, limit: i64) -> Result<ViewResult> {
        let g = self.gmail(account)?;
        let label = v.label.clone().unwrap_or_default();
        let (label_ids, q) = self.gmail_view_query_for(v);
        let include_spam_trash = label == "TRASH" || label == "SPAM";
        let read = self.db.begin_read(account);
        let (ids, next, estimate) = gmail::list_page(&g, &read, &label_ids, Some(&q), v.page_token.as_deref(), limit as u32, include_spam_trash).await?;
        if v.page_token.is_none() && !label.is_empty() {
            self.correct_cached_page(&g, account, v, &ids, next.is_none(), limit).await;
        }
        // Conversations this Mac knows newer things about than this listing's read (a change made here, still on its
        // way or landed meanwhile, or a newer answer) follow the cache: out of the page if the cache says they left
        // the view, into the first page if it says they came in.
        let (filter, _) = self.filter_for(account, v)?;
        let known = self.db.threads_known_after(account, read.stamp())?;
        let listed_known: Vec<String> = ids.iter().filter(|t| known.contains(*t)).cloned().collect();
        let stays = self.db.threads_in_view(account, &filter, &listed_known)?;
        let listed_n = ids.len() as i64;
        let mut ids: Vec<String> = ids.into_iter().filter(|t| !known.contains(t) || stays.contains(t)).collect();
        let dropped = listed_n - ids.len() as i64;
        let mut came: Vec<String> = Vec::new();
        if v.page_token.is_none() && !known.is_empty() {
            let missing: Vec<String> = known.iter().filter(|t| !ids.contains(t)).cloned().collect();
            came = self.db.threads_in_view(account, &filter, &missing)?.into_iter().collect();
        }
        drop(read);
        // Locally snoozed threads stay hidden from the inbox.
        let snoozed: HashSet<String> = if label == "INBOX" { self.db.snoozed_thread_ids(account)?.into_iter().map(|x| x.0).collect() } else { HashSet::new() };
        let in_bin = include_spam_trash || search::parse(&q).map(|n| search::mentions_spam_trash(&n)).unwrap_or(false);
        let listed: Vec<(String, i64)> = ids.drain(..).filter(|i| !snoozed.contains(i)).map(|i| (i, 0)).collect();
        let mut threads = self.db.thread_summaries(account, &listed, in_bin)?;
        let mut added = 0i64;
        if !came.is_empty() {
            // Only within the span this page covers (newer than its oldest row, or all when it's the last page).
            let oldest = if next.is_none() { i64::MIN } else { threads.iter().map(|t| t.last_date).min().unwrap_or(i64::MIN) };
            let extra: Vec<(String, i64)> = came.into_iter().filter(|t| !snoozed.contains(t)).map(|t| (t, 0)).collect();
            let extra: Vec<ThreadSummary> = self.db.thread_summaries(account, &extra, in_bin)?.into_iter().filter(|t| t.last_date >= oldest).collect();
            added = extra.len() as i64;
            threads.extend(extra);
            threads.sort_by(|a, b| b.last_date.cmp(&a.last_date));
        }
        let (total, est) = if v.category.is_none() && v.query.as_deref().map(|q| q.trim().is_empty()).unwrap_or(true) && !label.is_empty() && label != "ALL" {
            (self.db.label(account, &label)?.map(|l| l.threads_total).unwrap_or(estimate), false)
        } else {
            // The server's estimate counted what the page listed; the cache's verdict took some out or put some in.
            ((estimate - dropped + added).max(threads.len() as i64), true)
        };
        Ok(ViewResult { has_more: next.is_some(), next_page_token: next, total, estimate: est, threads, source: "server".into(), ledger: 0 })
    }

    /// The cached first page of a view lists conversations the server's first page doesn't (changed on another
    /// device, and the change hasn't reached Courier): ask the server about those, so the cached listing shown
    /// first next time agrees with it.
    async fn correct_cached_page(&self, g: &gmail::Gmail, account: &str, v: &ViewQuery, server: &[String], complete: bool, limit: i64) {
        let mut local = v.clone();
        local.mode = Some("cache".into());
        let Ok((cached, _)) = self.local_list(account, &local, 0, limit) else { return };
        let listed: HashSet<&String> = server.iter().collect();
        // Within the span the server page covers: newer than its oldest row, or everything when it was the last page.
        let oldest = server.iter().filter_map(|id| self.db.thread_messages(account, id).ok()).filter_map(|ms| ms.iter().map(|m| m.internal_date).max()).min().unwrap_or(0);
        let stale: Vec<String> = cached.into_iter().filter(|t| !listed.contains(&t.thread_id) && (complete || t.last_date >= oldest)).map(|t| t.thread_id).take(50).collect();
        if stale.is_empty() {
            return;
        }
        use futures::stream::{self, StreamExt};
        let read = self.db.begin_read(account);
        let read = &read;
        let got: Vec<(String, Result<Value>)> = stream::iter(stale.into_iter().map(|t| async move {
            let r = g.thread_minimal(read, &t).await;
            (t, r)
        }))
        .buffer_unordered(8)
        .collect()
        .await;
        for (t, r) in got {
            let cached = self.db.thread_messages(account, &t).unwrap_or_default();
            match r {
                Ok(v) => {
                    let msgs = v["messages"].as_array().cloned().unwrap_or_default();
                    for m in &msgs {
                        if let Some(id) = m["id"].as_str() {
                            let _ = read.set_labels(id, &gmail::str_labels(m));
                        }
                    }
                    for m in cached.iter().filter(|c| !msgs.iter().any(|x| x["id"].as_str() == Some(c.id.as_str()))) {
                        let _ = read.forget(&m.id);
                    }
                }
                Err(Error::NotFound(_)) => {
                    for m in cached {
                        let _ = read.forget(&m.id);
                    }
                }
                Err(_) => {}
            }
        }
    }

    // ---- reading ----

    /// Make sure a conversation is on this Mac before it's shown. One that's already here in full shows at once;
    /// the server is asked in the background, and the view refreshes only if the conversation changed there.
    pub async fn open_thread(self: &Arc<Self>, account: &str, thread_id: &str) -> Result<()> {
        if self.kind(account)? != "gmail" || !self.online.load(Ordering::SeqCst) {
            return Ok(());
        }
        let snapshot = |e: &Engine| e.db.thread_messages(account, thread_id).map(|ms| ms.into_iter().map(|m| (m.id, m.labels, m.has_raw)).collect::<Vec<_>>());
        let before = snapshot(self)?;
        if !before.is_empty() && before.iter().all(|(_, _, raw)| *raw) {
            let (e, a, t) = (self.clone(), account.to_string(), thread_id.to_string());
            tokio::spawn(async move {
                let Ok(g) = e.gmail(&a) else { return };
                match gmail::ensure_thread(&g, &e.db, &a, &t).await {
                    Ok(()) => {
                        let after = e.db.thread_messages(&a, &t).map(|ms| ms.into_iter().map(|m| (m.id, m.labels, m.has_raw)).collect::<Vec<_>>());
                        if after.ok().as_ref() != Some(&before) {
                            e.changed(&a, "thread");
                        }
                    }
                    Err(err) if err.is_offline() => e.set_online(false),
                    Err(_) => {}
                }
            });
            return Ok(());
        }
        let g = self.gmail(account)?;
        match gmail::ensure_thread(&g, &self.db, account, thread_id).await {
            Ok(()) => {}
            Err(e) if e.is_offline() => self.set_online(false),
            Err(e) => return Err(e),
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

    pub async fn modify_threads(&self, account: &str, thread_ids: &[String], add: &[String], remove: &[String]) -> Result<Changed> {
        Ok(self.change_threads(account, thread_ids, add, remove).await?.result)
    }

    /// Change whole conversations, as the web client does: every message of each one on the server, the ones this
    /// Mac doesn't keep included (mail-API accounts read each conversation when the change goes out). Trash and
    /// spam changes take every message; other changes leave the conversation's trashed or spam messages alone.
    pub async fn change_threads(&self, account: &str, thread_ids: &[String], add: &[String], remove: &[String]) -> Result<Receipt> {
        let (add, remove) = expand_label_rules(add, remove);
        let bin = add.iter().chain(&remove).any(|l| l == "TRASH" || l == "SPAM");
        let ids: Vec<String> = self
            .thread_message_ids(account, thread_ids)?
            .into_iter()
            .filter(|id| bin || self.db.message(account, id).ok().flatten().map(|m| !m.has("TRASH") && !m.has("SPAM")).unwrap_or(true))
            .collect();
        let threads: &[String] = if self.kind(account)? == "gmail" { thread_ids } else { &[] };
        self.change(account, &ids, &add, &remove, threads).await
    }

    /// Every message of these conversations as the server has them now (id, labels), the ones a change applies to:
    /// all for Trash/Spam changes, else those not in Trash or Spam. Read under a `Read`, so the cache learns them too.
    async fn resolve_threads(&self, g: &Gmail, account: &str, threads: &[String], bin: bool) -> Result<Vec<(String, Vec<String>)>> {
        use futures::stream::{self, StreamExt};
        let read = self.db.begin_read(account);
        let read = &read;
        let got: Vec<Result<Value>> = stream::iter(threads.to_vec().into_iter().map(|t| async move { g.thread_minimal(read, &t).await })).buffer_unordered(8).collect().await;
        let mut out = Vec::new();
        for r in got {
            let v = match r {
                Ok(v) => v,
                Err(Error::NotFound(_)) => continue,
                Err(e) => return Err(e),
            };
            for m in v["messages"].as_array().cloned().unwrap_or_default() {
                let Some(id) = m["id"].as_str() else { continue };
                let labels = gmail::str_labels(&m);
                read.set_labels(id, &labels)?;
                if bin || !labels.iter().any(|l| l == "TRASH" || l == "SPAM") {
                    out.push((id.to_string(), labels));
                }
            }
        }
        Ok(out)
    }

    /// Undo a change made here: whatever of it still waits is cancelled, and every message it changed gets back
    /// the labels it touched as they were before (on the server too, the messages this Mac doesn't keep included).
    pub async fn undo_change(&self, account: &str, change: u64) -> Result<Changed> {
        let made = self.made.lock().iter().find(|m| m.id == change && m.account == account).cloned().ok_or_else(|| Error::NotFound("that change".into()))?;
        for t in &made.queued_threads {
            self.db.cancel_queued_thread(account, t, &made.add, &made.remove)?;
        }
        let ids: Vec<String> = made.prior.keys().cloned().collect();
        let cancelled = if made.queued { self.db.cancel_queued(account, &ids, &made.add, &made.remove)? } else { vec![] };
        let touched: Vec<String> = made.add.iter().chain(&made.remove).cloned().collect();
        let mut groups: Vec<(Vec<String>, Vec<String>, Vec<String>)> = Vec::new();
        for (id, before) in made.prior.iter().filter(|(id, _)| !cancelled.contains(id)) {
            let add: Vec<String> = touched.iter().filter(|l| before.contains(l)).cloned().collect();
            let remove: Vec<String> = touched.iter().filter(|l| !before.contains(l)).cloned().collect();
            match groups.iter_mut().find(|g| g.0 == add && g.1 == remove) {
                Some(g) => g.2.push(id.clone()),
                None => groups.push((add, remove, vec![id.clone()])),
            }
        }
        let mut out = if cancelled.is_empty() { Changed::Done } else { Changed::Queued };
        for (add, remove, ids) in groups {
            if self.change(account, &ids, &add, &remove, &[]).await?.result == Changed::Queued {
                out = Changed::Queued;
            }
        }
        Ok(out)
    }

    /// Change labels: here at once, then on the server. Offline, the change waits here (and over a restart) and
    /// goes out when the connection is back; so does one made while earlier ones still wait, after them.
    pub async fn modify_messages(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<Changed> {
        let (add, remove) = expand_label_rules(add, remove);
        Ok(self.change(account, ids, &add, &remove, &[]).await?.result)
    }

    /// A label change, exactly as given: here at once on the cached messages `ids`, then on the server; with
    /// `threads`, on every message of those conversations the server has (read when it goes out).
    async fn change(&self, account: &str, ids: &[String], add: &[String], remove: &[String], threads: &[String]) -> Result<Receipt> {
        if ids.is_empty() && threads.is_empty() {
            return Ok(Receipt { result: Changed::Done, change: self.next_made.fetch_add(1, Ordering::SeqCst) });
        }
        let (add, remove) = (add.to_vec(), remove.to_vec());
        let bin = add.iter().chain(&remove).any(|l| l == "TRASH" || l == "SPAM");
        let gmail = self.kind(account)? == "gmail";
        if self.db.has_queued(account)? {
            let _ = self.flush_queue(account).await;
        }
        let behind = self.db.has_queued(account)?;
        // Optimistic local change first so the UI updates immediately, counts included. It holds until the server
        // answers, whatever a sync reads from the server meanwhile.
        let cached_threads = self.thread_ids_of(account, ids);
        let before = self.db.label_thread_stats(account, &cached_threads)?;
        let had: HashMap<String, Vec<String>> = ids.iter().filter_map(|id| self.db.message(account, id).ok().flatten().map(|m| (id.clone(), m.labels))).collect();
        let change = self.db.begin_change(account, ids, &add, &remove)?;
        if gmail && !threads.is_empty() {
            self.db.begin_thread_change(account, threads, &add, &remove, change)?;
        }
        // Numbered once it shows here: a listing stamped with this number or later has it.
        let id = self.next_made.fetch_add(1, Ordering::SeqCst);
        let after = self.db.label_thread_stats(account, &cached_threads)?;
        if gmail {
            self.db.apply_label_deltas(account, &before, &after)?;
        } else {
            self.db.recount_labels(account).ok();
        }
        self.changed(account, "modify");
        let mut prior = had.clone();
        let result: Result<Vec<String>> = if behind {
            // Earlier changes still wait for the connection; this one waits behind them.
            Err(Error::Offline("earlier changes are still waiting".into()))
        } else if gmail {
            let g = self.gmail(account)?;
            let mut all = ids.to_vec();
            let mut beyond = Vec::new();
            let resolved = if threads.is_empty() { Ok(vec![]) } else { self.resolve_threads(&g, account, threads, bin).await };
            match resolved {
                Ok(found) => {
                    for (m, labels) in found {
                        if !all.contains(&m) {
                            all.push(m.clone());
                            beyond.push(m.clone());
                            prior.insert(m, labels);
                        }
                    }
                    g.batch_modify(&all, &add, &remove).await.map(|_| beyond)
                }
                Err(e) => Err(e),
            }
        } else {
            self.imap_modify(account, ids, &add, &remove).await.map(|_| vec![])
        };
        // Removing INBOX from a snoozed thread that the user then un-archives clears the snooze, etc.
        if gmail && add.iter().any(|l| l == "INBOX") && (result.is_ok() || result.as_ref().is_err_and(Error::is_offline)) {
            for t in self.thread_ids_of(account, ids) {
                let _ = self.db.unsnooze(account, &t);
            }
        }
        if let Err(e) = &result {
            if e.is_offline() {
                if !behind {
                    self.set_online(false);
                }
                self.db.queue_change(account, ids, &add, &remove, &had, change)?;
                for t in threads {
                    self.db.queue_thread(account, t, &add, &remove)?;
                }
                self.db.thread_change_queued(account, change);
                self.remember(Made { id, account: account.into(), add: add.clone(), remove: remove.clone(), prior, queued: true, queued_threads: threads.to_vec() });
                return Ok(Receipt { result: Changed::Queued, change: id });
            }
        }
        self.db.end_change(account, ids, change, result.is_ok())?;
        match result {
            Ok(beyond) => {
                self.db.mark_landed(account, &beyond, &add, &remove);
                if gmail {
                    let touched: Vec<String> = before.keys().chain(after.keys()).chain(&add).chain(&remove).cloned().collect();
                    self.db.counts_landed(account, &touched);
                }
                self.remember(Made { id, account: account.into(), add: add.clone(), remove: remove.clone(), prior, queued: false, queued_threads: vec![] });
                if gmail {
                    // The server's own counts for every label involved.
                    let touched: Vec<String> = before.keys().chain(after.keys()).cloned().collect();
                    if let Ok(g) = self.gmail(account) {
                        let _ = gmail::refresh_label_counts(&g, &self.db, account, &touched).await;
                    }
                } else {
                    self.db.recount_labels(account).ok();
                }
                self.trigger(account);
                self.changed(account, "modify");
                Ok(Receipt { result: Changed::Done, change: id })
            }
            Err(e) => {
                // end_change undid the optimistic change; now its counts.
                if gmail {
                    self.db.apply_label_deltas(account, &after, &before)?;
                } else {
                    self.db.recount_labels(account).ok();
                }
                self.changed(account, "modify-failed");
                Err(e)
            }
        }
    }

    fn remember(&self, m: Made) {
        let mut made = self.made.lock();
        made.push_back(m);
        while made.len() > 100 {
            made.pop_front();
        }
    }

    /// Send the label changes made offline, oldest first, messages with the same change together. No connection
    /// (or a sign-in or rate limit) stops it, and the rest wait for the next try; a change the server refuses is
    /// undone here and the UI is told.
    pub async fn flush_queue(&self, account: &str) -> Result<()> {
        let lock = self.flushing.lock().entry(account.to_string()).or_default().clone();
        let _one_at_a_time = lock.lock().await;
        let queued = self.db.queued_changes(account)?;
        let queued_threads = self.db.queued_threads(account)?;
        let deletes = self.db.queued_deletes(account)?;
        if queued.is_empty() && queued_threads.is_empty() && deletes.is_empty() {
            return Ok(());
        }
        let gmail = self.kind(account)? == "gmail";
        let (mut sent, mut refused, mut threads) = (0, 0, Vec::new());
        let mut outcome = Ok(());
        // Conversation changes first: each conversation is read now and every message the change applies to is
        // changed, the ones this Mac didn't have included; its cached messages' waiting rows go with it.
        let mut covered: HashSet<String> = HashSet::new();
        if gmail {
            let g = self.gmail(account)?;
            for (t, add, remove) in &queued_threads {
                let bin = add.iter().chain(remove).any(|l| l == "TRASH" || l == "SPAM");
                // A cached message's waiting row keeps only what the change does to it, so the conversation's change
                // covers it when the row's labels are all part of it (else it goes out on its own after).
                let cached: Vec<String> = queued
                    .iter()
                    .filter(|q| q.add.iter().all(|l| add.contains(l)) && q.remove.iter().all(|l| remove.contains(l)))
                    .filter(|q| self.db.message(account, &q.message_id).ok().flatten().is_some_and(|m| m.thread_id == *t))
                    .map(|q| q.message_id.clone())
                    .collect();
                let r = match self.resolve_threads(&g, account, std::slice::from_ref(t), bin).await {
                    Ok(found) => {
                        let mut ids: Vec<String> = found.into_iter().map(|(m, _)| m).collect();
                        for c in &cached {
                            if !ids.contains(c) {
                                ids.push(c.clone());
                            }
                        }
                        if ids.is_empty() { Ok(ids) } else { g.batch_modify(&ids, add, remove).await.map(|_| ids) }
                    }
                    Err(e) => Err(e),
                };
                match r {
                    Ok(ids) => {
                        let beyond: Vec<String> = ids.iter().filter(|m| !cached.contains(m)).cloned().collect();
                        for c in &cached {
                            if let Some(q) = queued.iter().find(|q| q.message_id == *c) {
                                self.db.change_sent(account, std::slice::from_ref(c), &q.add, &q.remove)?;
                            }
                        }
                        self.db.mark_landed(account, &beyond, add, remove);
                        self.db.thread_done(account, t)?;
                        covered.extend(cached);
                        threads.push(t.clone());
                        sent += ids.len();
                    }
                    Err(e) if e.is_offline() || e.is_auth() || e.is_rate_limited() => {
                        outcome = Err(e);
                        break;
                    }
                    Err(e) => {
                        crate::applog::warn(&format!("{account}: a change made offline to a conversation was refused ({}): +{add:?} -{remove:?}", e.kind()));
                        self.db.change_refused(account, &cached)?;
                        self.db.thread_done(account, t)?;
                        refused += cached.len().max(1);
                        covered.extend(cached);
                    }
                }
            }
        }
        let mut groups: Vec<(Vec<String>, Vec<String>, Vec<String>)> = Vec::new();
        for q in queued.into_iter().filter(|q| !covered.contains(&q.message_id)) {
            match groups.iter_mut().find(|g| g.0 == q.add && g.1 == q.remove) {
                Some(g) => g.2.push(q.message_id),
                None => groups.push((q.add, q.remove, vec![q.message_id])),
            }
        }
        'groups: for (add, remove, ids) in groups.iter().filter(|_| outcome.is_ok()) {
            for part in ids.chunks(if gmail { 1000 } else { ids.len() }) {
                threads.extend(self.thread_ids_of(account, part));
                let r = if gmail { self.gmail(account)?.batch_modify(part, add, remove).await } else { self.imap_modify(account, part, add, remove).await };
                match r {
                    Ok(()) => {
                        self.db.change_sent(account, part, add, remove)?;
                        sent += part.len();
                    }
                    Err(e) if e.is_offline() || e.is_auth() || e.is_rate_limited() => {
                        outcome = Err(e);
                        break 'groups;
                    }
                    Err(e) => {
                        crate::applog::warn(&format!("{account}: a change made offline to {} message(s) was refused ({}): +{add:?} -{remove:?}", part.len(), e.kind()));
                        self.db.change_refused(account, part)?;
                        refused += part.len();
                    }
                }
            }
        }
        // Delete forever last: whatever was moved first has been.
        if outcome.is_ok() && !deletes.is_empty() {
            let mut gone = HashSet::new();
            match self.delete_on_server(account, gmail, &deletes, &mut gone).await {
                Ok(()) => {}
                Err(e) if e.is_offline() || e.is_auth() || e.is_rate_limited() => outcome = Err(e),
                Err(e) => {
                    let left: Vec<String> = deletes.iter().filter(|id| !gone.contains(*id)).cloned().collect();
                    crate::applog::warn(&format!("{account}: Delete forever made offline was refused for {} message(s) ({})", left.len(), e.kind()));
                    self.db.delete_done(account, &left)?;
                    refused += left.len();
                }
            }
            sent += gone.len();
            self.db.delete_done(account, &gone.into_iter().collect::<Vec<_>>())?;
        }
        if sent + refused > 0 {
            crate::applog::info(&format!("{account}: changes made offline: {sent} message(s) sent, {refused} refused"));
            if gmail {
                let mut touched: Vec<String> = self.db.label_thread_stats(account, &threads)?.into_keys().collect();
                touched.extend(groups.iter().flat_map(|(add, remove, _)| add.iter().chain(remove).cloned()));
                if let Ok(g) = self.gmail(account) {
                    let _ = gmail::refresh_label_counts(&g, &self.db, account, &touched).await;
                }
            } else {
                self.db.recount_labels(account).ok();
            }
            self.changed(account, if refused > 0 { "modify-failed" } else { "modify" });
        }
        if refused > 0 {
            self.emit("queued-changes-refused", json!({"accountId": account, "messages": refused}));
        }
        if outcome.as_ref().is_err_and(Error::is_offline) {
            self.set_online(false);
        }
        outcome
    }

    // ---- Manage subscriptions ----

    /// Senders offering an unsubscribe link, from the cached mail (all accounts for "all"), with the ones Courier
    /// already unsubscribed from marked.
    pub fn subscriptions(&self, account: &str) -> Result<Vec<crate::db::Subscription>> {
        let accounts: Vec<String> = if account == "all" { self.db.accounts()?.into_iter().map(|a| a.id).collect() } else { vec![account.to_string()] };
        let since = now_ms() - 30 * 86_400_000;
        let mut out = Vec::new();
        for a in accounts {
            let done = self.db.kv_get(&format!("unsubscribed:{a}"))?.unwrap_or(json!({}));
            let emails: Vec<String> = done.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            for mut s in self.db.subscriptions(&a, since, &emails)? {
                s.unsubscribed = done[&s.email].as_i64();
                out.push(s);
            }
        }
        out.sort_by(|x, y| y.recent.cmp(&x.recent).then(y.last_date.cmp(&x.last_date)));
        Ok(out)
    }

    pub fn mark_unsubscribed(&self, account: &str, email: &str) -> Result<()> {
        let key = format!("unsubscribed:{account}");
        let mut done = self.db.kv_get(&key)?.unwrap_or(json!({}));
        done[email.to_lowercase()] = json!(now_ms());
        self.db.kv_set(&key, &done)?;
        Ok(())
    }

    // ---- bulk actions ("select all conversations in this view") ----

    /// Every message in a view — all pages, from the server for Gmail and for IMAP folders — except the
    /// conversations in `keep`. Whole conversations, as the web client acts on them: the cached messages of
    /// each matching conversation come along (a reply in Sent goes to Trash with the rest).
    pub async fn view_message_ids(&self, v: &ViewQuery, keep: &HashSet<String>) -> Result<(Vec<(String, String)>, bool)> {
        let account = v.account_id.as_str();
        let label = v.label.clone().unwrap_or_default();
        let kind = self.kind(account)?;
        let mut ids: Vec<(String, String)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut threads: HashSet<String> = HashSet::new();
        let local_only = matches!(label.as_str(), "SNOOZED" | "SCHEDULED" | "OUTBOX");
        let has_query = v.query.as_deref().map(|q| !q.trim().is_empty()).unwrap_or(false) || v.category.as_deref().map(|c| !c.is_empty()).unwrap_or(false);
        // Offline: the conversations this Mac has for the view (the second value says so).
        let mut offline = false;
        let found: Result<()> = async {
            if kind == "gmail" && !local_only {
                let g = self.gmail(account)?;
                let (label_ids, q) = self.gmail_view_query_for(v);
                let mut page: Option<String> = None;
                let read = self.db.begin_read(account);
                loop {
                    let r = g.messages_list(&read, Some(&q), &label_ids, page.as_deref(), 500).await?;
                    for m in r["messages"].as_array().cloned().unwrap_or_default() {
                        let (Some(id), Some(t)) = (m["id"].as_str(), m["threadId"].as_str()) else { continue };
                        if keep.contains(t) {
                            continue;
                        }
                        threads.insert(t.to_string());
                        if seen.insert(id.to_string()) {
                            ids.push((id.to_string(), t.to_string()));
                        }
                    }
                    self.emit("bulk-progress", json!({"accountId": account, "phase": "finding", "found": ids.len()}));
                    page = r["nextPageToken"].as_str().map(str::to_string);
                    if page.is_none() {
                        break;
                    }
                }
            } else if kind == "imap" && !local_only && !has_query && !label.is_empty() && label != "ALL" {
                // A folder: every message in it on the server, not only the cached window.
                if let Some(l) = self.db.label(account, &label)? {
                    if let (Some(path), Some(uv)) = (l.imap_path.clone(), l.imap_uidvalidity) {
                        let acc = self.imap_account(account)?;
                        let mut g = acc.session().await?;
                        let s = g.as_mut().unwrap();
                        let found: Result<Vec<u32>> = async {
                            s.select(&path).await?;
                            Ok(s.uid_search("ALL").await?.into_iter().collect())
                        }
                        .await;
                        let uids = match found {
                            Ok(u) => u,
                            Err(e) => {
                                *g = None;
                                return Err(e);
                            }
                        };
                        let kept: HashSet<String> = keep.iter().flat_map(|t| self.db.thread_messages(account, t).unwrap_or_default()).map(|m| m.id).collect();
                        let mut uids = uids;
                        uids.sort_unstable();
                        for uid in uids.into_iter().rev() {
                            let id = imap::message_id_for(&path, uv as u32, uid);
                            if !kept.contains(&id) && seen.insert(id.clone()) {
                                // Uncached mail has no conversation yet: it counts as its own.
                                let thread = self.db.message(account, &id)?.map(|m| m.thread_id).unwrap_or_else(|| id.clone());
                                ids.push((id, thread));
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        match found {
            Ok(()) => {}
            Err(e) if e.is_offline() => {
                offline = true;
                ids.clear();
                seen.clear();
                threads.clear();
            }
            Err(e) => return Err(e),
        }
        if ids.is_empty() {
            // The cache: every page of the local listing.
            let mut q = v.clone();
            q.conversations = true;
            let mut offset = 0;
            loop {
                let (page, total) = self.local_list(account, &q, offset, 500)?;
                for t in &page {
                    if !keep.contains(&t.thread_id) {
                        threads.insert(t.thread_id.clone());
                    }
                }
                offset += 500;
                if page.is_empty() || offset >= total {
                    break;
                }
            }
        }
        for t in &threads {
            for m in self.db.thread_messages(account, t)? {
                if seen.insert(m.id.clone()) {
                    ids.push((m.id, t.clone()));
                }
            }
        }
        Ok((ids, offline))
    }

    /// Apply a label change to everything in a view except `keep`. A batch the server refuses doesn't stop the
    /// rest; the outcome says how many conversations changed and how many didn't, and which messages changed
    /// (for Undo).
    pub async fn bulk_modify(&self, v: &ViewQuery, add: &[String], remove: &[String], keep: &[String]) -> Result<BulkOutcome> {
        let account = v.account_id.clone();
        let keep: HashSet<String> = keep.iter().cloned().collect();
        let (ids, offline) = self.view_message_ids(v, &keep).await?;
        let total = ids.len();
        self.emit("bulk-progress", json!({"accountId": account, "phase": "working", "done": 0, "total": total}));
        let gmail = self.kind(&account)? == "gmail";
        let chunk = if gmail { 1000 } else { total.max(1) };
        let mut out = BulkTally::default();
        for part in ids.chunks(chunk) {
            let only: Vec<String> = part.iter().map(|(id, _)| id.clone()).collect();
            let r = if offline && gmail {
                // As conversation changes: each conversation's messages this Mac doesn't have go with it.
                let (add, remove) = expand_label_rules(add, remove);
                let mut threads: Vec<String> = part.iter().map(|(_, t)| t.clone()).collect();
                threads.dedup();
                self.change(&account, &only, &add, &remove, &threads).await.map(|r| r.result)
            } else {
                self.modify_messages(&account, &only, add, remove).await
            };
            match r {
                Ok(_) => out.done(part),
                Err(e) if e.is_offline() || e.is_auth() || out.ids.is_empty() && part.len() == total => return Err(e),
                Err(e) => out.failed(part, e),
            }
            self.emit("bulk-progress", json!({"accountId": account, "phase": "working", "done": out.ids.len() + out.failed_ids, "total": total}));
        }
        if let Ok(g) = self.gmail(&account) {
            let _ = gmail::refresh_labels(&g, &self.db, &account).await;
        }
        self.emit("bulk-progress", json!({"accountId": account, "phase": "done", "done": total, "total": total}));
        self.changed(&account, "bulk");
        out.finish().map(|o| BulkOutcome { queued: offline, ..o })
    }

    /// Delete forever everything in Trash or Spam (or a search inside them) except `keep`. As with
    /// `bulk_modify`, a refused batch doesn't stop the rest.
    pub async fn bulk_delete_forever(&self, v: &ViewQuery, keep: &[String]) -> Result<BulkOutcome> {
        let account = v.account_id.clone();
        let label = v.label.clone().unwrap_or_default();
        if label != "TRASH" && label != "SPAM" {
            return Err(Error::msg("Only conversations in Trash or Spam can be deleted forever."));
        }
        let keep: HashSet<String> = keep.iter().cloned().collect();
        let (pairs, offline) = self.view_message_ids(v, &keep).await?;
        let total = pairs.len();
        self.emit("bulk-progress", json!({"accountId": account, "phase": "working", "done": 0, "total": total}));
        if offline {
            let mut threads: Vec<String> = pairs.iter().map(|(_, t)| t.clone()).collect();
            threads.sort();
            threads.dedup();
            let r = self.delete_forever(&account, &threads).await?;
            let mut out = BulkTally::default();
            out.done(&pairs);
            self.emit("bulk-progress", json!({"accountId": account, "phase": "done", "done": total, "total": total}));
            return out.finish().map(|o| BulkOutcome { queued: r == Changed::Queued, ..o });
        }
        if self.kind(&account)? == "gmail" {
            let g = self.gmail(&account)?;
            let mut out = BulkTally::default();
            for part in pairs.chunks(1000) {
                let only: Vec<String> = part.iter().map(|(id, _)| id.clone()).collect();
                match g.batch_delete(&only).await {
                    Ok(()) => {
                        for id in &only {
                            self.db.delete_message(&account, id)?;
                        }
                        out.done(part);
                    }
                    Err(e) if e.is_offline() || e.is_auth() || out.ids.is_empty() && part.len() == total => return Err(e),
                    Err(e) => out.failed(part, e),
                }
                self.emit("bulk-progress", json!({"accountId": account, "phase": "working", "done": out.ids.len() + out.failed_ids, "total": total}));
            }
            let _ = gmail::refresh_labels(&g, &self.db, &account).await;
            self.emit("bulk-progress", json!({"accountId": account, "phase": "done", "done": total, "total": total}));
            self.changed(&account, "delete");
            return out.finish();
        }
        let ids: Vec<String> = pairs.iter().map(|(id, _)| id.clone()).collect();
        {
            let acc = self.imap_account(&account)?;
            let mut g = acc.session().await?;
            let mut by_folder: HashMap<(String, u32), Vec<u32>> = HashMap::new();
            for id in &ids {
                if let Some((path, uv, uid)) = imap::parse_message_id(id) {
                    by_folder.entry((path, uv)).or_default().push(uid);
                }
            }
            for ((folder, uv), uids) in by_folder {
                if let Err(e) = imap::expunge_uids_checked(g.as_mut().unwrap(), &folder, uv, &uids).await {
                    *g = None;
                    return Err(e);
                }
            }
            for id in &ids {
                self.db.delete_message(&account, id)?;
            }
            self.db.recount_labels(&account).ok();
        }
        self.emit("bulk-progress", json!({"accountId": account, "phase": "done", "done": total, "total": total}));
        self.changed(&account, "delete");
        let mut out = BulkTally::default();
        out.done(&pairs);
        out.finish()
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

    /// Delete forever: here at once; offline, it waits and goes out when the connection is back.
    pub async fn delete_forever(&self, account: &str, thread_ids: &[String]) -> Result<Changed> {
        let ids = self.thread_message_ids(account, thread_ids)?;
        let ids: Vec<String> = ids.into_iter().filter(|id| self.db.message(account, id).ok().flatten().map(|m| m.has("TRASH") || m.has("SPAM") || m.has("DRAFT")).unwrap_or(false)).collect();
        if ids.is_empty() {
            return Ok(Changed::Done);
        }
        let gmail = self.kind(account)? == "gmail";
        let threads = self.thread_ids_of(account, &ids);
        let before = self.db.label_thread_stats(account, &threads)?;
        if self.db.has_queued(account)? {
            let _ = self.flush_queue(account).await;
        }
        // Earlier changes still waiting go first (a move to Trash, say); this one waits behind them.
        let behind = self.db.has_queued(account)?;
        let mut done: HashSet<String> = HashSet::new();
        let result = if behind { Err(Error::Offline("earlier changes are still waiting".into())) } else { self.delete_on_server(account, gmail, &ids, &mut done).await };
        match result {
            Ok(()) => {}
            Err(e) if e.is_offline() => {
                // An IMAP message with a move still waiting isn't where the server has it yet: that one needs the
                // connection.
                let waiting: HashSet<String> = if gmail { HashSet::new() } else { self.db.queued_changes(account)?.into_iter().map(|q| q.message_id).collect() };
                let rest: Vec<String> = ids.iter().filter(|id| !done.contains(*id)).cloned().collect();
                if rest.iter().any(|id| waiting.contains(id)) {
                    return Err(e);
                }
                self.db.queue_delete(account, &rest)?;
                if !behind {
                    self.set_online(false);
                }
                self.after_delete(account, gmail, &threads, &before).await?;
                return Ok(Changed::Queued);
            }
            Err(e) => {
                if let Ok(g) = self.gmail(account) {
                    let _ = gmail::refresh_labels(&g, &self.db, account).await;
                }
                self.changed(account, "delete");
                return Err(e);
            }
        }
        self.after_delete(account, gmail, &threads, &before).await?;
        Ok(Changed::Done)
    }

    /// Delete messages on the server, recording in `done` (and dropping from the cache) what it deleted: batch by
    /// batch, so a later batch refused or cut off doesn't lose what went.
    async fn delete_on_server(&self, account: &str, gmail: bool, ids: &[String], done: &mut HashSet<String>) -> Result<()> {
        if gmail {
            let g = self.gmail(account)?;
            for part in ids.chunks(1000) {
                g.batch_delete(part).await?;
                for id in part {
                    self.db.delete_message(account, id)?;
                    done.insert(id.clone());
                }
            }
            return Ok(());
        }
        let acc = self.imap_account(account)?;
        let mut g = acc.session().await?;
        let mut by_folder: HashMap<(String, u32), Vec<(u32, String)>> = HashMap::new();
        for id in ids {
            if let Some((path, uv, uid)) = imap::parse_message_id(id) {
                by_folder.entry((path, uv)).or_default().push((uid, id.clone()));
            }
        }
        for ((folder, uv), msgs) in by_folder {
            let uids: Vec<u32> = msgs.iter().map(|m| m.0).collect();
            if let Err(e) = imap::expunge_uids_checked(g.as_mut().unwrap(), &folder, uv, &uids).await {
                *g = None;
                return Err(e);
            }
            for (_, id) in msgs {
                self.db.delete_message(account, &id)?;
                done.insert(id);
            }
        }
        Ok(())
    }

    /// Counts after messages left the cache by Delete forever.
    async fn after_delete(&self, account: &str, gmail: bool, threads: &[String], before: &HashMap<String, (i64, i64)>) -> Result<()> {
        if gmail {
            let after = self.db.label_thread_stats(account, threads)?;
            self.db.apply_label_deltas(account, before, &after)?;
            let touched: Vec<String> = before.keys().cloned().collect();
            let _ = gmail::refresh_label_counts(&*self.gmail(account)?, &self.db, account, &touched).await;
        } else {
            self.db.recount_labels(account).ok();
        }
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
            // The server copy leaves the inbox (as a label change like any other: shown at once, kept over older
            // answers, waiting when offline); the local record brings it back at `until`.
            let ids = self.thread_message_ids(account, thread_ids)?;
            self.modify_messages(account, &ids, &[], &["INBOX".into()]).await?;
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
            self.modify_messages(account, &ids, &["INBOX".into()], &[]).await?;
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
                    Err(e) if e.is_rate_limited() => {
                        // Try again in a minute; not a reason to call the app offline.
                        let _ = self.db.outbox_retry(row.id, now_ms() + 60_000, &e.to_string());
                        crate::applog::warn(&format!("{}: send postponed: {e}", row.account_id));
                        self.emit("outbox-changed", json!({"accountId": row.account_id, "error": e.to_string()}));
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
                        crate::applog::error(&format!("{}: send failed: {e}", row.account_id));
                        let _ = self.db.outbox_fail(row.id, &e.to_string());
                        self.emit("outbox-changed", json!({"accountId": row.account_id, "error": e.to_string()}));
                    }
                }
            }
        }
    }

    pub async fn send_now(&self, row: &OutboxRow) -> Result<()> {
        let a = self.db.account(&row.account_id)?;
        // Compose ▸ More ▸ Label: the labels ride in a private header that never leaves the Mac.
        let (raw, labels) = take_header(&row.raw, LABELS_HEADER);
        let labels: Vec<String> = labels.map(|v| v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
        let row = &OutboxRow { raw, ..row.clone() };
        if a.kind == "gmail" {
            let g = self.gmail(&row.account_id)?;
            let sent = g.send(&row.raw, row.thread_id.as_deref()).await?;
            if let (Some(id), false) = (sent["id"].as_str(), labels.is_empty()) {
                let _ = g.batch_modify(&[id.to_string()], &labels, &[]).await;
            }
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
            self.note_contact(&row.account_id, r, "", true, now_ms());
        }
        Ok(())
    }

    // ---- unsubscribe ----

    /// RFC 8058 one-click: POST "List-Unsubscribe=One-Click" to the sender's https link, from a client of its own
    /// (no cookies, nothing of the account's), following at most 5 redirects and only to https. Done when the
    /// final answer is 2xx. The caller handles mailto and website links.
    pub async fn unsubscribe_one_click(&self, url: &str) -> Result<()> {
        // Debug and test builds also accept the local fake server.
        let local_fake = cfg!(debug_assertions);
        if !one_click_allowed(url, local_fake) {
            return Err(Error::msg("This sender's unsubscribe link can't be used for one-click unsubscribe."));
        }
        let policy = reqwest::redirect::Policy::custom(move |a| {
            if a.previous().len() >= 5 {
                a.error("too many redirects")
            } else if one_click_allowed(a.url().as_str(), local_fake) {
                a.follow()
            } else {
                a.stop()
            }
        });
        let ms = ONE_CLICK_TIMEOUT_MS.load(Ordering::Relaxed);
        let client = reqwest::Client::builder()
            .redirect(policy)
            .timeout(Duration::from_millis(ms))
            .connect_timeout(Duration::from_millis(ms.min(10_000)))
            .user_agent("Courier")
            .build()
            .map_err(|e| Error::msg(e.to_string()))?;
        let sent = client.post(url).header("Content-Type", "application/x-www-form-urlencoded").body("List-Unsubscribe=One-Click").send().await;
        match sent {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => {
                crate::applog::warn(&format!("one-click unsubscribe: the sender answered {}", r.status()));
                Err(Error::msg("The sender's server didn't confirm it."))
            }
            Err(e) => {
                crate::applog::warn(&format!("one-click unsubscribe: {e}"));
                Err(Error::msg("The sender's server didn't answer."))
            }
        }
    }

    /// Each mailing list a sender has used in the cached mail, by List-Id (mail without one counts as one list),
    /// with the newest message's unsubscribe headers, newest first: Manage subscriptions unsubscribes from each
    /// once. Senders often put a link of its own in every message; the web client uses the newest.
    pub fn sender_lists(&self, account: &str, email: &str) -> Result<Vec<crate::db::SenderList>> {
        self.db.sender_lists(account, email)
    }
}

/// Labels to put on a message once it's sent (Compose ▸ More ▸ Label), removed before it goes out.
pub const LABELS_HEADER: &str = "X-Courier-Labels";

/// A header's value taken out of a message (with its folded lines); the rest of the message as it was.
pub fn take_header(raw: &[u8], name: &str) -> (Vec<u8>, Option<String>) {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 2).unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let key = format!("{}:", name.to_ascii_lowercase());
    let mut out = String::new();
    let mut value: Option<String> = None;
    let mut taking = false;
    for line in head.split_inclusive("\r\n") {
        if line.starts_with(' ') || line.starts_with('\t') {
            if taking {
                value.get_or_insert_with(String::new).push_str(line.trim_end());
            } else {
                out.push_str(line);
            }
            continue;
        }
        taking = line.to_ascii_lowercase().starts_with(&key);
        if taking {
            value = Some(line[key.len()..].trim().to_string());
        } else {
            out.push_str(line);
        }
    }
    let mut v = out.into_bytes();
    v.extend_from_slice(&raw[end..]);
    (v, value)
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

/// How long a one-click unsubscribe request may take (tests shorten it).
pub static ONE_CLICK_TIMEOUT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(15_000);

/// Whether Courier may POST a one-click unsubscribe to `url`: https only, and never to this Mac or the local
/// network (a link in a message must not reach a router or a printer). `local_fake` lets debug builds reach the
/// fake servers on 127.0.0.1 over http.
pub fn one_click_allowed(url: &str, local_fake: bool) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    if local_fake && u.scheme() == "http" && u.host_str() == Some("127.0.0.1") {
        return true;
    }
    if u.scheme() != "https" {
        return false;
    }
    let v4_public = |ip: std::net::Ipv4Addr| {
        let o = ip.octets();
        // Also shared address space (100.64/10) and the benchmarking range (198.18/15).
        !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || o[0] == 100 && o[1] & 0xc0 == 64 || o[0] == 198 && o[1] & 0xfe == 18)
    };
    match u.host() {
        Some(url::Host::Domain(d)) => {
            // "localhost." is localhost.
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            !(d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || d.ends_with(".internal") || !d.contains('.'))
        }
        Some(url::Host::Ipv4(ip)) => v4_public(ip),
        Some(url::Host::Ipv6(ip)) => {
            let seg = ip.segments();
            // An IPv4 address written as IPv6 (::ffff:a.b.c.d, or NAT64's 64:ff9b::/96) is judged as that address.
            let embedded = (seg[..5] == [0; 5] && seg[5] == 0xffff || seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0]).then(|| std::net::Ipv4Addr::new((seg[6] >> 8) as u8, seg[6] as u8, (seg[7] >> 8) as u8, seg[7] as u8));
            match embedded {
                Some(v4) => v4_public(v4),
                None => !(ip.is_loopback() || ip.is_unspecified() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80),
            }
        }
        None => false,
    }
}

/// What a whole-view action did: the messages changed (for Undo) and how many conversations changed or didn't.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkOutcome {
    pub ids: Vec<String>,
    pub conversations: usize,
    pub failed_conversations: usize,
    /// Offline: the conversations this Mac has were changed here and wait to go out.
    pub queued: bool,
}

#[derive(Default)]
struct BulkTally {
    ids: Vec<String>,
    threads: HashSet<String>,
    failed_threads: HashSet<String>,
    failed_ids: usize,
    error: Option<Error>,
}

impl BulkTally {
    fn done(&mut self, part: &[(String, String)]) {
        for (id, t) in part {
            self.ids.push(id.clone());
            self.threads.insert(t.clone());
        }
    }
    fn failed(&mut self, part: &[(String, String)], e: Error) {
        self.failed_ids += part.len();
        self.failed_threads.extend(part.iter().map(|(_, t)| t.clone()));
        self.error = Some(e);
    }
    /// A conversation split across a done and a refused batch counts as not done.
    fn finish(self) -> Result<BulkOutcome> {
        if self.ids.is_empty() {
            if let Some(e) = self.error {
                return Err(e);
            }
        }
        let conversations = self.threads.iter().filter(|t| !self.failed_threads.contains(*t)).count();
        Ok(BulkOutcome { ids: self.ids, conversations, failed_conversations: self.failed_threads.len(), queued: false })
    }
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
    fn the_private_labels_header_is_taken_out_before_sending() {
        let raw = b"From: a@x\r\nX-Courier-Labels: Label_1,\r\n Label_2\r\nSubject: s\r\n\r\nX-Courier-Labels: body text\r\n";
        let (out, v) = take_header(raw, LABELS_HEADER);
        let out = String::from_utf8(out).unwrap();
        // A folded value comes back joined (the sender splits on commas and trims).
        assert_eq!(v.as_deref(), Some("Label_1, Label_2"));
        assert_eq!(out, "From: a@x\r\nSubject: s\r\n\r\nX-Courier-Labels: body text\r\n");
        let (same, none) = take_header(b"From: a@x\r\n\r\nbody", LABELS_HEADER);
        assert_eq!((same.as_slice(), none), (&b"From: a@x\r\n\r\nbody"[..], None));
    }

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
