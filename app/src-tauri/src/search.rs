//! Search operators, Rust side: a twin of app/src/core/search/parser.ts (kept identical by the shared
//! fixture app/tests/fixtures/search-cases.json), a compiler to SQL over the local cache (+ FTS5) for IMAP
//! accounts and offline search, and an evaluator for the fake mail API and local filters.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    And { children: Vec<Node> },
    Or { children: Vec<Node> },
    Not { child: Box<Node> },
    Term {
        field: Option<String>,
        value: String,
        #[serde(default, skip_serializing_if = "is_false")]
        exact: bool,
    },
}

fn is_false(b: &bool) -> bool {
    !*b
}

pub const FIELDS: &[&str] = &[
    "from", "to", "cc", "bcc", "subject", "label", "in", "is", "has", "filename", "larger", "smaller", "size", "before", "after", "older", "newer", "older_than",
    "newer_than", "category", "list", "deliveredto", "rfc822msgid",
];

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    LParen,
    RParen,
    LBrace,
    RBrace,
    Minus,
    Or,
    And,
    Field(String),
    Word(String, bool),
    Phrase(String),
}

fn is_space(c: char) -> bool {
    c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u{a0}'
}

fn tokenize(q: &str) -> Vec<Tok> {
    let chars: Vec<char> = q.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if is_space(c) {
            i += 1;
            continue;
        }
        match c {
            '(' => {
                out.push(Tok::LParen);
                i += 1;
                continue;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
                continue;
            }
            '{' => {
                out.push(Tok::LBrace);
                i += 1;
                continue;
            }
            '}' => {
                out.push(Tok::RBrace);
                i += 1;
                continue;
            }
            '|' => {
                out.push(Tok::Or);
                i += 1;
                continue;
            }
            _ => {}
        }
        if c == '-' && i + 1 < n && !is_space(chars[i + 1]) && (out.is_empty() || i == 0 || is_space(chars[i - 1]) || chars[i - 1] == '(' || chars[i - 1] == '{') {
            out.push(Tok::Minus);
            i += 1;
            continue;
        }
        if c == '"' {
            let mut j = i + 1;
            let mut v = String::new();
            while j < n && chars[j] != '"' {
                v.push(chars[j]);
                j += 1;
            }
            out.push(Tok::Phrase(v));
            i = j + 1;
            continue;
        }
        let stop = |c: char| is_space(c) || "(){}\"".contains(c);
        let mut j = i;
        while j < n && !stop(chars[j]) {
            if chars[j] == ':' {
                break;
            }
            j += 1;
        }
        let word: String = chars[i..j].iter().collect();
        if j < n && chars[j] == ':' && FIELDS.contains(&word.to_lowercase().as_str()) {
            out.push(Tok::Field(word.to_lowercase()));
            i = j + 1;
            continue;
        }
        while j < n && !stop(chars[j]) {
            j += 1;
        }
        let full: String = chars[i..j].iter().collect();
        if full == "OR" {
            out.push(Tok::Or);
        } else if full == "AND" {
            out.push(Tok::And);
        } else if full.starts_with('+') && full.chars().count() > 1 {
            out.push(Tok::Word(full[1..].to_string(), true));
        } else {
            out.push(Tok::Word(full, false));
        }
        i = j;
    }
    out
}

fn flatten(is_and: bool, children: Vec<Node>) -> Node {
    let mut flat = Vec::new();
    for c in children {
        match c {
            Node::And { children } if is_and => flat.extend(children),
            Node::Or { children } if !is_and => flat.extend(children),
            other => flat.push(other),
        }
    }
    if flat.len() == 1 {
        return flat.pop().unwrap();
    }
    if is_and { Node::And { children: flat } } else { Node::Or { children: flat } }
}

#[derive(Clone, Copy, PartialEq)]
enum Stop {
    Paren,
    Brace,
}

struct P {
    toks: Vec<Tok>,
    pos: usize,
}

