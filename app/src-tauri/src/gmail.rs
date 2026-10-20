//! Mail API client (REST over HTTPS) and its sync into the local cache: an initial window, then
//! incremental changes by history ID, plus on-demand pages and threads.

use crate::db::{AttachmentMeta, Db, LabelRow, MessageRow};
use crate::error::{Error, Result};
use crate::mailmeta;
use crate::oauth::TokenManager;
use base64::Engine as _;
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

pub struct Gmail {
    pub http: reqwest::Client,
    pub tokens: Arc<TokenManager>,
    pub base: String,
    pub people: String,
}

const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub fn encode_raw(raw: &[u8]) -> String {
    B64URL.encode(raw)
}

pub fn decode_raw(s: &str) -> Result<Vec<u8>> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace() && *c != '=').collect();
    B64URL.decode(cleaned.replace('+', "-").replace('/', "_")).map_err(|e| Error::msg(format!("bad raw message: {e}")))
}

impl Gmail {
    pub fn new(http: reqwest::Client, tokens: Arc<TokenManager>) -> Self {
        let base = tokens.endpoints.api_base.trim_end_matches('/').to_string();
        let people = tokens.endpoints.people_base.trim_end_matches('/').to_string();
        Gmail { http, tokens, base, people }
    }

    async fn call(&self, method: Method, url: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value> {
        let mut attempt = 0;
        let mut refreshed = false;
        loop {
            attempt += 1;
            let token = self.tokens.access_token().await?;
            let mut rb = self.http.request(method.clone(), url).bearer_auth(&token).query(query);
            if let Some(b) = body {
                rb = rb.json(b);
            }
            let resp = rb.send().await?;
            let status = resp.status().as_u16();
            if status == 401 && !refreshed {
                refreshed = true;
                self.tokens.force_refresh(Some(&token)).await?;
                continue;
            }
            if status >= 500 && attempt < 4 {
                tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
                continue;
            }
            let text = resp.text().await?;
            if (200..300).contains(&status) {
                return Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text)? });
            }
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let msg = v["error"]["message"].as_str().unwrap_or(&text).to_string();
            // Gmail slows a busy app down with 429, or with 403 "User-rate limit exceeded": wait and retry.
            let limited = status == 429 || (status == 403 && is_rate_limit(&v));
            if limited && attempt < 6 {
                tokio::time::sleep(rate_limit_wait(attempt)).await;
                continue;
            }
            // Now and then the API refuses a request with 400 failedPrecondition and takes the same request a
            // moment later (seen on lists, label changes and sends alike); it changed nothing, so try again.
            if status == 400 && is_failed_precondition(&v) && attempt < 4 {
                tokio::time::sleep(rate_limit_wait(attempt) / 2).await;
                continue;
            }
            // Status and reason only: the server's message can quote an address or a header.
            crate::applog::warn(&format!("mail API {} {} → {status} {}", method, api_path(url), api_reason(&v)));
            return Err(match status {
                401 => Error::Auth(msg),
                404 => Error::NotFound(msg),
                // Still limited, busy or down after the retries above: treat like no connection, so sends wait in
                // the outbox and sync backs off, instead of failing for good.
                _ if limited => Error::RateLimited("Gmail is busy right now. Courier will try again shortly.".into()),
                500..=599 => Error::Offline(format!("server unavailable ({status})")),
                _ => Error::Server(format!("{status}: {msg}")),
            });
        }
    }

    pub async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        self.call(Method::GET, &format!("{}{}", self.base, path), query, None).await
    }
    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(Method::POST, &format!("{}{}", self.base, path), &[], Some(body)).await
    }
    pub async fn put(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(Method::PUT, &format!("{}{}", self.base, path), &[], Some(body)).await
    }
    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(Method::PATCH, &format!("{}{}", self.base, path), &[], Some(body)).await
    }
    pub async fn delete(&self, path: &str) -> Result<Value> {
        self.call(Method::DELETE, &format!("{}{}", self.base, path), &[], None).await
    }

    // ---- core resources ----

    pub async fn profile(&self) -> Result<Value> {
        self.get("/profile", &[]).await
    }
    pub async fn labels(&self) -> Result<Vec<Value>> {
        Ok(self.get("/labels", &[]).await?["labels"].as_array().cloned().unwrap_or_default())
    }
    pub async fn label(&self, id: &str) -> Result<Value> {
        self.get(&format!("/labels/{}", enc(id)), &[]).await
    }
    pub async fn message_raw(&self, id: &str) -> Result<Value> {
        self.get(&format!("/messages/{}", enc(id)), &[("format", "raw".into())]).await
    }
    pub async fn thread_minimal(&self, id: &str) -> Result<Value> {
        self.get(&format!("/threads/{}", enc(id)), &[("format", "minimal".into())]).await
    }
    pub async fn thread_metadata(&self, id: &str) -> Result<Value> {
        let mut q: Vec<(&str, String)> = vec![("format", "metadata".into())];
        for h in METADATA_HEADERS {
            q.push(("metadataHeaders", h.to_string()));
        }
        self.get(&format!("/threads/{}", enc(id)), &q).await
    }
    pub async fn threads_list(&self, label_ids: &[String], q: Option<&str>, page_token: Option<&str>, max: u32, include_spam_trash: bool) -> Result<Value> {
        let mut query: Vec<(&str, String)> = vec![("maxResults", max.to_string())];
        for l in label_ids {
            query.push(("labelIds", l.clone()));
        }
        if let Some(q) = q.filter(|q| !q.is_empty()) {
            query.push(("q", q.to_string()));
        }
        if let Some(p) = page_token {
            query.push(("pageToken", p.to_string()));
        }
        if include_spam_trash {
            query.push(("includeSpamTrash", "true".into()));
        }
        self.get("/threads", &query).await
    }
    pub async fn messages_list(&self, q: Option<&str>, label_ids: &[String], page_token: Option<&str>, max: u32) -> Result<Value> {
        let mut query: Vec<(&str, String)> = vec![("maxResults", max.to_string())];
        for l in label_ids {
            query.push(("labelIds", l.clone()));
        }
        if let Some(q) = q.filter(|q| !q.is_empty()) {
            query.push(("q", q.to_string()));
        }
        if let Some(p) = page_token {
            query.push(("pageToken", p.to_string()));
        }
        self.get("/messages", &query).await
    }
    pub async fn history(&self, start: &str, page_token: Option<&str>) -> Result<Value> {
        let mut q: Vec<(&str, String)> = vec![("startHistoryId", start.to_string()), ("maxResults", "500".into())];
        if let Some(p) = page_token {
            q.push(("pageToken", p.to_string()));
        }
        self.get("/history", &q).await
    }
    pub async fn batch_modify(&self, ids: &[String], add: &[String], remove: &[String]) -> Result<()> {
        for chunk in ids.chunks(1000) {
            self.post("/messages/batchModify", &json!({"ids": chunk, "addLabelIds": add, "removeLabelIds": remove})).await?;
        }
        Ok(())
    }
    pub async fn thread_modify(&self, id: &str, add: &[String], remove: &[String]) -> Result<Value> {
        self.post(&format!("/threads/{}/modify", enc(id)), &json!({"addLabelIds": add, "removeLabelIds": remove})).await
    }
    pub async fn thread_trash(&self, id: &str) -> Result<Value> {
        self.post(&format!("/threads/{}/trash", enc(id)), &json!({})).await
    }
    pub async fn thread_untrash(&self, id: &str) -> Result<Value> {
        self.post(&format!("/threads/{}/untrash", enc(id)), &json!({})).await
    }
    pub async fn message_trash(&self, id: &str) -> Result<Value> {
        self.post(&format!("/messages/{}/trash", enc(id)), &json!({})).await
    }
    pub async fn message_untrash(&self, id: &str) -> Result<Value> {
        self.post(&format!("/messages/{}/untrash", enc(id)), &json!({})).await
    }
    pub async fn batch_delete(&self, ids: &[String]) -> Result<()> {
        for chunk in ids.chunks(1000) {
            self.post("/messages/batchDelete", &json!({"ids": chunk})).await?;
        }
        Ok(())
    }
    pub async fn send(&self, raw: &[u8], thread_id: Option<&str>) -> Result<Value> {
        let mut body = json!({"raw": encode_raw(raw)});
        if let Some(t) = thread_id {
            body["threadId"] = json!(t);
        }
        self.post("/messages/send", &body).await
    }
    pub async fn draft_create(&self, raw: &[u8], thread_id: Option<&str>) -> Result<Value> {
        let mut m = json!({"raw": encode_raw(raw)});
        if let Some(t) = thread_id {
            m["threadId"] = json!(t);
        }
        self.post("/drafts", &json!({"message": m})).await
    }
    pub async fn draft_update(&self, id: &str, raw: &[u8], thread_id: Option<&str>) -> Result<Value> {
        let mut m = json!({"raw": encode_raw(raw)});
        if let Some(t) = thread_id {
            m["threadId"] = json!(t);
        }
        self.put(&format!("/drafts/{}", enc(id)), &json!({"id": id, "message": m})).await
    }
    pub async fn draft_delete(&self, id: &str) -> Result<()> {
        self.delete(&format!("/drafts/{}", enc(id))).await.map(|_| ())
    }
    pub async fn drafts_list(&self, page_token: Option<&str>) -> Result<Value> {
        let mut q: Vec<(&str, String)> = vec![("maxResults", "100".into())];
        if let Some(p) = page_token {
            q.push(("pageToken", p.to_string()));
        }
        self.get("/drafts", &q).await
    }
    pub async fn label_create(&self, body: &Value) -> Result<Value> {
        self.post("/labels", body).await
    }
    pub async fn label_patch(&self, id: &str, body: &Value) -> Result<Value> {
        self.patch(&format!("/labels/{}", enc(id)), body).await
    }
    pub async fn label_delete(&self, id: &str) -> Result<()> {
        self.delete(&format!("/labels/{}", enc(id))).await.map(|_| ())
    }

    // ---- People API (optional; needs the contacts scopes) ----

    pub async fn other_contacts(&self, page_token: Option<&str>) -> Result<Value> {
        let mut q: Vec<(&str, String)> = vec![("readMask", "names,emailAddresses".into()), ("pageSize", "1000".into())];
        if let Some(p) = page_token {
            q.push(("pageToken", p.to_string()));
        }
        self.call(Method::GET, &format!("{}/otherContacts", self.people), &q, None).await
    }
    pub async fn connections(&self, page_token: Option<&str>) -> Result<Value> {
        let mut q: Vec<(&str, String)> = vec![("personFields", "names,emailAddresses".into()), ("pageSize", "1000".into())];
        if let Some(p) = page_token {
            q.push(("pageToken", p.to_string()));
        }
        self.call(Method::GET, &format!("{}/people/me/connections", self.people), &q, None).await
    }
}

