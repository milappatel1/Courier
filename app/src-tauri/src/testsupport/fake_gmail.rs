//! A local fake of the mail REST API + OAuth endpoints, for the Rust tests and the in-app end-to-end run.
//! Enough of the real API's behaviour for Courier: labels with counts, messages/threads (raw, metadata,
//! minimal), search with operators (via crate::search), modify/trash/delete, send, drafts, history,
//! settings (filters, send-as, vacation, forwarding, IMAP/POP, language), People, and OAuth with PKCE.

use crate::http::{self, Request, Response};
use crate::mailmeta;
use crate::search;
use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone, Debug)]
pub struct FMsg {
    pub id: String,
    pub thread_id: String,
    pub labels: Vec<String>,
    pub raw: Vec<u8>,
    pub internal_date: i64,
}

#[derive(Default)]
pub struct GState {
    pub email: String,
    pub name: String,
    pub client_id: String,
    pub messages: BTreeMap<String, FMsg>,
    pub user_labels: Vec<Value>,
    pub drafts: BTreeMap<String, String>, // draft id → message id
    pub history: Vec<(u64, Value)>,
    pub history_id: u64,
    pub history_floor: u64,
    pub next: u64,
    pub access: HashMap<String, i64>, // token → expiry (unix secs)
    pub refresh: HashMap<String, bool>,
    pub codes: HashMap<String, (String, String)>, // code → (challenge, redirect_uri)
    pub access_ttl: i64,
    pub filters: Vec<Value>,
    pub send_as: Vec<Value>,
    pub vacation: Value,
    pub forwarding: Vec<Value>,
    pub auto_forwarding: Value,
    pub imap: Value,
    pub pop: Value,
    pub language: Value,
    pub sent: Vec<FMsg>,
    pub log: Vec<String>,
    pub unsubscribed: Vec<String>,
    /// Every request to /unsubscribe/…: method, path, Content-Type, body, and whether it carried a cookie or
    /// credentials (a one-click request must carry neither).
    pub unsubscribe_requests: Vec<Value>,
    pub offline: bool,
    pub refresh_count: u32,
    /// The next N API calls get Gmail's 403 "User-rate limit exceeded".
    pub rate_limit_next: u32,
    /// Message ids whose fetch always fails with a plain 403.
    pub forbidden_ids: Vec<String>,
    /// Extra time (ms) the server takes before it answers, by route ("batchModify", "threads.list", …): the
    /// real API takes hundreds of milliseconds for a change, and a listing made meanwhile still shows the old state.
    pub latency: HashMap<String, u64>,
    /// The next N label changes or deletions (batchModify, batchDelete, modify, trash) get the API's 400
    /// "Precondition check failed." and change nothing.
    pub precondition_next: u32,
    /// Message ids that make any batchModify or batchDelete naming them fail that way, every time.
    pub precondition_ids: Vec<String>,
    /// Routes (as in `latency`) that answer with this status and the API's error body, every time.
    pub fail_routes: HashMap<String, u16>,
    /// How far (ms) listings run behind changes, as on the real API: a search (`q=`) reads an index that lags,
    /// a plain label listing (`labelIds=` only) reads the labels themselves. Zero answers from the current state.
    pub search_lag_ms: u64,
    pub label_lag_ms: u64,
    /// Time (ms) between reading the mailbox and the answer arriving, by route: a read answered from the
    /// mailbox as it was when the request arrived, delivered later (a change can land in between).
    pub tail_latency: HashMap<String, u64>,
    /// Each message's labels before every change (when, id, labels before; None = it didn't exist yet), so a
    /// lagging listing can answer from the past.
    pub label_log: Vec<(i64, String, Option<Vec<String>>)>,
    /// Messages parsed for search, by id and size (see `searchable`).
    pub parsed: Mutex<HashMap<(String, usize), search::Searchable>>,
    /// Time spent answering, by route (not counting `latency`/`tail` waits): how much of a run was the fake's own work.
    pub served: HashMap<String, Served>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Served {
    pub count: u64,
    pub total_ms: f64,
    pub max_ms: f64,
}

#[derive(Clone)]
pub struct FakeGmail {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<GState>>,
}

const SYSTEM: &[&str] = &["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "CHAT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];

fn unix() -> i64 {
    crate::error::now_ms() / 1000
}

impl FakeGmail {
    pub async fn start(email: &str, name: &str) -> FakeGmail {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind fake mail API");
        let addr = listener.local_addr().unwrap();
        let st = GState {
            email: email.into(),
            name: name.into(),
            client_id: "courier-test-client".into(),
            history_id: 1000,
            history_floor: 1000,
            next: 1,
            access_ttl: 3600,
            send_as: vec![json!({"sendAsEmail": email, "displayName": name, "isPrimary": true, "isDefault": true, "signature": "", "verificationStatus": "accepted"})],
            vacation: json!({"enableAutoReply": false, "responseSubject": "", "responseBodyHtml": "", "restrictToContacts": false, "restrictToDomain": false}),
            auto_forwarding: json!({"enabled": false, "emailAddress": "", "disposition": "leaveInInbox"}),
            imap: json!({"enabled": true, "autoExpunge": true, "expungeBehavior": "archive", "maxFolderSize": 0}),
            pop: json!({"accessWindow": "disabled", "disposition": "leaveInInbox"}),
            language: json!({"displayLanguage": "en"}),
            ..Default::default()
        };
        let fake = FakeGmail { addr, state: Arc::new(Mutex::new(st)) };
        let f2 = fake.clone();
        let handler: http::Handler = Arc::new(move |req| {
            let f = f2.clone();
            Box::pin(async move {
                let route = route_name(&req.method, &req.path).to_string();
                let wait = f.state.lock().latency.get(&route).copied().unwrap_or(0);
                if wait > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                }
                let t0 = std::time::Instant::now();
                let resp = f.handle(req);
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                let tail = {
                    let mut st = f.state.lock();
                    // A message fetch's route is its id.
                    let key = if route.len() == 16 && route.bytes().all(|b| b.is_ascii_hexdigit()) { "messages.get".to_string() } else { route.clone() };
                    let served = st.served.entry(key).or_default();
                    served.count += 1;
                    served.total_ms += ms;
                    served.max_ms = served.max_ms.max(ms);
                    st.tail_latency.get(&route).copied().unwrap_or(0)
                };
                if tail > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(tail)).await;
                }
                resp
            })
        });
        tokio::spawn(http::serve(listener, handler));
        fake
    }

    pub fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn endpoints(&self) -> crate::oauth::Endpoints {
        crate::oauth::Endpoints {
            auth_url: format!("{}/o/oauth2/v2/auth", self.base()),
            token_url: format!("{}/token", self.base()),
            userinfo_url: format!("{}/userinfo", self.base()),
            api_base: format!("{}/gmail/v1/users/me", self.base()),
            people_base: format!("{}/v1", self.base()),
        }
    }

    /// Put a message in the mailbox as if it had arrived (records history).
    pub fn deliver(&self, raw: &[u8], labels: &[&str]) -> String {
        let mut s = self.state.lock();
        let thread = thread_for(&s, raw);
        let id = new_id(&mut s);
        let thread_id = thread.unwrap_or_else(|| id.clone());
        let date = mailmeta::parse_raw(raw).row.internal_date;
        let m = FMsg { id: id.clone(), thread_id, labels: labels.iter().map(|s| s.to_string()).collect(), raw: raw.to_vec(), internal_date: if date > 0 { date } else { crate::error::now_ms() } };
        s.messages.insert(id.clone(), m.clone());
        record(&mut s, "messagesAdded", &m, &[]);
        id
    }

    /// A label change made on another device (it shows up in history).
    pub fn modify_elsewhere(&self, id: &str, add: &[&str], remove: &[&str]) {
        let mut s = self.state.lock();
        let add: Vec<String> = add.iter().map(|x| x.to_string()).collect();
        let remove: Vec<String> = remove.iter().map(|x| x.to_string()).collect();
        modify(&mut s, id, &add, &remove);
    }

    pub fn message(&self, id: &str) -> Option<FMsg> {
        self.state.lock().messages.get(id).cloned()
    }

    fn handle(&self, req: Request) -> Response {
        let path = req.path.clone();
        self.state.lock().log.push(format!("{} {}", req.method, path));
        if self.state.lock().offline {
            return Response::status(503);
        }
        if path.starts_with("/gmail/") {
            let mut s = self.state.lock();
            if s.rate_limit_next > 0 {
                s.rate_limit_next -= 1;
                return Response::json(
                    403,
                    &json!({"error": {"code": 403, "message": "User-rate limit exceeded.  Retry after 2026-10-19T19:51:40.000Z", "errors": [{"message": "User-rate limit exceeded.", "domain": "usageLimits", "reason": "userRateLimitExceeded"}], "status": "PERMISSION_DENIED"}}),
                );
            }
            if s.forbidden_ids.iter().any(|id| path.contains(&format!("/messages/{id}"))) {
                return Response::json(403, &json!({"error": {"code": 403, "message": "Forbidden", "errors": [{"reason": "forbidden"}], "status": "PERMISSION_DENIED"}}));
            }
            if let Some(code) = s.fail_routes.get(route_name(&req.method, &path)).copied() {
                return Response::json(code, &json!({"error": {"code": code, "message": "Bad Request", "errors": [{"message": "Bad Request", "domain": "global", "reason": "badRequest"}], "status": "INVALID_ARGUMENT"}}));
            }
            let write = req.method == "POST" && (path.ends_with("/batchModify") || path.ends_with("/batchDelete") || path.ends_with("/modify") || path.ends_with("/trash"));
            let named_bad = write && !s.precondition_ids.is_empty() && strs(&req.json()["ids"]).iter().any(|id| s.precondition_ids.contains(id));
            if write && (s.precondition_next > 0 || named_bad) {
                if !named_bad {
                    s.precondition_next -= 1;
                }
                return precondition_failed();
            }
        }
        if path == "/o/oauth2/v2/auth" {
            return self.authorize(&req);
        }
        if path == "/token" {
            return self.token(&req);
        }
        if let Some(rest) = path.strip_prefix("/unsubscribe/") {
            let mut s = self.state.lock();
            s.unsubscribe_requests.push(json!({
                "method": req.method, "path": rest, "contentType": req.header("content-type").unwrap_or(""),
                "body": String::from_utf8_lossy(&req.body), "cookie": req.header("cookie").is_some(), "authorization": req.header("authorization").is_some(),
            }));
            // A sender's server: "redirect…" sends the client on (307 keeps the POST), "fail" breaks, the rest confirm.
            if let Some(to) = rest.strip_prefix("redirect-") {
                return Response { status: 307, headers: vec![("Location".into(), format!("/unsubscribe/{to}"))], body: vec![] };
            }
            if rest.starts_with("fail") {
                return Response::status(500);
            }
            s.unsubscribed.push(rest.to_string());
            return Response::json(200, &json!({}));
        }
        // Everything else needs a valid bearer token.
        let token = req.header("authorization").and_then(|h| h.strip_prefix("Bearer ")).unwrap_or("").to_string();
        {
            let s = self.state.lock();
            match s.access.get(&token) {
                Some(exp) if *exp > unix() => {}
                _ => return Response::json(401, &json!({"error": {"code": 401, "message": "Invalid Credentials"}})),
            }
        }
        if path == "/userinfo" {
            let s = self.state.lock();
            return Response::json(200, &json!({"email": s.email, "name": s.name, "picture": ""}));
        }
        if let Some(rest) = path.strip_prefix("/v1/") {
            return self.people(rest);
        }
        let Some(rest) = path.strip_prefix("/gmail/v1/users/me/") else { return Response::status(404) };
        let parts: Vec<&str> = rest.split('/').collect();
        self.api(&req, &parts)
    }

    fn authorize(&self, req: &Request) -> Response {
        let redirect = req.q("redirect_uri").unwrap_or("").to_string();
        let state = req.q("state").unwrap_or("").to_string();
        let challenge = req.q("code_challenge").unwrap_or("").to_string();
        if req.q("client_id") != Some(self.state.lock().client_id.as_str()) || req.q("code_challenge_method") != Some("S256") {
            return Response::redirect(&format!("{redirect}?error=invalid_request&state={state}"));
        }
        let code = format!("code-{}", crate::error::random_token(8));
        self.state.lock().codes.insert(code.clone(), (challenge, redirect.clone()));
        Response::redirect(&format!("{redirect}?code={}&state={}", http::url_encode(&code), http::url_encode(&state)))
    }

    fn token(&self, req: &Request) -> Response {
        let f = req.form();
        let mut s = self.state.lock();
        if f.get("client_id").map(|c| c != &s.client_id).unwrap_or(true) {
            return Response::json(401, &json!({"error": "invalid_client"}));
        }
        let ttl = s.access_ttl;
        match f.get("grant_type").map(|x| x.as_str()) {
            Some("authorization_code") => {
                let code = f.get("code").cloned().unwrap_or_default();
                let Some((challenge, redirect)) = s.codes.remove(&code) else { return Response::json(400, &json!({"error": "invalid_grant"})) };
                let verifier = f.get("code_verifier").cloned().unwrap_or_default();
                let calc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
                if calc != challenge || f.get("redirect_uri") != Some(&redirect) {
                    return Response::json(400, &json!({"error": "invalid_grant", "error_description": "PKCE verification failed"}));
                }
                let access = format!("at-{}", crate::error::random_token(12));
                let refresh = format!("rt-{}", crate::error::random_token(12));
                s.access.insert(access.clone(), unix() + ttl);
                s.refresh.insert(refresh.clone(), true);
                Response::json(200, &json!({"access_token": access, "refresh_token": refresh, "expires_in": ttl, "scope": crate::oauth::SCOPES.join(" "), "token_type": "Bearer"}))
            }
            Some("refresh_token") => {
                let rt = f.get("refresh_token").cloned().unwrap_or_default();
                if !s.refresh.get(&rt).copied().unwrap_or(false) {
                    return Response::json(400, &json!({"error": "invalid_grant"}));
                }
                s.refresh_count += 1;
                let access = format!("at-{}", crate::error::random_token(12));
                s.access.insert(access.clone(), unix() + ttl);
                Response::json(200, &json!({"access_token": access, "expires_in": ttl, "token_type": "Bearer"}))
            }
            _ => Response::json(400, &json!({"error": "unsupported_grant_type"})),
        }
    }

    fn people(&self, rest: &str) -> Response {
        let list = json!([
            {"names": [{"displayName": "Dana Fields"}], "emailAddresses": [{"value": "dana@contacts.example"}]},
            {"names": [{"displayName": "Eli Park"}], "emailAddresses": [{"value": "eli@contacts.example"}]}
        ]);
        if rest == "otherContacts" {
            return Response::json(200, &json!({"otherContacts": list}));
        }
        if rest == "people/me/connections" {
            return Response::json(200, &json!({"connections": []}));
        }
        Response::status(404)
    }

    fn api(&self, req: &Request, p: &[&str]) -> Response {
        let m = req.method.as_str();
        let mut s = self.state.lock();
        let ok = |v: Value| Response::json(200, &v);
        let not_found = || Response::json(404, &json!({"error": {"code": 404, "message": "Not Found"}}));
        match (m, p) {
            ("GET", ["profile"]) => {
                let threads: std::collections::HashSet<&String> = s.messages.values().map(|m| &m.thread_id).collect();
                ok(json!({"emailAddress": s.email, "messagesTotal": s.messages.len(), "threadsTotal": threads.len(), "historyId": s.history_id.to_string()}))
            }
            ("GET", ["labels"]) => {
                let all = all_labels(&s);
                ok(json!({"labels": all}))
            }
            ("GET", ["labels", id]) => match all_labels(&s).into_iter().find(|l| l["id"] == *id) {
                Some(l) => ok(l),
                None => not_found(),
            },
            ("POST", ["labels"]) => {
                let b = req.json();
                let name = b["name"].as_str().unwrap_or("").to_string();
                if name.is_empty() || s.user_labels.iter().any(|l| l["name"].as_str().map(|n| n.eq_ignore_ascii_case(&name)).unwrap_or(false)) {
                    return Response::json(409, &json!({"error": {"code": 409, "message": "Label name exists or conflicts"}}));
                }
                let id = format!("Label_{}", s.next);
                s.next += 1;
                let mut l = json!({"id": id, "name": name, "type": "user", "labelListVisibility": b["labelListVisibility"].as_str().unwrap_or("labelShow"), "messageListVisibility": b["messageListVisibility"].as_str().unwrap_or("show")});
                if b["color"].is_object() {
                    l["color"] = b["color"].clone();
                }
                s.user_labels.push(l.clone());
                ok(l)
            }
            ("PATCH", ["labels", id]) | ("PUT", ["labels", id]) => {
                let b = req.json();
                let Some(l) = s.user_labels.iter_mut().find(|l| l["id"] == *id) else { return not_found() };
                for k in ["name", "color", "labelListVisibility", "messageListVisibility"] {
                    if !b[k].is_null() {
                        l[k] = b[k].clone();
                    }
                }
                ok(l.clone())
            }
            ("DELETE", ["labels", id]) => {
                let id = id.to_string();
                s.user_labels.retain(|l| l["id"] != id.as_str());
                let ids: Vec<String> = s.messages.keys().cloned().collect();
                for mid in ids {
                    let msg = s.messages.get_mut(&mid).unwrap();
                    if msg.labels.contains(&id) {
                        msg.labels.retain(|l| l != &id);
                        let m2 = msg.clone();
                        record(&mut s, "labelsRemoved", &m2, std::slice::from_ref(&id));
                    }
                }
                Response::status(204)
            }
            ("GET", ["messages"]) => {
                let ids = list_messages(&s, req);
                let max: usize = req.q("maxResults").and_then(|x| x.parse().ok()).unwrap_or(100);
                let start: usize = req.q("pageToken").and_then(|x| x.parse().ok()).unwrap_or(0);
                let page: Vec<Value> = ids.iter().skip(start).take(max).map(|m| json!({"id": m.id, "threadId": m.thread_id})).collect();
                let mut r = json!({"messages": page, "resultSizeEstimate": ids.len()});
                if start + max < ids.len() {
                    r["nextPageToken"] = json!((start + max).to_string());
                }
                ok(r)
            }
            ("GET", ["messages", id]) => match s.messages.get(*id) {
                Some(msg) => ok(message_json(&s, msg, req.q("format").unwrap_or("full"))),
                None => not_found(),
            },
            ("POST", ["messages", "batchModify"]) => {
                let b = req.json();
                let ids = strs(&b["ids"]);
                for id in ids {
                    modify(&mut s, &id, &strs(&b["addLabelIds"]), &strs(&b["removeLabelIds"]));
                }
                Response::status(204)
            }
            ("POST", ["messages", "batchDelete"]) => {
                for id in strs(&req.json()["ids"]) {
                    delete(&mut s, &id);
                }
                Response::status(204)
            }
            ("POST", ["messages", id, "modify"]) => {
                let b = req.json();
                if !s.messages.contains_key(*id) {
                    return not_found();
                }
                modify(&mut s, id, &strs(&b["addLabelIds"]), &strs(&b["removeLabelIds"]));
                let msg = s.messages.get(*id).unwrap().clone();
                ok(message_json(&s, &msg, "minimal"))
            }
            ("POST", ["messages", id, "trash"]) => {
                modify(&mut s, id, &["TRASH".into()], &["INBOX".into(), "SPAM".into()]);
                ok(json!({"id": id}))
            }
            ("POST", ["messages", id, "untrash"]) => {
                modify(&mut s, id, &["INBOX".into()], &["TRASH".into()]);
                ok(json!({"id": id}))
            }
            ("DELETE", ["messages", id]) => {
                delete(&mut s, id);
                Response::status(204)
            }
            ("POST", ["messages", "send"]) => {
                let b = req.json();
                let raw = crate::gmail::decode_raw(b["raw"].as_str().unwrap_or("")).unwrap_or_default();
                let msg = send(&mut s, raw, b["threadId"].as_str());
                ok(message_json(&s, &msg, "minimal"))
            }
            ("GET", ["threads"]) => {
                let msgs = list_messages(&s, req);
                let mut listed = std::collections::HashSet::new();
                let mut seen: Vec<String> = msgs.iter().filter(|m| listed.insert(&m.thread_id)).map(|m| m.thread_id.clone()).collect();
                // Like the real API: a conversation sorts by its newest message (a sent reply moves it up). One pass
                // over the mailbox, so listing a 20,000-conversation mailbox stays fast enough not to be what a perf run measures.
                let include = req.q("includeSpamTrash") == Some("true") || req.q_all("labelIds").iter().any(|l| l == "SPAM" || l == "TRASH");
                let mut newest: HashMap<&String, i64> = HashMap::new();
                for m in s.messages.values().filter(|m| listed.contains(&m.thread_id) && (include || !m.labels.iter().any(|l| l == "SPAM" || l == "TRASH"))) {
                    let n = newest.entry(&m.thread_id).or_insert(0);
                    *n = (*n).max(m.internal_date);
                }
                seen.sort_by_key(|t| std::cmp::Reverse(newest.get(t).copied().unwrap_or(0)));
                let max: usize = req.q("maxResults").and_then(|x| x.parse().ok()).unwrap_or(100);
                let start: usize = req.q("pageToken").and_then(|x| x.parse().ok()).unwrap_or(0);
                let page: Vec<Value> = seen.iter().skip(start).take(max).map(|t| json!({"id": t, "snippet": "", "historyId": s.history_id.to_string()})).collect();
                let mut r = json!({"threads": page, "resultSizeEstimate": seen.len()});
                if start + max < seen.len() {
                    r["nextPageToken"] = json!((start + max).to_string());
                }
                ok(r)
            }
            ("GET", ["threads", id]) => {
                let fmt = req.q("format").unwrap_or("full");
                let mut msgs: Vec<&FMsg> = s.messages.values().filter(|m| m.thread_id == *id).collect();
                if msgs.is_empty() {
                    return not_found();
                }
                msgs.sort_by_key(|m| m.internal_date);
                let list: Vec<Value> = msgs.iter().map(|m| message_json(&s, m, fmt)).collect();
                ok(json!({"id": id, "historyId": s.history_id.to_string(), "messages": list}))
            }
            ("POST", ["threads", id, "modify"]) => {
                let b = req.json();
                let ids: Vec<String> = s.messages.values().filter(|m| m.thread_id == *id).map(|m| m.id.clone()).collect();
                for mid in ids {
                    modify(&mut s, &mid, &strs(&b["addLabelIds"]), &strs(&b["removeLabelIds"]));
                }
                ok(json!({"id": id}))
            }
            ("POST", ["threads", id, action]) if *action == "trash" || *action == "untrash" => {
                let ids: Vec<String> = s.messages.values().filter(|m| m.thread_id == *id).map(|m| m.id.clone()).collect();
                for mid in ids {
                    if *action == "trash" {
                        modify(&mut s, &mid, &["TRASH".into()], &["INBOX".into(), "SPAM".into()]);
                    } else {
                        modify(&mut s, &mid, &["INBOX".into()], &["TRASH".into()]);
                    }
                }
                ok(json!({"id": id}))
            }
            ("GET", ["history"]) => {
                let start: u64 = req.q("startHistoryId").and_then(|x| x.parse().ok()).unwrap_or(0);
                if start < s.history_floor {
                    return not_found();
                }
                let recs: Vec<Value> = s.history.iter().filter(|(id, _)| *id > start).map(|(_, v)| v.clone()).collect();
                ok(json!({"history": recs, "historyId": s.history_id.to_string()}))
            }
            ("GET", ["drafts"]) => {
                let list: Vec<Value> = s.drafts.iter().filter_map(|(d, mid)| s.messages.get(mid).map(|m| json!({"id": d, "message": {"id": m.id, "threadId": m.thread_id}}))).collect();
                ok(json!({"drafts": list}))
            }
            ("GET", ["drafts", id]) => match s.drafts.get(*id).and_then(|mid| s.messages.get(mid)) {
                Some(m) => ok(json!({"id": id, "message": message_json(&s, m, req.q("format").unwrap_or("full"))})),
                None => not_found(),
            },
            ("POST", ["drafts"]) => {
                let b = req.json();
                let raw = crate::gmail::decode_raw(b["message"]["raw"].as_str().unwrap_or("")).unwrap_or_default();
                let did = format!("r{}", s.next);
                s.next += 1;
                let m = put_draft(&mut s, raw, b["message"]["threadId"].as_str());
                s.drafts.insert(did.clone(), m.id.clone());
                ok(json!({"id": did, "message": {"id": m.id, "threadId": m.thread_id, "labelIds": m.labels}}))
            }
            ("PUT", ["drafts", id]) => {
                let Some(old) = s.drafts.get(*id).cloned() else { return not_found() };
                let b = req.json();
                let raw = crate::gmail::decode_raw(b["message"]["raw"].as_str().unwrap_or("")).unwrap_or_default();
                delete(&mut s, &old);
                let m = put_draft(&mut s, raw, b["message"]["threadId"].as_str());
                s.drafts.insert(id.to_string(), m.id.clone());
                ok(json!({"id": id, "message": {"id": m.id, "threadId": m.thread_id, "labelIds": m.labels}}))
            }
            ("DELETE", ["drafts", id]) => {
                let Some(mid) = s.drafts.remove(*id) else { return not_found() };
                delete(&mut s, &mid);
                Response::status(204)
            }
            ("POST", ["drafts", "send"]) => {
                let b = req.json();
                let did = b["id"].as_str().unwrap_or("").to_string();
                let Some(mid) = s.drafts.remove(&did) else { return not_found() };
                let Some(dm) = s.messages.get(&mid).cloned() else { return not_found() };
                delete(&mut s, &mid);
                let msg = send(&mut s, dm.raw, Some(&dm.thread_id));
                ok(message_json(&s, &msg, "minimal"))
            }
            // ---- settings ----
            ("GET", ["settings", "filters"]) => ok(json!({"filter": s.filters})),
            ("POST", ["settings", "filters"]) => {
                let mut b = req.json();
                b["id"] = json!(format!("f{}", s.next));
                s.next += 1;
                s.filters.push(b.clone());
                ok(b)
            }
            ("DELETE", ["settings", "filters", id]) => {
                s.filters.retain(|f| f["id"] != *id);
                Response::status(204)
            }
            ("GET", ["settings", "sendAs"]) => ok(json!({"sendAs": s.send_as})),
            ("POST", ["settings", "sendAs"]) => {
                let mut b = req.json();
                b["verificationStatus"] = json!("pending");
                b["isPrimary"] = json!(false);
                s.send_as.push(b.clone());
                ok(b)
            }
            ("PATCH", ["settings", "sendAs", email]) | ("PUT", ["settings", "sendAs", email]) => {
                let b = req.json();
                let make_default = b["isDefault"].as_bool() == Some(true);
                if make_default {
                    for x in s.send_as.iter_mut() {
                        x["isDefault"] = json!(false);
                    }
                }
                let Some(x) = s.send_as.iter_mut().find(|x| x["sendAsEmail"] == *email) else { return not_found() };
                if let Some(o) = b.as_object() {
                    for (k, v) in o {
                        x[k] = v.clone();
                    }
                }
                ok(x.clone())
            }
            ("DELETE", ["settings", "sendAs", email]) => {
                s.send_as.retain(|x| x["sendAsEmail"] != *email || x["isPrimary"] == true);
                Response::status(204)
            }
            ("POST", ["settings", "sendAs", email, "verify"]) => {
                if let Some(x) = s.send_as.iter_mut().find(|x| x["sendAsEmail"] == *email) {
                    x["verificationStatus"] = json!("accepted");
                }
                Response::status(204)
            }
            ("GET", ["settings", "vacation"]) => ok(s.vacation.clone()),
            ("PUT", ["settings", "vacation"]) => {
                s.vacation = req.json();
                ok(s.vacation.clone())
            }
            ("GET", ["settings", "forwardingAddresses"]) => ok(json!({"forwardingAddresses": s.forwarding})),
            ("POST", ["settings", "forwardingAddresses"]) => {
                let mut b = req.json();
                b["verificationStatus"] = json!("pending");
                s.forwarding.push(b.clone());
                ok(b)
            }
            ("DELETE", ["settings", "forwardingAddresses", email]) => {
                s.forwarding.retain(|f| f["forwardingEmail"] != *email);
                Response::status(204)
            }
            ("GET", ["settings", "autoForwarding"]) => ok(s.auto_forwarding.clone()),
            ("PUT", ["settings", "autoForwarding"]) => {
                s.auto_forwarding = req.json();
                ok(s.auto_forwarding.clone())
            }
            ("GET", ["settings", "imap"]) => ok(s.imap.clone()),
            ("PUT", ["settings", "imap"]) => {
                s.imap = req.json();
                ok(s.imap.clone())
            }
            ("GET", ["settings", "pop"]) => ok(s.pop.clone()),
            ("PUT", ["settings", "pop"]) => {
                s.pop = req.json();
                ok(s.pop.clone())
            }
            ("GET", ["settings", "language"]) => ok(s.language.clone()),
            ("PUT", ["settings", "language"]) => {
                s.language = req.json();
                ok(s.language.clone())
            }
            _ => not_found(),
        }
    }
}