impl P {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }
    fn is_stop(t: &Tok, stops: &[Stop]) -> bool {
        (matches!(t, Tok::RParen) && stops.contains(&Stop::Paren)) || (matches!(t, Tok::RBrace) && stops.contains(&Stop::Brace))
    }
    fn parse_or(&mut self, field: Option<&str>, stops: &[Stop]) -> Option<Node> {
        let mut parts = Vec::new();
        if let Some(n) = self.parse_and(field, stops) {
            parts.push(n);
        }
        while matches!(self.peek(), Some(Tok::Or)) {
            self.pos += 1;
            if let Some(n) = self.parse_and(field, stops) {
                parts.push(n);
            }
        }
        if parts.is_empty() { None } else { Some(flatten(false, parts)) }
    }
    fn parse_and(&mut self, field: Option<&str>, stops: &[Stop]) -> Option<Node> {
        let mut parts = Vec::new();
        while let Some(t) = self.peek() {
            if P::is_stop(t, stops) || matches!(t, Tok::Or) {
                break;
            }
            if matches!(t, Tok::And) {
                self.pos += 1;
                continue;
            }
            if let Some(u) = self.parse_unary(field, stops) {
                parts.push(u);
            }
        }
        if parts.is_empty() { None } else { Some(flatten(true, parts)) }
    }
    fn parse_unary(&mut self, field: Option<&str>, stops: &[Stop]) -> Option<Node> {
        if matches!(self.peek(), Some(Tok::Minus)) {
            self.pos += 1;
            match self.peek() {
                None => return if field.is_some() { None } else { Some(term(None, "-", false)) },
                Some(t) if P::is_stop(t, stops) => return if field.is_some() { None } else { Some(term(None, "-", false)) },
                _ => {}
            }
            return self.parse_unary(field, stops).map(|c| Node::Not { child: Box::new(c) });
        }
        self.parse_primary(field, stops)
    }
    fn parse_primary(&mut self, field: Option<&str>, stops: &[Stop]) -> Option<Node> {
        let t = self.toks.get(self.pos)?.clone();
        self.pos += 1;
        match t {
            Tok::LParen => {
                let inner = self.parse_or(field, &[Stop::Paren]);
                if matches!(self.peek(), Some(Tok::RParen)) {
                    self.pos += 1;
                }
                inner
            }
            Tok::LBrace => {
                let mut items = Vec::new();
                while let Some(t) = self.peek() {
                    if matches!(t, Tok::RBrace) {
                        break;
                    }
                    if matches!(t, Tok::Or | Tok::And) {
                        self.pos += 1;
                        continue;
                    }
                    if let Some(u) = self.parse_unary(field, &[Stop::Brace]) {
                        items.push(u);
                    }
                }
                if matches!(self.peek(), Some(Tok::RBrace)) {
                    self.pos += 1;
                }
                if items.is_empty() { None } else { Some(flatten(false, items)) }
            }
            Tok::RParen | Tok::RBrace | Tok::Or | Tok::And | Tok::Minus => None,
            Tok::Field(f) => {
                let f = match f.as_str() {
                    "older" => "before".to_string(),
                    "newer" => "after".to_string(),
                    _ => f,
                };
                match self.peek().cloned() {
                    None => Some(term(Some(&f), "", false)),
                    Some(t) if P::is_stop(&t, stops) => Some(term(Some(&f), "", false)),
                    Some(Tok::LParen) | Some(Tok::LBrace) => self.parse_primary(Some(&f), stops),
                    Some(Tok::Phrase(v)) => {
                        self.pos += 1;
                        Some(term(Some(&f), &v, true))
                    }
                    Some(Tok::Word(v, _)) => {
                        self.pos += 1;
                        Some(term(Some(&f), &v, false))
                    }
                    Some(Tok::Field(v)) => {
                        self.pos += 1;
                        Some(term(Some(&f), &format!("{v}:"), false))
                    }
                    Some(_) => Some(term(Some(&f), "", false)),
                }
            }
            Tok::Phrase(v) => Some(term(field, &v, true)),
            Tok::Word(v, exact) => Some(term(field, &v, exact)),
        }
    }
}

fn term(field: Option<&str>, value: &str, exact: bool) -> Node {
    Node::Term { field: field.map(str::to_string), value: value.to_string(), exact }
}