pub fn enc(s: &str) -> String {
    crate::http::url_encode(s)
}

const METADATA_HEADERS: &[&str] = &["From", "To", "Cc", "Bcc", "Reply-To", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Delivered-To"];

// ---- conversions ----

pub fn label_row(account: &str, v: &Value) -> LabelRow {
    LabelRow {
        account_id: account.into(),
        id: v["id"].as_str().unwrap_or("").into(),
        name: v["name"].as_str().unwrap_or("").into(),
        kind: if v["type"].as_str() == Some("system") { "system".into() } else { "user".into() },
        bg: v["color"]["backgroundColor"].as_str().map(str::to_string),
        fg: v["color"]["textColor"].as_str().map(str::to_string),
        label_list_visibility: v["labelListVisibility"].as_str().map(str::to_string),
        message_list_visibility: v["messageListVisibility"].as_str().map(str::to_string),
        threads_total: v["threadsTotal"].as_i64().unwrap_or(0),
        threads_unread: v["threadsUnread"].as_i64().unwrap_or(0),
        messages_total: v["messagesTotal"].as_i64().unwrap_or(0),
        messages_unread: v["messagesUnread"].as_i64().unwrap_or(0),
        ..Default::default()
    }
}

pub fn str_labels(v: &Value) -> Vec<String> {
    v["labelIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn internal_date(v: &Value) -> i64 {
    v["internalDate"].as_str().and_then(|s| s.parse().ok()).or_else(|| v["internalDate"].as_i64()).unwrap_or(0)
}

/// Cache a message fetched with format=raw (full content, indexed).
pub fn ingest_raw(db: &Db, account: &str, v: &Value) -> Result<MessageRow> {
    let raw = decode_raw(v["raw"].as_str().unwrap_or(""))?;
    let mut row = mailmeta::parse_raw(&raw).row;
    row.account_id = account.into();
    row.id = v["id"].as_str().unwrap_or("").into();
    row.thread_id = v["threadId"].as_str().unwrap_or(&row.id).into();
    row.labels = str_labels(v);
    let d = internal_date(v);
    if d > 0 {
        row.internal_date = d;
    }
    if let Some(s) = v["snippet"].as_str() {
        if !s.is_empty() {
            row.snippet = crate::mailmeta::html_to_text(s);
        }
    }
    if let Some(n) = v["sizeEstimate"].as_i64() {
        row.size = n;
    }
    row.has_raw = true;
    db.upsert_message(&row, Some(&raw))?;
    Ok(row)
}

fn header<'a>(headers: &'a [Value], name: &str) -> Option<&'a str> {
    headers.iter().find(|h| h["name"].as_str().map(|n| n.eq_ignore_ascii_case(name)).unwrap_or(false)).and_then(|h| h["value"].as_str())
}

