//! IMAP for every other provider: TLS / STARTTLS / plain (tests) connections, folders shown as labels,
//! UID-based sync with flag and expunge reconciliation, moves/copies for label actions, APPEND, IDLE.

use crate::db::{Db, LabelRow, MessageRow, Read};
use crate::error::{io_error, Error, Result};
use crate::mailmeta;
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    #[default]
    Tls,
    Starttls,
    Plain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub security: Security,
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImapAccountConfig {
    pub imap: ServerConfig,
    pub smtp: ServerConfig,
    /// Whether to APPEND sent mail to the Sent folder (servers that save it themselves don't need it).
    #[serde(default = "yes")]
    pub save_sent: bool,
    /// Messages per folder to cache on first sync.
    #[serde(default = "default_window")]
    pub initial_window: u32,
}

fn yes() -> bool {
    true
}
fn default_window() -> u32 {
    500
}

#[derive(Debug)]
pub enum MaybeTls {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for MaybeTls {
    /// The server closing the connection is an error, never the end of an answer: async-imap takes a response stream
    /// that just ends as a complete one, so a command the server never answered (it timed out, restarted, or the
    /// network went) would count as done, and a sync would read an empty mailbox.
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let (room, had) = (buf.remaining(), buf.filled().len());
        let r = match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_read(cx, buf),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        };
        match r {
            Poll::Ready(Ok(())) if room > 0 && buf.filled().len() == had => Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the mail server closed the connection"))),
            r => r,
        }
    }
}

impl AsyncWrite for MaybeTls {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_write(cx, buf),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_flush(cx),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_shutdown(cx),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

pub type Session = async_imap::Session<MaybeTls>;

pub fn tls_config() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(cfg)
}

async fn tls_wrap(host: &str, tcp: TcpStream) -> Result<MaybeTls> {
    let connector = tokio_rustls::TlsConnector::from(tls_config());
    let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|e| Error::msg(format!("bad host name: {e}")))?;
    let s = connector.connect(name, tcp).await.map_err(io_error)?;
    Ok(MaybeTls::Tls(Box::new(s)))
}

pub async fn connect(cfg: &ServerConfig, password: &str) -> Result<Session> {
    let tcp = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect((cfg.host.as_str(), cfg.port)))
        .await
        .map_err(|_| Error::Offline(format!("timed out connecting to {}", cfg.host)))?
        .map_err(io_error)?;
    let stream = match cfg.security {
        Security::Tls => tls_wrap(&cfg.host, tcp).await?,
        Security::Plain => MaybeTls::Plain(tcp),
        Security::Starttls => {
            let mut c = async_imap::Client::new(MaybeTls::Plain(tcp));
            c.read_response().await.map_err(io_error)?; // greeting
            c.run_command_and_check_ok("STARTTLS", None).await?;
            let MaybeTls::Plain(tcp) = c.into_inner() else { unreachable!() };
            let s = tls_wrap(&cfg.host, tcp).await?;
            let client = async_imap::Client::new(s);
            return login(client, cfg, password).await;
        }
    };
    let mut client = async_imap::Client::new(stream);
    client.read_response().await.map_err(io_error)?; // greeting
    login(client, cfg, password).await
}

