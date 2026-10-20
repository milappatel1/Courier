//! A small local IMAP4rev1 server (plain TCP) plus an SMTP server, for the Rust tests and the end-to-end
//! run. Supports what Courier uses: LOGIN, CAPABILITY, LIST with special-use, SELECT/EXAMINE, STATUS,
//! (UID) FETCH/STORE/COPY/MOVE/SEARCH/EXPUNGE, APPEND with literals, CREATE/RENAME/DELETE/SUBSCRIBE, IDLE.

use parking_lot::Mutex;
use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

#[derive(Clone, Debug)]
pub struct IMsg {
    pub uid: u32,
    pub flags: BTreeSet<String>,
    pub raw: Vec<u8>,
    pub internal_date: i64,
}

#[derive(Clone, Debug)]
pub struct IFolder {
    pub uidvalidity: u32,
    pub uidnext: u32,
    pub special: Option<String>,
    pub msgs: Vec<IMsg>,
}

pub struct IState {
    pub user: String,
    pub password: String,
    pub folders: BTreeMap<String, IFolder>,
    pub log: Vec<String>,
    /// Extra time (ms) a MOVE or COPY takes, as on a real server.
    pub move_latency: u64,
}

#[derive(Clone)]
pub struct FakeImap {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<IState>>,
    pub changes: broadcast::Sender<String>,
}

fn folder(special: Option<&str>, uv: u32) -> IFolder {
    IFolder { uidvalidity: uv, uidnext: 1, special: special.map(str::to_string), msgs: vec![] }
}