fn walk_parts(p: &Value, out: &mut Vec<AttachmentMeta>) {
    let name = p["filename"].as_str().unwrap_or("");
    if !name.is_empty() {
        let inline_cid = p["headers"].as_array().map(|h| header(h, "Content-ID").is_some() && header(h, "Content-Disposition").map(|d| d.to_lowercase().starts_with("inline")).unwrap_or(false)).unwrap_or(false);
        let mime = p["mimeType"].as_str().unwrap_or("application/octet-stream").to_lowercase();
        if !(inline_cid && mime.starts_with("image/")) {
            out.push(AttachmentMeta { name: name.into(), mime, size: p["body"]["size"].as_i64().unwrap_or(0) });
        }
    }
    if let Some(parts) = p["parts"].as_array() {
        for c in parts {
            walk_parts(c, out);
        }
    }
}

/// Cache a message from format=metadata/full (headers, labels, snippet; no body text). Keeps any raw.
pub fn ingest_metadata(db: &Db, account: &str, v: &Value) -> Result<MessageRow> {
    let id = v["id"].as_str().unwrap_or("").to_string();
    if let Some(existing) = db.message(account, &id)? {
        if existing.has_raw {
            // We already have the full message; just refresh labels.
            db.set_labels(account, &id, &str_labels(v))?;
            return Ok(MessageRow { labels: str_labels(v), ..existing });
        }
    }
    let headers = v["payload"]["headers"].as_array().cloned().unwrap_or_default();
    // Re-use the raw parser on a synthetic header block so address/encoded-word handling is identical.
    let mut block = String::new();
    for h in &headers {
        if let (Some(n), Some(val)) = (h["name"].as_str(), h["value"].as_str()) {
            block.push_str(&format!("{n}: {val}\r\n"));
        }
    }
    block.push_str("\r\n");
    let mut row = mailmeta::parse_raw(block.as_bytes()).row;
    row.account_id = account.into();
    row.id = id;
    row.thread_id = v["threadId"].as_str().unwrap_or(&row.id).into();
    row.labels = str_labels(v);
    row.snippet = crate::mailmeta::html_to_text(v["snippet"].as_str().unwrap_or(""));
    row.size = v["sizeEstimate"].as_i64().unwrap_or(0);
    let d = internal_date(v);
    if d > 0 {
        row.internal_date = d;
    }
    let mut atts = Vec::new();
    walk_parts(&v["payload"], &mut atts);
    row.attachments = atts;
    row.body_text = String::new();
    db.upsert_message(&row, None)?;
    Ok(row)
}