async fn login(client: async_imap::Client<MaybeTls>, cfg: &ServerConfig, password: &str) -> Result<Session> {
    match tokio::time::timeout(Duration::from_secs(30), client.login(&cfg.username, password)).await {
        Err(_) => Err(Error::Offline("login timed out".into())),
        Ok(Ok(s)) => Ok(s),
        Ok(Err((e, _))) => Err(match e {
            async_imap::error::Error::No(s) | async_imap::error::Error::Bad(s) => Error::Auth(format!("The server didn't accept the user name or password ({s}).")),
            other => other.into(),
        }),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub delimiter: Option<String>,
    pub attrs: Vec<String>,
}

impl Folder {
    pub fn selectable(&self) -> bool {
        !self.attrs.iter().any(|a| a.eq_ignore_ascii_case("noselect") || a.eq_ignore_ascii_case("nonexistent"))
    }
}

fn attr_name(a: &async_imap::types::NameAttribute) -> String {
    // Debug forms: NoSelect, Sent, Junk, Extension("\\HasNoChildren")…
    let d = format!("{a:?}");
    if let Some(inner) = d.strip_prefix("Extension(").and_then(|x| x.strip_suffix(')')) {
        inner.trim_matches('"').trim_start_matches('\\').trim_start_matches('\\').to_string()
    } else {
        d
    }
}

pub async fn list_folders(s: &mut Session) -> Result<Vec<Folder>> {
    let names: Vec<async_imap::types::Name> = s.list(Some(""), Some("*")).await?.try_collect().await?;
    Ok(names.iter().map(|n| Folder { path: n.name().to_string(), delimiter: n.delimiter().map(str::to_string), attrs: n.attributes().iter().map(attr_name).collect() }).collect())
}

/// System label for a folder: special-use attributes first, then well-known names.
pub fn folder_system_label(f: &Folder) -> Option<&'static str> {
    for a in &f.attrs {
        match a.to_ascii_lowercase().as_str() {
            "sent" => return Some("SENT"),
            "drafts" => return Some("DRAFT"),
            "trash" => return Some("TRASH"),
            "junk" => return Some("SPAM"),
            "archive" => return Some("ALL"),
            "all" => return Some("ALLVIRTUAL"),
            "flagged" => return Some("FLAGGEDVIRTUAL"),
            _ => {}
        }
    }
    if f.path.eq_ignore_ascii_case("INBOX") {
        return Some("INBOX");
    }
    let leaf = f.delimiter.as_deref().and_then(|d| f.path.rsplit(d).next()).unwrap_or(&f.path).to_lowercase();
    match leaf.as_str() {
        "sent" | "sent items" | "sent messages" | "sent mail" => Some("SENT"),
        "drafts" | "draft" => Some("DRAFT"),
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" => Some("TRASH"),
        "spam" | "junk" | "junk e-mail" | "junk email" | "bulk mail" => Some("SPAM"),
        "archive" | "archives" => Some("ALL"),
        "important" if f.path.to_lowercase().starts_with("[gmail]") => Some("IMPORTANTVIRTUAL"),
        "all mail" => Some("ALLVIRTUAL"),
        "starred" if f.path.to_lowercase().starts_with("[gmail]") => Some("FLAGGEDVIRTUAL"),
        _ => None,
    }
}

