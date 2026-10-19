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
    pub offline: bool,
    pub refresh_count: u32,
    /// The next N API calls get Gmail's 403 "User-rate limit exceeded".
    pub rate_limit_next: u32,
    /// Message ids whose fetch always fails with a plain 403.
    pub forbidden_ids: Vec<String>,
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
            Box::pin(async move { f.handle(req) })
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
        }
        if path == "/o/oauth2/v2/auth" {
            return self.authorize(&req);
        }
        if path == "/token" {
            return self.token(&req);
        }
        if let Some(rest) = path.strip_prefix("/unsubscribe/") {
            self.state.lock().unsubscribed.push(rest.to_string());
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
                let mut seen = Vec::new();
                for m in &msgs {
                    if !seen.contains(&m.thread_id) {
                        seen.push(m.thread_id.clone());
                    }
                }
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

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn new_id(s: &mut GState) -> String {
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
    s.history_id += 1;
    let id = s.history_id;
    let msg = json!({"id": m.id, "threadId": m.thread_id, "labelIds": m.labels});
    let entry = if kind == "messagesAdded" || kind == "messagesDeleted" { json!({"message": msg}) } else { json!({"message": msg, "labelIds": label_ids}) };
    s.history.push((id, json!({"id": id.to_string(), kind: [entry]})));
}

fn modify(s: &mut GState, id: &str, add: &[String], remove: &[String]) {
    let Some(m) = s.messages.get_mut(id) else { return };
    let before = m.labels.clone();
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

fn searchable(s: &GState, m: &FMsg, names: &HashMap<String, String>) -> search::Searchable {
    let p = mailmeta::parse_raw(&m.raw).row;
    let addrs = |l: &[crate::db::Addr]| l.iter().map(|a| format!("{} {}", a.name, a.email)).collect::<Vec<_>>().join(" ").to_lowercase();
    let _ = s;
    search::Searchable {
        from: format!("{} {}", p.from_name, p.from_email).to_lowercase(),
        to: addrs(&p.to),
        cc: addrs(&p.cc),
        bcc: addrs(&p.bcc),
        delivered_to: p.delivered_to.clone(),
        subject: p.subject.clone(),
        body: p.body_text.clone(),
        labels: m.labels.clone(),
        label_names: m.labels.iter().filter_map(|l| names.get(l).cloned()).collect(),
        attachment_names: p.attachments.iter().map(|a| a.name.clone()).collect(),
        size: m.raw.len() as i64,
        date_ms: m.internal_date,
        list_id: p.list_id.clone(),
        message_id: p.message_id.clone(),
        ..Default::default()
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
    let mut out: Vec<&FMsg> = s
        .messages
        .values()
        .filter(|m| label_ids.iter().all(|l| m.labels.contains(l)))
        .filter(|m| include || asks_spam_trash || label_ids.iter().any(|l| l == "SPAM" || l == "TRASH") || !(m.labels.iter().any(|l| l == "SPAM" || l == "TRASH")))
        .filter(|m| node.as_ref().map(|n| search::eval(n, &searchable(s, m, &names), now)).unwrap_or(true))
        .collect();
    out.sort_by(|a, b| b.internal_date.cmp(&a.internal_date));
    out
}

fn all_labels(s: &GState) -> Vec<Value> {
    let count = |id: &str| {
        let msgs: Vec<&FMsg> = s.messages.values().filter(|m| m.labels.iter().any(|l| l == id)).collect();
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