// ---- sync ----

#[derive(Default, Debug)]
pub struct SyncReport {
    pub new_messages: Vec<MessageRow>,
    pub changed: bool,
    pub history_id: Option<String>,
}

/// Re-read the counts of the labels an action or a sync touched (one small request each).
pub async fn refresh_label_counts(g: &Gmail, db: &Db, account: &str, ids: &[String]) -> Result<()> {
    use futures::stream::{self, StreamExt};
    let known: HashSet<String> = db.labels(account)?.into_iter().map(|l| l.id).collect();
    // The server's count for a label a pending change touches is about to change: keep ours until it has.
    let pending = db.pending_labels(account);
    let mut want: Vec<String> = ids.iter().filter(|i| known.contains(*i) && !pending.contains(*i)).cloned().collect();
    want.sort();
    want.dedup();
    let got: Vec<Result<Value>> = stream::iter(want.into_iter().map(|id| async move { g.label(&id).await })).buffer_unordered(4).collect().await;
    for v in got {
        match v {
            Ok(v) => {
                let n = |k: &str| v[k].as_i64().unwrap_or(0);
                if let Some(id) = v["id"].as_str() {
                    db.set_label_counts(account, id, (n("threadsTotal"), n("threadsUnread"), n("messagesTotal"), n("messagesUnread")))?;
                }
            }
            Err(e) if e.is_offline() || e.is_auth() || e.is_rate_limited() => return Err(e),
            Err(_) => {}
        }
    }
    Ok(())
}

/// How often the whole label list is re-read even without changes (labels made elsewhere, counts of mail
/// that isn't cached).
pub const LABELS_REFRESH_MS: i64 = 10 * 60 * 1000;

