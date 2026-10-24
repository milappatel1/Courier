//! Commands the web view calls. Thin wrappers over the engine and the cache; errors go back as strings.

use crate::db::{AccountRow, Contact, LabelRow, OutboxRow};
use crate::engine::{account_info, AccountInfo, Changed, Engine, ViewQuery, ViewResult};
use crate::error::{now_ms, random_token, Error, Result};
use crate::imap::{self, ImapAccountConfig};
use crate::oauth::{self, ClientCreds, TokenManager};
use crate::secrets::{self};
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub data_dir: PathBuf,
    pub e2e: Option<Arc<crate::e2e::E2e>>,
    /// Payloads handed to new windows (compose pop-outs, print views).
    pub handoff: Mutex<HashMap<String, Value>>,
    pub pending_open: Mutex<Vec<Value>>,
}

type S<'a> = State<'a, Arc<AppState>>;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn b64(s: &str) -> Result<Vec<u8>> {
    B64.decode(s.trim()).map_err(|e| Error::msg(format!("bad data: {e}")))
}

const ACCOUNT_COLORS: &[&str] = &["#1a73e8", "#0b8043", "#d93025", "#9334e6", "#e37400", "#007b83", "#c5221f", "#3949ab", "#5f6368"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub e2e: bool,
    pub data_dir: String,
    pub online: bool,
    pub platform: String,
}

#[tauri::command]
pub fn app_info(st: S) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        e2e: st.e2e.is_some(),
        data_dir: st.data_dir.display().to_string(),
        online: st.engine.online.load(std::sync::atomic::Ordering::SeqCst),
        platform: std::env::consts::OS.into(),
    }
}

// ---- accounts ----