/// The API's answer, word for word, when it refuses a request with failedPrecondition.
pub fn precondition_failed() -> Response {
    Response::json(
        400,
        &json!({"error": {"code": 400, "message": "Precondition check failed.", "errors": [{"message": "Precondition check failed.", "domain": "global", "reason": "failedPrecondition"}], "status": "FAILED_PRECONDITION"}}),
    )
}

/// The latency key for a request: the last path segment for actions, "<resource>.list" / "<resource>.get" otherwise.
fn route_name<'a>(method: &str, path: &'a str) -> &'a str {
    let rest = path.strip_prefix("/gmail/v1/users/me/").unwrap_or(path);
    let parts: Vec<&str> = rest.split('/').collect();
    match (method, parts.as_slice()) {
        ("GET", ["threads"]) => "threads.list",
        ("GET", ["messages"]) => "messages.list",
        ("GET", ["threads", _]) => "threads.get",
        ("GET", ["history"]) => "history",
        ("GET", ["labels", ..]) => "labels",
        _ => parts.last().copied().unwrap_or(""),
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

pub fn new_id(s: &mut GState) -> String {
    let id = format!("{:016x}", 0x18f0_0000_0000u64 + s.next);
    s.next += 1;
    id
}

fn thread_for(s: &GState, raw: &[u8]) -> Option<String> {
    let row = mailmeta::parse_raw(raw).row;
    let mut refs = row.references.clone();
    if !row.in_reply_to.is_empty() {
        refs.push(row.in_reply_to.clone());
    }
    for r in refs.iter().rev() {
        for m in s.messages.values() {
            if mailmeta::parse_raw(&m.raw).row.message_id == *r {
                return Some(m.thread_id.clone());
            }
        }
    }
    None
}

fn record(s: &mut GState, kind: &str, m: &FMsg, label_ids: &[String]) {
    if kind == "messagesAdded" {
        s.label_log.push((crate::error::now_ms(), m.id.clone(), None));
    }
    s.history_id += 1;
    let id = s.history_id;
    let msg = json!({"id": m.id, "threadId": m.thread_id, "labelIds": m.labels});
    let entry = if kind == "messagesAdded" || kind == "messagesDeleted" { json!({"message": msg}) } else { json!({"message": msg, "labelIds": label_ids}) };
    s.history.push((id, json!({"id": id.to_string(), kind: [entry]})));
}

fn modify(s: &mut GState, id: &str, add: &[String], remove: &[String]) {
    let Some(before) = s.messages.get(id).map(|m| m.labels.clone()) else { return };
    s.label_log.push((crate::error::now_ms(), id.to_string(), Some(before.clone())));
    let Some(m) = s.messages.get_mut(id) else { return };
    m.labels.retain(|l| !remove.contains(l));
    for a in add {
        if !m.labels.contains(a) {
            m.labels.push(a.clone());
        }
    }
    let after = m.clone();
    let added: Vec<String> = after.labels.iter().filter(|l| !before.contains(l)).cloned().collect();
    let removed: Vec<String> = before.iter().filter(|l| !after.labels.contains(l)).cloned().collect();
    if !added.is_empty() {
        record(s, "labelsAdded", &after, &added);
    }
    if !removed.is_empty() {
        record(s, "labelsRemoved", &after, &removed);
    }
}

fn delete(s: &mut GState, id: &str) {
    if let Some(m) = s.messages.remove(id) {
        record(s, "messagesDeleted", &m, &[]);
    }
}

fn send(s: &mut GState, raw: Vec<u8>, thread_id: Option<&str>) -> FMsg {
    let thread = thread_id.map(str::to_string).or_else(|| thread_for(s, &raw));
    let id = new_id(s);
    let row = mailmeta::parse_raw(&raw).row;
    let mut labels = vec!["SENT".to_string()];
    let me = s.email.to_lowercase();
    if row.to.iter().chain(&row.cc).chain(&row.bcc).any(|a| a.email.to_lowercase() == me) {
        labels.extend(["INBOX".to_string(), "UNREAD".to_string(), "CATEGORY_PERSONAL".to_string()]);
    }
    // The API strips Bcc from what it stores for the sender's copy only when not self; keep raw as sent.
    let m = FMsg { id: id.clone(), thread_id: thread.unwrap_or_else(|| id.clone()), labels, raw, internal_date: crate::error::now_ms() };
    s.messages.insert(id.clone(), m.clone());
    s.sent.push(m.clone());
    record(s, "messagesAdded", &m, &[]);
    m
}

fn put_draft(s: &mut GState, raw: Vec<u8>, thread_id: Option<&str>) -> FMsg {
    let thread = thread_id.map(str::to_string).or_else(|| thread_for(s, &raw));
    let id = new_id(s);
    let m = FMsg { id: id.clone(), thread_id: thread.unwrap_or_else(|| id.clone()), labels: vec!["DRAFT".into()], raw, internal_date: crate::error::now_ms() };
    s.messages.insert(id.clone(), m.clone());
    record(s, "messagesAdded", &m, &[]);
    m
}

fn label_names(s: &GState) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = SYSTEM.iter().map(|x| (x.to_string(), x.to_string())).collect();
    for l in &s.user_labels {
        map.insert(l["id"].as_str().unwrap_or("").to_string(), l["name"].as_str().unwrap_or("").to_string());
    }
    map
}

