//! Local cache: SQLite (WAL) with an FTS5 index for offline search. One connection behind a mutex; every
//! call is short. Labels are stored as " A B C " so membership is `labels LIKE '% A %'`.

use crate::error::{now_ms, Error, Result};
use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Addr {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AttachmentMeta {
    pub name: String,
    pub mime: String,
    pub size: i64,
}

/// A sender on the Manage subscriptions page.
/// One mailing list a sender uses, with the unsubscribe headers of its newest message.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderList {
    pub list_id: String,
    pub list_unsubscribe: String,
    pub list_unsubscribe_post: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub account_id: String,
    pub email: String,
    pub name: String,
    pub last_date: i64,
    pub list_unsubscribe: String,
    pub list_unsubscribe_post: String,
    pub list_id: String,
    pub total: i64,
    /// Messages in the last 30 days.
    pub recent: i64,
    /// When Courier unsubscribed (ms), if it did.
    pub unsubscribed: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub account_id: String,
    pub id: String,
    pub thread_id: String,
    pub internal_date: i64,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub bcc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    pub delivered_to: String,
    pub subject: String,
    pub norm_subject: String,
    pub snippet: String,
    pub size: i64,
    pub attachments: Vec<AttachmentMeta>,
    pub message_id: String,
    pub in_reply_to: String,
    pub references: Vec<String>,
    pub list_unsubscribe: String,
    pub list_unsubscribe_post: String,
    pub list_id: String,
    pub labels: Vec<String>,
    pub imap_folder: Option<String>,
    pub imap_uid: Option<i64>,
    #[serde(skip)]
    pub body_text: String,
    pub has_raw: bool,
}

impl MessageRow {
    pub fn has(&self, l: &str) -> bool {
        self.labels.iter().any(|x| x == l)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRow {
    pub account_id: String,
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String, // system | user
    pub bg: Option<String>,
    pub fg: Option<String>,
    pub label_list_visibility: Option<String>,
    pub message_list_visibility: Option<String>,
    pub threads_total: i64,
    pub threads_unread: i64,
    pub messages_total: i64,
    pub messages_unread: i64,
    pub imap_path: Option<String>,
    pub imap_delimiter: Option<String>,
    #[serde(skip)]
    pub imap_uidvalidity: Option<i64>,
    #[serde(skip)]
    pub imap_uidnext: Option<i64>,
    #[serde(skip)]
    pub imap_modseq: Option<i64>,
    pub special: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    pub id: String,
    pub kind: String, // gmail | imap
    pub email: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub config: serde_json::Value,
    pub state: serde_json::Value,
    pub photo: Option<String>,
    pub created_at: i64,
    pub needs_reauth: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRow {
    pub id: i64,
    pub account_id: String,
    #[serde(skip)]
    pub raw: Vec<u8>,
    pub send_at: i64,
    pub status: String, // pending | sending | failed
    pub attempts: i64,
    pub error: Option<String>,
    pub thread_id: Option<String>,
    pub draft_id: Option<String>,
    pub scheduled: bool,
    pub subject: String,
    pub recipients: Vec<String>,
    pub from_email: String,
    pub created_at: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub name: String,
    pub email: String,
    pub unread: bool,
    pub draft: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub account_id: String,
    pub thread_id: String,
    pub subject: String,
    pub snippet: String,
    pub last_date: i64,
    pub message_count: i64,
    pub unread: bool,
    pub starred: bool,
    pub star_type: Option<String>,
    pub important: bool,
    pub labels: Vec<String>,
    pub participants: Vec<Participant>,
    pub has_attachments: bool,
    pub attachments: Vec<AttachmentMeta>,
    pub snoozed_until: Option<i64>,
    pub muted: bool,
    pub message_ids: Vec<String>,
    pub draft_ids: Vec<String>,
    pub outbox_id: Option<i64>,
    pub scheduled_at: Option<i64>,
    pub list_unsubscribe: bool,
    /// Personal level: 0 = not addressed to me (a list, Bcc), 1 = to me among others, 2 = to me alone.
    pub to_me: u8,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub name: String,
    pub email: String,
    pub times: i64,
    pub last_used: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
    /// Label changes made here that the server hasn't confirmed yet, per (account, message), in order. Labels
    /// read from the server meanwhile describe the message before the change, so these are applied on top.
    /// A message's queued change (`change_queue`, token `QUEUED`) comes first.
    pending: Mutex<HashMap<(String, String), Vec<PendingChange>>>,
    next_change: std::sync::atomic::AtomicU64,
    /// Courier's clock for server reads and acknowledgements (see `Read`). The launch's generation is in the high
    /// bits, so a stamp kept from an earlier launch is older than any taken now.
    clock: std::sync::atomic::AtomicU64,
    /// Reads still out, by stamp, and changes the server confirmed on messages this Mac didn't have then (by
    /// message: the confirmation's stamp and the change). An answer read before the confirmation that brings one
    /// of those messages gets the change on top; a mark goes once no read older than it is out.
    reads_out: Mutex<BTreeMap<i64, usize>>,
    marks: Mutex<HashMap<(String, String), (i64, Vec<String>, Vec<String>)>>,
}

/// A server read in progress, opened before its request goes out (the mail API client's read methods take one).
/// Its stamp is the latest moment its answer can describe. The cache keeps each message's labels as the server
/// last said them (`server_labels`) with the stamp of the read they came from, and the newest wins; an
/// acknowledgement of a change made here counts as a read of the result at the moment it arrived. So an answer
/// read before a change landed can never undo it. Server data reaches the cache only through a `Read`.
pub struct Read<'a> {
    db: &'a Db,
    account: String,
    stamp: i64,
}

impl Drop for Read<'_> {
    fn drop(&mut self) {
        let mut out = self.db.reads_out.lock();
        if let Some(n) = out.get_mut(&self.stamp) {
            *n -= 1;
            if *n == 0 {
                out.remove(&self.stamp);
            }
        }
        let oldest = out.keys().next().copied().unwrap_or(i64::MAX);
        drop(out);
        self.db.marks.lock().retain(|_, (at, _, _)| *at > oldest);
    }
}

impl Read<'_> {
    pub fn stamp(&self) -> i64 {
        self.stamp
    }
    pub fn account(&self) -> &str {
        &self.account
    }
    pub fn db(&self) -> &Db {
        self.db
    }
    #[track_caller]
    pub fn set_labels(&self, id: &str, labels: &[String]) -> Result<()> {
        self.db.server_labels(&self.account, id, labels, self.stamp)
    }
    #[track_caller]
    pub fn upsert_message(&self, m: &MessageRow, raw: Option<&[u8]>) -> Result<()> {
        self.db.upsert_from_server(m, raw, self.stamp)
    }
    pub fn set_label_counts(&self, id: &str, counts: (i64, i64, i64, i64)) -> Result<()> {
        self.db.label_counts_from_server(&self.account, id, counts, self.stamp)
    }
    /// A label as the server lists it: name, colour and visibility always; its counts unless newer ones are held.
    pub fn upsert_label(&self, l: &LabelRow) -> Result<()> {
        let held: Option<(i64, i64, i64, i64, i64)> = self.db.with(|c| {
            c.query_row("SELECT threads_total, threads_unread, messages_total, messages_unread, counts_stamp FROM labels WHERE account_id=? AND id=?", [&l.account_id, &l.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .optional()
        })?;
        match held {
            Some((tt, tu, mt, mu, s)) if s > self.stamp => self.db.upsert_label(&LabelRow { threads_total: tt, threads_unread: tu, messages_total: mt, messages_unread: mu, ..l.clone() }),
            _ => {
                self.db.upsert_label(l)?;
                self.db.label_counts_from_server(&l.account_id, &l.id, (l.threads_total, l.threads_unread, l.messages_total, l.messages_unread), self.stamp)
            }
        }
    }
    /// The server's answer didn't have this message: it's gone, unless a newer answer put it here.
    pub fn forget(&self, id: &str) -> Result<()> {
        let held: Option<i64> = self.db.with(|c| c.query_row("SELECT server_stamp FROM messages WHERE account_id=? AND id=?", [&self.account, id], |r| r.get(0)).optional())?;
        if held.is_some_and(|h| h <= self.stamp) {
            self.db.delete_message(&self.account, id)?;
        }
        Ok(())
    }
}

struct PendingChange {
    token: u64,
    add: Vec<String>,
    remove: Vec<String>,
}

/// The token of a message's queued change in `pending` (changes on their way count from 1).
const QUEUED: u64 = 0;

/// End-to-end runs: log every write that moves a cached message into or out of the Inbox, with the code that
/// wrote it, so a row that comes back on screen can be traced to the write that brought it back.
pub static TRACE_INBOX: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A label change made while the server couldn't be reached, waiting to go to it: one per message, with every
/// change made to the message meanwhile folded in.
#[derive(Debug, Clone, PartialEq)]
pub struct QueuedChange {
    pub message_id: String,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', color TEXT NOT NULL,
  position INTEGER NOT NULL, config TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', photo TEXT,
  created_at INTEGER NOT NULL, needs_reauth INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS labels (
  account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, bg TEXT, fg TEXT,
  label_list_visibility TEXT, message_list_visibility TEXT,
  threads_total INTEGER NOT NULL DEFAULT 0, threads_unread INTEGER NOT NULL DEFAULT 0,
  messages_total INTEGER NOT NULL DEFAULT 0, messages_unread INTEGER NOT NULL DEFAULT 0,
  imap_path TEXT, imap_delimiter TEXT, imap_uidvalidity INTEGER, imap_uidnext INTEGER, imap_modseq INTEGER, special TEXT,
  counts_stamp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS messages (
  account_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL, internal_date INTEGER NOT NULL,
  from_name TEXT NOT NULL DEFAULT '', from_email TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]', reply_to_json TEXT NOT NULL DEFAULT '[]',
  delivered_to TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', norm_subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0, attachments_json TEXT NOT NULL DEFAULT '[]',
  message_id TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '', references_json TEXT NOT NULL DEFAULT '[]',
  list_unsubscribe TEXT NOT NULL DEFAULT '', list_unsubscribe_post TEXT NOT NULL DEFAULT '', list_id TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT ' ', raw BLOB, imap_folder TEXT, imap_uid INTEGER,
  server_labels TEXT NOT NULL DEFAULT ' ', server_stamp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS msg_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS msg_date ON messages(account_id, internal_date DESC);
CREATE INDEX IF NOT EXISTS msg_imap ON messages(account_id, imap_folder, imap_uid);
CREATE INDEX IF NOT EXISTS msg_mid ON messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS msg_irt ON messages(account_id, in_reply_to);
CREATE INDEX IF NOT EXISTS msg_subj ON messages(account_id, norm_subject);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(subject, sender, recipients, body, attachments, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS drafts (account_id TEXT NOT NULL, draft_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT, PRIMARY KEY (account_id, draft_id));
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, raw BLOB NOT NULL, send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, thread_id TEXT, draft_id TEXT,
  scheduled INTEGER NOT NULL DEFAULT 0, subject TEXT NOT NULL DEFAULT '', recipients TEXT NOT NULL DEFAULT '[]',
  from_email TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snoozes (account_id TEXT NOT NULL, thread_id TEXT NOT NULL, until INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, thread_id));
CREATE TABLE IF NOT EXISTS bumps (account_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (account_id, thread_id));
CREATE TABLE IF NOT EXISTS muted (account_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (account_id, thread_id));
CREATE TABLE IF NOT EXISTS star_types (account_id TEXT NOT NULL, message_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (account_id, message_id));
CREATE TABLE IF NOT EXISTS contacts (account_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', last_used INTEGER NOT NULL DEFAULT 0, times INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'mail', PRIMARY KEY (account_id, email));
CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', html TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signatures (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, html TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_filters (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, criteria TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blocked (account_id TEXT NOT NULL, email TEXT NOT NULL, filter_id TEXT, PRIMARY KEY (account_id, email));
CREATE TABLE IF NOT EXISTS thread_queue (
  account_id TEXT NOT NULL, thread_id TEXT NOT NULL, seq INTEGER NOT NULL, add_labels TEXT NOT NULL, remove_labels TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id)
);
CREATE TABLE IF NOT EXISTS change_queue (
  account_id TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER NOT NULL, before TEXT, add_labels TEXT NOT NULL, remove_labels TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
"#;

fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|x| b.contains(x))
}

/// A message's labels with the changes made here that the server doesn't have yet, in order, on top.
fn fold_pending(p: &HashMap<(String, String), Vec<PendingChange>>, account: &str, id: &str, labels: Vec<String>) -> Vec<String> {
    match p.get(&(account.to_string(), id.to_string())) {
        Some(list) => list.iter().fold(labels, |l, c| apply_change(l, &c.add, &c.remove)),
        None => labels,
    }
}

fn apply_change(labels: Vec<String>, add: &[String], remove: &[String]) -> Vec<String> {
    let mut out: Vec<String> = labels.into_iter().filter(|l| !remove.contains(l)).collect();
    for a in add {
        if !out.contains(a) {
            out.push(a.clone());
        }
    }
    out
}

/// What changed from `before` to `after`, as labels to add and labels to remove.
fn diff(before: &[String], after: &[String]) -> (Vec<String>, Vec<String>) {
    (after.iter().filter(|l| !before.contains(l)).cloned().collect(), before.iter().filter(|l| !after.contains(l)).cloned().collect())
}

/// Two label changes, one after the other, as one. Measured against the labels the message had before both,
/// only the difference is left (a change and its undo leave nothing); without them, the two combined.
fn compose(before: Option<&[String]>, first: (&[String], &[String]), then: (&[String], &[String])) -> (Vec<String>, Vec<String>) {
    if let Some(b) = before {
        return diff(b, &apply_change(apply_change(b.to_vec(), first.0, first.1), then.0, then.1));
    }
    let add = apply_change(first.0.to_vec(), then.0, then.1);
    let remove = apply_change(first.1.to_vec(), then.1, then.0).into_iter().filter(|l| !add.contains(l)).collect();
    (add, remove)
}

fn labels_text(labels: &[String]) -> String {
    let mut seen = HashSet::new();
    let mut s = String::from(" ");
    for l in labels {
        if !l.is_empty() && seen.insert(l.clone()) {
            s.push_str(l);
            s.push(' ');
        }
    }
    s
}

pub fn labels_vec(s: &str) -> Vec<String> {
    s.split(' ').filter(|x| !x.is_empty()).map(str::to_string).collect()
}

fn j<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

fn pj<T: for<'a> Deserialize<'a> + Default>(s: &str) -> T {
    serde_json::from_str(s).unwrap_or_default()
}

const MSG_COLS: &str = "m.account_id, m.id, m.thread_id, m.internal_date, m.from_name, m.from_email, m.to_json, m.cc_json, m.bcc_json, m.reply_to_json, m.delivered_to, m.subject, m.norm_subject, m.snippet, m.size, m.attachments_json, m.message_id, m.in_reply_to, m.references_json, m.list_unsubscribe, m.list_unsubscribe_post, m.list_id, m.labels, m.imap_folder, m.imap_uid, (m.raw IS NOT NULL)";

fn msg_from_row(r: &Row) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        account_id: r.get(0)?,
        id: r.get(1)?,
        thread_id: r.get(2)?,
        internal_date: r.get(3)?,
        from_name: r.get(4)?,
        from_email: r.get(5)?,
        to: pj(&r.get::<_, String>(6)?),
        cc: pj(&r.get::<_, String>(7)?),
        bcc: pj(&r.get::<_, String>(8)?),
        reply_to: pj(&r.get::<_, String>(9)?),
        delivered_to: r.get(10)?,
        subject: r.get(11)?,
        norm_subject: r.get(12)?,
        snippet: r.get(13)?,
        size: r.get(14)?,
        attachments: pj(&r.get::<_, String>(15)?),
        message_id: r.get(16)?,
        in_reply_to: r.get(17)?,
        references: pj(&r.get::<_, String>(18)?),
        list_unsubscribe: r.get(19)?,
        list_unsubscribe_post: r.get(20)?,
        list_id: r.get(21)?,
        labels: labels_vec(&r.get::<_, String>(22)?),
        imap_folder: r.get(23)?,
        imap_uid: r.get(24)?,
        body_text: String::new(),
        has_raw: r.get(25)?,
    })
}