#[tauri::command]
pub fn accounts_list(st: S) -> Result<Vec<AccountInfo>> {
    Ok(st.engine.db.accounts()?.iter().map(account_info).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleClientStatus {
    pub configured: bool,
    pub client_id_hint: Option<String>,
}

#[tauri::command]
pub async fn google_client_status(st: S<'_>) -> Result<GoogleClientStatus> {
    Ok(match st.engine.google_client() {
        Ok(c) => GoogleClientStatus { configured: true, client_id_hint: Some(format!("{}…", c.client_id.chars().take(12).collect::<String>())) },
        Err(_) => GoogleClientStatus { configured: false, client_id_hint: None },
    })
}

/// Save the cloud-console client (either the downloaded JSON, or an ID + secret) in the Keychain.
#[tauri::command]
pub async fn google_client_set(st: S<'_>, json_text: Option<String>, client_id: Option<String>, client_secret: Option<String>) -> Result<()> {
    let creds = match json_text.filter(|s| !s.trim().is_empty()) {
        Some(j) => ClientCreds::from_json(&j)?,
        None => ClientCreds { client_id: client_id.unwrap_or_default().trim().to_string(), client_secret: client_secret.unwrap_or_default().trim().to_string() },
    };
    if creds.client_id.is_empty() {
        return Err(Error::msg("Enter a client ID."));
    }
    st.engine.secrets.set(secrets::GOOGLE_CLIENT_KEY, &serde_json::to_string(&creds)?)?;
    Ok(())
}

#[tauri::command]
pub async fn google_client_clear(st: S<'_>) -> Result<()> {
    st.engine.secrets.delete(secrets::GOOGLE_CLIENT_KEY)
}

fn next_color(st: &AppState) -> Result<String> {
    let used: Vec<String> = st.engine.db.accounts()?.into_iter().map(|a| a.color).collect();
    Ok(ACCOUNT_COLORS.iter().find(|c| !used.contains(&c.to_string())).unwrap_or(&ACCOUNT_COLORS[used.len() % ACCOUNT_COLORS.len()]).to_string())
}

/// Sign in with the mail API in the browser (PKCE + loopback). Re-signing in an existing account keeps it.
#[tauri::command]
pub async fn account_add_gmail(st: S<'_>, app: AppHandle, login_hint: Option<String>, reauth_id: Option<String>) -> Result<AccountInfo> {
    let engine = st.engine.clone();
    let creds = engine.google_client()?;
    let ep = engine.google_endpoints.read().clone();
    let opener = engine.opener.clone();
    let auth = oauth::authorize(&engine.http, &ep, &creds, login_hint.as_deref(), move |url| opener.open(&url)).await?;
    let info = oauth::userinfo(&engine.http, &ep, &auth.tokens.access_token).await.unwrap_or_default();
    let email = if info.email.is_empty() {
        // Fall back to the mail profile.
        let tmp = Arc::new(TokenManager::new("probe", ep.clone(), creds.clone(), Arc::new(crate::secrets::MemoryStore::default()), engine.http.clone()));
        tmp.save(&auth.tokens)?;
        crate::gmail::Gmail::new(engine.http.clone(), tmp).profile().await?["emailAddress"].as_str().unwrap_or("").to_string()
    } else {
        info.email.clone()
    };
    crate::recon::check_account(&email)?;
    let accounts = engine.db.accounts()?;
    let existing = accounts.iter().find(|a| a.kind == "gmail" && a.email.eq_ignore_ascii_case(&email)).cloned();
    if let Some(id) = &reauth_id {
        if let Some(a) = accounts.iter().find(|a| &a.id == id) {
            if !a.email.eq_ignore_ascii_case(&email) {
                return Err(Error::msg(format!("You signed in as {email}, but this account is {}.", a.email)));
            }
        }
    }
    let id = existing.as_ref().map(|a| a.id.clone()).unwrap_or_else(|| format!("g-{}", random_token(6)));
    TokenManager::new(&id, ep.clone(), creds, engine.secrets.clone(), engine.http.clone()).save(&auth.tokens)?;
    let row = match existing {
        Some(mut a) => {
            a.needs_reauth = false;
            a.config = json!({"endpoints": ep});
            engine.db.update_account(&a)?;
            a
        }
        None => {
            let a = AccountRow {
                id: id.clone(),
                kind: "gmail".into(),
                email: email.clone(),
                name: info.name.clone(),
                color: next_color(&st)?,
                position: accounts.len() as i64,
                config: json!({"endpoints": ep}),
                state: json!({}),
                photo: if info.picture.is_empty() { None } else { Some(info.picture.clone()) },
                created_at: now_ms(),
                needs_reauth: false,
            };
            engine.db.insert_account(&a)?;
            a
        }
    };
    engine.forget_provider(&id);
    engine.start_account(&id);
    engine.emit("accounts-changed", json!({}));
    let _ = app;
    Ok(account_info(&row))
}

#[tauri::command]
pub async fn account_discover(st: S<'_>, email: String) -> Result<Vec<crate::discovery::Discovered>> {
    if let Some(e2e) = &st.e2e {
        if let Some(d) = e2e.discover(&email) {
            return Ok(vec![d]);
        }
    }
    Ok(crate::discovery::discover(&st.engine.http, &email).await)
}

/// Check IMAP login and SMTP before saving an account.
#[tauri::command]
pub async fn account_test_imap(config: ImapAccountConfig, password: String, smtp_password: Option<String>) -> Result<()> {
    let mut s = imap::connect(&config.imap, &password).await?;
    let _ = s.logout().await;
    imap::smtp_test(&config.smtp, smtp_password.as_deref().unwrap_or(&password)).await
}

#[tauri::command]
pub async fn account_add_imap(st: S<'_>, email: String, name: String, config: ImapAccountConfig, password: String, smtp_password: Option<String>, reauth_id: Option<String>) -> Result<AccountInfo> {
    if crate::recon::address().is_some() {
        return Err(Error::msg("This test build signs in only the recon account."));
    }
    account_test_imap(config.clone(), password.clone(), smtp_password.clone()).await?;
    let engine = st.engine.clone();
    let accounts = engine.db.accounts()?;
    let id = reauth_id.clone().unwrap_or_else(|| format!("i-{}", random_token(6)));
    engine.secrets.set(&secrets::password_key(&id), &password)?;
    match smtp_password.filter(|p| !p.is_empty() && *p != password) {
        Some(p) => engine.secrets.set(&secrets::smtp_password_key(&id), &p)?,
        None => engine.secrets.delete(&secrets::smtp_password_key(&id))?,
    }
    let row = if let Some(rid) = reauth_id {
        let mut a = engine.db.account(&rid)?;
        a.config = serde_json::to_value(&config)?;
        a.needs_reauth = false;
        if !name.is_empty() {
            a.name = name;
        }
        engine.db.update_account(&a)?;
        a
    } else {
        if accounts.iter().any(|a| a.email.eq_ignore_ascii_case(&email) && a.kind == "imap") {
            return Err(Error::msg(format!("{email} is already added.")));
        }
        let a = AccountRow {
            id: id.clone(),
            kind: "imap".into(),
            email: email.trim().into(),
            name: name.trim().into(),
            color: next_color(&st)?,
            position: accounts.len() as i64,
            config: serde_json::to_value(&config)?,
            state: json!({}),
            photo: None,
            created_at: now_ms(),
            needs_reauth: false,
        };
        engine.db.insert_account(&a)?;
        a
    };
    engine.forget_provider(&id);
    engine.start_account(&id);
    engine.emit("accounts-changed", json!({}));
    Ok(account_info(&row))
}

#[tauri::command]
pub fn account_update(st: S, id: String, name: Option<String>, color: Option<String>, position: Option<i64>) -> Result<AccountInfo> {
    let mut a = st.engine.db.account(&id)?;
    if let Some(n) = name {
        a.name = n;
    }
    if let Some(c) = color {
        a.color = c;
    }
    if let Some(p) = position {
        a.position = p;
    }
    st.engine.db.update_account(&a)?;
    st.engine.emit("accounts-changed", json!({}));
    Ok(account_info(&a))
}

/// Whether saved sign-ins couldn't be opened this launch (a message for the user, shown once).
#[tauri::command]
pub async fn secrets_notice(st: S<'_>) -> Result<Option<String>> {
    Ok(st.engine.secrets.notice())
}

/// Sign out: tokens/passwords out of the Keychain, the account's cache deleted.
#[tauri::command]
pub async fn account_remove(st: S<'_>, id: String) -> Result<()> {
    st.engine.stop_account(&id);
    secrets::forget_account(&*st.engine.secrets, &id)?;
    st.engine.db.delete_account(&id)?;
    st.engine.emit("accounts-changed", json!({}));
    st.engine.refresh_badge();
    Ok(())
}

// ---- labels ----

/// What's new in each Inbox tab since it was last opened.
#[tauri::command]
pub fn tab_news(st: S, account_id: String) -> Result<Vec<crate::engine::TabNews>> {
    if account_id == "all" {
        return Ok(vec![]);
    }
    st.engine.tab_news(&account_id)
}

#[tauri::command]
pub fn tab_seen(st: S, account_id: String, tab: String) -> Result<()> {
    st.engine.tab_seen(&account_id, &tab)
}

#[tauri::command]
pub fn labels_list(st: S, account_id: String) -> Result<Vec<LabelRow>> {
    st.engine.labels_for_nav(&account_id)
}

#[tauri::command]
pub async fn label_create(st: S<'_>, account_id: String, name: String, bg: Option<String>, fg: Option<String>) -> Result<String> {
    st.engine.label_create(&account_id, &name, bg.as_deref(), fg.as_deref()).await
}

#[tauri::command]
pub async fn label_update(st: S<'_>, account_id: String, id: String, patch: Value) -> Result<()> {
    st.engine.label_update(&account_id, &id, &patch).await
}

#[tauri::command]
pub async fn label_delete(st: S<'_>, account_id: String, id: String) -> Result<()> {
    st.engine.label_delete(&account_id, &id).await
}

// ---- listing & reading ----

#[tauri::command]
pub async fn list_threads(st: S<'_>, view: ViewQuery) -> Result<ViewResult> {
    st.engine.list(&view).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub account_id: String,
    pub thread_id: String,
    pub messages: Vec<Value>,
    pub snoozed_until: Option<i64>,
    pub muted: bool,
}

#[tauri::command]
pub async fn thread_get(st: S<'_>, account_id: String, thread_id: String) -> Result<ThreadDetail> {
    st.engine.open_thread(&account_id, &thread_id).await?;
    let db = &st.engine.db;
    let msgs = db.thread_messages(&account_id, &thread_id)?;
    let mut out = Vec::new();
    for m in msgs {
        let star: Option<String> = db.with(|c| {
            use rusqlite::OptionalExtension;
            c.query_row("SELECT type FROM star_types WHERE account_id=? AND message_id=?", [&account_id, &m.id], |r| r.get(0)).optional()
        })?;
        let draft_id = db.draft_for_message(&account_id, &m.id)?;
        let mut v = serde_json::to_value(&m)?;
        v["starType"] = json!(star);
        v["draftId"] = json!(draft_id);
        out.push(v);
    }
    let snoozed_until = db.snoozed_thread_ids(&account_id)?.into_iter().find(|(t, _)| t == &thread_id).map(|x| x.1);
    let muted = db.is_muted(&account_id, &thread_id)?;
    Ok(ThreadDetail { account_id, thread_id, messages: out, snoozed_until, muted })
}

#[tauri::command]
pub async fn message_raw(st: S<'_>, account_id: String, message_id: String) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(st.engine.raw(&account_id, &message_id).await?))
}

// ---- actions ----

/// The action log in courier.log: what was done, to how many, and how it ended. Never subjects, addresses or
/// message text; label ids only.
fn log_action<T>(account: &str, what: &str, r: &Result<T>) {
    match r {
        Ok(_) => crate::applog::info(&format!("{account}: {what}: done")),
        Err(e) => crate::applog::warn(&format!("{account}: {what}: failed ({})", e.kind())),
    }
}

fn log_change(account: &str, what: &str, r: &Result<Changed>) {
    match r {
        Ok(Changed::Queued) => crate::applog::info(&format!("{account}: {what}: offline, queued")),
        _ => log_action(account, what, r),
    }
}

fn log_bulk(account: &str, what: &str, r: &Result<crate::engine::BulkOutcome>) {
    match r {
        Ok(o) => crate::applog::info(&format!("{account}: {what}: {} conversation(s) done, {} not", o.conversations, o.failed_conversations)),
        Err(e) => crate::applog::warn(&format!("{account}: {what}: failed ({})", e.kind())),
    }
}

fn view_name(v: &ViewQuery) -> String {
    let label = v.label.clone().unwrap_or_else(|| "search".into());
    match v.category.as_deref() {
        Some(c) if !c.is_empty() => format!("{label}/{c}"),
        _ if v.query.as_deref().is_some_and(|q| !q.is_empty()) => format!("{label} (search)"),
        _ => label,
    }
}

#[tauri::command]
pub async fn modify_threads(st: S<'_>, account_id: String, thread_ids: Vec<String>, add: Vec<String>, remove: Vec<String>) -> Result<Changed> {
    let r = st.engine.modify_threads(&account_id, &thread_ids, &add, &remove).await;
    log_change(&account_id, &format!("labels +{add:?} -{remove:?} on {} conversation(s)", thread_ids.len()), &r);
    r
}

#[tauri::command]
pub async fn modify_messages(st: S<'_>, account_id: String, message_ids: Vec<String>, add: Vec<String>, remove: Vec<String>) -> Result<Changed> {
    let r = st.engine.modify_messages(&account_id, &message_ids, &add, &remove).await;
    log_change(&account_id, &format!("labels +{add:?} -{remove:?} on {} message(s)", message_ids.len()), &r);
    r
}

#[tauri::command]
pub fn subscriptions(st: S, account_id: String) -> Result<Vec<crate::db::Subscription>> {
    st.engine.subscriptions(&account_id)
}

#[tauri::command]
pub fn mark_unsubscribed(st: S, account_id: String, email: String) -> Result<()> {
    st.engine.mark_unsubscribed(&account_id, &email)
}

/// "Select all conversations in this view" actions: every page, on the server, minus the ones to keep.
#[tauri::command]
pub async fn bulk_modify(st: S<'_>, view: ViewQuery, add: Vec<String>, remove: Vec<String>, keep: Vec<String>) -> Result<crate::engine::BulkOutcome> {
    let r = st.engine.bulk_modify(&view, &add, &remove, &keep).await;
    let what = format!("whole view {} +{add:?} -{remove:?}, {} kept", view_name(&view), keep.len());
    log_bulk(&view.account_id, &what, &r);
    r
}

#[tauri::command]
pub async fn bulk_delete_forever(st: S<'_>, view: ViewQuery, keep: Vec<String>) -> Result<crate::engine::BulkOutcome> {
    let r = st.engine.bulk_delete_forever(&view, &keep).await;
    log_bulk(&view.account_id, &format!("whole view {} deleted forever, {} kept", view_name(&view), keep.len()), &r);
    r
}

#[tauri::command]
pub async fn delete_forever(st: S<'_>, account_id: String, thread_ids: Vec<String>) -> Result<()> {
    let r = st.engine.delete_forever(&account_id, &thread_ids).await;
    log_action(&account_id, &format!("deleted forever {} conversation(s)", thread_ids.len()), &r);
    r
}

#[tauri::command]
pub async fn empty_label(st: S<'_>, account_id: String, label: String) -> Result<usize> {
    let r = st.engine.empty_label(&account_id, &label).await;
    log_action(&account_id, &format!("emptied {label}{}", r.as_ref().map(|n| format!(" ({n} message(s))")).unwrap_or_default()), &r);
    r
}

#[tauri::command]
pub async fn snooze_threads(st: S<'_>, account_id: String, thread_ids: Vec<String>, until: i64) -> Result<()> {
    let r = st.engine.snooze(&account_id, &thread_ids, until).await;
    log_action(&account_id, &format!("snoozed {} conversation(s)", thread_ids.len()), &r);
    r
}

#[tauri::command]
pub async fn unsnooze_threads(st: S<'_>, account_id: String, thread_ids: Vec<String>) -> Result<()> {
    let r = st.engine.unsnooze(&account_id, &thread_ids).await;
    log_action(&account_id, &format!("unsnoozed {} conversation(s)", thread_ids.len()), &r);
    r
}

#[tauri::command]
pub async fn mute_threads(st: S<'_>, account_id: String, thread_ids: Vec<String>, on: bool) -> Result<()> {
    st.engine.mute(&account_id, &thread_ids, on).await
}

/// Set (or clear) the star type of a message; the server gets STARRED.
#[tauri::command]
pub async fn star_message(st: S<'_>, account_id: String, message_id: String, star_type: Option<String>) -> Result<Changed> {
    st.engine.db.set_star_type(&account_id, &message_id, star_type.as_deref())?;
    if star_type.is_some() {
        st.engine.modify_messages(&account_id, &[message_id], &["STARRED".into()], &[]).await
    } else {
        st.engine.modify_messages(&account_id, &[message_id], &[], &["STARRED".into()]).await
    }
}

#[tauri::command]
pub async fn block_sender(st: S<'_>, account_id: String, email: String) -> Result<()> {
    st.engine.block(&account_id, &email).await
}

#[tauri::command]
pub async fn unblock_sender(st: S<'_>, account_id: String, email: String) -> Result<()> {
    st.engine.unblock(&account_id, &email).await
}

#[tauri::command]
pub fn blocked_list(st: S, account_id: String) -> Result<Vec<String>> {
    Ok(st.engine.db.blocked(&account_id)?.into_iter().map(|x| x.0).collect())
}

// ---- compose ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOptions {
    #[serde(default)]
    pub send_at: Option<i64>,
    #[serde(default)]
    pub scheduled: bool,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub draft_id: Option<String>,
    #[serde(default)]
    pub undo_ms: Option<i64>,
}

#[tauri::command]
pub fn send_message(st: S, account_id: String, raw: String, opts: SendOptions) -> Result<i64> {
    let bytes = b64(&raw)?;
    let at = opts.send_at.unwrap_or_else(|| now_ms() + opts.undo_ms.unwrap_or(5000).max(0));
    st.engine.queue_send(&account_id, &bytes, at, opts.scheduled, opts.thread_id.as_deref(), opts.draft_id.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancelled {
    pub account_id: String,
    pub raw: String,
    pub thread_id: Option<String>,
    pub draft_id: Option<String>,
}

/// Undo send / cancel a scheduled send: hands the message back for the compose window.
#[tauri::command]
pub fn outbox_cancel(st: S, id: i64) -> Result<Option<Cancelled>> {
    Ok(st.engine.cancel_send(id)?.map(|r| Cancelled { account_id: r.account_id, raw: B64.encode(&r.raw), thread_id: r.thread_id, draft_id: r.draft_id }))
}

#[tauri::command]
pub fn outbox_list(st: S) -> Result<Vec<OutboxRow>> {
    st.engine.db.outbox()
}

#[tauri::command]
pub fn outbox_send_now(st: S, id: i64) -> Result<()> {
    st.engine.send_soon(id)
}

#[tauri::command]
pub fn outbox_raw(st: S, id: i64) -> Result<String> {
    Ok(B64.encode(st.engine.db.outbox_item(id)?.ok_or_else(|| Error::NotFound("outbox".into()))?.raw))
}

#[tauri::command]
pub async fn draft_save(st: S<'_>, account_id: String, draft_id: Option<String>, raw: String, thread_id: Option<String>) -> Result<String> {
    let bytes = b64(&raw)?;
    st.engine.draft_save(&account_id, draft_id.as_deref(), &bytes, thread_id.as_deref()).await
}

#[tauri::command]
pub async fn draft_delete(st: S<'_>, account_id: String, draft_id: String) -> Result<()> {
    st.engine.draft_delete(&account_id, &draft_id).await
}

#[tauri::command]
pub fn contacts_search(st: S, account_id: Option<String>, query: String, limit: Option<i64>) -> Result<Vec<Contact>> {
    st.engine.db.search_contacts(account_id.as_deref(), &query, limit.unwrap_or(8))
}

#[tauri::command]
pub fn templates_list(st: S) -> Result<Vec<Value>> {
    st.engine.db.templates()
}

#[tauri::command]
pub fn template_save(st: S, id: Option<String>, account_id: Option<String>, name: String, subject: String, html: String) -> Result<String> {
    let id = id.unwrap_or_else(|| format!("tpl-{}", random_token(6)));
    st.engine.db.save_template(&id, account_id.as_deref(), &name, &subject, &html)?;
    Ok(id)
}

#[tauri::command]
pub fn template_delete(st: S, id: String) -> Result<()> {
    st.engine.db.delete_template(&id)
}

#[tauri::command]
pub fn signatures_list(st: S, account_id: String) -> Result<Vec<Value>> {
    st.engine.db.signatures(&account_id)
}

#[tauri::command]
pub async fn signature_save(st: S<'_>, id: Option<String>, account_id: String, name: String, html: String) -> Result<String> {
    let id = id.unwrap_or_else(|| format!("sig-{}", random_token(6)));
    st.engine.db.save_signature(&id, &account_id, &name, &html)?;
    Ok(id)
}

#[tauri::command]
pub fn signature_delete(st: S, id: String) -> Result<()> {
    st.engine.db.delete_signature(&id)
}

/// Default signatures per send-as address; for mail-API accounts the "new mail" one is also pushed to the
/// server so other clients use it.
#[tauri::command]
pub async fn signature_defaults_set(st: S<'_>, account_id: String, address: String, new_mail: Option<String>, replies: Option<String>) -> Result<()> {
    let key = format!("sigDefaults:{account_id}");
    let mut all = st.engine.db.kv_get(&key)?.unwrap_or(json!({}));
    all[&address] = json!({"newMail": new_mail, "replies": replies});
    st.engine.db.kv_set(&key, &all)?;
    if st.engine.kind(&account_id)? == "gmail" {
        let html = match &new_mail {
            Some(id) => st.engine.db.signatures(&account_id)?.into_iter().find(|s| s["id"] == id.as_str()).and_then(|s| s["html"].as_str().map(str::to_string)).unwrap_or_default(),
            None => String::new(),
        };
        st.engine.gmail(&account_id)?.patch(&format!("/settings/sendAs/{}", crate::gmail::enc(&address)), &json!({"signature": html})).await?;
    }
    Ok(())
}

// ---- settings ----

#[tauri::command]
pub fn settings_all(st: S) -> Result<serde_json::Map<String, Value>> {
    st.engine.db.kv_all()
}

#[tauri::command]
pub fn settings_set(st: S, key: String, value: Value) -> Result<()> {
    st.engine.db.kv_set(&key, &value)?;
    if key == "badge" || key == "categories" {
        st.engine.refresh_badge();
    }
    if key == "syncSeconds" {
        if let Some(n) = value.as_u64() {
            *st.engine.sync_interval.write() = std::time::Duration::from_secs(n.clamp(10, 3600));
        }
    }
    Ok(())
}

// ---- filters ----

#[tauri::command]
pub async fn filters_list(st: S<'_>, account_id: String) -> Result<Vec<Value>> {
    if st.engine.kind(&account_id)? == "gmail" {
        let v = st.engine.gmail(&account_id)?.get("/settings/filters", &[]).await?;
        return Ok(v["filter"].as_array().cloned().unwrap_or_default());
    }
    st.engine.db.local_filters(&account_id)
}

#[tauri::command]
pub async fn filter_create(st: S<'_>, account_id: String, criteria: Value, action: Value, apply_existing: Option<bool>) -> Result<Value> {
    let created = if st.engine.kind(&account_id)? == "gmail" {
        st.engine.gmail(&account_id)?.post("/settings/filters", &json!({"criteria": criteria, "action": action})).await?
    } else {
        let id = format!("lf-{}", random_token(6));
        st.engine.db.add_local_filter(&id, &account_id, &criteria, &action)?;
        json!({"id": id, "criteria": criteria, "action": action})
    };
    // "Also apply filter to matching conversations"
    if apply_existing.unwrap_or(false) {
        let q = crate::engine::criteria_query(&criteria);
        let view = ViewQuery { account_id: account_id.clone(), query: Some(q), page_size: 200, conversations: true, mode: Some("server".into()), ..Default::default() };
        let r = st.engine.list(&view).await?;
        let ids: Vec<String> = r.threads.iter().map(|t| t.thread_id.clone()).collect();
        let add: Vec<String> = action["addLabelIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let remove: Vec<String> = action["removeLabelIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if !ids.is_empty() && (!add.is_empty() || !remove.is_empty()) {
            st.engine.modify_threads(&account_id, &ids, &add, &remove).await?;
        }
    }
    Ok(created)
}

#[tauri::command]
pub async fn filter_delete(st: S<'_>, account_id: String, id: String) -> Result<()> {
    if st.engine.kind(&account_id)? == "gmail" {
        st.engine.gmail(&account_id)?.delete(&format!("/settings/filters/{}", crate::gmail::enc(&id))).await?;
        return Ok(());
    }
    st.engine.db.delete_local_filter(&id)
}

/// Mail-API settings resources: vacation, autoForwarding, imap, pop, language (GET/PUT).
#[tauri::command]
pub async fn server_settings_get(st: S<'_>, account_id: String, which: String) -> Result<Value> {
    if !["vacation", "autoForwarding", "imap", "pop", "language"].contains(&which.as_str()) {
        return Err(Error::msg("unknown setting"));
    }
    st.engine.gmail(&account_id)?.get(&format!("/settings/{which}"), &[]).await
}

#[tauri::command]
pub async fn server_settings_set(st: S<'_>, account_id: String, which: String, value: Value) -> Result<Value> {
    if !["vacation", "autoForwarding", "imap", "pop", "language"].contains(&which.as_str()) {
        return Err(Error::msg("unknown setting"));
    }
    st.engine.gmail(&account_id)?.put(&format!("/settings/{which}"), &value).await
}

#[tauri::command]
pub async fn sendas_list(st: S<'_>, account_id: String) -> Result<Vec<Value>> {
    if st.engine.kind(&account_id)? != "gmail" {
        let a = st.engine.db.account(&account_id)?;
        return Ok(vec![json!({"sendAsEmail": a.email, "displayName": a.name, "isPrimary": true, "isDefault": true, "verificationStatus": "accepted"})]);
    }
    let v = st.engine.gmail(&account_id)?.get("/settings/sendAs", &[]).await?;
    Ok(v["sendAs"].as_array().cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn sendas_save(st: S<'_>, account_id: String, email: String, patch: Value, create: Option<bool>) -> Result<Value> {
    let g = st.engine.gmail(&account_id)?;
    if create.unwrap_or(false) {
        let mut body = patch.clone();
        body["sendAsEmail"] = json!(email);
        return g.post("/settings/sendAs", &body).await;
    }
    g.patch(&format!("/settings/sendAs/{}", crate::gmail::enc(&email)), &patch).await
}

#[tauri::command]
pub async fn sendas_delete(st: S<'_>, account_id: String, email: String) -> Result<()> {
    st.engine.gmail(&account_id)?.delete(&format!("/settings/sendAs/{}", crate::gmail::enc(&email))).await.map(|_| ())
}

#[tauri::command]
pub async fn forwarding_list(st: S<'_>, account_id: String) -> Result<Vec<Value>> {
    let v = st.engine.gmail(&account_id)?.get("/settings/forwardingAddresses", &[]).await?;
    Ok(v["forwardingAddresses"].as_array().cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn forwarding_add(st: S<'_>, account_id: String, email: String) -> Result<Value> {
    st.engine.gmail(&account_id)?.post("/settings/forwardingAddresses", &json!({"forwardingEmail": email})).await
}

#[tauri::command]
pub async fn forwarding_remove(st: S<'_>, account_id: String, email: String) -> Result<()> {
    st.engine.gmail(&account_id)?.delete(&format!("/settings/forwardingAddresses/{}", crate::gmail::enc(&email))).await.map(|_| ())
}

// ---- unsubscribe ----

#[tauri::command]
pub async fn unsubscribe_one_click(st: S<'_>, url: String) -> Result<()> {
    let r = st.engine.unsubscribe_one_click(&url).await;
    log_action("-", "one-click unsubscribe", &r);
    r
}

#[tauri::command]
pub fn sender_lists(st: S, account_id: String, email: String) -> Result<Vec<crate::db::SenderList>> {
    st.engine.sender_lists(&account_id, &email)
}

#[tauri::command]
pub fn unsubscribed_senders(st: S, account_id: String) -> Result<Vec<String>> {
    let done = st.engine.db.kv_get(&format!("unsubscribed:{account_id}"))?.unwrap_or(serde_json::json!({}));
    Ok(done.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default())
}

// ---- sync & status ----

#[tauri::command]
pub fn sync_now(st: S, account_id: Option<String>) {
    match account_id {
        Some(a) => st.engine.trigger(&a),
        None => st.engine.trigger_all(),
    }
}

// ---- files & Mac integration ----

/// A file name that's safe on disk ("attachment" when there's nothing left).
pub fn safe_file_name(name: &str) -> String {
    let safe: String = name.chars().map(|c| if c == '/' || c == '\\' || c == ':' || c.is_control() { '_' } else { c }).collect();
    let safe = safe.trim().trim_start_matches('.').to_string();
    if safe.is_empty() { "attachment".to_string() } else { safe }
}

/// `dir/name`, or `dir/name (1).ext`, `(2)`… when that's taken, as browsers name downloads.
pub fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

fn write_temp(data_dir: &std::path::Path, name: &str, bytes: &[u8]) -> Result<std::path::PathBuf> {
    let dir = data_dir.join("tmp").join(random_token(6));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(safe_file_name(name));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// Write bytes (an attachment) to a private temp folder; returns the path (drag-out, Share).
#[tauri::command]
pub fn temp_file(st: S, name: String, data: String) -> Result<String> {
    Ok(write_temp(&st.data_dir, &name, &b64(&data)?)?.display().to_string())
}

/// Download: straight into the Downloads folder, as a browser does. End-to-end runs use their own folder.
#[tauri::command]
pub fn save_download(app: AppHandle, st: S, name: String, data: String) -> Result<String> {
    use tauri::Manager;
    let dir = if st.e2e.is_some() { st.data_dir.join("Downloads") } else { app.path().download_dir().map_err(|e| Error::msg(e.to_string()))? };
    std::fs::create_dir_all(&dir)?;
    let path = unique_path(&dir, &safe_file_name(&name));
    std::fs::write(&path, b64(&data)?)?;
    Ok(path.display().to_string())
}

/// Open an attachment in the app the Mac uses for it (a PDF in Preview…), from a private copy.
#[tauri::command]
pub fn open_file(st: S, name: String, data: String) -> Result<String> {
    let path = write_temp(&st.data_dir, &name, &b64(&data)?)?;
    let shown = path.display().to_string();
    if let Some(e2e) = &st.e2e {
        e2e.opened.lock().push(format!("file:{shown}"));
        return Ok(shown);
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| Error::msg(e.to_string()))?;
    Ok(shown)
}

/// Show a downloaded file in Finder (only when asked: it brings Finder forward).
#[tauri::command]
pub fn reveal_file(st: S, path: String) -> Result<()> {
    if let Some(e2e) = &st.e2e {
        e2e.opened.lock().push(format!("reveal:{path}"));
        return Ok(());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| Error::msg(e.to_string()))
}

#[tauri::command]
pub fn write_file(path: String, data: String) -> Result<()> {
    std::fs::write(&path, b64(&data)?)?;
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<tauri::ipc::Response> {
    let p = path.strip_prefix("file://").map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).unwrap_or(path);
    Ok(tauri::ipc::Response::new(std::fs::read(p)?))
}

#[tauri::command]
pub fn open_external(st: S, url: String) -> Result<()> {
    let ok = url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") || url.starts_with("tel:");
    if !ok {
        return Err(Error::msg("That link can't be opened."));
    }
    if let Some(e2e) = &st.e2e {
        e2e.opened.lock().push(url);
        return Ok(());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| Error::msg(e.to_string()))
}

/// The clipboard as plain text, for Paste and Match Style. End-to-end runs never read the real clipboard.
#[tauri::command]
pub fn clipboard_text(st: S) -> Option<String> {
    if st.e2e.is_some() {
        return Some("Pasted as plain text".into());
    }
    crate::macos::pasteboard_text()
}

#[tauri::command]
pub fn spell_check(app: AppHandle, texts: Vec<String>) -> Result<Vec<Vec<crate::macos::SpellIssue>>> {
    #[cfg(target_os = "macos")]
    return crate::macos::spell_check(&app, texts).map_err(Error::msg);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(texts.iter().map(|_| vec![]).collect())
    }
}

#[tauri::command]
pub fn share(st: S, window: tauri::WebviewWindow, paths: Vec<String>, text: Option<String>, x: f64, y: f64) -> Result<()> {
    // End-to-end runs record what would be shared instead of showing the Share menu.
    if let Some(e2e) = &st.e2e {
        e2e.opened.lock().push(format!("share:{}", paths.join("|")));
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return crate::macos::share(&window, paths, text, x, y).map_err(Error::msg);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, paths, text, x, y);
        Ok(())
    }
}

#[tauri::command]
pub fn default_mail_app(st: S) -> bool {
    if st.e2e.is_some() {
        return false;
    }
    // Recon mode never offers to become the default mail app.
    if crate::recon::address().is_some() {
        return true;
    }
    #[cfg(target_os = "macos")]
    return crate::macos::is_default_mail_app();
    #[cfg(not(target_os = "macos"))]
    false
}

#[tauri::command]
pub fn set_default_mail_app(st: S, app: AppHandle) -> Result<()> {
    if st.e2e.is_some() || crate::recon::address().is_some() {
        return Err(Error::msg("Not changed during tests."));
    }
    #[cfg(target_os = "macos")]
    return crate::macos::set_default_mail_app(&app).map_err(Error::msg);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub fn badge_refresh(st: S) {
    st.engine.refresh_badge();
}

/// Open a second window (compose pop-out, conversation in a new window, print view).
#[tauri::command]
pub fn window_open(st: S, app: AppHandle, kind: String, payload: Value, title: Option<String>) -> Result<String> {
    let id = random_token(6);
    st.handoff.lock().insert(id.clone(), payload);
    crate::open_window(&app, &kind, &id, title.as_deref().unwrap_or("Courier"), st.e2e.is_some())?;
    Ok(id)
}

#[tauri::command]
pub fn window_take(st: S, id: String) -> Option<Value> {
    st.handoff.lock().remove(&id)
}

/// Things opened before the UI was ready (mailto links, .eml files).
#[tauri::command]
pub fn pending_opens(st: S) -> Vec<Value> {
    std::mem::take(&mut *st.pending_open.lock())
}

#[tauri::command]
pub fn print_window(window: tauri::WebviewWindow, st: S) -> Result<()> {
    if st.e2e.is_some() || std::env::var("COURIER_NO_PRINT").is_ok() {
        return Ok(()); // never print during tests
    }
    window.print().map_err(|e| Error::msg(e.to_string()))
}

// ---- end-to-end hooks (debug builds with COURIER_E2E only) ----

#[tauri::command]
pub fn e2e_info(st: S) -> Result<Value> {
    st.e2e.as_ref().map(|e| e.info()).ok_or_else(|| Error::msg("not running end-to-end tests"))
}

#[tauri::command]
pub async fn e2e_control(app: AppHandle, st: S<'_>, action: String, args: Value) -> Result<Value> {
    let e = st.e2e.as_ref().ok_or_else(|| Error::msg("not running end-to-end tests"))?;
    match action.as_str() {
        #[cfg(debug_assertions)]
        "big-accounts" => e.big_accounts(&st.engine, &args).await,
        "perf-info" => e.perf_info(&app).await,
        // Files saved by Download (end-to-end runs use their own Downloads folder).
        "downloads" => {
            let dir = st.data_dir.join("Downloads");
            let mut names: Vec<String> = std::fs::read_dir(&dir).map(|it| it.filter_map(|x| x.ok()).map(|x| x.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
            names.sort();
            Ok(json!({"names": names}))
        }
        // As if the Mac handed Courier files (Open With, another app's "Email this file").
        "open-files" => {
            let dir = st.data_dir.join("handed");
            std::fs::create_dir_all(&dir)?;
            let mut urls = Vec::new();
            for f in args["files"].as_array().cloned().unwrap_or_default() {
                let path = dir.join(safe_file_name(f["name"].as_str().unwrap_or("file")));
                std::fs::write(&path, f["text"].as_str().unwrap_or("").as_bytes())?;
                urls.push(url::Url::from_file_path(&path).map_err(|_| Error::msg("bad path"))?.to_string());
            }
            crate::handle_opened(&app, &urls);
            Ok(json!({"urls": urls}))
        }
        // As if a notification's Archive button was pressed.
        "notification-action" => {
            crate::notification_action(&app, args["accountId"].as_str().unwrap_or(""), args["threadId"].as_str().unwrap_or(""), args["action"].as_str().unwrap_or(""));
            Ok(json!({}))
        }
        // Whether two-finger swipes go back and forward in the main window's web view.
        "swipe-nav" => {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let w = app.get_webview_window("main").ok_or_else(|| Error::msg("no main window"))?;
                return Ok(json!({"enabled": crate::macos::swipe_navigation_enabled(&w).await}));
            }
            #[cfg(not(target_os = "macos"))]
            Ok(json!({"enabled": false}))
        }
        _ => e.control(&st.engine, &action, &args),
    }
}

#[tauri::command]
pub fn e2e_log(st: S, line: String) {
    if st.e2e.is_some() {
        match line.strip_prefix(':') {
            Some(detail) => eprintln!("[e2e:{detail}"), // ":trace …" → "[e2e:trace …" (kept out of the summary)
            None => eprintln!("[e2e] {line}"),
        }
    }
}

#[tauri::command]
pub fn e2e_finish(st: S, app: AppHandle, report: String, failed: bool) -> Result<()> {
    let e = st.e2e.as_ref().ok_or_else(|| Error::msg("not running end-to-end tests"))?;
    std::fs::write(&e.report_path, report)?;
    eprintln!("[e2e] report written: {}", e.report_path);
    let code = if failed { 1 } else { 0 };
    app.exit(code);
    Ok(())
}