/// IMAP modified UTF-7 (RFC 3501 §5.1.3) → Unicode.
pub fn decode_mutf7(s: &str) -> String {
    use base64::Engine as _;
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        let Some(end) = tail.find('-') else {
            out.push_str(&rest[i..]);
            return out;
        };
        let b = &tail[..end];
        if b.is_empty() {
            out.push('&');
        } else {
            let std = b.replace(',', "/");
            let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(std.trim_end_matches('=')).unwrap_or_default();
            let units: Vec<u16> = bytes.chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            out.push_str(&String::from_utf16_lossy(&units));
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

pub fn folder_label_name(f: &Folder) -> String {
    let parts: Vec<String> = match &f.delimiter {
        Some(d) if !d.is_empty() => f.path.split(d.as_str()).map(decode_mutf7).collect(),
        _ => vec![decode_mutf7(&f.path)],
    };
    let parts = if parts.len() > 1 && parts[0].eq_ignore_ascii_case("INBOX") { parts[1..].to_vec() } else { parts };
    parts.join("/")
}

pub fn folder_label_id(f: &Folder) -> String {
    match folder_system_label(f) {
        Some(s) if !s.ends_with("VIRTUAL") => s.to_string(),
        _ => format!("F:{}", f.path),
    }
}

pub fn message_id_for(path: &str, uidvalidity: u32, uid: u32) -> String {
    format!("i:{uidvalidity}:{uid}:{path}")
}

pub fn parse_message_id(id: &str) -> Option<(String, u32, u32)> {
    let rest = id.strip_prefix("i:")?;
    let mut it = rest.splitn(3, ':');
    let uv = it.next()?.parse().ok()?;
    let uid = it.next()?.parse().ok()?;
    let path = it.next()?.to_string();
    Some((path, uv, uid))
}

fn flags_to_labels(flags: &[String], folder_label: &str) -> Vec<String> {
    let mut labels = vec![folder_label.to_string()];
    let has = |f: &str| flags.iter().any(|x| x.eq_ignore_ascii_case(f));
    if !has("\\Seen") {
        labels.push("UNREAD".into());
    }
    if has("\\Flagged") {
        labels.push("STARRED".into());
    }
    if has("\\Draft") && folder_label != "DRAFT" {
        labels.push("DRAFT".into());
    }
    labels
}

fn flag_strings(f: &async_imap::types::Fetch) -> Vec<String> {
    use async_imap::types::Flag;
    f.flags()
        .map(|fl| match fl {
            Flag::Seen => "\\Seen".to_string(),
            Flag::Answered => "\\Answered".to_string(),
            Flag::Flagged => "\\Flagged".to_string(),
            Flag::Deleted => "\\Deleted".to_string(),
            Flag::Draft => "\\Draft".to_string(),
            Flag::Recent => "\\Recent".to_string(),
            Flag::MayCreate => "\\*".to_string(),
            Flag::Custom(c) => c.to_string(),
        })
        .collect()
}

/// Assign a conversation to a newly seen local message (reference threading with a subject fallback).
pub fn assign_thread(db: &Db, account: &str, row: &MessageRow, is_reply: bool) -> Result<String> {
    if !row.message_id.is_empty() {
        let same = db.messages_where(account, "m.message_id = ?", vec![row.message_id.clone().into()], 1)?;
        if let Some(m) = same.first() {
            return Ok(m.thread_id.clone());
        }
    }
    let mut refs = row.references.clone();
    if !row.in_reply_to.is_empty() {
        refs.push(row.in_reply_to.clone());
    }
    if let Some(t) = db.thread_for_refs(account, &row.message_id, &refs, &row.norm_subject, is_reply, row.internal_date)? {
        return Ok(t);
    }
    let seed = if row.message_id.is_empty() { row.id.clone() } else { row.message_id.clone() };
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(seed.as_bytes());
    Ok(format!("t{}", h.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>()))
}

#[derive(Debug, Default)]
pub struct FolderSync {
    pub new_messages: Vec<MessageRow>,
    pub changed: bool,
}

pub struct FolderInfo {
    pub folder: Folder,
    pub label_id: String,
}

/// Update the label list from the server's folders. Returns the folders worth syncing, most important first.
pub async fn sync_folder_list(s: &mut Session, db: &Db, account: &str) -> Result<Vec<FolderInfo>> {
    let folders = list_folders(s).await?;
    let mut infos = Vec::new();
    let mut seen = Vec::new();
    for f in folders {
        if !f.selectable() {
            continue;
        }
        let sys = folder_system_label(&f);
        if matches!(sys, Some(s) if s.ends_with("VIRTUAL")) {
            continue; // virtual folders duplicate other folders
        }
        let id = folder_label_id(&f);
        if seen.contains(&id) {
            continue; // two folders claiming the same role: keep the first
        }
        seen.push(id.clone());
        let existing = db.label(account, &id)?;
        let name = match sys {
            Some("INBOX") => "INBOX".to_string(),
            Some("SENT") => "SENT".to_string(),
            Some("DRAFT") => "DRAFT".to_string(),
            Some("TRASH") => "TRASH".to_string(),
            Some("SPAM") => "SPAM".to_string(),
            Some("ALL") => "Archive".to_string(),
            _ => folder_label_name(&f),
        };
        let mut row = existing.clone().unwrap_or_default();
        row.account_id = account.into();
        row.id = id.clone();
        row.name = name;
        row.kind = if sys.is_some() { "system".into() } else { "user".into() };
        row.imap_path = Some(f.path.clone());
        row.imap_delimiter = f.delimiter.clone();
        row.special = sys.map(str::to_string);
        db.upsert_label(&LabelRow { imap_uidvalidity: existing.as_ref().and_then(|e| e.imap_uidvalidity), imap_uidnext: existing.as_ref().and_then(|e| e.imap_uidnext), ..row })?;
        infos.push(FolderInfo { folder: f, label_id: id });
    }
    for l in db.labels(account)? {
        if l.imap_path.is_some() && !seen.contains(&l.id) {
            if let Some(p) = &l.imap_path {
                db.delete_folder_messages(account, p)?;
            }
            db.delete_label(account, &l.id)?;
        }
    }
    let rank = |id: &str| match id {
        "INBOX" => 0,
        "SENT" => 1,
        "DRAFT" => 2,
        "ALL" => 3,
        "SPAM" => 5,
        "TRASH" => 6,
        _ => 4,
    };
    infos.sort_by_key(|i| rank(&i.label_id));
    Ok(infos)
}

const FETCH_FULL: &str = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])";