pub fn parse(q: &str) -> Option<Node> {
    let mut p = P { toks: tokenize(q), pos: 0 };
    let root = p.parse_or(None, &[]);
    let mut rest = Vec::new();
    while p.pos < p.toks.len() {
        p.pos += 1;
        if let Some(more) = p.parse_or(None, &[]) {
            rest.push(more);
        }
    }
    if !rest.is_empty() {
        let mut all = Vec::new();
        if let Some(r) = root {
            all.push(r);
        }
        all.extend(rest);
        return Some(flatten(true, all));
    }
    root
}

// ---- values ----

/// "2026/01/31", "2026-1-31", "01/31/2026" → local midnight (ms); unix seconds → that instant.
pub fn parse_date_ms(v: &str) -> Option<i64> {
    use chrono::{Local, NaiveDate, TimeZone};
    let s = v.trim();
    if s.len() >= 9 && s.len() <= 11 && s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse::<i64>().ok().map(|x| x * 1000);
    }
    let parts: Vec<&str> = s.split(['/', '-']).collect();
    if parts.len() != 3 {
        return None;
    }
    let nums: Vec<u32> = parts.iter().filter_map(|p| p.parse().ok()).collect();
    if nums.len() != 3 {
        return None;
    }
    let (y, m, d) = if parts[0].len() == 4 { (nums[0] as i32, nums[1], nums[2]) } else { (nums[2] as i32, nums[0], nums[1]) };
    let date = NaiveDate::from_ymd_opt(y, m, d)?;
    Local.from_local_datetime(&date.and_hms_opt(0, 0, 0)?).earliest().map(|dt| dt.timestamp_millis())
}

pub fn parse_relative_ms(v: &str, now_ms: i64) -> Option<i64> {
    use chrono::{Datelike, Duration, Local, TimeZone};
    let s = v.trim().to_lowercase();
    let unit = s.chars().last()?;
    let n: i64 = s[..s.len() - 1].parse().ok()?;
    let now = Local.timestamp_millis_opt(now_ms).single()?;
    let t = match unit {
        'h' => now - Duration::hours(n),
        'd' => now - Duration::days(n),
        'm' => {
            let total = now.year() as i64 * 12 + now.month0() as i64 - n;
            let (y, m0) = (total.div_euclid(12) as i32, total.rem_euclid(12) as u32);
            let day = now.day().min(28);
            now.with_day(day)?.with_year(y)?.with_month0(m0)?
        }
        'y' => now.with_year(now.year() - n as i32)?,
        _ => return None,
    };
    Some(t.timestamp_millis())
}

pub fn parse_size(v: &str) -> Option<i64> {
    let s = v.trim().to_lowercase();
    let s = s.strip_suffix('b').unwrap_or(&s).to_string();
    let (num, mult) = if let Some(x) = s.strip_suffix('k') {
        (x.to_string(), 1024.0)
    } else if let Some(x) = s.strip_suffix('m') {
        (x.to_string(), 1024.0 * 1024.0)
    } else if let Some(x) = s.strip_suffix('g') {
        (x.to_string(), 1024.0 * 1024.0 * 1024.0)
    } else {
        (s.clone(), 1.0)
    };
    num.trim().parse::<f64>().ok().map(|n| (n * mult).round() as i64)
}