pub async fn refresh_labels(g: &Gmail, db: &Db, account: &str) -> Result<()> {
    use futures::stream::{self, StreamExt};
    let labels = g.labels().await?;
    // labels.list omits counts; each label's own request has them.
    let got: Vec<(Value, Result<Value>)> = stream::iter(labels.iter().cloned().map(|l| async move {
        let id = l["id"].as_str().unwrap_or("").to_string();
        let full = if l.get("threadsTotal").is_some() { Ok(l.clone()) } else { g.label(&id).await };
        (l, full)
    }))
    .buffered(4)
    .collect()
    .await;
    let mut keep = Vec::new();
    let pending = db.pending_labels(account);
    for (l, full) in got {
        let id = l["id"].as_str().unwrap_or("").to_string();
        match full {
            Ok(full) if !pending.contains(&id) => db.upsert_label(&label_row(account, &full))?,
            Err(e) if e.is_offline() || e.is_auth() => return Err(e),
            // Couldn't read the counts this time (rate limit, a hiccup), or a pending change is about to move
            // them: keep the ones we have, not zeros.
            _ => {
                let mut row = label_row(account, &l);
                if let Some(old) = db.label(account, &id)? {
                    (row.threads_total, row.threads_unread, row.messages_total, row.messages_unread) = (old.threads_total, old.threads_unread, old.messages_total, old.messages_unread);
                }
                db.upsert_label(&row)?;
            }
        }
        keep.push(id);
    }
    for old in db.labels(account)? {
        if old.kind == "user" && !keep.contains(&old.id) {
            db.delete_label(account, &old.id)?;
        }
    }
    db.set_account_state(account, "labelsRefreshedAt", json!(crate::error::now_ms())).ok();
    Ok(())
}

/// Fetch full messages we don't have yet, a few at a time.
/// Fetch and cache messages in full. A message that keeps failing is skipped (it's fetched again when opened),
/// so one bad message can't hold up a whole sync; no connection or a needed sign-in still stops it.
pub async fn fetch_raw_many(g: &Gmail, db: &Db, account: &str, ids: Vec<String>) -> Result<Vec<MessageRow>> {
    use futures::stream::{self, StreamExt};
    // A few at a time: Gmail rate-limits bursts per user.
    let results: Vec<Result<MessageRow>> = stream::iter(ids.into_iter().map(|id| async move {
        let v = g.message_raw(&id).await?;
        ingest_raw(db, account, &v)
    }))
    .buffer_unordered(4)
    .collect()
    .await;
    let mut out = Vec::new();
    let mut skipped = 0usize;
    let mut last_skip = String::new();
    for r in results {
        match r {
            Ok(m) => out.push(m),
            Err(Error::NotFound(_)) => {}
            Err(e) if e.is_offline() || e.is_auth() || e.is_rate_limited() => return Err(e),
            Err(e) => {
                skipped += 1;
                last_skip = e.to_string();
            }
        }
    }
    if skipped > 0 {
        crate::applog::warn(&format!("{account}: skipped {skipped} message(s) while syncing: {last_skip}"));
    }
    Ok(out)
}