/// A message for search, with `labels` as the listing sees them. Parsing is cached per message (a busy mailbox
/// has thousands, and every search reads them all).
fn searchable(s: &GState, m: &FMsg, labels: &[String], names: &HashMap<String, String>) -> search::Searchable {
    let key = (m.id.clone(), m.raw.len());
    let mut cache = s.parsed.lock();
    let base = cache.entry(key).or_insert_with(|| parsed_searchable(m)).clone();
    drop(cache);
    search::Searchable {
        labels: labels.to_vec(),
        label_names: labels.iter().filter_map(|l| names.get(l).cloned()).collect(),
        size: m.raw.len() as i64,
        date_ms: m.internal_date,
        ..base
    }
}

fn parsed_searchable(m: &FMsg) -> search::Searchable {
    let p = mailmeta::parse_raw(&m.raw).row;
    let addrs = |l: &[crate::db::Addr]| l.iter().map(|a| format!("{} {}", a.name, a.email)).collect::<Vec<_>>().join(" ").to_lowercase();
    search::Searchable {
        from: format!("{} {}", p.from_name, p.from_email).to_lowercase(),
        to: addrs(&p.to),
        cc: addrs(&p.cc),
        bcc: addrs(&p.bcc),
        delivered_to: p.delivered_to.clone(),
        subject: p.subject.clone(),
        body: p.body_text.clone(),
        attachment_names: p.attachments.iter().map(|a| a.name.clone()).collect(),
        list_id: p.list_id.clone(),
        message_id: p.message_id.clone(),
        ..Default::default()
    }
}