fn ingest_fetch(read: &Read<'_>, path: &str, label_id: &str, uv: u32, f: &async_imap::types::Fetch) -> Result<Option<MessageRow>> {
    let (db, account) = (read.db(), read.account());
    let Some(uid) = f.uid else { return Ok(None) };
    let Some(body) = f.body() else { return Ok(None) };
    let parsed = mailmeta::parse_raw(body);
    let mut row = parsed.row;
    row.account_id = account.into();
    row.id = message_id_for(path, uv, uid);
    if let Some(d) = f.internal_date() {
        row.internal_date = d.timestamp_millis();
    }
    if let Some(sz) = f.size {
        row.size = sz as i64;
    }
    row.labels = flags_to_labels(&flag_strings(f), label_id);
    if label_id == "SENT" && !row.labels.contains(&"SENT".to_string()) {
        row.labels.push("SENT".into());
    }
    row.imap_folder = Some(path.into());
    row.imap_uid = Some(uid as i64);
    row.thread_id = assign_thread(db, account, &row, parsed.is_reply)?;
    row.has_raw = true;
    read.upsert_message(&row, Some(body))?;
    Ok(Some(row))
}

/// Sync one folder: new messages (initial window, then by UIDNEXT), flag changes and expunges.
pub async fn sync_folder(s: &mut Session, db: &Db, account: &str, info: &FolderInfo, initial_window: u32) -> Result<FolderSync> {
    let read = db.begin_read(account);
    let path = info.folder.path.clone();
    let mb = s.select(&path).await?;
    let uv = mb.uid_validity.unwrap_or(0);
    let label = db.label(account, &info.label_id)?.unwrap_or_default();
    let mut out = FolderSync::default();
    if label.imap_uidvalidity.is_some() && label.imap_uidvalidity != Some(uv as i64) {
        db.delete_folder_messages(account, &path)?;
        out.changed = true;
    }
    let known = db.message_ids_in_folder(account, &path)?;
    let stored_next = if label.imap_uidvalidity == Some(uv as i64) { label.imap_uidnext } else { None };
    if mb.exists > 0 {
        let fetches: Vec<async_imap::types::Fetch> = match stored_next {
            Some(n) if !known.is_empty() || n > 1 => s.uid_fetch(format!("{n}:*"), FETCH_FULL).await?.try_collect().await?,
            _ => {
                let start = mb.exists.saturating_sub(initial_window.max(1)) + 1;
                s.fetch(format!("{start}:*"), FETCH_FULL).await?.try_collect().await?
            }
        };
        for f in &fetches {
            let Some(uid) = f.uid else { continue };
            if known.contains_key(&(uid as i64)) || stored_next.map(|n| (uid as i64) < n).unwrap_or(false) {
                continue;
            }
            if let Some(row) = ingest_fetch(&read, &path, &info.label_id, uv, f)? {
                out.new_messages.push(row);
                out.changed = true;
            }
        }
    }
    // Flags and expunges for what we already have.
    if !known.is_empty() {
        let min = *known.keys().min().unwrap();
        let fetches: Vec<async_imap::types::Fetch> = s.uid_fetch(format!("{min}:*"), "(UID FLAGS)").await?.try_collect().await?;
        let mut flags: HashMap<i64, Vec<String>> = HashMap::new();
        for f in &fetches {
            if let Some(uid) = f.uid {
                flags.insert(uid as i64, flag_strings(f));
            }
        }
        for (uid, id) in &known {
            match flags.get(uid) {
                None => {
                    read.forget(id)?;
                    out.changed = true;
                }
                Some(fl) => {
                    if let Some(m) = db.message(account, id)? {
                        let mut labels = flags_to_labels(fl, &info.label_id);
                        if info.label_id == "SENT" && !labels.contains(&"SENT".to_string()) {
                            labels.push("SENT".into());
                        }
                        let mut a = m.labels.clone();
                        a.sort();
                        let mut b = labels.clone();
                        b.sort();
                        if a != b {
                            read.set_labels(id, &labels)?;
                            out.changed = true;
                        }
                    }
                }
            }
        }
    }
    db.set_label_imap_state(account, &info.label_id, Some(uv as i64), mb.uid_next.map(|n| n as i64), mb.highest_modseq.map(|n| n as i64))?;
    Ok(out)
}