const LABEL_COLS: &str = "account_id, id, name, type, bg, fg, label_list_visibility, message_list_visibility, threads_total, threads_unread, messages_total, messages_unread, imap_path, imap_delimiter, imap_uidvalidity, imap_uidnext, imap_modseq, special";

fn label_from_row(r: &Row) -> rusqlite::Result<LabelRow> {
    Ok(LabelRow {
        account_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        bg: r.get(4)?,
        fg: r.get(5)?,
        label_list_visibility: r.get(6)?,
        message_list_visibility: r.get(7)?,
        threads_total: r.get(8)?,
        threads_unread: r.get(9)?,
        messages_total: r.get(10)?,
        messages_unread: r.get(11)?,
        imap_path: r.get(12)?,
        imap_delimiter: r.get(13)?,
        imap_uidvalidity: r.get(14)?,
        imap_uidnext: r.get(15)?,
        imap_modseq: r.get(16)?,
        special: r.get(17)?,
    })
}

const ACCOUNT_COLS: &str = "id, kind, email, name, color, position, config, state, photo, created_at, needs_reauth";

fn account_from_row(r: &Row) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        email: r.get(2)?,
        name: r.get(3)?,
        color: r.get(4)?,
        position: r.get(5)?,
        config: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
        state: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
        photo: r.get(8)?,
        created_at: r.get(9)?,
        needs_reauth: r.get(10)?,
    })
}

const OUTBOX_COLS: &str = "id, account_id, raw, send_at, status, attempts, error, thread_id, draft_id, scheduled, subject, recipients, from_email, created_at, snippet";

fn outbox_from_row(r: &Row) -> rusqlite::Result<OutboxRow> {
    Ok(OutboxRow {
        id: r.get(0)?,
        account_id: r.get(1)?,
        raw: r.get(2)?,
        send_at: r.get(3)?,
        status: r.get(4)?,
        attempts: r.get(5)?,
        error: r.get(6)?,
        thread_id: r.get(7)?,
        draft_id: r.get(8)?,
        scheduled: r.get(9)?,
        subject: r.get(10)?,
        recipients: pj(&r.get::<_, String>(11)?),
        from_email: r.get(12)?,
        created_at: r.get(13)?,
        snippet: r.get(14)?,
    })
}

/// Which messages a thread listing should consider.
#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    /// Extra SQL condition on `m` plus its params (label membership, search …).
    pub clause: String,
    pub params: Vec<rusqlite::types::Value>,
    /// Exclude messages in Trash/Spam (true unless viewing those or the query asks for them).
    pub exclude_trash_spam: bool,
    /// Hide locally snoozed threads (Inbox views).
    pub exclude_snoozed: bool,
}

/// Caches from before 1.1 keep only the labels shown: those become the server's labels, except where a change
/// waits in the queue (it is in `labels` already), where the labels before it are the server's.
fn migrate(c: &Connection) -> rusqlite::Result<()> {
    if !c.prepare("SELECT 1 FROM pragma_table_info('labels') WHERE name='counts_stamp'")?.exists([])? {
        c.execute_batch("ALTER TABLE labels ADD COLUMN counts_stamp INTEGER NOT NULL DEFAULT 0;")?;
    }
    if c.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name='server_labels'")?.exists([])? {
        return Ok(());
    }
    c.execute_batch(
        "ALTER TABLE messages ADD COLUMN server_labels TEXT NOT NULL DEFAULT ' ';
         ALTER TABLE messages ADD COLUMN server_stamp INTEGER NOT NULL DEFAULT 0;
         UPDATE messages SET server_labels = labels;",
    )?;
    let queued: Vec<(String, String, Option<String>, String, String)> = c
        .prepare("SELECT account_id, message_id, before, add_labels, remove_labels FROM change_queue")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (account, id, before, add, remove) in queued {
        let base = match before {
            Some(b) => pj::<Vec<String>>(&b),
            None => {
                let shown: Option<String> = c.query_row("SELECT labels FROM messages WHERE account_id=? AND id=?", [&account, &id], |r| r.get(0)).optional()?;
                let Some(shown) = shown else { continue };
                apply_change(labels_from(&shown), &pj::<Vec<String>>(&remove), &pj::<Vec<String>>(&add))
            }
        };
        c.execute("UPDATE messages SET server_labels=? WHERE account_id=? AND id=?", params![labels_text(&base), account, id])?;
    }
    Ok(())
}