/// A message's labels as a listing that runs `lag` ms behind sees them, or None if it didn't exist yet.
fn labels_as_of<'a>(s: &'a GState, m: &'a FMsg, lag: u64) -> Option<&'a [String]> {
    if lag == 0 {
        return Some(&m.labels);
    }
    let cutoff = crate::error::now_ms() - lag as i64;
    match s.label_log.iter().find(|(t, id, _)| *t > cutoff && id == &m.id) {
        None => Some(&m.labels),
        Some((_, _, None)) => None,
        Some((_, _, Some(before))) => Some(before),
    }
}

fn list_messages<'a>(s: &'a GState, req: &Request) -> Vec<&'a FMsg> {
    let label_ids = req.q_all("labelIds");
    let q = req.q("q").unwrap_or("");
    let include = req.q("includeSpamTrash") == Some("true");
    let node = search::parse(q);
    let asks_spam_trash = node.as_ref().map(search::mentions_spam_trash).unwrap_or(false);
    let names = label_names(s);
    let now = crate::error::now_ms();
    let lag = if q.trim().is_empty() { s.label_lag_ms } else { s.search_lag_ms };
    let mut out: Vec<&FMsg> = s
        .messages
        .values()
        .filter_map(|m| labels_as_of(s, m, lag).map(|labels| (m, labels)))
        .filter(|(_, labels)| label_ids.iter().all(|l| labels.contains(l)))
        .filter(|(_, labels)| include || asks_spam_trash || label_ids.iter().any(|l| l == "SPAM" || l == "TRASH") || !(labels.iter().any(|l| l == "SPAM" || l == "TRASH")))
        .filter(|(m, labels)| node.as_ref().map(|n| search::eval(n, &searchable(s, m, labels, &names), now)).unwrap_or(true))
        .map(|(m, _)| m)
        .collect();
    out.sort_by(|a, b| b.internal_date.cmp(&a.internal_date));
    out
}