pub async fn sync_all(s: &mut Session, db: &Db, account: &str, initial_window: u32) -> Result<FolderSync> {
    let infos = sync_folder_list(s, db, account).await?;
    let mut total = FolderSync::default();
    for info in &infos {
        let r = sync_folder(s, db, account, info, initial_window).await?;
        total.changed |= r.changed;
        total.new_messages.extend(r.new_messages);
    }
    db.recount_labels(account)?;
    Ok(total)
}

pub async fn has_capability(s: &mut Session, cap: &str) -> bool {
    match s.capabilities().await {
        Ok(c) => c.has_str(cap),
        Err(_) => false,
    }
}

/// Move messages (same source folder) to another folder; COPY + \Deleted + EXPUNGE without MOVE.
pub async fn move_uids(s: &mut Session, from: &str, uids: &[u32], to: &str) -> Result<()> {
    if uids.is_empty() || from == to {
        return Ok(());
    }
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    s.select(from).await?;
    if has_capability(s, "MOVE").await {
        s.uid_mv(&set, to).await?;
    } else {
        s.uid_copy(&set, to).await?;
        let _: Vec<_> = s.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
        if has_capability(s, "UIDPLUS").await {
            let _: Vec<_> = s.uid_expunge(&set).await?.try_collect().await?;
        } else {
            let _: Vec<_> = s.expunge().await?.try_collect().await?;
        }
    }
    Ok(())
}

pub async fn copy_uids(s: &mut Session, from: &str, uids: &[u32], to: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    s.select(from).await?;
    s.uid_copy(&set, to).await?;
    Ok(())
}

pub async fn store_flags(s: &mut Session, folder: &str, uids: &[u32], add: bool, flags: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    s.select(folder).await?;
    let cmd = format!("{}FLAGS.SILENT ({flags})", if add { "+" } else { "-" });
    let _: Vec<_> = s.uid_store(&set, &cmd).await?.try_collect().await?;
    Ok(())
}

pub async fn expunge_uids(s: &mut Session, folder: &str, uids: &[u32]) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    store_flags(s, folder, uids, true, "\\Deleted").await?;
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    if has_capability(s, "UIDPLUS").await {
        let _: Vec<_> = s.uid_expunge(&set).await?.try_collect().await?;
    } else {
        let _: Vec<_> = s.expunge().await?.try_collect().await?;
    }
    Ok(())
}

pub async fn append(s: &mut Session, folder: &str, flags: &str, raw: &[u8]) -> Result<()> {
    s.append(folder, Some(flags), None, raw).await?;
    Ok(())
}