impl FakeImap {
    pub async fn start(user: &str, password: &str) -> FakeImap {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind fake IMAP");
        let addr = listener.local_addr().unwrap();
        let mut folders = BTreeMap::new();
        folders.insert("INBOX".to_string(), folder(None, 11));
        folders.insert("Sent".to_string(), folder(Some("\\Sent"), 12));
        folders.insert("Drafts".to_string(), folder(Some("\\Drafts"), 13));
        folders.insert("Trash".to_string(), folder(Some("\\Trash"), 14));
        folders.insert("Junk".to_string(), folder(Some("\\Junk"), 15));
        folders.insert("Archive".to_string(), folder(Some("\\Archive"), 16));
        let state = Arc::new(Mutex::new(IState { user: user.into(), password: password.into(), folders, log: vec![], move_latency: 0 }));
        let (tx, _) = broadcast::channel(64);
        let fake = FakeImap { addr, state, changes: tx };
        let f = fake.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let f = f.clone();
                tokio::spawn(async move {
                    let _ = f.conn(stream).await;
                });
            }
        });
        fake
    }

    pub fn deliver(&self, folder: &str, raw: &[u8], flags: &[&str]) -> u32 {
        let uid = {
            let mut s = self.state.lock();
            let next_uv = 20 + s.folders.len() as u32;
            let f = s.folders.entry(folder.to_string()).or_insert_with(|| self::folder(None, next_uv));
            let uid = f.uidnext;
            f.uidnext += 1;
            f.msgs.push(IMsg { uid, flags: flags.iter().map(|x| x.to_string()).collect(), raw: raw.to_vec(), internal_date: crate::error::now_ms() });
            uid
        };
        let _ = self.changes.send(folder.to_string());
        uid
    }

    pub fn folder(&self, name: &str) -> Option<IFolder> {
        self.state.lock().folders.get(name).cloned()
    }

    async fn conn(&self, stream: TcpStream) -> std::io::Result<()> {
        let (r, mut w) = stream.into_split();
        let mut r = BufReader::new(r);
        w.write_all(b"* OK [CAPABILITY IMAP4rev1 IDLE MOVE UIDPLUS SPECIAL-USE LITERAL+ ID] Courier test server ready\r\n").await?;
        let mut selected: Option<String> = None;
        let mut authed = false;
        loop {
            let Some(line) = read_line(&mut r).await? else { return Ok(()) };
            // Literal on the command line ({n} or {n+}): read it now.
            let (line, literal) = match literal_len(&line) {
                Some((n, sync)) => {
                    if sync {
                        w.write_all(b"+ Ready for literal data\r\n").await?;
                    }
                    let mut buf = vec![0u8; n];
                    r.read_exact(&mut buf).await?;
                    let mut rest = String::new();
                    r.read_line(&mut rest).await?;
                    (line, Some(buf))
                }
                None => (line, None),
            };
            self.state.lock().log.push(line.clone());
            let mut parts = line.splitn(2, ' ');
            let tag = parts.next().unwrap_or("*").to_string();
            let rest = parts.next().unwrap_or("").to_string();
            let (cmd, args) = split_cmd(&rest);
            let upper = cmd.to_ascii_uppercase();
            if authed && (upper == "UID" || ["FETCH", "STORE", "COPY", "MOVE", "SEARCH", "EXPUNGE"].contains(&upper.as_str())) {
                let sub_upper = if upper == "UID" { split_cmd(&args).0.to_ascii_uppercase() } else { upper.clone() };
                let wait = self.state.lock().move_latency;
                if wait > 0 && (sub_upper == "MOVE" || sub_upper == "COPY") {
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                }
                let bytes = if upper == "UID" {
                    let (sub, subargs) = split_cmd(&args);
                    self.command(&tag, &sub.to_ascii_uppercase(), &subargs, true, &selected)
                } else {
                    self.command(&tag, &upper, &args, false, &selected)
                };
                w.write_all(&bytes).await?;
                continue;
            }
            let out = match upper.as_str() {
                "CAPABILITY" => format!("* CAPABILITY IMAP4rev1 IDLE MOVE UIDPLUS SPECIAL-USE LITERAL+ ID\r\n{tag} OK CAPABILITY completed\r\n"),
                "NOOP" | "CHECK" => format!("{tag} OK done\r\n"),
                "ID" => format!("* ID NIL\r\n{tag} OK ID completed\r\n"),
                "LOGOUT" => {
                    w.write_all(format!("* BYE bye\r\n{tag} OK LOGOUT completed\r\n").as_bytes()).await?;
                    return Ok(());
                }
                "LOGIN" => {
                    let a = parse_astrings(&args);
                    let (u, p) = (a.first().cloned().unwrap_or_default(), a.get(1).cloned().unwrap_or_default());
                    let s = self.state.lock();
                    if u == s.user && p == s.password {
                        authed = true;
                        format!("{tag} OK [CAPABILITY IMAP4rev1 IDLE MOVE UIDPLUS SPECIAL-USE LITERAL+] LOGIN completed\r\n")
                    } else {
                        format!("{tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n")
                    }
                }
                _ if !authed => format!("{tag} BAD not authenticated\r\n"),
                "LIST" | "LSUB" => {
                    let s = self.state.lock();
                    let mut out = String::new();
                    for (name, f) in &s.folders {
                        let mut attrs = vec!["\\HasNoChildren".to_string()];
                        if let Some(sp) = &f.special {
                            attrs.push(sp.clone());
                        }
                        out.push_str(&format!("* {upper} ({}) \"/\" {}\r\n", attrs.join(" "), quote(name)));
                    }
                    out + &format!("{tag} OK {upper} completed\r\n")
                }
                "SELECT" | "EXAMINE" => {
                    let name = unquote(args.trim());
                    let s = self.state.lock();
                    match s.folders.get(&name) {
                        Some(f) => {
                            selected = Some(name.clone());
                            let unseen = f.msgs.iter().position(|m| !m.flags.contains("\\Seen")).map(|i| format!("* OK [UNSEEN {}] first unseen\r\n", i + 1)).unwrap_or_default();
                            format!(
                                "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok\r\n* {} EXISTS\r\n* 0 RECENT\r\n{unseen}* OK [UIDVALIDITY {}] ok\r\n* OK [UIDNEXT {}] ok\r\n{tag} OK [{}] {upper} completed\r\n",
                                f.msgs.len(),
                                f.uidvalidity,
                                f.uidnext,
                                if upper == "SELECT" { "READ-WRITE" } else { "READ-ONLY" }
                            )
                        }
                        None => format!("{tag} NO no such mailbox\r\n"),
                    }
                }
                "STATUS" => {
                    let a = parse_astrings(&args);
                    let name = a.first().cloned().unwrap_or_default();
                    let s = self.state.lock();
                    match s.folders.get(&name) {
                        Some(f) => {
                            let unseen = f.msgs.iter().filter(|m| !m.flags.contains("\\Seen")).count();
                            format!("* STATUS {} (MESSAGES {} UIDNEXT {} UIDVALIDITY {} UNSEEN {unseen})\r\n{tag} OK STATUS completed\r\n", quote(&name), f.msgs.len(), f.uidnext, f.uidvalidity)
                        }
                        None => format!("{tag} NO no such mailbox\r\n"),
                    }
                }
                "CREATE" => {
                    let name = unquote(args.trim());
                    let mut s = self.state.lock();
                    if s.folders.contains_key(&name) {
                        format!("{tag} NO [ALREADYEXISTS] exists\r\n")
                    } else {
                        let uv = 100 + s.folders.len() as u32;
                        s.folders.insert(name, folder(None, uv));
                        format!("{tag} OK CREATE completed\r\n")
                    }
                }
                "DELETE" => {
                    let name = unquote(args.trim());
                    self.state.lock().folders.remove(&name);
                    format!("{tag} OK DELETE completed\r\n")
                }
                "RENAME" => {
                    let a = parse_astrings(&args);
                    let mut s = self.state.lock();
                    if let Some(f) = s.folders.remove(&a[0]) {
                        s.folders.insert(a[1].clone(), f);
                    }
                    format!("{tag} OK RENAME completed\r\n")
                }
                "SUBSCRIBE" | "UNSUBSCRIBE" => format!("{tag} OK done\r\n"),
                "APPEND" => {
                    let name = parse_astrings(&args).first().cloned().unwrap_or_default();
                    let flags = args.find('(').and_then(|a| args[a + 1..].find(')').map(|b| args[a + 1..a + 1 + b].to_string())).unwrap_or_default();
                    let raw = literal.unwrap_or_default();
                    let mut s = self.state.lock();
                    match s.folders.get_mut(&name) {
                        Some(f) => {
                            let uid = f.uidnext;
                            f.uidnext += 1;
                            f.msgs.push(IMsg { uid, flags: flags.split_whitespace().map(str::to_string).collect(), raw, internal_date: crate::error::now_ms() });
                            let uv = f.uidvalidity;
                            drop(s);
                            let _ = self.changes.send(name.clone());
                            format!("{tag} OK [APPENDUID {uv} {uid}] APPEND completed\r\n")
                        }
                        None => format!("{tag} NO [TRYCREATE] no such mailbox\r\n"),
                    }
                }
                "CLOSE" => {
                    if let Some(sel) = &selected {
                        let mut s = self.state.lock();
                        if let Some(f) = s.folders.get_mut(sel) {
                            f.msgs.retain(|m| !m.flags.contains("\\Deleted"));
                        }
                    }
                    selected = None;
                    format!("{tag} OK CLOSE completed\r\n")
                }
                "IDLE" => {
                    w.write_all(b"+ idling\r\n").await?;
                    let mut rx = self.changes.subscribe();
                    let sel = selected.clone().unwrap_or_default();
                    loop {
                        tokio::select! {
                            line = read_line(&mut r) => {
                                let line = line?.unwrap_or_default();
                                if line.trim().eq_ignore_ascii_case("DONE") { break; }
                                if line.is_empty() { return Ok(()); }
                            }
                            changed = rx.recv() => {
                                if let Ok(name) = changed {
                                    if name == sel {
                                        let n = self.state.lock().folders.get(&sel).map(|f| f.msgs.len()).unwrap_or(0);
                                        w.write_all(format!("* {n} EXISTS\r\n").as_bytes()).await?;
                                    }
                                }
                            }
                        }
                    }
                    format!("{tag} OK IDLE terminated\r\n")
                }
                _ => format!("{tag} BAD unknown command\r\n"),
            };
            w.write_all(out.as_bytes()).await?;
        }
    }

    fn command(&self, tag: &str, cmd: &str, args: &str, uid_mode: bool, selected: &Option<String>) -> Vec<u8> {
        self.command_inner(tag, cmd, args, uid_mode, selected).unwrap_or_else(|s| s.into_bytes())
    }

    /// Ok(bytes) for FETCH (literals are binary), Err(text) for the textual replies.
    fn command_inner(&self, tag: &str, cmd: &str, args: &str, uid_mode: bool, selected: &Option<String>) -> Result<Vec<u8>, String> {
        let Some(sel) = selected.clone() else { return Err(format!("{tag} BAD no mailbox selected\r\n")) };
        let mut s = self.state.lock();
        let Some(f) = s.folders.get(&sel).cloned() else { return Err(format!("{tag} NO gone\r\n")) };
        let max_uid = f.msgs.last().map(|m| m.uid).unwrap_or(0);
        let n = f.msgs.len() as u32;
        let (set_str, rest) = split_cmd(args);
        let pick = |set: &str| -> Vec<usize> {
            let mut idx = Vec::new();
            for (i, m) in f.msgs.iter().enumerate() {
                let key = if uid_mode { m.uid } else { i as u32 + 1 };
                let maxk = if uid_mode { max_uid } else { n };
                if in_set(set, key, maxk) {
                    idx.push(i);
                }
            }
            idx
        };
        match cmd {
            "FETCH" => {
                let items = rest.to_ascii_uppercase();
                let mut out = Vec::<u8>::new();
                for i in pick(&set_str) {
                    let m = &f.msgs[i];
                    let mut fields = vec![format!("UID {}", m.uid)];
                    if items.contains("FLAGS") {
                        fields.push(format!("FLAGS ({})", m.flags.iter().cloned().collect::<Vec<_>>().join(" ")));
                    }
                    if items.contains("INTERNALDATE") {
                        fields.push(format!("INTERNALDATE \"{}\"", imap_date(m.internal_date)));
                    }
                    if items.contains("RFC822.SIZE") {
                        fields.push(format!("RFC822.SIZE {}", m.raw.len()));
                    }
                    let mut line = format!("* {} FETCH ({}", i + 1, fields.join(" ")).into_bytes();
                    if items.contains("BODY[]") || items.contains("BODY.PEEK[]") || items.contains("RFC822)") || items.ends_with("RFC822") {
                        line.extend_from_slice(format!(" BODY[] {{{}}}\r\n", m.raw.len()).as_bytes());
                        line.extend_from_slice(&m.raw);
                    }
                    line.extend_from_slice(b")\r\n");
                    out.extend(line);
                    if items.contains("BODY[]") && !items.contains("PEEK") {
                        if let Some(fm) = s.folders.get_mut(&sel) {
                            fm.msgs[i].flags.insert("\\Seen".into());
                        }
                    }
                }
                out.extend_from_slice(format!("{tag} OK FETCH completed\r\n").as_bytes());
                Ok(out)
            }
            "STORE" => {
                let up = rest.to_ascii_uppercase();
                let flags: Vec<String> = rest.find('(').and_then(|a| rest[a + 1..].find(')').map(|b| rest[a + 1..a + 1 + b].to_string())).unwrap_or_default().split_whitespace().map(str::to_string).collect();
                let silent = up.contains(".SILENT");
                let mut out = String::new();
                let idx = pick(&set_str);
                let fm = s.folders.get_mut(&sel).unwrap();
                for i in idx {
                    let m = &mut fm.msgs[i];
                    if up.starts_with('+') {
                        m.flags.extend(flags.iter().cloned());
                    } else if up.starts_with('-') {
                        for fl in &flags {
                            m.flags.remove(fl);
                        }
                    } else {
                        m.flags = flags.iter().cloned().collect();
                    }
                    if !silent {
                        out.push_str(&format!("* {} FETCH (UID {} FLAGS ({}))\r\n", i + 1, m.uid, m.flags.iter().cloned().collect::<Vec<_>>().join(" ")));
                    }
                }
                Err(out + &format!("{tag} OK STORE completed\r\n"))
            }
            "COPY" | "MOVE" => {
                let dest = unquote(rest.trim());
                let idx = pick(&set_str);
                if !s.folders.contains_key(&dest) {
                    return Err(format!("{tag} NO [TRYCREATE] no such mailbox\r\n"));
                }
                let moving: Vec<IMsg> = idx.iter().map(|&i| f.msgs[i].clone()).collect();
                let (src_uids, mut dst_uids) = (moving.iter().map(|m| m.uid.to_string()).collect::<Vec<_>>(), Vec::new());
                let d = s.folders.get_mut(&dest).unwrap();
                for mut m in moving {
                    m.uid = d.uidnext;
                    d.uidnext += 1;
                    dst_uids.push(m.uid.to_string());
                    d.msgs.push(m);
                }
                let uv = d.uidvalidity;
                let mut out = String::new();
                if cmd == "MOVE" {
                    let src = s.folders.get_mut(&sel).unwrap();
                    let mut removed = 0;
                    for i in idx {
                        src.msgs.remove(i - removed);
                        out.push_str(&format!("* {} EXPUNGE\r\n", i - removed + 1));
                        removed += 1;
                    }
                }
                let _ = self.changes.send(dest.clone());
                Err(format!("* OK [COPYUID {uv} {} {}] done\r\n{out}{tag} OK {cmd} completed\r\n", src_uids.join(","), dst_uids.join(",")))
            }
            "EXPUNGE" => {
                let only: Option<Vec<usize>> = if uid_mode { Some(pick(&set_str)) } else { None };
                let fm = s.folders.get_mut(&sel).unwrap();
                let mut out = String::new();
                let mut i = 0;
                let mut pos = 0;
                while i < fm.msgs.len() {
                    let del = fm.msgs[i].flags.contains("\\Deleted") && only.as_ref().map(|o| o.contains(&pos)).unwrap_or(true);
                    if del {
                        fm.msgs.remove(i);
                        out.push_str(&format!("* {} EXPUNGE\r\n", i + 1));
                    } else {
                        i += 1;
                    }
                    pos += 1;
                }
                Err(out + &format!("{tag} OK EXPUNGE completed\r\n"))
            }
            "SEARCH" => {
                let q = format!("{set_str} {rest}");
                let qu = q.to_ascii_uppercase();
                let mut hits = Vec::new();
                for (i, m) in f.msgs.iter().enumerate() {
                    let key = if uid_mode { m.uid } else { i as u32 + 1 };
                    let ok = if qu.starts_with("HEADER MESSAGE-ID") {
                        let want = parse_astrings(&q).get(2).cloned().unwrap_or_default();
                        String::from_utf8_lossy(&m.raw).to_lowercase().contains(&want.to_lowercase())
                    } else if qu.starts_with("UNSEEN") {
                        !m.flags.contains("\\Seen")
                    } else if qu.starts_with("SEEN") {
                        m.flags.contains("\\Seen")
                    } else if qu.starts_with("FLAGGED") {
                        m.flags.contains("\\Flagged")
                    } else if qu.starts_with("UID ") {
                        in_set(q[4..].trim(), m.uid, max_uid)
                    } else {
                        true
                    };
                    if ok {
                        hits.push(key.to_string());
                    }
                }
                Err(format!("* SEARCH {}\r\n{tag} OK SEARCH completed\r\n", hits.join(" ")))
            }
            _ => Err(format!("{tag} BAD unsupported\r\n")),
        }
    }
}

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> std::io::Result<Option<String>> {
    let mut line = String::new();
    if r.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(['\r', '\n']).to_string()))
}