pub fn label_key(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::new();
    let mut prev_dash = false;
    for c in lower.chars() {
        if c.is_whitespace() || c == '/' || c == '_' {
            if !prev_dash {
                out.push('-');
            }
            prev_dash = true;
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    out
}

const STAR_NAMES: &[&str] = &[
    "yellow-star", "orange-star", "red-star", "purple-star", "blue-star", "green-star", "red-bang", "orange-guillemet", "yellow-bang", "green-check", "blue-info", "purple-question",
];

// ---- SQL over the local cache ----

/// Label resolution for `label:` (by name, "-" for spaces/slashes) → ids. Nested labels are not included.
pub trait LabelResolver {
    fn resolve(&self, key: &str) -> Vec<String>;
}

pub struct Sql {
    pub clause: String,
    pub params: Vec<rusqlite::types::Value>,
}

fn fts_quote(word: &str) -> String {
    format!("\"{}\"", word.replace('"', "\"\""))
}

/// FTS5 query for free text: every word must match as a prefix; quoted values match the phrase.
pub fn fts_query(value: &str, exact: bool) -> Option<String> {
    if exact {
        let v = value.trim();
        if v.is_empty() {
            return None;
        }
        return Some(fts_quote(v));
    }
    let words: Vec<String> = value.split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '@' && c != '.').filter(|w| !w.is_empty()).map(|w| format!("{}*", fts_quote(w))).collect();
    if words.is_empty() { None } else { Some(words.join(" ")) }
}

/// Whether the query asks for spam/trash explicitly (otherwise they're excluded, as in the web client).
pub fn mentions_spam_trash(n: &Node) -> bool {
    match n {
        Node::And { children } | Node::Or { children } => children.iter().any(mentions_spam_trash),
        Node::Not { child } => mentions_spam_trash(child),
        Node::Term { field: Some(f), value, .. } if f == "in" || f == "label" => {
            let v = value.to_lowercase();
            v == "spam" || v == "trash" || v == "anywhere" || v == "bin"
        }
        _ => false,
    }
}

pub fn compile(n: &Node, labels: &dyn LabelResolver, now_ms: i64) -> Sql {
    let mut params = Vec::new();
    let clause = compile_node(n, labels, now_ms, &mut params);
    Sql { clause, params }
}

fn has_label(id: &str, params: &mut Vec<rusqlite::types::Value>) -> String {
    params.push(rusqlite::types::Value::Text(format!("% {id} %")));
    "m.labels LIKE ?".into()
}

fn like(col: &str, v: &str, params: &mut Vec<rusqlite::types::Value>) -> String {
    params.push(rusqlite::types::Value::Text(format!("%{}%", v.to_lowercase().replace('%', "\\%").replace('_', "\\_"))));
    format!("lower({col}) LIKE ? ESCAPE '\\'")
}

fn words_like(cols: &[&str], v: &str, exact: bool, params: &mut Vec<rusqlite::types::Value>) -> String {
    let words: Vec<String> = if exact { vec![v.to_string()] } else { v.split_whitespace().map(str::to_string).collect() };
    if words.is_empty() {
        return "1".into();
    }
    let parts: Vec<String> = words
        .iter()
        .map(|w| {
            let ors: Vec<String> = cols.iter().map(|c| like(c, w, params)).collect();
            format!("({})", ors.join(" OR "))
        })
        .collect();
    parts.join(" AND ")
}

fn compile_node(n: &Node, labels: &dyn LabelResolver, now_ms: i64, params: &mut Vec<rusqlite::types::Value>) -> String {
    use rusqlite::types::Value as V;
    match n {
        Node::And { children } => format!("({})", children.iter().map(|c| compile_node(c, labels, now_ms, params)).collect::<Vec<_>>().join(" AND ")),
        Node::Or { children } => format!("({})", children.iter().map(|c| compile_node(c, labels, now_ms, params)).collect::<Vec<_>>().join(" OR ")),
        Node::Not { child } => format!("NOT ({})", compile_node(child, labels, now_ms, params)),
        Node::Term { field, value, exact } => {
            let v = value.as_str();
            let lv = v.to_lowercase();
            match field.as_deref() {
                None => match fts_query(v, *exact) {
                    Some(q) => {
                        params.push(V::Text(q));
                        "m.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?)".into()
                    }
                    None => "1".into(),
                },
                Some("from") => {
                    if lv == "me" {
                        has_label("SENT", params)
                    } else {
                        words_like(&["m.from_name", "m.from_email"], v, *exact, params)
                    }
                }
                Some("to") => words_like(&["m.to_json"], v, *exact, params),
                Some("cc") => words_like(&["m.cc_json"], v, *exact, params),
                Some("bcc") => words_like(&["m.bcc_json"], v, *exact, params),
                Some("deliveredto") => words_like(&["m.to_json", "m.delivered_to"], v, true, params),
                Some("subject") => words_like(&["m.subject"], v, *exact, params),
                Some("list") => like("m.list_id", v, params),
                Some("rfc822msgid") => {
                    params.push(V::Text(format!("<{}>", v.trim_matches(['<', '>']))));
                    "m.message_id = ?".into()
                }
                Some("filename") => like("m.attachments_json", v, params),
                Some("label") => {
                    let ids = labels.resolve(&label_key(v));
                    if ids.is_empty() {
                        "0".into()
                    } else {
                        format!("({})", ids.iter().map(|id| has_label(id, params)).collect::<Vec<_>>().join(" OR "))
                    }
                }
                Some("category") => {
                    let c = if lv == "personal" { "primary".to_string() } else { lv.clone() };
                    if c == "primary" {
                        let others = ["SOCIAL", "PROMOTIONS", "UPDATES", "FORUMS"].iter().map(|x| has_label(&format!("CATEGORY_{x}"), params)).collect::<Vec<_>>().join(" OR ");
                        format!("NOT ({others})")
                    } else {
                        has_label(&format!("CATEGORY_{}", c.to_uppercase()), params)
                    }
                }
                Some("in") => match lv.as_str() {
                    "anywhere" => "1".into(),
                    "inbox" => has_label("INBOX", params),
                    "sent" => has_label("SENT", params),
                    "drafts" | "draft" => has_label("DRAFT", params),
                    "spam" => has_label("SPAM", params),
                    "trash" | "bin" => has_label("TRASH", params),
                    "starred" => has_label("STARRED", params),
                    "important" => has_label("IMPORTANT", params),
                    "snoozed" => "m.thread_id IN (SELECT thread_id FROM snoozes s WHERE s.account_id = m.account_id)".into(),
                    "chats" => "0".into(),
                    other => {
                        let ids = labels.resolve(&label_key(other));
                        if ids.is_empty() { "0".into() } else { format!("({})", ids.iter().map(|id| has_label(id, params)).collect::<Vec<_>>().join(" OR ")) }
                    }
                },
                Some("is") => match lv.as_str() {
                    "unread" => has_label("UNREAD", params),
                    "read" => format!("NOT ({})", has_label("UNREAD", params)),
                    "starred" => has_label("STARRED", params),
                    "important" => has_label("IMPORTANT", params),
                    "snoozed" => "m.thread_id IN (SELECT thread_id FROM snoozes s WHERE s.account_id = m.account_id)".into(),
                    "muted" => "m.thread_id IN (SELECT thread_id FROM muted x WHERE x.account_id = m.account_id)".into(),
                    _ => "0".into(),
                },
                Some("has") => match lv.as_str() {
                    "attachment" => "m.has_attachments = 1".into(),
                    "userlabels" => "(m.labels LIKE '% Label\\_%' ESCAPE '\\' OR m.labels LIKE '% F:%')".into(),
                    "nouserlabels" => "NOT (m.labels LIKE '% Label\\_%' ESCAPE '\\' OR m.labels LIKE '% F:%')".into(),
                    s if STAR_NAMES.contains(&s) => {
                        let mut c = has_label("STARRED", params);
                        params.push(V::Text(s.to_string()));
                        c.push_str(if s == "yellow-star" {
                            " AND COALESCE((SELECT type FROM star_types t WHERE t.account_id = m.account_id AND t.message_id = m.id), 'yellow-star') = ?"
                        } else {
                            " AND (SELECT type FROM star_types t WHERE t.account_id = m.account_id AND t.message_id = m.id) = ?"
                        });
                        format!("({c})")
                    }
                    _ => "0".into(),
                },
                Some("larger") | Some("size") => match parse_size(v) {
                    Some(n) => {
                        params.push(V::Integer(n));
                        "m.size > ?".into()
                    }
                    None => "0".into(),
                },
                Some("smaller") => match parse_size(v) {
                    Some(n) => {
                        params.push(V::Integer(n));
                        "m.size < ?".into()
                    }
                    None => "0".into(),
                },
                Some("before") => match parse_date_ms(v) {
                    Some(t) => {
                        params.push(V::Integer(t));
                        "m.internal_date < ?".into()
                    }
                    None => "0".into(),
                },
                Some("after") => match parse_date_ms(v) {
                    Some(t) => {
                        params.push(V::Integer(t));
                        "m.internal_date >= ?".into()
                    }
                    None => "0".into(),
                },
                Some("older_than") => match parse_relative_ms(v, now_ms) {
                    Some(t) => {
                        params.push(V::Integer(t));
                        "m.internal_date < ?".into()
                    }
                    None => "0".into(),
                },
                Some("newer_than") => match parse_relative_ms(v, now_ms) {
                    Some(t) => {
                        params.push(V::Integer(t));
                        "m.internal_date >= ?".into()
                    }
                    None => "0".into(),
                },
                Some(other) => match fts_query(&format!("{other} {v}"), false) {
                    Some(q) => {
                        params.push(V::Text(q));
                        "m.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?)".into()
                    }
                    None => "1".into(),
                },
            }
        }
    }
}

// ---- in-memory evaluation (fake server, local filters) ----

#[derive(Debug, Clone, Default)]
pub struct Searchable {
    pub from: String, // "name email" lower-case
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub delivered_to: String,
    pub subject: String,
    pub body: String,
    pub labels: Vec<String>, // ids
    pub label_names: Vec<String>,
    pub attachment_names: Vec<String>,
    pub size: i64,
    pub date_ms: i64,
    pub list_id: String,
    pub message_id: String,
    pub star_type: Option<String>,
    pub snoozed: bool,
    pub muted: bool,
}

fn text_has(hay: &str, needle: &str, exact: bool) -> bool {
    let h = hay.to_lowercase();
    let n = needle.to_lowercase();
    let n = n.trim();
    if n.is_empty() {
        return true;
    }
    if exact {
        return h.contains(n);
    }
    let words: Vec<&str> = h.split(|c: char| !c.is_alphanumeric() && c != '@' && c != '.' && c != '+' && c != '-' && c != '_').filter(|w| !w.is_empty()).collect();
    n.split(|c: char| !c.is_alphanumeric() && c != '@' && c != '.' && c != '+' && c != '-' && c != '_')
        .filter(|w| !w.is_empty())
        .all(|w| words.iter().any(|x| x.starts_with(w)) || h.contains(w))
}

pub fn eval(n: &Node, m: &Searchable, now_ms: i64) -> bool {
    match n {
        Node::And { children } => children.iter().all(|c| eval(c, m, now_ms)),
        Node::Or { children } => children.iter().any(|c| eval(c, m, now_ms)),
        Node::Not { child } => !eval(child, m, now_ms),
        Node::Term { field, value, exact } => {
            let has = |id: &str| m.labels.iter().any(|l| l == id);
            let lv = value.to_lowercase();
            match field.as_deref() {
                None => text_has(&format!("{} {} {} {} {} {}", m.subject, m.body, m.from, m.to, m.cc, m.attachment_names.join(" ")), value, *exact),
                Some("from") => {
                    if lv == "me" {
                        has("SENT")
                    } else {
                        text_has(&m.from, value, *exact)
                    }
                }
                Some("to") => text_has(&format!("{} {}", m.to, m.delivered_to), value, *exact),
                Some("cc") => text_has(&m.cc, value, *exact),
                Some("bcc") => text_has(&m.bcc, value, *exact),
                Some("deliveredto") => m.delivered_to.to_lowercase().contains(&lv) || text_has(&m.to, value, true),
                Some("subject") => text_has(&m.subject, value, *exact),
                Some("list") => m.list_id.to_lowercase().contains(&lv),
                Some("rfc822msgid") => m.message_id.trim_matches(['<', '>']).eq_ignore_ascii_case(value.trim_matches(['<', '>'])),
                Some("filename") => m.attachment_names.iter().any(|a| a.to_lowercase().contains(&lv)),
                Some("label") => {
                    let k = label_key(value);
                    m.label_names.iter().any(|n| label_key(n) == k) || m.labels.iter().any(|id| label_key(id) == k)
                }
                Some("category") => {
                    let c = if lv == "personal" { "primary".to_string() } else { lv.clone() };
                    if c == "primary" {
                        !["SOCIAL", "PROMOTIONS", "UPDATES", "FORUMS"].iter().any(|x| has(&format!("CATEGORY_{x}")))
                    } else {
                        has(&format!("CATEGORY_{}", c.to_uppercase()))
                    }
                }
                Some("in") => match lv.as_str() {
                    "anywhere" => true,
                    "inbox" => has("INBOX"),
                    "sent" => has("SENT"),
                    "drafts" | "draft" => has("DRAFT"),
                    "spam" => has("SPAM"),
                    "trash" | "bin" => has("TRASH"),
                    "starred" => has("STARRED"),
                    "important" => has("IMPORTANT"),
                    "snoozed" => m.snoozed,
                    _ => m.label_names.iter().any(|n| label_key(n) == label_key(&lv)),
                },
                Some("is") => match lv.as_str() {
                    "unread" => has("UNREAD"),
                    "read" => !has("UNREAD"),
                    "starred" => has("STARRED"),
                    "important" => has("IMPORTANT"),
                    "snoozed" => m.snoozed,
                    "muted" => m.muted,
                    _ => false,
                },
                Some("has") => match lv.as_str() {
                    "attachment" => !m.attachment_names.is_empty(),
                    "userlabels" => m.labels.iter().any(|l| l.starts_with("Label_") || l.starts_with("F:")),
                    "nouserlabels" => !m.labels.iter().any(|l| l.starts_with("Label_") || l.starts_with("F:")),
                    s if STAR_NAMES.contains(&s) => has("STARRED") && m.star_type.as_deref().unwrap_or("yellow-star") == s,
                    _ => false,
                },
                Some("larger") | Some("size") => parse_size(value).map(|n| m.size > n).unwrap_or(false),
                Some("smaller") => parse_size(value).map(|n| m.size < n).unwrap_or(false),
                Some("before") => parse_date_ms(value).map(|t| m.date_ms < t).unwrap_or(false),
                Some("after") => parse_date_ms(value).map(|t| m.date_ms >= t).unwrap_or(false),
                Some("older_than") => parse_relative_ms(value, now_ms).map(|t| m.date_ms < t).unwrap_or(false),
                Some("newer_than") => parse_relative_ms(value, now_ms).map(|t| m.date_ms >= t).unwrap_or(false),
                Some(other) => text_has(&format!("{} {}", m.subject, m.body), &format!("{other}:{value}"), *exact),
            }
        }
    }
}

pub fn matches(q: &str, m: &Searchable, now_ms: i64) -> bool {
    match parse(q) {
        Some(n) => eval(&n, m, now_ms),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_fixture_matches_typescript_parser() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../tests/fixtures/search-cases.json")).unwrap();
        for c in cases {
            let q = c["q"].as_str().unwrap();
            let got = serde_json::to_value(parse(q)).unwrap();
            assert_eq!(got, c["ast"], "query {q:?}");
        }
    }

    #[test]
    fn values() {
        assert_eq!(parse_size("10M"), Some(10 * 1024 * 1024));
        assert_eq!(parse_size("500k"), Some(512000));
        assert!(parse_date_ms("2026/01/31").is_some());
        assert_eq!(parse_date_ms("2026/01/31"), parse_date_ms("01/31/2026"));
        assert_eq!(parse_date_ms("1767225600"), Some(1767225600000));
        assert_eq!(label_key("Projects/Alpha Beta"), "projects-alpha-beta");
        let now = parse_date_ms("2026/10/18").unwrap();
        assert!(parse_relative_ms("2d", now).unwrap() < now);
    }

    #[test]
    fn evaluate() {
        let m = Searchable {
            from: "alice doe alice@example.com".into(),
            to: "pat pat@example.com".into(),
            subject: "Quarterly planning notes".into(),
            body: "Attached are the planning notes".into(),
            labels: vec!["INBOX".into(), "UNREAD".into(), "Label_1".into()],
            label_names: vec!["Projects/Alpha".into()],
            attachment_names: vec!["quarterly-plan.pdf".into()],
            size: 120_000,
            date_ms: parse_date_ms("2026/10/18").unwrap() + 3600_000,
            ..Default::default()
        };
        let now = parse_date_ms("2026/10/19").unwrap();
        for (q, want) in [
            ("from:alice", true),
            ("from:bob", false),
            ("subject:\"planning notes\"", true),
            // Exact labels only: the parent does not match mail filed under Projects/Alpha.
            ("label:projects", false),
            ("label:projects-alpha has:attachment", true),
            ("is:unread in:inbox", true),
            ("is:read", false),
            ("larger:100K smaller:1M", true),
            ("after:2026/10/18 before:2026/10/19", true),
            ("newer_than:2d", true),
            ("plan -quarterly", false),
            ("{from:bob from:alice}", true),
            ("filename:pdf", true),
        ] {
            assert_eq!(matches(q, &m, now), want, "{q}");
        }
    }
}
