//! OAuth 2 for the mail API: authorization code + PKCE (S256) through the system browser, with a
//! loopback redirect on 127.0.0.1:<random port>. Tokens are kept in the Keychain; access tokens are
//! refreshed on demand.

use crate::error::{random_token, Error, Result};
use crate::http::{self, Response};
use crate::secrets::{oauth_key, SecretStore};
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::BufReader;
use tokio::net::TcpListener;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub auth_url: String,
    pub token_url: String,
    pub userinfo_url: String,
    pub api_base: String,
    pub people_base: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo".into(),
            api_base: "https://gmail.googleapis.com/gmail/v1/users/me".into(),
            people_base: "https://people.googleapis.com/v1".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientCreds {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
}

impl ClientCreds {
    /// Accepts the JSON file the cloud console downloads ({"installed": {...}}) or {clientId, clientSecret}.
    pub fn from_json(s: &str) -> Result<Self> {
        let v: serde_json::Value = serde_json::from_str(s)?;
        let inner = v.get("installed").or_else(|| v.get("web")).unwrap_or(&v);
        let id = inner.get("client_id").or_else(|| inner.get("clientId")).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let secret = inner.get("client_secret").or_else(|| inner.get("clientSecret")).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if id.is_empty() {
            return Err(Error::msg("That file doesn't contain a client ID."));
        }
        Ok(ClientCreds { client_id: id, client_secret: secret })
    }
}

pub const SCOPES: &[&str] = &[
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.settings.sharing",
    "https://www.googleapis.com/auth/contacts.other.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
    "openid",
    "email",
    "profile",
];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub scope: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
}

fn unix_now() -> i64 {
    crate::error::now_ms() / 1000
}

pub fn pkce_pair() -> (String, String) {
    let verifier = random_token(48); // 64 URL-safe chars
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub struct Authorization {
    pub tokens: Tokens,
    pub redirect_uri: String,
}

const DONE_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Courier</title>
<body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#202124">
<div style="text-align:center"><h2 style="font-weight:500">You're signed in to Courier</h2><p>You can close this tab and go back to the app.</p></div>"#;

/// Run the browser flow. `open` receives the authorization URL (it opens the system browser, or in the
/// end-to-end run fetches the URL directly against the fake server).
pub async fn authorize<F>(http_client: &reqwest::Client, ep: &Endpoints, creds: &ClientCreds, login_hint: Option<&str>, open: F) -> Result<Authorization>
where
    F: FnOnce(String) -> Result<()>,
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let (verifier, challenge) = pkce_pair();
    let state = random_token(16);
    let mut url = url::Url::parse(&ep.auth_url).map_err(|e| Error::msg(e.to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &creds.client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &SCOPES.join(" "))
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent")
            .append_pair("include_granted_scopes", "true");
        if let Some(h) = login_hint {
            q.append_pair("login_hint", h);
        }
    }
    open(url.to_string())?;
    let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(listener, &state))
        .await
        .map_err(|_| Error::msg("Sign-in timed out. Try again."))??;
    let tokens = exchange_code(http_client, ep, creds, &code, &verifier, &redirect_uri).await?;
    Ok(Authorization { tokens, redirect_uri })
}

async fn wait_for_code(listener: TcpListener, state: &str) -> Result<String> {
    loop {
        let (stream, _) = listener.accept().await?;
        let (r, mut w) = stream.into_split();
        let mut reader = BufReader::new(r);
        let Some(req) = http::read_request(&mut reader).await? else { continue };
        if let Some(err) = req.q("error") {
            let _ = http::write_response(&mut w, &Response::html(200, "<p>Sign-in was cancelled. You can close this tab.</p>"), false).await;
            return Err(Error::Auth(format!("Sign-in was cancelled ({err}).")));
        }
        match (req.q("code"), req.q("state")) {
            (Some(code), Some(s)) if s == state => {
                let _ = http::write_response(&mut w, &Response::html(200, DONE_PAGE), false).await;
                return Ok(code.to_string());
            }
            _ => {
                // Favicon or a stray request: answer and keep waiting.
                let _ = http::write_response(&mut w, &Response::status(404), false).await;
            }
        }
    }
}