fn literal_len(line: &str) -> Option<(usize, bool)> {
    let l = line.trim_end();
    if !l.ends_with('}') {
        return None;
    }
    let open = l.rfind('{')?;
    let inner = &l[open + 1..l.len() - 1];
    let (num, sync) = match inner.strip_suffix('+') {
        Some(n) => (n, false),
        None => (inner, true),
    };
    num.parse().ok().map(|n| (n, sync))
}

fn split_cmd(s: &str) -> (String, String) {
    let s = s.trim_start();
    match s.find(' ') {
        Some(i) => (s[..i].to_string(), s[i + 1..].to_string()),
        None => (s.to_string(), String::new()),
    }
}

/// Quoted strings and atoms (for LOGIN, LIST args, mailbox names).
fn parse_astrings(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ' ' {
            i += 1;
            continue;
        }
        if chars[i] == '"' {
            let mut v = String::new();
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                v.push(chars[i]);
                i += 1;
            }
            out.push(v);
            i += 1;
        } else if chars[i] == '(' {
            while i < chars.len() && chars[i] != ')' {
                i += 1;
            }
            i += 1;
        } else {
            let start = i;
            while i < chars.len() && chars[i] != ' ' {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
        }
    }
    out
}

fn unquote(s: &str) -> String {
    parse_astrings(s).into_iter().next().unwrap_or_default()
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn in_set(set: &str, key: u32, max: u32) -> bool {
    set.split(',').any(|part| {
        let part = part.trim();
        if let Some((a, b)) = part.split_once(':') {
            let a = if a == "*" { max } else { a.parse().unwrap_or(0) };
            let b = if b == "*" { max } else { b.parse().unwrap_or(0) };
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            // "n:*" with n > max still matches the highest message (RFC 3501).
            if lo > max && (part.ends_with('*')) {
                return key == max;
            }
            key >= lo && key <= hi
        } else if part == "*" {
            key == max
        } else {
            part.parse::<u32>().map(|v| v == key).unwrap_or(false)
        }
    })
}

fn imap_date(ms: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_millis_opt(ms).single().map(|d| d.format("%d-%b-%Y %H:%M:%S +0000").to_string()).unwrap_or_else(|| "01-Jan-2026 00:00:00 +0000".into())
}

// ---- SMTP ----

#[derive(Clone, Debug)]
pub struct SentMail {
    pub from: String,
    pub rcpts: Vec<String>,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub struct FakeSmtp {
    pub addr: SocketAddr,
    pub sent: Arc<Mutex<Vec<SentMail>>>,
    pub user: String,
    pub password: String,
    pub reject: Arc<Mutex<bool>>,
}

impl FakeSmtp {
    pub async fn start(user: &str, password: &str) -> FakeSmtp {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind fake SMTP");
        let addr = listener.local_addr().unwrap();
        let fake = FakeSmtp { addr, sent: Arc::new(Mutex::new(vec![])), user: user.into(), password: password.into(), reject: Arc::new(Mutex::new(false)) };
        let f = fake.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let f = f.clone();
                tokio::spawn(async move {
                    let _ = f.conn(stream).await;
                });
            }
        });
        fake
    }

    async fn conn(&self, stream: TcpStream) -> std::io::Result<()> {
        use base64::Engine as _;
        let (r, mut w) = stream.into_split();
        let mut r = BufReader::new(r);
        w.write_all(b"220 courier-test ESMTP ready\r\n").await?;
        let mut from = String::new();
        let mut rcpts = Vec::new();
        let mut authed = false;
        loop {
            let Some(line) = read_line(&mut r).await? else { return Ok(()) };
            let up = line.to_ascii_uppercase();
            if up.starts_with("EHLO") || up.starts_with("HELO") {
                w.write_all(b"250-courier-test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 35882577\r\n").await?;
            } else if up.starts_with("AUTH PLAIN") {
                let payload = line.split_whitespace().nth(2).map(str::to_string);
                let payload = match payload {
                    Some(p) => p,
                    None => {
                        w.write_all(b"334 \r\n").await?;
                        read_line(&mut r).await?.unwrap_or_default()
                    }
                };
                let dec = base64::engine::general_purpose::STANDARD.decode(payload.trim()).unwrap_or_default();
                let parts: Vec<String> = dec.split(|b| *b == 0).map(|x| String::from_utf8_lossy(x).into_owned()).collect();
                authed = parts.len() >= 3 && parts[1] == self.user && parts[2] == self.password;
                w.write_all(if authed { b"235 2.7.0 Authentication successful\r\n" } else { b"535 5.7.8 Authentication credentials invalid\r\n" }).await?;
            } else if up.starts_with("AUTH LOGIN") {
                w.write_all(b"334 VXNlcm5hbWU6\r\n").await?;
                let u = read_line(&mut r).await?.unwrap_or_default();
                w.write_all(b"334 UGFzc3dvcmQ6\r\n").await?;
                let p = read_line(&mut r).await?.unwrap_or_default();
                let d = |s: &str| String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(s.trim()).unwrap_or_default()).into_owned();
                authed = d(&u) == self.user && d(&p) == self.password;
                w.write_all(if authed { b"235 2.7.0 Authentication successful\r\n" } else { b"535 5.7.8 Authentication credentials invalid\r\n" }).await?;
            } else if up.starts_with("MAIL FROM:") {
                if !authed && !self.user.is_empty() {
                    w.write_all(b"530 5.7.0 Authentication required\r\n").await?;
                    continue;
                }
                from = line[10..].trim().trim_matches(['<', '>']).split_whitespace().next().unwrap_or("").to_string();
                rcpts.clear();
                w.write_all(b"250 2.1.0 OK\r\n").await?;
            } else if up.starts_with("RCPT TO:") {
                rcpts.push(line[8..].trim().trim_matches(['<', '>']).split_whitespace().next().unwrap_or("").trim_matches(['<', '>']).to_string());
                w.write_all(b"250 2.1.5 OK\r\n").await?;
            } else if up == "DATA" {
                if *self.reject.lock() {
                    w.write_all(b"451 4.3.0 Try again later\r\n").await?;
                    continue;
                }
                w.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n").await?;
                let mut data = Vec::new();
                loop {
                    let mut l = Vec::new();
                    let n = r.read_until(b'\n', &mut l).await?;
                    if n == 0 {
                        return Ok(());
                    }
                    if l == b".\r\n" || l == b".\n" {
                        break;
                    }
                    if l.starts_with(b"..") {
                        l.remove(0);
                    }
                    data.extend_from_slice(&l);
                }
                self.sent.lock().push(SentMail { from: from.clone(), rcpts: rcpts.clone(), data });
                w.write_all(b"250 2.0.0 OK queued\r\n").await?;
            } else if up == "QUIT" {
                w.write_all(b"221 2.0.0 Bye\r\n").await?;
                return Ok(());
            } else if up == "RSET" || up == "NOOP" {
                w.write_all(b"250 2.0.0 OK\r\n").await?;
            } else {
                w.write_all(b"502 5.5.2 Command not recognized\r\n").await?;
            }
        }
    }
}