/// Find a message in a folder by Message-ID (after APPEND, to learn its UID).
pub async fn find_by_message_id(s: &mut Session, folder: &str, message_id: &str) -> Result<Option<u32>> {
    s.select(folder).await?;
    let q = format!("HEADER Message-ID \"{}\"", message_id.replace('"', ""));
    let uids = s.uid_search(&q).await?;
    Ok(uids.into_iter().max())
}

pub async fn create_folder(s: &mut Session, path: &str) -> Result<()> {
    s.create(path).await?;
    let _ = s.subscribe(path).await;
    Ok(())
}

pub async fn rename_folder(s: &mut Session, from: &str, to: &str) -> Result<()> {
    s.rename(from, to).await?;
    Ok(())
}

pub async fn delete_folder(s: &mut Session, path: &str) -> Result<()> {
    s.delete(path).await?;
    Ok(())
}

/// Encode a label name ("Projects/Alpha") as a folder path with the server's delimiter (mUTF-7).
pub fn path_for_label_name(name: &str, delimiter: &str) -> String {
    name.split('/').map(encode_mutf7).collect::<Vec<_>>().join(delimiter)
}

pub fn encode_mutf7(s: &str) -> String {
    use base64::Engine as _;
    let mut out = String::new();
    let mut buf: Vec<u16> = Vec::new();
    let flush = |buf: &mut Vec<u16>, out: &mut String| {
        if buf.is_empty() {
            return;
        }
        let bytes: Vec<u8> = buf.iter().flat_map(|u| u.to_be_bytes()).collect();
        out.push('&');
        out.push_str(&base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes).replace('/', ","));
        out.push('-');
        buf.clear();
    };
    for ch in s.chars() {
        if (' '..='~').contains(&ch) {
            flush(&mut buf, &mut out);
            if ch == '&' {
                out.push_str("&-");
            } else {
                out.push(ch);
            }
        } else {
            let mut tmp = [0u16; 2];
            buf.extend_from_slice(ch.encode_utf16(&mut tmp));
        }
    }
    flush(&mut buf, &mut out);
    out
}

/// IDLE on INBOX until the server reports a change, the timeout passes or `stop` fires.
/// Returns true when there's new data.
pub async fn idle_once(s: Session, timeout: Duration, stop: &mut tokio::sync::watch::Receiver<bool>) -> Result<(Session, bool)> {
    let mut s = s;
    s.select("INBOX").await?;
    let mut idle = s.idle();
    idle.init().await?;
    let (fut, interrupt) = idle.wait_with_timeout(timeout);
    let res = tokio::select! {
        r = fut => Some(r),
        _ = stop.changed() => None,
    };
    drop(interrupt);
    let changed = matches!(res, Some(Ok(async_imap::extensions::idle::IdleResponse::NewData(_))));
    if let Some(Err(e)) = res {
        return Err(e.into());
    }
    let s = idle.done().await?;
    Ok((s, changed))
}

// ---- SMTP ----

pub async fn smtp_send(cfg: &ServerConfig, password: &str, from: &str, recipients: &[String], raw: &[u8]) -> Result<()> {
    use lettre::address::Envelope;
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
    let builder = match cfg.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)?,
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)?,
        Security::Plain => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
    };
    let mut builder = builder.port(cfg.port).timeout(Some(Duration::from_secs(60)));
    if !cfg.username.is_empty() {
        builder = builder.credentials(Credentials::new(cfg.username.clone(), password.to_string()));
    }
    let transport = builder.build::<Tokio1Executor>();
    let from_addr = from.parse().map_err(|e| Error::Smtp(format!("bad From address: {e}")))?;
    let to: std::result::Result<Vec<lettre::Address>, _> = recipients.iter().map(|r| r.parse()).collect();
    let to = to.map_err(|e| Error::Smtp(format!("bad recipient: {e}")))?;
    if to.is_empty() {
        return Err(Error::Smtp("No recipients.".into()));
    }
    let env = Envelope::new(Some(from_addr), to).map_err(|e| Error::Smtp(e.to_string()))?;
    transport.send_raw(&env, raw).await?;
    Ok(())
}