pub async fn exchange_code(http_client: &reqwest::Client, ep: &Endpoints, creds: &ClientCreds, code: &str, verifier: &str, redirect_uri: &str) -> Result<Tokens> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("client_id", creds.client_id.as_str()),
        ("redirect_uri", redirect_uri),
    ];
    if !creds.client_secret.is_empty() {
        form.push(("client_secret", creds.client_secret.as_str()));
    }
    let resp = http_client.post(&ep.token_url).form(&form).send().await?;
    token_response(resp, None).await
}

pub async fn refresh(http_client: &reqwest::Client, ep: &Endpoints, creds: &ClientCreds, refresh_token: &str) -> Result<Tokens> {
    let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", creds.client_id.as_str())];
    if !creds.client_secret.is_empty() {
        form.push(("client_secret", creds.client_secret.as_str()));
    }
    let resp = http_client.post(&ep.token_url).form(&form).send().await?;
    token_response(resp, Some(refresh_token)).await
}

async fn token_response(resp: reqwest::Response, keep_refresh: Option<&str>) -> Result<Tokens> {
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("");
        if err == "invalid_grant" || err == "unauthorized_client" || status.as_u16() == 401 {
            return Err(Error::Auth("Sign-in expired. Sign in again.".into()));
        }
        return Err(Error::Server(format!("token endpoint {status}: {err}")));
    }
    let t: TokenResponse = serde_json::from_str(&body)?;
    Ok(Tokens {
        access_token: t.access_token,
        refresh_token: t.refresh_token.or_else(|| keep_refresh.map(str::to_string)),
        expires_at: unix_now() + t.expires_in.unwrap_or(3600),
        scope: t.scope.unwrap_or_default(),
    })
}

/// Hands out a valid access token for one account, refreshing (and re-saving) when it's close to expiry.
pub struct TokenManager {
    pub account_id: String,
    pub endpoints: Endpoints,
    pub creds: ClientCreds,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    cached: Mutex<Option<Tokens>>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl TokenManager {
    pub fn new(account_id: &str, endpoints: Endpoints, creds: ClientCreds, secrets: Arc<dyn SecretStore>, http: reqwest::Client) -> Self {
        TokenManager { account_id: account_id.into(), endpoints, creds, secrets, http, cached: Mutex::new(None), refresh_lock: tokio::sync::Mutex::new(()) }
    }

    fn load(&self) -> Result<Tokens> {
        if let Some(t) = self.cached.lock().clone() {
            return Ok(t);
        }
        let raw = self.secrets.get(&oauth_key(&self.account_id))?.ok_or_else(|| Error::Auth("Not signed in.".into()))?;
        let t: Tokens = serde_json::from_str(&raw)?;
        *self.cached.lock() = Some(t.clone());
        Ok(t)
    }

    pub fn save(&self, t: &Tokens) -> Result<()> {
        self.secrets.set(&oauth_key(&self.account_id), &serde_json::to_string(t)?)?;
        *self.cached.lock() = Some(t.clone());
        Ok(())
    }

    pub async fn access_token(&self) -> Result<String> {
        let t = self.load()?;
        if t.expires_at - 60 > unix_now() && !t.access_token.is_empty() {
            return Ok(t.access_token);
        }
        self.force_refresh(None).await
    }

    /// Refreshes the access token. `failed` is the token a request was just refused with (a 401): if another
    /// request already replaced it while this one waited for the lock, that newer token is used instead.
    pub async fn force_refresh(&self, failed: Option<&str>) -> Result<String> {
        let _g = self.refresh_lock.lock().await;
        let t = self.load()?;
        let still_valid = t.expires_at - 60 > unix_now() && !t.access_token.is_empty();
        if still_valid && failed.is_none_or(|f| f != t.access_token) {
            return Ok(t.access_token);
        }
        let rt = t.refresh_token.clone().ok_or_else(|| Error::Auth("Sign in again.".into()))?;
        let fresh = refresh(&self.http, &self.endpoints, &self.creds, &rt).await?;
        self.save(&fresh)?;
        Ok(fresh.access_token)
    }

    pub fn invalidate(&self) {
        if let Some(t) = self.cached.lock().as_mut() {
            t.expires_at = 0;
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct UserInfo {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: String,
}

pub async fn userinfo(http_client: &reqwest::Client, ep: &Endpoints, access_token: &str) -> Result<UserInfo> {
    let r = http_client.get(&ep.userinfo_url).bearer_auth(access_token).send().await?;
    if !r.status().is_success() {
        return Err(Error::Server(format!("userinfo {}", r.status())));
    }
    Ok(r.json().await?)
}