/// The Inbox count (and Dock badge) is computed from the cache, which otherwise holds only the recent window:
/// make sure every unread Inbox conversation outside the category tabs (`skip_categories`) is cached, however old.
/// One list request per sync; only missing conversations are fetched (as metadata). Returns how many were added.
pub async fn backfill_unread_inbox(g: &Gmail, db: &Db, account: &str, skip_categories: &[&str]) -> Result<usize> {
    use futures::stream::{self, StreamExt};
    let mut q = String::from("in:inbox is:unread -in:chats");
    for c in skip_categories {
        q.push_str(&format!(" -category:{}", c.trim_start_matches("CATEGORY_").to_lowercase()));
    }
    let mut missing: Vec<String> = Vec::new();
    let mut page: Option<String> = None;
    let mut seen = 0usize;
    loop {
        let r = g.messages_list(Some(&q), &[], page.as_deref(), 500).await?;
        for m in r["messages"].as_array().cloned().unwrap_or_default() {
            seen += 1;
            let (Some(id), Some(tid)) = (m["id"].as_str(), m["threadId"].as_str()) else { continue };
            if !db.has_message(account, id).unwrap_or(false) && !missing.iter().any(|t| t == tid) {
                missing.push(tid.to_string());
            }
        }
        page = r["nextPageToken"].as_str().map(str::to_string);
        if page.is_none() || seen >= 2000 {
            break;
        }
    }
    let n = missing.len();
    let fetched: Vec<Result<Value>> = stream::iter(missing.into_iter().map(|id| async move { g.thread_metadata(&id).await })).buffer_unordered(8).collect().await;
    for t in fetched {
        match t {
            Ok(t) => {
                for m in t["messages"].as_array().cloned().unwrap_or_default() {
                    ingest_metadata(db, account, &m)?;
                }
            }
            Err(Error::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// First sync: labels, then the offline window (newest first, capped).
pub async fn initial_sync(g: &Gmail, db: &Db, account: &str, window_days: u32, max_messages: usize) -> Result<SyncReport> {
    let profile = g.profile().await?;
    let history_id = profile["historyId"].as_str().map(str::to_string).or_else(|| profile["historyId"].as_i64().map(|n| n.to_string()));
    refresh_labels(g, db, account).await?;
    let q = format!("newer_than:{window_days}d -in:chats");
    let mut ids = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let r = g.messages_list(Some(&q), &[], page.as_deref(), 500).await?;
        for m in r["messages"].as_array().cloned().unwrap_or_default() {
            if let Some(id) = m["id"].as_str() {
                ids.push(id.to_string());
            }
        }
        page = r["nextPageToken"].as_str().map(str::to_string);
        if page.is_none() || ids.len() >= max_messages {
            break;
        }
    }
    ids.truncate(max_messages);
    let missing: Vec<String> = ids.into_iter().filter(|id| !db.has_message(account, id).unwrap_or(false)).collect();
    let fetched = fetch_raw_many(g, db, account, missing).await?;
    sync_drafts(g, db, account).await.ok();
    if let Some(h) = &history_id {
        db.set_account_state(account, "historyId", json!(h))?;
    }
    db.set_account_state(account, "initialSyncDone", json!(true))?;
    Ok(SyncReport { new_messages: vec![], changed: !fetched.is_empty(), history_id })
}

/// After a full resync: the history that would have told Courier what changed is gone, so ask the server about
/// each cached message (newest first, at most `limit`): deleted ones leave the cache, the rest get their current
/// labels. Returns how many changed.
pub async fn reconcile_cache(g: &Gmail, db: &Db, account: &str, limit: i64) -> Result<usize> {
    use futures::stream::{self, StreamExt};
    let ids = db.message_ids(account, limit)?;
    let got: Vec<(String, Result<Value>)> = stream::iter(ids.into_iter().map(|id| async move {
        let r = g.get(&format!("/messages/{}", enc(&id)), &[("format", "minimal".into())]).await;
        (id, r)
    }))
    .buffer_unordered(8)
    .collect()
    .await;
    let mut changed = 0;
    for (id, r) in got {
        match r {
            Ok(v) => {
                let labels = str_labels(&v);
                if db.message(account, &id)?.map(|m| m.labels != labels).unwrap_or(false) {
                    db.set_labels(account, &id, &labels)?;
                    changed += 1;
                }
            }
            Err(Error::NotFound(_)) => {
                db.delete_message(account, &id)?;
                changed += 1;
            }
            Err(e) if e.is_offline() || e.is_auth() || e.is_rate_limited() => return Err(e),
            Err(_) => {}
        }
    }
    if changed > 0 {
        refresh_labels(g, db, account).await?;
    }
    Ok(changed)
}

/// Apply history since the stored ID. Err(NotFound) means the ID is too old → run initial_sync again.
pub async fn incremental_sync(g: &Gmail, db: &Db, account: &str) -> Result<SyncReport> {
    let state = db.account(account)?.state;
    let Some(start) = state["historyId"].as_str().map(str::to_string) else {
        return Err(Error::NotFound("no history id".into()));
    };
    let mut page: Option<String> = None;
    let mut added: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut relabel: Vec<(String, String, Vec<String>)> = Vec::new();
    // Labels whose counts may have moved, cached mail or not.
    let mut touched: Vec<String> = Vec::new();
    let mut latest = start.clone();
    loop {
        let r = g.history(&start, page.as_deref()).await?;
        if let Some(h) = r["historyId"].as_str() {
            latest = h.to_string();
        }
        for h in r["history"].as_array().cloned().unwrap_or_default() {
            for a in h["messagesAdded"].as_array().cloned().unwrap_or_default() {
                if let Some(id) = a["message"]["id"].as_str() {
                    let labels = str_labels(&a["message"]);
                    if !labels.iter().any(|l| l == "CHAT") {
                        added.push(id.to_string());
                        touched.extend(labels);
                    }
                }
            }
            for d in h["messagesDeleted"].as_array().cloned().unwrap_or_default() {
                if let Some(id) = d["message"]["id"].as_str() {
                    deleted.push(id.to_string());
                    touched.extend(str_labels(&d["message"]));
                }
            }
            for key in ["labelsAdded", "labelsRemoved"] {
                for x in h[key].as_array().cloned().unwrap_or_default() {
                    let m = &x["message"];
                    if let (Some(id), Some(t)) = (m["id"].as_str(), m["threadId"].as_str()) {
                        relabel.push((id.to_string(), t.to_string(), str_labels(m)));
                        // The changed labels, and the message's others (its unread state may count there).
                        touched.extend(str_labels(&x));
                        touched.extend(str_labels(m));
                    }
                }
            }
        }
        page = r["nextPageToken"].as_str().map(str::to_string);
        if page.is_none() {
            break;
        }
    }
    let mut report = SyncReport { history_id: Some(latest.clone()), ..Default::default() };
    for id in &deleted {
        if let Some(m) = db.message(account, id)? {
            touched.extend(m.labels);
        }
        db.delete_message(account, id)?;
        report.changed = true;
    }
    added.retain(|id| !deleted.contains(id));
    added.dedup();
    let (cached, fresh): (Vec<String>, Vec<String>) = added.iter().cloned().partition(|id| db.has_message(account, id).unwrap_or(false));
    if !fresh.is_empty() {
        report.new_messages = fetch_raw_many(g, db, account, fresh).await?;
        report.changed = true;
    }
    // New since the last check even if already cached (the unread backfill or a list page may have fetched it
    // first): it still counts as new mail, so it still notifies.
    for id in cached {
        if let Some(m) = db.message(account, &id)? {
            report.new_messages.push(m);
        }
    }
    for (id, _thread, labels) in relabel {
        if deleted.contains(&id) {
            continue;
        }
        if db.has_message(account, &id)? {
            db.set_labels(account, &id, &labels)?;
            report.changed = true;
        }
    }
    let stale = state["labelsRefreshedAt"].as_i64().map(|t| crate::error::now_ms() - t > LABELS_REFRESH_MS).unwrap_or(true);
    if stale {
        refresh_labels(g, db, account).await?;
        report.changed = true;
    } else if !touched.is_empty() {
        refresh_label_counts(g, db, account, &touched).await?;
        report.changed = true;
    }
    if report.changed {
        sync_drafts(g, db, account).await.ok();
    }
    db.set_account_state(account, "historyId", json!(latest))?;
    Ok(report)
}

/// Make sure every message of a thread is cached in full (opening a conversation).
pub async fn ensure_thread(g: &Gmail, db: &Db, account: &str, thread_id: &str) -> Result<()> {
    let t = g.thread_minimal(thread_id).await?;
    let mut missing = Vec::new();
    let mut ids = Vec::new();
    for m in t["messages"].as_array().cloned().unwrap_or_default() {
        let Some(id) = m["id"].as_str() else { continue };
        ids.push(id.to_string());
        match db.message(account, id)? {
            Some(row) if row.has_raw => {
                db.set_labels(account, id, &str_labels(&m))?;
            }
            _ => missing.push(id.to_string()),
        }
    }
    // Messages no longer in the thread (deleted elsewhere).
    for old in db.thread_messages(account, thread_id)? {
        if !ids.contains(&old.id) {
            db.delete_message(account, &old.id)?;
        }
    }
    fetch_raw_many(g, db, account, missing).await?;
    Ok(())
}

pub async fn ensure_raw(g: &Gmail, db: &Db, account: &str, id: &str) -> Result<Vec<u8>> {
    if let Some(r) = db.raw(account, id)? {
        return Ok(r);
    }
    let v = g.message_raw(id).await?;
    ingest_raw(db, account, &v)?;
    db.raw(account, id)?.ok_or_else(|| Error::NotFound(id.into()))
}

/// One page of a server-side listing (label view or search). Caches what's missing; returns ids in order.
pub async fn list_page(g: &Gmail, db: &Db, account: &str, label_ids: &[String], q: Option<&str>, page_token: Option<&str>, max: u32, include_spam_trash: bool) -> Result<(Vec<String>, Option<String>, i64)> {
    let r = g.threads_list(label_ids, q, page_token, max, include_spam_trash).await?;
    let mut ids = Vec::new();
    let mut need = Vec::new();
    for t in r["threads"].as_array().cloned().unwrap_or_default() {
        if let Some(id) = t["id"].as_str() {
            ids.push(id.to_string());
            if db.thread_messages(account, id)?.is_empty() {
                need.push(id.to_string());
            }
        }
    }
    use futures::stream::{self, StreamExt};
    let fetched: Vec<Result<Value>> = stream::iter(need.into_iter().map(|id| async move { g.thread_metadata(&id).await })).buffer_unordered(8).collect().await;
    for t in fetched {
        let t = t?;
        for m in t["messages"].as_array().cloned().unwrap_or_default() {
            ingest_metadata(db, account, &m)?;
        }
    }
    Ok((ids, r["nextPageToken"].as_str().map(str::to_string), r["resultSizeEstimate"].as_i64().unwrap_or(0)))
}

/// Keep the draft-id ↔ message-id map current.
pub async fn sync_drafts(g: &Gmail, db: &Db, account: &str) -> Result<()> {
    let mut page: Option<String> = None;
    let mut seen = Vec::new();
    loop {
        let r = g.drafts_list(page.as_deref()).await?;
        for d in r["drafts"].as_array().cloned().unwrap_or_default() {
            let (Some(did), Some(mid)) = (d["id"].as_str(), d["message"]["id"].as_str()) else { continue };
            db.set_draft(account, did, mid, d["message"]["threadId"].as_str())?;
            seen.push(did.to_string());
            if !db.has_message(account, mid)? {
                if let Ok(v) = g.message_raw(mid).await {
                    ingest_raw(db, account, &v)?;
                }
            }
        }
        page = r["nextPageToken"].as_str().map(str::to_string);
        if page.is_none() {
            break;
        }
    }
    for (did, _, _) in db.drafts(account)? {
        if !seen.contains(&did) {
            db.delete_draft(account, &did)?;
        }
    }
    Ok(())
}

/// Import contacts from the People API when the scopes were granted (best effort).
pub async fn sync_people(g: &Gmail, db: &Db, account: &str) -> Result<usize> {
    let mut n = 0;
    for kind in ["other", "connections"] {
        let mut page: Option<String> = None;
        loop {
            let r = if kind == "other" { g.other_contacts(page.as_deref()).await } else { g.connections(page.as_deref()).await };
            let Ok(r) = r else { break };
            let list = if kind == "other" { r["otherContacts"].clone() } else { r["connections"].clone() };
            for p in list.as_array().cloned().unwrap_or_default() {
                let name = p["names"][0]["displayName"].as_str().unwrap_or("");
                for e in p["emailAddresses"].as_array().cloned().unwrap_or_default() {
                    if let Some(email) = e["value"].as_str() {
                        db.touch_contact(account, email, name, false, 0)?;
                        n += 1;
                    }
                }
            }
            page = r["nextPageToken"].as_str().map(str::to_string);
            if page.is_none() {
                break;
            }
        }
    }
    Ok(n)
}

/// Whether a Gmail error body is a rate limit (403 `userRateLimitExceeded` / `rateLimitExceeded`, or
/// `RESOURCE_EXHAUSTED`) rather than a real permission problem.
pub fn is_failed_precondition(v: &Value) -> bool {
    v["error"]["status"].as_str() == Some("FAILED_PRECONDITION") || api_reason(v) == "failedPrecondition"
}

fn api_reason(v: &Value) -> &str {
    v["error"]["errors"][0]["reason"].as_str().or(v["error"]["status"].as_str()).unwrap_or("")
}

/// A request's path for the log, with message, thread and draft ids left out.
fn api_path(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split("/users/me").nth(1).unwrap_or(path);
    let mut out = Vec::new();
    let mut prev = "";
    for seg in path.split('/') {
        out.push(if matches!(prev, "messages" | "threads" | "drafts") && !matches!(seg, "batchModify" | "batchDelete" | "send" | "import" | "insert") { "{id}" } else { seg });
        prev = seg;
    }
    out.join("/")
}

pub fn is_rate_limit(v: &Value) -> bool {
    let e = &v["error"];
    let reasons = e["errors"].as_array().map(|a| a.iter().filter_map(|x| x["reason"].as_str()).any(|r| r.ends_with("ateLimitExceeded") || r == "quotaExceeded")).unwrap_or(false);
    reasons || e["status"].as_str() == Some("RESOURCE_EXHAUSTED") || e["message"].as_str().is_some_and(|m| m.to_lowercase().contains("rate limit"))
}

/// One unit of rate-limit backoff in ms (tests shorten it).
pub static RETRY_UNIT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1000);

/// Backoff between rate-limited retries: 1, 2, 4, 8, 16 units (with a little jitter so parallel requests spread out).
pub fn rate_limit_wait(attempt: u32) -> Duration {
    let unit = RETRY_UNIT_MS.load(std::sync::atomic::Ordering::Relaxed);
    let base = unit << (attempt.saturating_sub(1)).min(4);
    let jitter = crate::error::now_ms() as u64 % (unit / 4 + 1);
    Duration::from_millis(base + jitter)
}