pub async fn smtp_test(cfg: &ServerConfig, password: &str) -> Result<()> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, Tokio1Executor};
    let builder = match cfg.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)?,
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)?,
        Security::Plain => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
    };
    let mut builder = builder.port(cfg.port).timeout(Some(Duration::from_secs(30)));
    if !cfg.username.is_empty() {
        builder = builder.credentials(Credentials::new(cfg.username.clone(), password.to_string()));
    }
    let ok = builder.build::<Tokio1Executor>().test_connection().await?;
    if ok { Ok(()) } else { Err(Error::Smtp("The outgoing server didn't respond.".into())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_mapping_and_mutf7() {
        let f = |p: &str, attrs: &[&str]| Folder { path: p.into(), delimiter: Some("/".into()), attrs: attrs.iter().map(|s| s.to_string()).collect() };
        assert_eq!(folder_system_label(&f("Sent Items", &[])), Some("SENT"));
        assert_eq!(folder_system_label(&f("Archive", &["Archive"])), Some("ALL"));
        assert_eq!(folder_system_label(&f("[Gmail]/All Mail", &["All"])), Some("ALLVIRTUAL"));
        assert_eq!(folder_label_id(&f("Receipts", &[])), "F:Receipts");
        assert_eq!(folder_label_name(&Folder { path: "INBOX.Receipts.2026".into(), delimiter: Some(".".into()), attrs: vec![] }), "Receipts/2026");
        assert_eq!(decode_mutf7("Proj&AOk-t"), "Projét");
        assert_eq!(decode_mutf7(&encode_mutf7("日本語 & more")), "日本語 & more");
        assert_eq!(path_for_label_name("Projects/Alpha", "."), "Projects.Alpha");
        let id = message_id_for("INBOX/Sub:folder", 7, 42);
        assert_eq!(parse_message_id(&id), Some(("INBOX/Sub:folder".into(), 7, 42)));
    }
}

#[cfg(test)]
mod live_tls {
    //! Opt-in (needs the network): `cargo test --lib live_tls -- --ignored`. TLS handshake with real providers'
    //! IMAP servers and their greeting only — no login, no credentials.
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    #[ignore]
    async fn real_providers_accept_our_tls_and_greet() {
        for host in ["imap.mail.me.com", "imap.mail.yahoo.com", "imap.fastmail.com", "outlook.office365.com"] {
            let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host, 993))).await.expect("connect timed out").expect("connect");
            let mut tls = tls_wrap(host, tcp).await.unwrap_or_else(|e| panic!("{host}: TLS failed: {e}"));
            let mut buf = vec![0u8; 512];
            let n = tokio::time::timeout(Duration::from_secs(10), tls.read(&mut buf)).await.expect("greeting timed out").expect("read");
            let greeting = String::from_utf8_lossy(&buf[..n]);
            assert!(greeting.starts_with("* OK"), "{host}: unexpected greeting {greeting:?}");
            eprintln!("{host}: TLS ok, greeting starts {:?}", &greeting[..greeting.len().min(40)]);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn real_providers_smtp_tls_and_starttls_without_login() {
        for email in ["someone@icloud.com", "someone@yahoo.com", "someone@fastmail.com", "someone@outlook.com"] {
            let mut cfg = crate::discovery::builtin(email).and_then(|d| d.config).expect("built-in settings").smtp;
            cfg.username.clear(); // no AUTH: connect, EHLO, (STARTTLS), NOOP, QUIT
            smtp_test(&cfg, "").await.unwrap_or_else(|e| panic!("{}:{} {:?}: {e}", cfg.host, cfg.port, cfg.security));
            eprintln!("{}:{} {:?}: ok", cfg.host, cfg.port, cfg.security);
        }
    }
}