fn labels_from(text: &str) -> Vec<String> {
    text.split_whitespace().map(String::from).collect()
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db::with_connection(conn))
    }

    pub fn open_in_memory() -> Result<Db> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db::with_connection(conn))
    }

    fn with_connection(conn: Connection) -> Db {
        let _ = migrate(&conn);
        let generation: i64 = conn
            .query_row("SELECT value FROM kv WHERE key='stampGeneration'", [], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
            + 1;
        let _ = conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES ('stampGeneration', ?)", [generation.to_string()]);
        let db = Db {
            conn: Mutex::new(conn),
            pending: Mutex::new(HashMap::new()),
            next_change: std::sync::atomic::AtomicU64::new(1),
            clock: std::sync::atomic::AtomicU64::new((generation as u64) << 32),
            reads_out: Mutex::new(BTreeMap::new()),
            marks: Mutex::new(HashMap::new()),
        };
        // Changes queued before a quit still hold over whatever the server says until they've gone out.
        if let Ok(rows) = db.with(|c| c.prepare("SELECT account_id, message_id, add_labels, remove_labels FROM change_queue")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()) {
            let mut p = db.pending.lock();
            for (account, id, add, remove) in rows {
                p.entry((account, id)).or_default().push(PendingChange { token: QUEUED, add: pj(&add), remove: pj(&remove) });
            }
        }
        db
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let c = self.conn.lock();
        Ok(f(&c)?)
    }

    // ---- accounts ----

    pub fn accounts(&self) -> Result<Vec<AccountRow>> {
        self.with(|c| {
            let mut s = c.prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts ORDER BY position, created_at"))?;
            let rows = s.query_map([], account_from_row)?.collect();
            rows
        })
    }

    pub fn account(&self, id: &str) -> Result<AccountRow> {
        self.with(|c| c.query_row(&format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?"), [id], account_from_row).optional())?
            .ok_or_else(|| Error::NotFound(format!("account {id}")))
    }

    pub fn insert_account(&self, a: &AccountRow) -> Result<()> {
        self.with(|c| {
            c.execute(
                &format!("INSERT INTO accounts ({ACCOUNT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
                params![a.id, a.kind, a.email, a.name, a.color, a.position, a.config.to_string(), a.state.to_string(), a.photo, a.created_at, a.needs_reauth],
            )
        })?;
        Ok(())
    }

    pub fn update_account(&self, a: &AccountRow) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE accounts SET email=?2, name=?3, color=?4, position=?5, config=?6, state=?7, photo=?8, needs_reauth=?9 WHERE id=?1",
                params![a.id, a.email, a.name, a.color, a.position, a.config.to_string(), a.state.to_string(), a.photo, a.needs_reauth],
            )
        })?;
        Ok(())
    }

    pub fn set_account_state(&self, id: &str, key: &str, value: serde_json::Value) -> Result<()> {
        let mut a = self.account(id)?;
        if !a.state.is_object() {
            a.state = serde_json::json!({});
        }
        a.state[key] = value;
        self.with(|c| c.execute("UPDATE accounts SET state=? WHERE id=?", params![a.state.to_string(), id]))?;
        Ok(())
    }

    pub fn set_needs_reauth(&self, id: &str, v: bool) -> Result<()> {
        self.with(|c| c.execute("UPDATE accounts SET needs_reauth=? WHERE id=?", params![v, id]))?;
        Ok(())
    }

    /// Remove an account and everything cached for it.
    pub fn delete_account(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ?)", [id])?;
            for t in ["messages", "labels", "drafts", "outbox", "snoozes", "bumps", "muted", "star_types", "contacts", "signatures", "local_filters", "blocked", "change_queue", "thread_queue"] {
                c.execute(&format!("DELETE FROM {t} WHERE account_id = ?"), [id])?;
            }
            c.execute("DELETE FROM templates WHERE account_id = ?", [id])?;
            c.execute("DELETE FROM accounts WHERE id = ?", [id])?;
            Ok(())
        })?;
        self.pending.lock().retain(|(a, _), _| a != id);
        Ok(())
    }

    // ---- labels ----

    pub fn labels(&self, account: &str) -> Result<Vec<LabelRow>> {
        self.with(|c| {
            let mut s = c.prepare(&format!("SELECT {LABEL_COLS} FROM labels WHERE account_id = ? ORDER BY type DESC, name COLLATE NOCASE"))?;
            let rows = s.query_map([account], label_from_row)?.collect();
            rows
        })
    }

    pub fn label(&self, account: &str, id: &str) -> Result<Option<LabelRow>> {
        self.with(|c| c.query_row(&format!("SELECT {LABEL_COLS} FROM labels WHERE account_id = ? AND id = ?"), [account, id], label_from_row).optional())
    }

    pub fn upsert_label(&self, l: &LabelRow) -> Result<()> {
        self.with(|c| {
            c.execute(
                &format!(
                    "INSERT INTO labels ({LABEL_COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                     ON CONFLICT(account_id, id) DO UPDATE SET name=excluded.name, type=excluded.type, bg=excluded.bg, fg=excluded.fg,
                     label_list_visibility=excluded.label_list_visibility, message_list_visibility=excluded.message_list_visibility,
                     threads_total=excluded.threads_total, threads_unread=excluded.threads_unread, messages_total=excluded.messages_total,
                     messages_unread=excluded.messages_unread, imap_path=COALESCE(excluded.imap_path, imap_path),
                     imap_delimiter=COALESCE(excluded.imap_delimiter, imap_delimiter), special=COALESCE(excluded.special, special)"
                ),
                params![
                    l.account_id,
                    l.id,
                    l.name,
                    l.kind,
                    l.bg,
                    l.fg,
                    l.label_list_visibility,
                    l.message_list_visibility,
                    l.threads_total,
                    l.threads_unread,
                    l.messages_total,
                    l.messages_unread,
                    l.imap_path,
                    l.imap_delimiter,
                    l.imap_uidvalidity,
                    l.imap_uidnext,
                    l.imap_modseq,
                    l.special
                ],
            )
        })?;
        Ok(())
    }

    pub fn set_label_imap_state(&self, account: &str, id: &str, uidvalidity: Option<i64>, uidnext: Option<i64>, modseq: Option<i64>) -> Result<()> {
        self.with(|c| c.execute("UPDATE labels SET imap_uidvalidity=?3, imap_uidnext=?4, imap_modseq=?5 WHERE account_id=?1 AND id=?2", params![account, id, uidvalidity, uidnext, modseq]))?;
        Ok(())
    }

    pub fn delete_label(&self, account: &str, id: &str) -> Result<()> {
        let pat = format!("% {id} %");
        self.with(|c| {
            c.execute("DELETE FROM labels WHERE account_id=? AND id=?", [account, id])?;
            c.execute("UPDATE messages SET labels = REPLACE(labels, ?3, ' ') WHERE account_id=?1 AND labels LIKE ?2", params![account, pat, format!(" {id} ")])?;
            Ok(())
        })
    }

    /// Recompute counts from the cache (IMAP accounts, and the local labels SNOOZED/SCHEDULED/OUTBOX).
    pub fn recount_labels(&self, account: &str) -> Result<()> {
        self.with(|c| {
            let ids: Vec<String> = c.prepare("SELECT id FROM labels WHERE account_id=?")?.query_map([account], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            for id in ids {
                let pat = format!("% {id} %");
                let (tt, tu, mt, mu): (i64, i64, i64, i64) = c.query_row(
                    "SELECT COUNT(DISTINCT thread_id), COUNT(DISTINCT CASE WHEN labels LIKE '% UNREAD %' THEN thread_id END), COUNT(*), SUM(CASE WHEN labels LIKE '% UNREAD %' THEN 1 ELSE 0 END)
                     FROM messages WHERE account_id=?1 AND labels LIKE ?2",
                    params![account, pat],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0))),
                )?;
                c.execute("UPDATE labels SET threads_total=?3, threads_unread=?4, messages_total=?5, messages_unread=?6 WHERE account_id=?1 AND id=?2", params![account, id, tt, tu, mt, mu])?;
            }
            Ok(())
        })
    }

    /// For these conversations, per label: 1 if the conversation carries it and 1 if it's unread there, as the
    /// sidebar counts conversations. A message in Trash or Spam counts only there, as on the server.
    pub fn label_thread_stats(&self, account: &str, thread_ids: &[String]) -> Result<HashMap<String, (i64, i64)>> {
        let mut out: HashMap<String, (i64, i64)> = HashMap::new();
        let mut seen = HashSet::new();
        for t in thread_ids {
            if !seen.insert(t.as_str()) {
                continue;
            }
            let mut has: HashSet<String> = HashSet::new();
            let mut unread: HashSet<String> = HashSet::new();
            for m in self.thread_messages(account, t)? {
                let binned = m.has("TRASH") || m.has("SPAM");
                for l in &m.labels {
                    if binned && l != "TRASH" && l != "SPAM" {
                        continue;
                    }
                    has.insert(l.clone());
                    if m.has("UNREAD") {
                        unread.insert(l.clone());
                    }
                }
            }
            for l in has {
                let e = out.entry(l.clone()).or_default();
                e.0 += 1;
                if unread.contains(&l) {
                    e.1 += 1;
                }
            }
        }
        Ok(out)
    }

    /// Move stored conversation counts by the difference between two `label_thread_stats` snapshots, so the
    /// sidebar is right at once (the server's own counts replace these when they arrive).
    pub fn apply_label_deltas(&self, account: &str, before: &HashMap<String, (i64, i64)>, after: &HashMap<String, (i64, i64)>) -> Result<()> {
        let ids: HashSet<&String> = before.keys().chain(after.keys()).collect();
        self.with(|c| {
            for id in ids {
                let (b, a) = (before.get(id).copied().unwrap_or_default(), after.get(id).copied().unwrap_or_default());
                let (dt, du) = (a.0 - b.0, a.1 - b.1);
                if dt != 0 || du != 0 {
                    c.execute(
                        "UPDATE labels SET threads_total=MAX(0, threads_total+?3), threads_unread=MAX(0, MIN(threads_unread+?4, threads_total+?3)) WHERE account_id=?1 AND id=?2",
                        params![account, id, dt, du],
                    )?;
                }
            }
            Ok(())
        })
    }

    /// A label's counts read from the server at `stamp`: kept unless the cache holds counts from a later read or
    /// acknowledgement (a count read before a change landed would put the old number back).
    fn label_counts_from_server(&self, account: &str, id: &str, counts: (i64, i64, i64, i64), stamp: i64) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE labels SET threads_total=?3, threads_unread=?4, messages_total=?5, messages_unread=?6, counts_stamp=?7 WHERE account_id=?1 AND id=?2 AND counts_stamp <= ?7",
                params![account, id, counts.0, counts.1, counts.2, counts.3, stamp],
            )?;
            Ok(())
        })
    }

    /// These labels' counts now include a change the server just acknowledged (they were adjusted when it was made):
    /// counts read before now are older.
    pub fn counts_landed(&self, account: &str, labels: &[String]) {
        let stamp = self.tick();
        let _ = self.with(|c| {
            for l in labels {
                c.execute("UPDATE labels SET counts_stamp=MAX(counts_stamp, ?3) WHERE account_id=?1 AND id=?2", params![account, l, stamp])?;
            }
            Ok(())
        });
    }

    pub fn sender_lists(&self, account: &str, email: &str) -> Result<Vec<SenderList>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT list_id, list_unsubscribe, list_unsubscribe_post FROM (
                   SELECT list_id, list_unsubscribe, list_unsubscribe_post, internal_date,
                          ROW_NUMBER() OVER (PARTITION BY CASE WHEN list_id != '' THEN list_id ELSE list_unsubscribe END ORDER BY internal_date DESC) AS rn
                   FROM messages WHERE account_id = ?1 AND lower(from_email) = lower(?2) AND list_unsubscribe != '')
                 WHERE rn = 1 ORDER BY internal_date DESC",
            )?;
            let rows = st
                .query_map(params![account, email], |r| Ok(SenderList { list_id: r.get(0)?, list_unsubscribe: r.get(1)?, list_unsubscribe_post: r.get(2)? }))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Senders whose mail offers a way to unsubscribe (List-Unsubscribe), busiest first: how many messages in
    /// all and since `since_ms`, and the newest message's unsubscribe headers.
    pub fn subscriptions(&self, account: &str, since_ms: i64) -> Result<Vec<Subscription>> {
        self.with(|c| {
            let mut st = c.prepare(
                "WITH s AS (
                   SELECT lower(from_email) AS e, from_name, internal_date, list_unsubscribe, list_unsubscribe_post, list_id,
                          ROW_NUMBER() OVER (PARTITION BY lower(from_email) ORDER BY internal_date DESC) AS rn,
                          COUNT(*) OVER (PARTITION BY lower(from_email)) AS total,
                          SUM(CASE WHEN internal_date >= ?2 THEN 1 ELSE 0 END) OVER (PARTITION BY lower(from_email)) AS recent
                   FROM messages
                   WHERE account_id = ?1 AND list_unsubscribe != '' AND from_email != ''
                     AND labels NOT LIKE '% SENT %' AND labels NOT LIKE '% DRAFT %')
                 SELECT e, from_name, internal_date, list_unsubscribe, list_unsubscribe_post, list_id, total, recent
                 FROM s WHERE rn = 1 ORDER BY recent DESC, internal_date DESC",
            )?;
            let rows = st
                .query_map(params![account, since_ms], |r| {
                    Ok(Subscription {
                        account_id: account.to_string(),
                        email: r.get(0)?,
                        name: r.get(1)?,
                        last_date: r.get(2)?,
                        list_unsubscribe: r.get(3)?,
                        list_unsubscribe_post: r.get(4)?,
                        list_id: r.get(5)?,
                        total: r.get(6)?,
                        recent: r.get(7)?,
                        unsubscribed: None,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    // ---- messages ----

    #[track_caller]
    fn trace_inbox(&self, c: &Connection, account: &str, id: &str, labels: &[String]) {
        if !TRACE_INBOX.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let was: Option<String> = c.query_row("SELECT labels FROM messages WHERE account_id=? AND id=?", [account, id], |r| r.get(0)).optional().ok().flatten();
        let was = was.map(|l| l.contains(" INBOX "));
        let now = labels.iter().any(|l| l == "INBOX");
        if was != Some(now) {
            eprintln!("[trace] {} cache {account} {id} inbox {was:?} -> {now} at {}", crate::error::now_ms(), std::panic::Location::caller());
        }
    }

    pub fn begin_read(&self, account: &str) -> Read<'_> {
        let stamp = self.tick();
        *self.reads_out.lock().entry(stamp).or_default() += 1;
        Read { db: self, account: account.to_string(), stamp }
    }

    /// A change the server confirmed on messages this Mac doesn't have: answers read before now that bring them
    /// get it on top (see `marks`).
    pub fn mark_landed(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) {
        if ids.is_empty() {
            return;
        }
        let at = self.tick();
        let mut m = self.marks.lock();
        for id in ids {
            m.insert((account.to_string(), id.clone()), (at, add.to_vec(), remove.to_vec()));
        }
    }

    /// Server labels read at `stamp`, with a confirmed change the read couldn't have seen on top.
    fn with_mark(&self, account: &str, id: &str, labels: Vec<String>, stamp: i64) -> (Vec<String>, i64) {
        match self.marks.lock().get(&(account.to_string(), id.to_string())) {
            Some((at, add, remove)) if *at > stamp => (apply_change(labels, add, remove), *at),
            _ => (labels, stamp),
        }
    }

    fn tick(&self) -> i64 {
        (self.clock.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1) as i64
    }

    /// A message read from the server at `stamp`: its content always; its labels unless the cache already holds
    /// newer ones; shown with the changes still on their way on top.
    #[track_caller]
    fn upsert_from_server(&self, m: &MessageRow, raw: Option<&[u8]>, stamp: i64) -> Result<()> {
        let p = self.pending.lock();
        let c = self.conn.lock();
        let held: Option<(String, i64)> = c.query_row("SELECT server_labels, server_stamp FROM messages WHERE account_id=? AND id=?", [&m.account_id, &m.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let (base, base_stamp) = match held {
            Some((b, s)) if s > stamp => (labels_from(&b), s),
            _ => self.with_mark(&m.account_id, &m.id, m.labels.clone(), stamp),
        };
        let shown = fold_pending(&p, &m.account_id, &m.id, base.clone());
        self.trace_inbox(&c, &m.account_id, &m.id, &shown);
        Self::put_message(&c, m, raw, &shown, &base, base_stamp)?;
        Ok(())
    }

    /// A message this Mac made itself (a draft saved, a message sent through IMAP): there's no server answer to
    /// order it against yet, so it counts as read now.
    pub fn upsert_message(&self, m: &MessageRow, raw: Option<&[u8]>) -> Result<()> {
        let stamp = self.tick();
        self.upsert_from_server(m, raw, stamp)
    }

    fn put_message(c: &Connection, m: &MessageRow, raw: Option<&[u8]>, labels: &[String], base: &[String], base_stamp: i64) -> rusqlite::Result<()> {
        {
            c.execute(
                "INSERT INTO messages (account_id, id, thread_id, internal_date, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json, delivered_to, subject, norm_subject, snippet, size, has_attachments, attachments_json, message_id, in_reply_to, references_json, list_unsubscribe, list_unsubscribe_post, list_id, labels, raw, imap_folder, imap_uid, server_labels, server_stamp)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)
                 ON CONFLICT(account_id, id) DO UPDATE SET thread_id=excluded.thread_id, internal_date=excluded.internal_date, from_name=excluded.from_name,
                   from_email=excluded.from_email, to_json=excluded.to_json, cc_json=excluded.cc_json, bcc_json=excluded.bcc_json, reply_to_json=excluded.reply_to_json,
                   delivered_to=excluded.delivered_to, subject=excluded.subject, norm_subject=excluded.norm_subject, snippet=excluded.snippet, size=excluded.size,
                   has_attachments=excluded.has_attachments, attachments_json=excluded.attachments_json, message_id=excluded.message_id, in_reply_to=excluded.in_reply_to,
                   references_json=excluded.references_json, list_unsubscribe=excluded.list_unsubscribe, list_unsubscribe_post=excluded.list_unsubscribe_post,
                   list_id=excluded.list_id, labels=excluded.labels, raw=COALESCE(excluded.raw, raw), imap_folder=COALESCE(excluded.imap_folder, imap_folder),
                   imap_uid=COALESCE(excluded.imap_uid, imap_uid), server_labels=excluded.server_labels, server_stamp=excluded.server_stamp",
                params![
                    m.account_id,
                    m.id,
                    m.thread_id,
                    m.internal_date,
                    m.from_name,
                    m.from_email,
                    j(&m.to),
                    j(&m.cc),
                    j(&m.bcc),
                    j(&m.reply_to),
                    m.delivered_to,
                    m.subject,
                    m.norm_subject,
                    m.snippet,
                    m.size,
                    !m.attachments.is_empty(),
                    j(&m.attachments),
                    m.message_id,
                    m.in_reply_to,
                    j(&m.references),
                    m.list_unsubscribe,
                    m.list_unsubscribe_post,
                    m.list_id,
                    labels_text(labels),
                    raw,
                    m.imap_folder,
                    m.imap_uid,
                    labels_text(base),
                    base_stamp
                ],
            )?;
            let rowid: i64 = c.query_row("SELECT rowid FROM messages WHERE account_id=? AND id=?", [&m.account_id, &m.id], |r| r.get(0))?;
            // Keep the previous body text when this update didn't carry one (label-only refreshes).
            let body = if m.body_text.is_empty() {
                c.query_row("SELECT body FROM fts WHERE rowid=?", [rowid], |r| r.get::<_, String>(0)).optional()?.unwrap_or_default()
            } else {
                m.body_text.clone()
            };
            c.execute("DELETE FROM fts WHERE rowid=?", [rowid])?;
            let recipients = m.to.iter().chain(&m.cc).chain(&m.bcc).map(|a| format!("{} {}", a.name, a.email)).collect::<Vec<_>>().join(" ");
            c.execute(
                "INSERT INTO fts (rowid, subject, sender, recipients, body, attachments) VALUES (?,?,?,?,?,?)",
                params![rowid, m.subject, format!("{} {}", m.from_name, m.from_email), recipients, if body.is_empty() { m.snippet.clone() } else { body }, m.attachments.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(" ")],
            )?;
            Ok(())
        }
    }

    pub fn message(&self, account: &str, id: &str) -> Result<Option<MessageRow>> {
        self.with(|c| c.query_row(&format!("SELECT {MSG_COLS} FROM messages m WHERE m.account_id=? AND m.id=?"), [account, id], msg_from_row).optional())
    }

    pub fn raw(&self, account: &str, id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.with(|c| c.query_row("SELECT raw FROM messages WHERE account_id=? AND id=?", [account, id], |r| r.get::<_, Option<Vec<u8>>>(0)).optional())?.flatten())
    }

    pub fn set_raw(&self, account: &str, id: &str, raw: &[u8]) -> Result<()> {
        self.with(|c| c.execute("UPDATE messages SET raw=? WHERE account_id=? AND id=?", params![raw, account, id]))?;
        Ok(())
    }

    /// Labels read from the server at `stamp`: kept unless the cache holds newer ones, and shown with the changes
    /// still on their way on top.
    #[track_caller]
    fn server_labels(&self, account: &str, id: &str, labels: &[String], stamp: i64) -> Result<()> {
        let p = self.pending.lock();
        let c = self.conn.lock();
        let held: Option<i64> = c.query_row("SELECT server_stamp FROM messages WHERE account_id=? AND id=?", [account, id], |r| r.get(0)).optional()?;
        if held.is_none_or(|h| h > stamp) {
            return Ok(());
        }
        let shown = fold_pending(&p, account, id, labels.to_vec());
        self.trace_inbox(&c, account, id, &shown);
        c.execute(
            "UPDATE messages SET server_labels=?, server_stamp=?, labels=? WHERE account_id=? AND id=?",
            params![labels_text(labels), stamp, labels_text(&shown), account, id],
        )?;
        Ok(())
    }

    /// Shown labels again from the server's, with the changes still on their way on top (the only other writer
    /// of `labels`).
    #[track_caller]
    fn rederive(&self, p: &HashMap<(String, String), Vec<PendingChange>>, account: &str, id: &str) -> Result<()> {
        let c = self.conn.lock();
        let base: Option<String> = c.query_row("SELECT server_labels FROM messages WHERE account_id=? AND id=?", [account, id], |r| r.get(0)).optional()?;
        let Some(base) = base else { return Ok(()) };
        let shown = fold_pending(p, account, id, labels_from(&base));
        self.trace_inbox(&c, account, id, &shown);
        c.execute("UPDATE messages SET labels=? WHERE account_id=? AND id=?", params![labels_text(&shown), account, id])?;
        Ok(())
    }

    /// The server acknowledged `add`/`remove` on these messages: that is what it holds now, as of this moment, so
    /// the change becomes part of the server's labels with a fresh stamp, newer than any answer still on its way.
    fn landed(&self, c: &Connection, account: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<i64> {
        let stamp = self.tick();
        for id in ids {
            let base: Option<String> = c.query_row("SELECT server_labels FROM messages WHERE account_id=? AND id=?", [account, id], |r| r.get(0)).optional()?;
            if let Some(base) = base {
                let after = apply_change(labels_from(&base), add, remove);
                c.execute(
                    "UPDATE messages SET server_labels=?, server_stamp=MAX(server_stamp, ?) WHERE account_id=? AND id=?",
                    params![labels_text(&after), stamp, account, id],
                )?;
            }
        }
        Ok(stamp)
    }

    /// Change labels here first (the UI shows it at once) and remember the change until `end_change`, so that
    /// labels read from the server in between don't undo it. Returns the change's token.
    pub fn begin_change(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<u64> {
        let token = self.next_change.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut p = self.pending.lock();
        for id in ids {
            p.entry((account.to_string(), id.clone())).or_default().push(PendingChange { token, add: add.to_vec(), remove: remove.to_vec() });
        }
        for id in ids {
            self.rederive(&p, account, id)?;
        }
        Ok(token)
    }

    /// The server has the change (`ok`): it joins the server's labels. Or it refused: the change is simply no
    /// longer shown, so the labels are the server's with any other change still on its way, exactly.
    pub fn end_change(&self, account: &str, ids: &[String], token: u64, ok: bool) -> Result<()> {
        let mut p = self.pending.lock();
        let mut sent: Option<(Vec<String>, Vec<String>)> = None;
        for id in ids {
            let key = (account.to_string(), id.clone());
            if let Some(list) = p.get_mut(&key) {
                if let Some(i) = list.iter().position(|c| c.token == token) {
                    let ch = list.remove(i);
                    sent.get_or_insert((ch.add, ch.remove));
                }
                if list.is_empty() {
                    p.remove(&key);
                }
            }
        }
        if ok {
            if let Some((add, remove)) = &sent {
                let c = self.conn.lock();
                self.landed(&c, account, ids, add, remove)?;
            }
        }
        for id in ids {
            self.rederive(&p, account, id)?;
        }
        Ok(())
    }

    /// Labels involved in changes still on their way to the server: their server counts are about to change.
    pub fn pending_labels(&self, account: &str) -> HashSet<String> {
        let p = self.pending.lock();
        let mut out = HashSet::new();
        for ((a, id), list) in p.iter() {
            if a != account {
                continue;
            }
            for c in list {
                out.extend(c.add.iter().cloned());
                out.extend(c.remove.iter().cloned());
            }
            if let Ok(Some(m)) = self.message(a, id) {
                out.extend(m.labels);
            }
        }
        out
    }

    // ---- label changes waiting for the connection ----

    /// Keep a change the server can't take now (offline, or behind earlier changes still waiting) until it goes
    /// out: on disk, and over whatever the server says meanwhile, folded into each message's queued change. The
    /// change `token` started (`begin_change`) becomes part of it. `before`: the labels before this change.
    pub fn queue_change(&self, account: &str, ids: &[String], add: &[String], remove: &[String], before: &HashMap<String, Vec<String>>, token: u64) -> Result<()> {
        let mut p = self.pending.lock();
        for id in ids {
            if let Some(list) = p.get_mut(&(account.to_string(), id.clone())) {
                list.retain(|c| c.token != token);
            }
            match self.queued(account, id)? {
                Some((seq, had, a, r)) => {
                    let (a, r) = compose(had.as_deref(), (&a, &r), (add, remove));
                    self.set_queued(&mut p, account, id, seq, had.as_ref(), a, r)?;
                }
                None => {
                    let had = before.get(id);
                    let (a, r) = compose(had.map(|h| h.as_slice()), (&[], &[]), (add, remove));
                    let seq: i64 = self.with(|c| c.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM change_queue", [], |r| r.get(0)))?;
                    self.set_queued(&mut p, account, id, seq, had, a, r)?;
                }
            }
            self.rederive(&p, account, id)?;
        }
        Ok(())
    }

    /// A conversation change that waits for the connection (mail-API accounts): when it goes out, the conversation
    /// is read again and every message it applies to is changed, the ones this Mac doesn't have included. The
    /// exact opposite of a waiting change cancels it; another change to the same conversation joins it.
    pub fn queue_thread(&self, account: &str, thread: &str, add: &[String], remove: &[String]) -> Result<()> {
        self.with(|c| {
            let held: Option<(String, String)> = c
                .query_row("SELECT add_labels, remove_labels FROM thread_queue WHERE account_id=? AND thread_id=?", [account, thread], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            match held {
                Some((a, r)) => {
                    let (a, r): (Vec<String>, Vec<String>) = (pj(&a), pj(&r));
                    let cancels = same_set(&a, remove) && same_set(&r, add);
                    if cancels {
                        c.execute("DELETE FROM thread_queue WHERE account_id=? AND thread_id=?", [account, thread])?;
                    } else {
                        let (a, r) = compose(None, (&a, &r), (add, remove));
                        c.execute("UPDATE thread_queue SET add_labels=?, remove_labels=? WHERE account_id=? AND thread_id=?", params![j(&a), j(&r), account, thread])?;
                    }
                }
                None => {
                    c.execute(
                        "INSERT INTO thread_queue (account_id, thread_id, seq, add_labels, remove_labels) VALUES (?,?,(SELECT COALESCE(MAX(seq), 0) + 1 FROM thread_queue),?,?)",
                        params![account, thread, j(&add), j(&remove)],
                    )?;
                }
            }
            Ok(())
        })
    }

    /// An account's conversation changes waiting for the connection, oldest first: (conversation, add, remove).
    pub fn queued_threads(&self, account: &str) -> Result<Vec<(String, Vec<String>, Vec<String>)>> {
        self.with(|c| {
            c.prepare("SELECT thread_id, add_labels, remove_labels FROM thread_queue WHERE account_id=? ORDER BY seq")?
                .query_map([account], |r| Ok((r.get(0)?, pj(&r.get::<_, String>(1)?), pj(&r.get::<_, String>(2)?))))?
                .collect()
        })
    }

    /// The conversation's waiting change went out (or was refused): it no longer waits.
    pub fn thread_done(&self, account: &str, thread: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM thread_queue WHERE account_id=? AND thread_id=?", [account, thread]))?;
        Ok(())
    }

    /// An account's queued changes, oldest first.
    pub fn queued_changes(&self, account: &str) -> Result<Vec<QueuedChange>> {
        self.with(|c| {
            c.prepare("SELECT message_id, add_labels, remove_labels FROM change_queue WHERE account_id=? ORDER BY seq")?
                .query_map([account], |r| Ok(QueuedChange { message_id: r.get(0)?, add: pj(&r.get::<_, String>(1)?), remove: pj(&r.get::<_, String>(2)?) }))?
                .collect()
        })
    }

    pub fn has_queued(&self, account: &str) -> Result<bool> {
        self.with(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM change_queue WHERE account_id=?1) OR EXISTS(SELECT 1 FROM thread_queue WHERE account_id=?1)", [account], |r| r.get(0)))
    }

    /// Accounts with changes waiting to go to the server.
    pub fn queued_accounts(&self) -> Result<Vec<String>> {
        self.with(|c| c.prepare("SELECT account_id FROM change_queue UNION SELECT account_id FROM thread_queue")?.query_map([], |r| r.get(0))?.collect())
    }

    /// The server took `add`/`remove` for these messages: their queued changes are done, or, where another change
    /// was folded in meanwhile, what's left of it stays.
    pub fn change_sent(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<()> {
        let mut p = self.pending.lock();
        {
            let c = self.conn.lock();
            self.landed(&c, account, ids, add, remove)?;
        }
        for id in ids {
            let Some((seq, had, a, r)) = self.queued(account, id)? else { continue };
            if a == add && r == remove {
                self.set_queued(&mut p, account, id, seq, None, vec![], vec![])?;
            } else if let Some(had) = had {
                let sent = apply_change(had.clone(), add, remove);
                let (a, r) = diff(&sent, &apply_change(had, &a, &r));
                self.set_queued(&mut p, account, id, seq, Some(&sent), a, r)?;
            }
            self.rederive(&p, account, id)?;
        }
        Ok(())
    }

    /// The server refused these messages' queued changes: undo them here (only what they did) and drop them.
    pub fn change_refused(&self, account: &str, ids: &[String]) -> Result<()> {
        let mut p = self.pending.lock();
        for id in ids {
            let Some((seq, _, _, _)) = self.queued(account, id)? else { continue };
            self.set_queued(&mut p, account, id, seq, None, vec![], vec![])?;
            self.rederive(&p, account, id)?;
        }
        Ok(())
    }

    /// A message's queued change: its place in the queue, the labels before it (when the message was here), and
    /// the change.
    #[allow(clippy::type_complexity)]
    fn queued(&self, account: &str, id: &str) -> Result<Option<(i64, Option<Vec<String>>, Vec<String>, Vec<String>)>> {
        self.with(|c| {
            c.query_row("SELECT seq, before, add_labels, remove_labels FROM change_queue WHERE account_id=? AND message_id=?", [account, id], |r| {
                Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.map(|b| pj(&b)), pj(&r.get::<_, String>(2)?), pj(&r.get::<_, String>(3)?)))
            })
            .optional()
        })
    }

    /// Write a message's queued change (nothing left: take it out), on disk and over the server's labels.
    #[allow(clippy::too_many_arguments)]
    fn set_queued(&self, p: &mut HashMap<(String, String), Vec<PendingChange>>, account: &str, id: &str, seq: i64, before: Option<&Vec<String>>, add: Vec<String>, remove: Vec<String>) -> Result<()> {
        let key = (account.to_string(), id.to_string());
        let list = p.entry(key.clone()).or_default();
        list.retain(|c| c.token != QUEUED);
        if add.is_empty() && remove.is_empty() {
            self.with(|c| c.execute("DELETE FROM change_queue WHERE account_id=? AND message_id=?", [account, id]))?;
        } else {
            self.with(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO change_queue (account_id, message_id, seq, before, add_labels, remove_labels) VALUES (?,?,?,?,?,?)",
                    params![account, id, seq, before.map(j), j(&add), j(&remove)],
                )
            })?;
            list.insert(0, PendingChange { token: QUEUED, add, remove });
        }
        if list.is_empty() {
            p.remove(&key);
        }
        Ok(())
    }

    pub fn delete_message(&self, account: &str, id: &str) -> Result<()> {
        let queued = self.with(|c| {
            c.execute("DELETE FROM fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id=? AND id=?)", [account, id])?;
            c.execute("DELETE FROM messages WHERE account_id=? AND id=?", [account, id])?;
            c.execute("DELETE FROM star_types WHERE account_id=? AND message_id=?", [account, id])?;
            c.execute("DELETE FROM change_queue WHERE account_id=? AND message_id=?", [account, id])
        })?;
        if queued > 0 {
            let mut p = self.pending.lock();
            let key = (account.to_string(), id.to_string());
            if let Some(list) = p.get_mut(&key) {
                list.retain(|c| c.token != QUEUED);
                if list.is_empty() {
                    p.remove(&key);
                }
            }
        }
        Ok(())
    }

    pub fn thread_messages(&self, account: &str, thread_id: &str) -> Result<Vec<MessageRow>> {
        self.with(|c| {
            let mut s = c.prepare(&format!("SELECT {MSG_COLS} FROM messages m WHERE m.account_id=? AND m.thread_id=? ORDER BY m.internal_date"))?;
            let rows = s.query_map([account, thread_id], msg_from_row)?.collect();
            rows
        })
    }

    pub fn messages_where(&self, account: &str, clause: &str, params: Vec<rusqlite::types::Value>, limit: i64) -> Result<Vec<MessageRow>> {
        self.with(|c| {
            let mut all: Vec<rusqlite::types::Value> = vec![account.to_string().into()];
            all.extend(params);
            all.push(limit.into());
            let mut s = c.prepare(&format!("SELECT {MSG_COLS} FROM messages m WHERE m.account_id=? AND ({clause}) ORDER BY m.internal_date DESC LIMIT ?"))?;
            let rows = s.query_map(params_from_iter(all), msg_from_row)?.collect();
            rows
        })
    }

    /// Every cached message of an account, newest first.
    pub fn message_ids(&self, account: &str, limit: i64) -> Result<Vec<String>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id FROM messages WHERE account_id = ? ORDER BY internal_date DESC LIMIT ?")?;
            let rows = st.query_map(params![account, limit], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn message_ids_in_folder(&self, account: &str, folder: &str) -> Result<HashMap<i64, String>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT imap_uid, id FROM messages WHERE account_id=? AND imap_folder=? AND imap_uid IS NOT NULL")?;
            let rows = s.query_map([account, folder], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?.collect();
            rows
        })
    }

    pub fn delete_folder_messages(&self, account: &str, folder: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id=? AND imap_folder=?)", [account, folder])?;
            c.execute("DELETE FROM messages WHERE account_id=? AND imap_folder=?", [account, folder])?;
            Ok(())
        })
    }

    pub fn has_message(&self, account: &str, id: &str) -> Result<bool> {
        Ok(self.with(|c| c.query_row("SELECT 1 FROM messages WHERE account_id=? AND id=?", [account, id], |_| Ok(())).optional())?.is_some())
    }

    /// Thread for a new local message from its references (IMAP threading), adopting later replies.
    pub fn thread_for_refs(&self, account: &str, message_id: &str, refs: &[String], norm_subject: &str, is_reply: bool, date: i64) -> Result<Option<String>> {
        self.with(|c| {
            for r in refs.iter().rev() {
                if r.is_empty() {
                    continue;
                }
                if let Some(t) = c.query_row("SELECT thread_id FROM messages WHERE account_id=? AND message_id=? LIMIT 1", [account, r], |x| x.get::<_, String>(0)).optional()? {
                    return Ok(Some(t));
                }
            }
            if !message_id.is_empty() {
                if let Some(t) = c
                    .query_row(
                        "SELECT thread_id FROM messages WHERE account_id=?1 AND (in_reply_to=?2 OR references_json LIKE ?3) LIMIT 1",
                        params![account, message_id, format!("%\"{}\"%", message_id.replace('"', ""))],
                        |x| x.get::<_, String>(0),
                    )
                    .optional()?
                {
                    return Ok(Some(t));
                }
            }
            if is_reply && !norm_subject.is_empty() {
                if let Some(t) = c
                    .query_row(
                        "SELECT thread_id FROM messages WHERE account_id=?1 AND norm_subject=?2 AND internal_date BETWEEN ?3 AND ?4 ORDER BY internal_date DESC LIMIT 1",
                        params![account, norm_subject, date - 30 * 86_400_000, date + 86_400_000],
                        |x| x.get::<_, String>(0),
                    )
                    .optional()?
                {
                    return Ok(Some(t));
                }
            }
            Ok(None)
        })
    }

    pub fn merge_threads(&self, account: &str, from: &str, into: &str) -> Result<()> {
        if from == into {
            return Ok(());
        }
        self.with(|c| {
            c.execute("UPDATE messages SET thread_id=?3 WHERE account_id=?1 AND thread_id=?2", params![account, from, into])?;
            Ok(())
        })
    }

    // ---- thread listing ----

    /// Page of thread ids (newest first) whose messages match the filter, plus the total count.
    pub fn list_thread_ids(&self, account: &str, f: &ListFilter, offset: i64, limit: i64) -> Result<(Vec<(String, i64)>, i64)> {
        let mut cond = format!("m.account_id = ? AND ({})", if f.clause.is_empty() { "1" } else { &f.clause });
        if f.exclude_trash_spam {
            cond.push_str(" AND m.labels NOT LIKE '% TRASH %' AND m.labels NOT LIKE '% SPAM %'");
        }
        if f.exclude_snoozed {
            cond.push_str(" AND m.thread_id NOT IN (SELECT thread_id FROM snoozes s WHERE s.account_id = m.account_id)");
        }
        self.with(|c| {
            let mut p: Vec<rusqlite::types::Value> = vec![account.to_string().into()];
            p.extend(f.params.clone());
            let total: i64 = c.query_row(&format!("SELECT COUNT(DISTINCT m.thread_id) FROM messages m WHERE {cond}"), params_from_iter(p.clone()), |r| r.get(0))?;
            let mut q = p.clone();
            q.push(limit.into());
            q.push(offset.into());
            // A conversation sorts by its newest message overall (a sent reply moves it up), or by its
            // un-snooze time.
            let visible = if f.exclude_trash_spam { " AND m2.labels NOT LIKE '% TRASH %' AND m2.labels NOT LIKE '% SPAM %'" } else { "" };
            // The CTE comes first so its bare `?`s are numbered from 1 (?1 = the account).
            let sql = format!(
                "WITH t AS (SELECT m.thread_id AS tid, MAX(m.internal_date) AS d FROM messages m WHERE {cond} GROUP BY m.thread_id)
                 SELECT t.tid, MAX(COALESCE((SELECT MAX(m2.internal_date) FROM messages m2 WHERE m2.account_id = ?1 AND m2.thread_id = t.tid{visible}), t.d), t.d, COALESCE(b.at, 0)) AS sd
                 FROM t LEFT JOIN bumps b ON b.account_id = ?1 AND b.thread_id = t.tid ORDER BY sd DESC LIMIT ? OFFSET ?"
            );
            let mut s = c.prepare(&sql)?;
            let rows = s.query_map(params_from_iter(q), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((rows, total))
        })
    }

    /// Which of `threads` the view `f` holds, as the cache sees them.
    pub fn threads_in_view(&self, account: &str, f: &ListFilter, threads: &[String]) -> Result<HashSet<String>> {
        if threads.is_empty() {
            return Ok(HashSet::new());
        }
        let mut cond = format!("m.account_id = ? AND ({})", if f.clause.is_empty() { "1" } else { &f.clause });
        if f.exclude_trash_spam {
            cond.push_str(" AND m.labels NOT LIKE '% TRASH %' AND m.labels NOT LIKE '% SPAM %'");
        }
        if f.exclude_snoozed {
            cond.push_str(" AND m.thread_id NOT IN (SELECT thread_id FROM snoozes s WHERE s.account_id = m.account_id)");
        }
        cond.push_str(&format!(" AND m.thread_id IN ({})", vec!["?"; threads.len()].join(",")));
        self.with(|c| {
            let mut p: Vec<rusqlite::types::Value> = vec![account.to_string().into()];
            p.extend(f.params.clone());
            p.extend(threads.iter().map(|t| t.clone().into()));
            c.prepare(&format!("SELECT DISTINCT m.thread_id FROM messages m WHERE {cond}"))?.query_map(params_from_iter(p), |r| r.get(0))?.collect()
        })
    }

    /// Conversations this Mac knows something newer about than a read stamped `stamp`: a message's labels came
    /// from a later read or acknowledgement, or a change made here is still on its way.
    pub fn threads_known_after(&self, account: &str, stamp: i64) -> Result<HashSet<String>> {
        let pending: Vec<String> = self.pending.lock().keys().filter(|(a, _)| a == account).map(|(_, id)| id.clone()).collect();
        self.with(|c| {
            let mut out: HashSet<String> = c.prepare("SELECT DISTINCT thread_id FROM messages WHERE account_id=? AND server_stamp > ?")?.query_map(params![account, stamp], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            for id in pending {
                if let Some(t) = c.query_row("SELECT thread_id FROM messages WHERE account_id=? AND id=?", [account, &id], |r| r.get::<_, String>(0)).optional()? {
                    out.insert(t);
                }
            }
            Ok(out)
        })
    }

    /// Build list rows for threads. `in_trash_or_spam` keeps those messages (when viewing Trash/Spam).
    pub fn thread_summaries(&self, account: &str, ids: &[(String, i64)], in_trash_or_spam: bool) -> Result<Vec<ThreadSummary>> {
        let mut out = Vec::new();
        // My addresses, for the personal level markers (› to me, » only to me).
        let mine: Vec<String> = match self.account(account) {
            Ok(a) => std::iter::once(a.email.to_lowercase())
                .chain(a.state["aliases"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(|s| s.to_lowercase())))
                .collect(),
            Err(_) => vec![],
        };
        for (tid, sort_date) in ids {
            let msgs = self.thread_messages(account, tid)?;
            let visible: Vec<&MessageRow> = msgs.iter().filter(|m| in_trash_or_spam || !(m.has("TRASH") || m.has("SPAM"))).collect();
            let visible: Vec<&MessageRow> = if visible.is_empty() { msgs.iter().collect() } else { visible };
            if visible.is_empty() {
                continue;
            }
            let last = visible.iter().filter(|m| !m.has("DRAFT")).last().copied().unwrap_or(visible[visible.len() - 1]);
            let first = visible[0];
            let received = visible.iter().filter(|m| !m.has("DRAFT") && !m.has("SENT")).last().copied();
            let to_me = received
                .map(|m| {
                    let to: Vec<String> = m.to.iter().chain(m.cc.iter()).map(|a| a.email.to_lowercase()).collect();
                    if !to.iter().any(|e| mine.contains(e)) || !m.list_id.is_empty() {
                        0
                    } else if to.len() == 1 {
                        2
                    } else {
                        1
                    }
                })
                .unwrap_or(0);
            let mut labels: Vec<String> = Vec::new();
            for m in &visible {
                for l in &m.labels {
                    if !labels.contains(l) {
                        labels.push(l.clone());
                    }
                }
            }
            let mut attachments = Vec::new();
            for m in &visible {
                for a in &m.attachments {
                    if attachments.len() < 4 {
                        attachments.push(a.clone());
                    }
                }
            }
            let star_type = self.with(|c| {
                c.query_row(
                    &format!("SELECT type FROM star_types WHERE account_id=? AND message_id IN ({}) LIMIT 1", visible.iter().map(|_| "?").collect::<Vec<_>>().join(",")),
                    params_from_iter(std::iter::once(account.to_string()).chain(visible.iter().map(|m| m.id.clone()))),
                    |r| r.get::<_, String>(0),
                )
                .optional()
            })?;
            let snoozed_until = self.with(|c| c.query_row("SELECT until FROM snoozes WHERE account_id=? AND thread_id=?", [account, tid], |r| r.get::<_, i64>(0)).optional())?;
            let muted = self.with(|c| c.query_row("SELECT 1 FROM muted WHERE account_id=? AND thread_id=?", [account, tid], |_| Ok(())).optional())?.is_some();
            let draft_ids = self.with(|c| {
                let mut s = c.prepare("SELECT draft_id FROM drafts WHERE account_id=? AND thread_id=?")?;
                let rows = s.query_map([account, tid], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>();
                rows
            })?;
            out.push(ThreadSummary {
                account_id: account.into(),
                thread_id: tid.clone(),
                subject: first.subject.clone(),
                snippet: last.snippet.clone(),
                last_date: (*sort_date).max(last.internal_date),
                message_count: visible.len() as i64,
                unread: visible.iter().any(|m| m.has("UNREAD")),
                starred: visible.iter().any(|m| m.has("STARRED")),
                star_type,
                important: visible.iter().any(|m| m.has("IMPORTANT")),
                labels,
                participants: visible.iter().map(|m| Participant { name: m.from_name.clone(), email: m.from_email.clone(), unread: m.has("UNREAD"), draft: m.has("DRAFT") }).collect(),
                has_attachments: visible.iter().any(|m| !m.attachments.is_empty()),
                attachments,
                snoozed_until,
                muted,
                message_ids: visible.iter().map(|m| m.id.clone()).collect(),
                draft_ids,
                to_me,
                outbox_id: None,
                scheduled_at: None,
                list_unsubscribe: visible.iter().any(|m| !m.list_unsubscribe.is_empty()),
            });
        }
        Ok(out)
    }

    // ---- drafts map ----

    pub fn set_draft(&self, account: &str, draft_id: &str, message_id: &str, thread_id: Option<&str>) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO drafts (account_id, draft_id, message_id, thread_id) VALUES (?,?,?,?) ON CONFLICT(account_id, draft_id) DO UPDATE SET message_id=excluded.message_id, thread_id=excluded.thread_id",
                params![account, draft_id, message_id, thread_id],
            )
        })?;
        Ok(())
    }

    pub fn draft_message(&self, account: &str, draft_id: &str) -> Result<Option<(String, Option<String>)>> {
        self.with(|c| c.query_row("SELECT message_id, thread_id FROM drafts WHERE account_id=? AND draft_id=?", [account, draft_id], |r| Ok((r.get(0)?, r.get(1)?))).optional())
    }

    pub fn draft_for_message(&self, account: &str, message_id: &str) -> Result<Option<String>> {
        self.with(|c| c.query_row("SELECT draft_id FROM drafts WHERE account_id=? AND message_id=?", [account, message_id], |r| r.get(0)).optional())
    }

    pub fn delete_draft(&self, account: &str, draft_id: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM drafts WHERE account_id=? AND draft_id=?", [account, draft_id]))?;
        Ok(())
    }

    pub fn drafts(&self, account: &str) -> Result<Vec<(String, String, Option<String>)>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT draft_id, message_id, thread_id FROM drafts WHERE account_id=?")?;
            let rows = s.query_map([account], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            rows
        })
    }

    // ---- outbox ----

    #[allow(clippy::too_many_arguments)]
    pub fn outbox_add(&self, account: &str, raw: &[u8], send_at: i64, scheduled: bool, thread_id: Option<&str>, draft_id: Option<&str>, subject: &str, recipients: &[String], from: &str, snippet: &str) -> Result<i64> {
        self.with(|c| {
            c.execute(
                "INSERT INTO outbox (account_id, raw, send_at, status, scheduled, thread_id, draft_id, subject, recipients, from_email, snippet, created_at) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?)",
                params![account, raw, send_at, scheduled, thread_id, draft_id, subject, j(&recipients), from, snippet, now_ms()],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn outbox(&self) -> Result<Vec<OutboxRow>> {
        self.with(|c| {
            let mut s = c.prepare(&format!("SELECT {OUTBOX_COLS} FROM outbox ORDER BY send_at"))?;
            let rows = s.query_map([], outbox_from_row)?.collect();
            rows
        })
    }

    pub fn outbox_item(&self, id: i64) -> Result<Option<OutboxRow>> {
        self.with(|c| c.query_row(&format!("SELECT {OUTBOX_COLS} FROM outbox WHERE id=?"), [id], outbox_from_row).optional())
    }

    /// Claim due items (pending, send_at <= now) by marking them sending; returns them.
    pub fn outbox_claim_due(&self, now: i64) -> Result<Vec<OutboxRow>> {
        self.with(|c| {
            let mut s = c.prepare(&format!("SELECT {OUTBOX_COLS} FROM outbox WHERE status='pending' AND send_at <= ? ORDER BY send_at"))?;
            let rows: Vec<OutboxRow> = s.query_map([now], outbox_from_row)?.collect::<rusqlite::Result<_>>()?;
            for r in &rows {
                c.execute("UPDATE outbox SET status='sending' WHERE id=?", [r.id])?;
            }
            Ok(rows)
        })
    }

    pub fn outbox_retry(&self, id: i64, at: i64, err: &str) -> Result<()> {
        self.with(|c| c.execute("UPDATE outbox SET status='pending', attempts=attempts+1, send_at=?, error=? WHERE id=?", params![at, err, id]))?;
        Ok(())
    }

    /// Back online: mail that failed for lack of a connection goes again now instead of after its backoff.
    /// Scheduled mail keeps its time unless that time has already passed.
    pub fn outbox_retry_now(&self, now: i64) -> Result<usize> {
        self.with(|c| c.execute("UPDATE outbox SET send_at=? WHERE status='pending' AND attempts > 0 AND send_at > ? AND (scheduled = 0 OR error IS NOT NULL)", params![now, now]))
    }

    pub fn outbox_fail(&self, id: i64, err: &str) -> Result<()> {
        self.with(|c| c.execute("UPDATE outbox SET status='failed', attempts=attempts+1, error=? WHERE id=?", params![err, id]))?;
        Ok(())
    }

    /// Remove an item if it hasn't started sending (undo send / cancel scheduled). Returns it.
    pub fn outbox_take(&self, id: i64) -> Result<Option<OutboxRow>> {
        self.with(|c| {
            let row = c.query_row(&format!("SELECT {OUTBOX_COLS} FROM outbox WHERE id=? AND status IN ('pending','failed')"), [id], outbox_from_row).optional()?;
            if row.is_some() {
                c.execute("DELETE FROM outbox WHERE id=?", [id])?;
            }
            Ok(row)
        })
    }

    pub fn outbox_done(&self, id: i64) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM outbox WHERE id=?", [id]))?;
        Ok(())
    }

    /// After a crash/quit mid-send, put "sending" items back to pending.
    pub fn outbox_reset_sending(&self) -> Result<()> {
        self.with(|c| c.execute("UPDATE outbox SET status='pending' WHERE status='sending'", []))?;
        Ok(())
    }

    pub fn outbox_reschedule(&self, id: i64, at: i64) -> Result<()> {
        self.with(|c| c.execute("UPDATE outbox SET send_at=?, status='pending' WHERE id=?", params![at, id]))?;
        Ok(())
    }

    // ---- snooze / bump / mute / stars ----

    pub fn snooze(&self, account: &str, thread: &str, until: i64) -> Result<()> {
        self.with(|c| c.execute("INSERT OR REPLACE INTO snoozes (account_id, thread_id, until, created_at) VALUES (?,?,?,?)", params![account, thread, until, now_ms()]))?;
        Ok(())
    }
    pub fn unsnooze(&self, account: &str, thread: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM snoozes WHERE account_id=? AND thread_id=?", [account, thread]))?;
        Ok(())
    }
    pub fn due_snoozes(&self, now: i64) -> Result<Vec<(String, String)>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT account_id, thread_id FROM snoozes WHERE until <= ?")?;
            let rows = s.query_map([now], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
            rows
        })
    }
    pub fn snoozed_thread_ids(&self, account: &str) -> Result<Vec<(String, i64)>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT thread_id, until FROM snoozes WHERE account_id=? ORDER BY until")?;
            let rows = s.query_map([account], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
            rows
        })
    }
    pub fn bump(&self, account: &str, thread: &str, at: i64) -> Result<()> {
        self.with(|c| c.execute("INSERT OR REPLACE INTO bumps (account_id, thread_id, at) VALUES (?,?,?)", params![account, thread, at]))?;
        Ok(())
    }
    pub fn set_muted(&self, account: &str, thread: &str, on: bool) -> Result<()> {
        self.with(|c| {
            if on {
                c.execute("INSERT OR IGNORE INTO muted (account_id, thread_id) VALUES (?,?)", [account, thread])
            } else {
                c.execute("DELETE FROM muted WHERE account_id=? AND thread_id=?", [account, thread])
            }
        })?;
        Ok(())
    }
    pub fn is_muted(&self, account: &str, thread: &str) -> Result<bool> {
        Ok(self.with(|c| c.query_row("SELECT 1 FROM muted WHERE account_id=? AND thread_id=?", [account, thread], |_| Ok(())).optional())?.is_some())
    }
    pub fn set_star_type(&self, account: &str, message: &str, t: Option<&str>) -> Result<()> {
        self.with(|c| match t {
            Some(t) => c.execute("INSERT OR REPLACE INTO star_types (account_id, message_id, type) VALUES (?,?,?)", params![account, message, t]),
            None => c.execute("DELETE FROM star_types WHERE account_id=? AND message_id=?", [account, message]),
        })?;
        Ok(())
    }

    // ---- contacts ----

    pub fn touch_contact(&self, account: &str, email: &str, name: &str, sent_to: bool, at: i64) -> Result<()> {
        let email = email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') {
            return Ok(());
        }
        let weight = if sent_to { 3 } else { 1 };
        self.with(|c| {
            c.execute(
                "INSERT INTO contacts (account_id, email, name, last_used, times, source) VALUES (?1,?2,?3,?4,?5,'mail')
                 ON CONFLICT(account_id, email) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
                 last_used = MAX(last_used, excluded.last_used), times = times + excluded.times",
                params![account, email, name, at, weight],
            )
        })?;
        Ok(())
    }

    pub fn has_contact(&self, account: &str, email: &str) -> Result<bool> {
        let email = email.trim().to_lowercase();
        self.with(|c| Ok(c.query_row("SELECT 1 FROM contacts WHERE account_id=? AND email=?", params![account, email], |_| Ok(())).optional()?.is_some()))
    }

    pub fn search_contacts(&self, account: Option<&str>, q: &str, limit: i64) -> Result<Vec<Contact>> {
        let pat = format!("%{}%", q.trim().to_lowercase());
        let prefix = format!("{}%", q.trim().to_lowercase());
        self.with(|c| {
            let sql = "SELECT name, email, SUM(times) AS t, MAX(last_used) AS l FROM contacts WHERE (?1 IS NULL OR account_id = ?1) AND (lower(email) LIKE ?2 OR lower(name) LIKE ?2)
                       GROUP BY email ORDER BY (lower(email) LIKE ?3 OR lower(name) LIKE ?3) DESC, t DESC, l DESC LIMIT ?4";
            let mut s = c.prepare(sql)?;
            let rows = s.query_map(params![account, pat, prefix, limit], |r| Ok(Contact { name: r.get(0)?, email: r.get(1)?, times: r.get(2)?, last_used: r.get(3)? }))?.collect();
            rows
        })
    }

    // ---- kv ----

    /// What's new in an Inbox tab since `since` (ms): unread conversations in that category whose newest unread
    /// message arrived later, newest first, with the senders of the first few.
    pub fn tab_news(&self, account: &str, category: &str, since: i64) -> Result<(i64, Vec<String>)> {
        debug_assert!(category.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_'));
        let sql = format!(
            "SELECT m.thread_id, MAX(m.internal_date) AS d FROM messages m WHERE m.account_id = ?1 AND m.labels LIKE '% INBOX %' AND m.labels LIKE '% UNREAD %' \
             AND m.labels LIKE '% {category} %' AND m.labels NOT LIKE '% TRASH %' AND m.labels NOT LIKE '% SPAM %' \
             AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id = m.account_id AND s.thread_id = m.thread_id) \
             GROUP BY m.thread_id HAVING d > ?2 ORDER BY d DESC"
        );
        self.with(|c| {
            let threads: Vec<String> = c.prepare(&sql)?.query_map(rusqlite::params![account, since], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?;
            let mut names: Vec<String> = Vec::new();
            for t in &threads {
                let mut st = c.prepare(
                    "SELECT from_name, from_email FROM messages WHERE account_id = ?1 AND thread_id = ?2 AND labels LIKE '% UNREAD %' ORDER BY internal_date DESC",
                )?;
                for row in st.query_map(rusqlite::params![account, t], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                    let (name, email) = row?;
                    let who = if name.is_empty() { email } else { name };
                    if !who.is_empty() && !names.contains(&who) {
                        names.push(who);
                    }
                }
                if names.len() >= 3 {
                    break;
                }
            }
            names.truncate(3);
            Ok((threads.len() as i64, names))
        })
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<serde_json::Value>> {
        Ok(self.with(|c| c.query_row("SELECT value FROM kv WHERE key=?", [key], |r| r.get::<_, String>(0)).optional())?.and_then(|s| serde_json::from_str(&s).ok()))
    }
    pub fn kv_set(&self, key: &str, v: &serde_json::Value) -> Result<()> {
        self.with(|c| c.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)", params![key, v.to_string()]))?;
        Ok(())
    }
    pub fn kv_all(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT key, value FROM kv")?;
            let mut map = serde_json::Map::new();
            for row in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (k, v) = row?;
                map.insert(k, serde_json::from_str(&v).unwrap_or(serde_json::Value::Null));
            }
            Ok(map)
        })
    }

    // ---- templates & signatures ----

    pub fn templates(&self) -> Result<Vec<serde_json::Value>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT id, account_id, name, subject, html, updated_at FROM templates ORDER BY name COLLATE NOCASE")?;
            let rows = s
                .query_map([], |r| {
                    Ok(serde_json::json!({"id": r.get::<_, String>(0)?, "accountId": r.get::<_, Option<String>>(1)?, "name": r.get::<_, String>(2)?, "subject": r.get::<_, String>(3)?, "html": r.get::<_, String>(4)?, "updatedAt": r.get::<_, i64>(5)?}))
                })?
                .collect();
            rows
        })
    }
    pub fn save_template(&self, id: &str, account: Option<&str>, name: &str, subject: &str, html: &str) -> Result<()> {
        self.with(|c| c.execute("INSERT OR REPLACE INTO templates (id, account_id, name, subject, html, updated_at) VALUES (?,?,?,?,?,?)", params![id, account, name, subject, html, now_ms()]))?;
        Ok(())
    }
    pub fn delete_template(&self, id: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM templates WHERE id=?", [id]))?;
        Ok(())
    }
    pub fn signatures(&self, account: &str) -> Result<Vec<serde_json::Value>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT id, name, html FROM signatures WHERE account_id=? ORDER BY name COLLATE NOCASE")?;
            let rows = s.query_map([account], |r| Ok(serde_json::json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "html": r.get::<_, String>(2)?})))?.collect();
            rows
        })
    }
    pub fn save_signature(&self, id: &str, account: &str, name: &str, html: &str) -> Result<()> {
        self.with(|c| c.execute("INSERT OR REPLACE INTO signatures (id, account_id, name, html, updated_at) VALUES (?,?,?,?,?)", params![id, account, name, html, now_ms()]))?;
        Ok(())
    }
    pub fn delete_signature(&self, id: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM signatures WHERE id=?", [id]))?;
        Ok(())
    }

    // ---- local filters & blocked senders ----

    pub fn local_filters(&self, account: &str) -> Result<Vec<serde_json::Value>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT id, criteria, action FROM local_filters WHERE account_id=? ORDER BY created_at")?;
            let rows = s
                .query_map([account], |r| {
                    Ok(serde_json::json!({"id": r.get::<_, String>(0)?, "criteria": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(1)?).unwrap_or_default(), "action": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(2)?).unwrap_or_default()}))
                })?
                .collect();
            rows
        })
    }
    pub fn add_local_filter(&self, id: &str, account: &str, criteria: &serde_json::Value, action: &serde_json::Value) -> Result<()> {
        self.with(|c| c.execute("INSERT INTO local_filters (id, account_id, criteria, action, created_at) VALUES (?,?,?,?,?)", params![id, account, criteria.to_string(), action.to_string(), now_ms()]))?;
        Ok(())
    }
    pub fn delete_local_filter(&self, id: &str) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM local_filters WHERE id=?", [id]))?;
        Ok(())
    }
    pub fn blocked(&self, account: &str) -> Result<Vec<(String, Option<String>)>> {
        self.with(|c| {
            let mut s = c.prepare("SELECT email, filter_id FROM blocked WHERE account_id=? ORDER BY email")?;
            let rows = s.query_map([account], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
            rows
        })
    }
    pub fn set_blocked(&self, account: &str, email: &str, filter_id: Option<&str>) -> Result<()> {
        self.with(|c| c.execute("INSERT OR REPLACE INTO blocked (account_id, email, filter_id) VALUES (?,?,?)", params![account, email.to_lowercase(), filter_id]))?;
        Ok(())
    }
    pub fn unblock(&self, account: &str, email: &str) -> Result<Option<String>> {
        self.with(|c| {
            let f = c.query_row("SELECT filter_id FROM blocked WHERE account_id=? AND email=?", [account, &email.to_lowercase()], |r| r.get::<_, Option<String>>(0)).optional()?.flatten();
            c.execute("DELETE FROM blocked WHERE account_id=? AND email=?", [account, &email.to_lowercase()])?;
            Ok(f)
        })
    }

    /// Unread conversations in the Inbox (one account, or all of them for the Dock badge): a conversation counts
    /// when one of its Inbox messages is unread, as in the web client. `skip_categories` leaves out mail in those
    /// category labels (with tabs on, the Inbox count covers Primary only), except starred conversations when
    /// `starred_in_primary` (Settings ▸ Inbox ▸ Include starred in Primary).
    pub fn inbox_unread(&self, account: Option<&str>, skip_categories: &[&str], starred_in_primary: bool) -> Result<i64> {
        let mut sql = String::from(
            "SELECT COUNT(DISTINCT m.account_id || ' ' || m.thread_id) FROM messages m WHERE m.labels LIKE '% INBOX %' AND m.labels LIKE '% UNREAD %' \
             AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id = m.account_id AND s.thread_id = m.thread_id)",
        );
        if !skip_categories.is_empty() {
            // Category ids are fixed constants (CATEGORY_*), never user input.
            debug_assert!(skip_categories.iter().all(|cat| cat.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_')));
            let outside: Vec<String> = skip_categories.iter().map(|cat| format!("m.labels NOT LIKE '% {cat} %'")).collect();
            let starred = if starred_in_primary {
                " OR EXISTS (SELECT 1 FROM messages t WHERE t.account_id = m.account_id AND t.thread_id = m.thread_id AND t.labels LIKE '% STARRED %')"
            } else {
                ""
            };
            sql.push_str(&format!(" AND (({}){starred})", outside.join(" AND ")));
        }
        if account.is_some() {
            sql.push_str(" AND m.account_id = ?1");
        }
        self.with(|c| match account {
            Some(a) => c.query_row(&sql, [a], |r| r.get(0)),
            None => c.query_row(&sql, [], |r| r.get(0)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, thread: &str, labels: &[&str], date: i64, subject: &str) -> MessageRow {
        MessageRow {
            account_id: "a".into(),
            id: id.into(),
            thread_id: thread.into(),
            internal_date: date,
            from_name: "Ana".into(),
            from_email: "ana@x.io".into(),
            subject: subject.into(),
            snippet: format!("snippet {id}"),
            labels: labels.iter().map(|s| s.to_string()).collect(),
            body_text: format!("body of {subject} with planning words"),
            ..Default::default()
        }
    }

    #[test]
    fn upsert_list_and_search() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_message(&msg("1", "t1", &["INBOX", "UNREAD"], 1000, "Lunch"), None).unwrap();
        db.upsert_message(&msg("2", "t1", &["SENT"], 2000, "Re: Lunch"), None).unwrap();
        db.upsert_message(&msg("3", "t2", &["INBOX"], 1500, "Quarterly planning"), Some(b"raw")).unwrap();
        db.upsert_message(&msg("4", "t3", &["TRASH"], 3000, "Old"), None).unwrap();
        let f = ListFilter { clause: "m.labels LIKE '% INBOX %'".into(), exclude_trash_spam: true, ..Default::default() };
        let (ids, total) = db.list_thread_ids("a", &f, 0, 50).unwrap();
        assert_eq!(total, 2);
        assert_eq!(ids.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["t1", "t2"]); // t1's latest message is newer
        let s = db.thread_summaries("a", &ids, false).unwrap();
        assert_eq!(s[0].message_count, 2);
        assert!(s[0].unread);
        assert_eq!(s[0].snippet, "snippet 2");
        // FTS free text
        let (ids, _) = db.list_thread_ids("a", &ListFilter { clause: "m.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?)".into(), params: vec!["\"plan\"*".to_string().into()], ..Default::default() }, 0, 50).unwrap();
        assert_eq!(ids.len(), 3); // every body mentions "planning"
        // label-only update keeps body text in the index
        db.begin_read("a").set_labels("3", &["INBOX".into(), "STARRED".into()]).unwrap();
        let m = db.message("a", "3").unwrap().unwrap();
        assert!(m.has("STARRED"));
        assert!(m.has_raw);
        db.upsert_message(&MessageRow { body_text: String::new(), ..msg("3", "t2", &["INBOX"], 1500, "Quarterly planning") }, None).unwrap();
        assert_eq!(db.raw("a", "3").unwrap().as_deref(), Some(&b"raw"[..]));
        let (ids, _) = db.list_thread_ids("a", &ListFilter { clause: "m.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?)".into(), params: vec!["\"words\"".to_string().into()], ..Default::default() }, 0, 50).unwrap();
        assert!(ids.iter().any(|x| x.0 == "t2"));
    }

    #[test]
    fn inbox_count_covers_primary_only() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_message(&msg("1", "t1", &["INBOX", "UNREAD", "CATEGORY_PERSONAL"], 1000, "Lunch"), None).unwrap();
        db.upsert_message(&msg("2", "t2", &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], 1001, "Sale"), None).unwrap();
        db.upsert_message(&msg("3", "t3", &["INBOX", "UNREAD", "CATEGORY_FORUMS"], 1002, "Forum"), None).unwrap();
        db.upsert_message(&msg("4", "t4", &["INBOX", "CATEGORY_PERSONAL"], 1003, "Read"), None).unwrap();
        db.upsert_message(&msg("5", "t1", &["INBOX", "UNREAD", "CATEGORY_PERSONAL"], 1004, "Re: Lunch"), None).unwrap();
        assert_eq!(db.inbox_unread(Some("a"), &[], false).unwrap(), 3);
        // Tabs for promotions/social/updates: forums mail stays in Primary.
        assert_eq!(db.inbox_unread(Some("a"), &["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"], false).unwrap(), 2);
        assert_eq!(db.inbox_unread(None, &["CATEGORY_PROMOTIONS", "CATEGORY_FORUMS"], false).unwrap(), 1);
        assert_eq!(db.inbox_unread(Some("other"), &[], false).unwrap(), 0);
    }

    #[test]
    fn outbox_undo_and_claim() {
        let db = Db::open_in_memory().unwrap();
        let id = db.outbox_add("a", b"raw", 1000, false, None, None, "Hi", &["b@x.io".into()], "a@x.io", "hello").unwrap();
        assert!(db.outbox_claim_due(500).unwrap().is_empty());
        assert!(db.outbox_take(id).unwrap().is_some()); // undo before it's due
        assert!(db.outbox().unwrap().is_empty());
        let id2 = db.outbox_add("a", b"raw2", 1000, true, None, None, "Later", &[], "a@x.io", "").unwrap();
        let due = db.outbox_claim_due(1000).unwrap();
        assert_eq!(due.len(), 1);
        assert!(db.outbox_take(id2).unwrap().is_none()); // already sending: can't undo
        db.outbox_retry(id2, 5000, "offline").unwrap();
        assert_eq!(db.outbox_item(id2).unwrap().unwrap().attempts, 1);
        // Back online: the retry is due at once.
        assert!(db.outbox_claim_due(1200).unwrap().is_empty());
        assert_eq!(db.outbox_retry_now(1200).unwrap(), 1);
        assert_eq!(db.outbox_claim_due(1200).unwrap().len(), 1);
    }

    #[test]
    fn threading_helpers_and_contacts() {
        let db = Db::open_in_memory().unwrap();
        let mut a = msg("1", "t1", &["INBOX"], 1000, "Lunch");
        a.message_id = "<a@x>".into();
        a.norm_subject = "lunch".into();
        db.upsert_message(&a, None).unwrap();
        assert_eq!(db.thread_for_refs("a", "<b@x>", &["<a@x>".into()], "lunch", true, 2000).unwrap().as_deref(), Some("t1"));
        assert_eq!(db.thread_for_refs("a", "<c@x>", &[], "lunch", true, 2000).unwrap().as_deref(), Some("t1"));
        assert_eq!(db.thread_for_refs("a", "<d@x>", &[], "lunch", false, 2000).unwrap(), None);
        db.touch_contact("a", "Bo@X.io", "Bo", true, 10).unwrap();
        db.touch_contact("a", "bo@x.io", "", false, 20).unwrap();
        let c = db.search_contacts(None, "bo", 5).unwrap();
        assert_eq!(c[0].email, "bo@x.io");
        assert_eq!(c[0].name, "Bo");
        assert_eq!(c[0].times, 4);
    }
}