fn all_labels(s: &GState) -> Vec<Value> {
    let count = |id: &str| {
        // As on the server, mail in Trash or Spam counts only there.
        let binned = |m: &FMsg| id != "TRASH" && id != "SPAM" && m.labels.iter().any(|l| l == "TRASH" || l == "SPAM");
        let msgs: Vec<&FMsg> = s.messages.values().filter(|m| m.labels.iter().any(|l| l == id) && !binned(m)).collect();
        let unread = msgs.iter().filter(|m| m.labels.iter().any(|l| l == "UNREAD")).count();
        let threads: std::collections::HashSet<&String> = msgs.iter().map(|m| &m.thread_id).collect();
        let tunread: std::collections::HashSet<&String> = msgs.iter().filter(|m| m.labels.iter().any(|l| l == "UNREAD")).map(|m| &m.thread_id).collect();
        (msgs.len(), unread, threads.len(), tunread.len())
    };
    let mut out = Vec::new();
    for id in SYSTEM {
        let (mt, mu, tt, tu) = count(id);
        out.push(json!({"id": id, "name": id, "type": "system", "messagesTotal": mt, "messagesUnread": mu, "threadsTotal": tt, "threadsUnread": tu}));
    }
    for l in &s.user_labels {
        let mut l = l.clone();
        let (mt, mu, tt, tu) = count(l["id"].as_str().unwrap_or(""));
        l["messagesTotal"] = json!(mt);
        l["messagesUnread"] = json!(mu);
        l["threadsTotal"] = json!(tt);
        l["threadsUnread"] = json!(tu);
        out.push(l);
    }
    out
}

fn message_json(_s: &GState, m: &FMsg, format: &str) -> Value {
    let p = mailmeta::parse_raw(&m.raw).row;
    let mut v = json!({
        "id": m.id, "threadId": m.thread_id, "labelIds": m.labels, "snippet": p.snippet,
        "historyId": "1", "internalDate": m.internal_date.to_string(), "sizeEstimate": m.raw.len()
    });
    match format {
        "raw" => {
            v["raw"] = json!(crate::gmail::encode_raw(&m.raw));
        }
        "minimal" => {}
        _ => {
            // metadata / full: headers + part tree (no body data needed by Courier).
            let headers = header_list(&m.raw);
            let parts: Vec<Value> = p.attachments.iter().map(|a| json!({"filename": a.name, "mimeType": a.mime, "body": {"size": a.size, "attachmentId": "att"}, "headers": []})).collect();
            v["payload"] = json!({"mimeType": "multipart/mixed", "filename": "", "headers": headers, "parts": parts});
        }
    }
    v
}

fn header_list(raw: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(raw);
    let head = text.split("\r\n\r\n").next().unwrap_or("").replace("\r\n ", " ").replace("\r\n\t", " ");
    head.lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| json!({"name": n.trim(), "value": v.trim()}))
        .collect()
}
