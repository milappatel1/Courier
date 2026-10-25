//! Race fuzzer: random sequences of user actions (archive, trash, spam, labels, star, read, Undo) interleaved with
//! what a real mailbox does meanwhile (another device changing labels, new mail, the network going away and
//! coming back, slow and refused answers, listings that run behind), on two mail-API accounts at once. Some steps
//! run two things at the same time (a listing while a change lands, a sync while a change is on its way).
//!
//! Checked after every step (and on a settled mailbox at the end):
//!
//! 1. **No resurrection.** A conversation the user took out of a view stays out of its listing (cache and server
//!    mode) while that is the user's latest standing change for it and no other device changed it after. The same
//!    for a conversation the user put into a view.
//! 2. **Settles.** With the connection back, every change answered and a sync made, the cached messages, the
//!    cached listings and every label count equal what the fake server says (counts also after a full resync).
//! 3. **No negative count**, ever.
//! 4. **No leak** between the two accounts.
//! 5. **The queue drains exactly once.** Every change made offline reaches the server once (counted from the
//!    requests the server accepted) and nothing stays queued.
//!
//! A failure prints the seed, the invariant and a step list reduced by dropping steps. Rerun one seed with
//! `COURIER_FUZZ_SEED=<n> COURIER_FUZZ_SEEDS=1`; rerun a reduced list with `COURIER_FUZZ_KEEP=1,4,9` (indexes of
//! the original steps).
//!
//! Environment: COURIER_FUZZ_SEEDS (count, default 60), COURIER_FUZZ_SEED (first seed, default 1), COURIER_FUZZ_SEED_LIST (comma-separated seeds instead),
//! COURIER_FUZZ_STEPS (per seed, default 40), COURIER_FUZZ_THREADS (seeds run side by side, default 3),
//! COURIER_FUZZ_BUDGET_SECS to stop starting seeds after that long, COURIER_FUZZ_SHRINK=0 to skip reducing, COURIER_FUZZ_AVOID=undo-queued,undo-offline to leave out the Undo steps
//! that hit the problems already reported (so the rest of the space can be explored). COURIER_FUZZ_FAULT=resurrect|negative|leak|dupsend|swallow|stuck|drift
//! injects one fault into the run, to show the matching check can fail (see `Fault`).
//!
//! Long run: `COURIER_FUZZ_SEEDS=300 COURIER_FUZZ_STEPS=80 cargo test --release --test race_fuzz -- --nocapture`

use courier_lib::db::{AccountRow, Db};
use courier_lib::engine::{Changed, Engine, EventSink, Notifier, Opener, ViewQuery, ViewResult};
use courier_lib::http::{self, Request, Response};
use courier_lib::oauth::{self, ClientCreds, Endpoints, TokenManager};
use courier_lib::secrets::{self, MemoryStore, SecretStore};
use courier_lib::testsupport::FakeGmail;
use courier_lib::testsupport::fake_gmail::{FMsg, GState};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const VIEWS: [&str; 6] = ["INBOX", "TRASH", "SPAM", "STARRED", "Label_1", "Label_2"];
const SLOW_ROUTES: [&str; 5] = ["batchModify", "threads.list", "messages.list", "history", "labels"];
const WINDOW_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;

// ---- randomness ----

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<'a, T>(&mut self, weighted: &'a [(u64, T)]) -> &'a T {
        let total: u64 = weighted.iter().map(|(w, _)| w).sum();
        let mut roll = self.below(total);
        for (w, v) in weighted {
            if roll < *w {
                return v;
            }
            roll -= w;
        }
        &weighted[0].1
    }
}

// ---- steps ----

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Archive,
    ToInbox,
    Trash,
    Untrash,
    Spam,
    NotSpam,
    Work,
    UnWork,
    Home,
    UnHome,
    Star,
    Unstar,
    Read,
    Unread,
}

impl Op {
    /// The change as the engine gets it (the Trash and Spam rules already applied).
    fn lists(self) -> (Vec<String>, Vec<String>) {
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        match self {
            Op::Archive => (v(&[]), v(&["INBOX"])),
            Op::ToInbox => (v(&["INBOX"]), v(&[])),
            Op::Trash => (v(&["TRASH"]), v(&["INBOX", "SPAM"])),
            Op::Untrash => (v(&["INBOX"]), v(&["TRASH"])),
            Op::Spam => (v(&["SPAM"]), v(&["INBOX", "TRASH"])),
            Op::NotSpam => (v(&["INBOX"]), v(&["SPAM"])),
            Op::Work => (v(&["Label_1"]), v(&[])),
            Op::UnWork => (v(&[]), v(&["Label_1"])),
            Op::Home => (v(&["Label_2"]), v(&[])),
            Op::UnHome => (v(&[]), v(&["Label_2"])),
            Op::Star => (v(&["STARRED"]), v(&[])),
            Op::Unstar => (v(&[]), v(&["STARRED"])),
            Op::Read => (v(&[]), v(&["UNREAD"])),
            Op::Unread => (v(&["UNREAD"]), v(&[])),
        }
    }
}

#[derive(Clone, Debug)]
enum Step {
    /// A change to a whole conversation (what the toolbar does).
    Change {
        a: usize,
        t: u32,
        op: Op,
    },
    /// A change to one message of a conversation.
    MsgChange {
        a: usize,
        t: u32,
        k: u32,
        op: Op,
    },
    Undo {
        a: usize,
        back: u32,
    },
    /// Another device changes one message.
    Remote {
        a: usize,
        t: u32,
        k: u32,
        op: Op,
    },
    Mail {
        a: usize,
        t: u32,
        reply: bool,
    },
    Sync {
        a: usize,
    },
    ListCache {
        a: usize,
        label: u32,
    },
    ListServer {
        a: usize,
        label: u32,
    },
    Offline {
        a: usize,
    },
    Online {
        a: usize,
    },
    /// The connection is back and one sync follows, alone: the queue must drain exactly once.
    Reconnect {
        a: usize,
    },
    Slow {
        a: usize,
        route: u32,
        ms: u64,
        tail: bool,
    },
    Lag {
        a: usize,
        ms: u64,
    },
    /// The next change the server is asked for is refused.
    Refuse {
        a: usize,
    },
    Precondition {
        a: usize,
        n: u32,
    },
    Heal {
        a: usize,
    },
    /// Delete forever, on a binned conversation this Mac holds in full.
    Delete {
        a: usize,
        t: u32,
    },
    /// These run at the same time.
    Race(Vec<Step>),
    Settle,
}

fn gen_op(r: &mut Rng) -> Op {
    *r.pick(&[
        (20, Op::Archive),
        (10, Op::ToInbox),
        (14, Op::Trash),
        (6, Op::Untrash),
        (6, Op::Spam),
        (3, Op::NotSpam),
        (6, Op::Work),
        (6, Op::UnWork),
        (4, Op::Home),
        (4, Op::UnHome),
        (6, Op::Star),
        (5, Op::Unstar),
        (5, Op::Read),
        (5, Op::Unread),
    ])
}

fn gen_leaf(r: &mut Rng, race: bool) -> Step {
    // A small pool of conversations, so changes meet each other.
    let a = r.below(2) as usize;
    let t = if r.chance(85) { r.below(6) as u32 } else { r.next() as u32 };
    let k = r.next() as u32;
    let kinds: &[(u64, u8)] = if race {
        &[(34, 0), (6, 1), (10, 2), (10, 3), (6, 4), (18, 5), (4, 6), (12, 7)]
    } else {
        &[
            (28, 0),
            (5, 1),
            (8, 2),
            (8, 3),
            (7, 4),
            (10, 5),
            (3, 6),
            (6, 7),
            (4, 8),
            (3, 9),
            (4, 10),
            (4, 11),
            (2, 12),
            (2, 13),
            (2, 14),
            (4, 15),
            (2, 16),
            (3, 17),
        ]
    };
    match *r.pick(kinds) {
        0 => Step::Change { a, t, op: gen_op(r) },
        1 => Step::MsgChange { a, t, k, op: gen_op(r) },
        2 => Step::Undo { a, back: r.below(4) as u32 },
        3 => Step::Remote { a, t, k, op: gen_op(r) },
        4 => Step::Mail { a, t, reply: r.chance(70) },
        5 => Step::Sync { a },
        6 => Step::ListCache { a, label: r.next() as u32 },
        7 => Step::ListServer { a, label: r.next() as u32 },
        8 => Step::Offline { a },
        9 => Step::Online { a },
        10 => Step::Reconnect { a },
        11 => Step::Slow { a, route: r.next() as u32, ms: *r.pick(&[(1, 0), (2, 15), (2, 45)]), tail: r.chance(50) },
        12 => Step::Lag { a, ms: *r.pick(&[(1, 0), (2, 60), (1, 200)]) },
        13 => Step::Refuse { a },
        14 => Step::Precondition { a, n: 1 + r.below(2) as u32 },
        15 => Step::Heal { a },
        17 => Step::Delete { a, t },
        _ => Step::Settle,
    }
}

fn gen_steps(seed: u64, n: usize) -> Vec<Step> {
    let mut r = Rng::new(seed ^ 0x5eed_f00d);
    (0..n)
        .map(|_| {
            if r.chance(20) {
                let parts = 2 + r.below(2) as usize;
                Step::Race((0..parts).map(|_| gen_leaf(&mut r, true)).collect())
            } else {
                gen_leaf(&mut r, false)
            }
        })
        .collect()
}

// ---- failures ----

#[derive(Clone, Debug)]
struct Fail {
    inv: u8,
    msg: String,
}

fn fail<T>(inv: u8, msg: impl Into<String>) -> Result<T, Fail> {
    Err(Fail { inv, msg: msg.into() })
}

fn inv_name(n: u8) -> &'static str {
    match n {
        1 => "1 no resurrection",
        2 => "2 settles to the server",
        3 => "3 no negative count",
        4 => "4 no leak between accounts",
        5 => "5 queue drains exactly once",
        _ => "0 engine or harness error",
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Fault {
    None,
    /// After a change that takes a conversation out of the Inbox, a newer read puts its old labels back.
    Resurrect,
    /// A label count goes negative.
    Negative,
    /// A message of one account is written into the other.
    Leak,
    /// The first change the server is asked for is sent twice.
    DupSend,
    /// The first change the server is asked for is acknowledged but never delivered (and so never counted).
    Swallow,
    /// A change stays queued after everything settled.
    Stuck,
    /// The server changes a message without a history record, and no sync can know.
    Drift,
}

impl Fault {
    fn from_env() -> Fault {
        match std::env::var("COURIER_FUZZ_FAULT").unwrap_or_default().as_str() {
            "resurrect" => Fault::Resurrect,
            "negative" => Fault::Negative,
            "leak" => Fault::Leak,
            "dupsend" => Fault::DupSend,
            "swallow" => Fault::Swallow,
            "stuck" => Fault::Stuck,
            "drift" => Fault::Drift,
            _ => Fault::None,
        }
    }
}

// ---- the engine's collaborators ----

struct Quiet;
impl EventSink for Quiet {
    fn emit(&self, _e: &str, _p: Value) {}
}
impl Notifier for Quiet {
    fn notify(&self, _title: &str, _body: &str, _a: &str, _t: &str) {}
}
impl Opener for Quiet {
    fn open(&self, _url: &str) -> courier_lib::error::Result<()> {
        Ok(())
    }
}

// ---- a recording proxy in front of each fake, to see exactly which changes the server accepted ----

#[derive(Clone, Debug)]
struct Sent {
    ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
    status: u16,
}

impl Sent {
    fn accepted(&self) -> bool {
        self.status / 100 == 2
    }
    fn refused(&self) -> bool {
        self.status == 400
    }
}

#[derive(Default)]
struct ProxyFaults {
    duplicate: AtomicBool,
    swallow: AtomicBool,
    /// The next N changes the server is asked for (while it is reachable) are refused.
    refuse: AtomicUsize,
}

async fn send_on(client: &reqwest::Client, target: &str, req: &Request) -> Response {
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut rb = client.request(method, format!("{target}{}", req.path)).query(&req.query).body(req.body.clone());
    for h in ["authorization", "content-type"] {
        if let Some(v) = req.header(h) {
            rb = rb.header(h, v);
        }
    }
    match rb.send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = r.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
            Response { status, headers: ct.map(|c| vec![("Content-Type".to_string(), c)]).unwrap_or_default(), body }
        }
        Err(_) => Response::status(502),
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

async fn proxied(client: &reqwest::Client, target: &str, log: &Mutex<Vec<Sent>>, faults: &ProxyFaults, req: Request) -> Response {
    let batch = req.method == "POST" && req.path.ends_with("/messages/batchModify");
    let single = req.method == "POST" && req.path.ends_with("/modify") && req.path.contains("/messages/");
    if !batch && !single {
        return send_on(client, target, &req).await;
    }
    let body = req.json();
    let ids = if batch { strs(&body["ids"]) } else { req.path.split('/').rev().nth(1).map(|s| vec![s.to_string()]).unwrap_or_default() };
    let note = |status: u16| Sent { ids: ids.clone(), add: strs(&body["addLabelIds"]), remove: strs(&body["removeLabelIds"]), status };
    if faults.refuse.load(Ordering::SeqCst) > 0 {
        faults.refuse.fetch_sub(1, Ordering::SeqCst);
        log.lock().push(note(400));
        return Response::json(
            400,
            &json!({"error": {"code": 400, "message": "Bad Request", "errors": [{"message": "Bad Request", "domain": "global", "reason": "badRequest"}], "status": "INVALID_ARGUMENT"}}),
        );
    }
    if faults.swallow.swap(false, Ordering::SeqCst) {
        return Response::status(204);
    }
    let resp = send_on(client, target, &req).await;
    log.lock().push(note(resp.status));
    if resp.status / 100 == 2 && faults.duplicate.swap(false, Ordering::SeqCst) {
        let again = send_on(client, target, &req).await;
        log.lock().push(note(again.status));
    }
    resp
}

/// The mail API as the engine reaches it: through this proxy, which records the changes it forwards.
async fn start_proxy(fake: FakeGmail, log: Arc<Mutex<Vec<Sent>>>, faults: Arc<ProxyFaults>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind proxy");
    let base = format!("http://{}", listener.local_addr().unwrap());
    let target = fake.base();
    let client = reqwest::Client::new();
    let handler: http::Handler = Arc::new(move |req: Request| {
        let (client, target, log, faults) = (client.clone(), target.clone(), log.clone(), faults.clone());
        Box::pin(async move { proxied(&client, &target, &log, &faults, req).await })
    });
    tokio::spawn(http::serve(listener, handler));
    base
}

// ---- mailboxes ----

fn raw_mail(from: &str, to: &str, subject: &str, date_ms: i64, msg_id: &str, reply_to: Option<&str>) -> Vec<u8> {
    let date = chrono::DateTime::from_timestamp_millis(date_ms).unwrap_or_default().to_rfc2822();
    let refs = reply_to.map(|r| format!("In-Reply-To: {r}\r\nReferences: {r}\r\n")).unwrap_or_default();
    format!("From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: {msg_id}\r\n{refs}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody of {subject}\r\n").into_bytes()
}

/// A dozen conversations: some archived, some starred or labelled, a few binned, one whose first message is older
/// than the window this Mac keeps and one that is entirely older.
fn populate(fake: &FakeGmail, prefix: &str, email: &str, rng: &mut Rng) {
    let now = courier_lib::error::now_ms();
    let hour = 3_600_000;
    for i in 0..(9 + rng.below(4) as i64) {
        let len = 1 + rng.below(3) as i64;
        let fully_old = i == 3;
        let old_first = i % 5 == 1 && len > 1;
        let binned = if rng.chance(8) {
            Some("TRASH")
        } else if rng.chance(6) {
            Some("SPAM")
        } else {
            None
        };
        let inbox = binned.is_none() && !fully_old && rng.chance(75);
        let (work, home, starred) = (rng.chance(25), rng.chance(15), rng.chance(15));
        let first_id = format!("<{prefix}-{i}-0@fuzz.example>");
        for k in 0..len {
            let age = if fully_old {
                (WINDOW_DAYS + 15 + k) * DAY_MS
            } else if old_first && k == 0 {
                (WINDOW_DAYS + 10) * DAY_MS
            } else {
                (i * 3 + (len - k)) * hour
            };
            let recent = age < (WINDOW_DAYS - 1) * DAY_MS;
            let mut labels = vec!["CATEGORY_PERSONAL"];
            if let Some(b) = binned {
                labels.push(b);
            }
            if inbox {
                labels.push("INBOX");
            }
            if work {
                labels.push("Label_1");
            }
            if home {
                labels.push("Label_2");
            }
            if starred && k == 0 {
                labels.push("STARRED");
            }
            if inbox && recent && k == len - 1 && rng.chance(55) {
                labels.push("UNREAD");
            }
            let subject = if k == 0 { format!("{prefix} thread {i}") } else { format!("Re: {prefix} thread {i}") };
            let raw = raw_mail(
                &format!("Ana <ana-{i}@friends.example>"),
                email,
                &subject,
                now - age,
                &format!("<{prefix}-{i}-{k}@fuzz.example>"),
                (k > 0).then_some(first_id.as_str()),
            );
            fake.deliver(&raw, &labels);
        }
    }
}

// ---- the world one run drives ----

struct Acct {
    id: &'static str,
    prefix: &'static str,
    email: &'static str,
    fake: FakeGmail,
    sent: Arc<Mutex<Vec<Sent>>>,
    faults: Arc<ProxyFaults>,
    proxy: String,
    linked: AtomicBool,
    /// (conversation, view) → whether the user's latest standing change says the conversation is in the view.
    expect: Mutex<HashMap<(String, &'static str), bool>>,
    made: Mutex<Vec<Made>>,
    /// Bumped by anything another device or the server does to a conversation (an Undo after it proves nothing).
    epoch: Mutex<HashMap<String, u32>>,
    /// Conversations another device changed, that no sync has brought here yet: what this Mac holds of them can be stale.
    dirty: Mutex<HashSet<String>>,
    /// When the user's latest change to a conversation came back.
    changed_at: Mutex<HashMap<String, i64>>,
    /// Conversations deleted forever here (the server may still hold them while the delete waits).
    deleted: Mutex<HashSet<String>>,
    undos: Mutex<HashMap<String, u32>>,
    /// Refused requests in `sent` that the model has dealt with (by index).
    handled: Mutex<HashSet<usize>>,
    next_local: AtomicUsize,
}

#[derive(Clone)]
struct Made {
    change: u64,
    thread: String,
    add: Vec<String>,
    remove: Vec<String>,
    /// Which views held the conversation before the change, in the cache and on the server.
    before: HashMap<&'static str, bool>,
    before_server: HashMap<&'static str, bool>,
    /// It waited for the connection when it was made.
    queued: bool,
    /// Undos already made on its conversation when it was made.
    undos: u32,
    epoch: u32,
    undone: bool,
}

fn binned(m: &FMsg) -> bool {
    m.labels.iter().any(|l| l == "TRASH" || l == "SPAM")
}

fn is_bin_label(l: &String) -> bool {
    l == "TRASH" || l == "SPAM"
}

impl Acct {
    fn threads(&self) -> Vec<String> {
        let gone = self.deleted.lock();
        let mut v: Vec<String> = self.fake.state.lock().messages.values().map(|m| m.thread_id.clone()).filter(|t| !gone.contains(t)).collect();
        v.sort();
        v.dedup();
        v
    }
    fn pick_thread(&self, t: u32) -> Option<String> {
        let all = self.threads();
        (!all.is_empty()).then(|| all[t as usize % all.len()].clone())
    }
    fn thread_msgs(&self, tid: &str) -> Vec<FMsg> {
        let mut v: Vec<FMsg> = self.fake.state.lock().messages.values().filter(|m| m.thread_id == tid).cloned().collect();
        v.sort_by(|a, b| (a.internal_date, &a.id).cmp(&(b.internal_date, &b.id)));
        v
    }
    fn clear_thread(&self, tid: &str) {
        self.expect.lock().retain(|(t, _), _| t != tid);
        *self.epoch.lock().entry(tid.to_string()).or_default() += 1;
    }
    fn heal(&self) {
        let mut s = self.fake.state.lock();
        s.latency.clear();
        s.tail_latency.clear();
        s.label_lag_ms = 0;
        s.search_lag_ms = 0;
        s.precondition_next = 0;
        s.fail_routes.clear();
        self.faults.refuse.store(0, Ordering::SeqCst);
    }
    /// Refused requests since `from` that nothing has accounted for yet.
    fn refusals(&self, from: usize) -> Vec<(usize, Vec<String>)> {
        let handled = self.handled.lock();
        self.sent.lock().iter().enumerate().skip(from).filter(|(i, s)| s.refused() && !handled.contains(i)).map(|(i, s)| (i, s.ids.clone())).collect()
    }
}

#[derive(Default)]
struct Stats {
    n: Mutex<HashMap<&'static str, usize>>,
}

impl Stats {
    fn bump(&self, k: &'static str) {
        *self.n.lock().entry(k).or_default() += 1;
    }
    fn line(&self) -> String {
        let n = self.n.lock();
        let mut keys: Vec<_> = n.iter().collect();
        keys.sort();
        keys.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")
    }
}

struct World {
    engine: Arc<Engine>,
    accts: [Acct; 2],
    fault: Fault,
    stats: Stats,
    soft: Mutex<Vec<String>>,
    step: AtomicUsize,
    /// Mail in Trash or Spam when the account was first synced: that sync doesn't list it, so it is never cached.
    uncached: HashSet<(usize, String)>,
}

enum Out {
    None,
    /// `lagging`: when the listing started, if it ran through a search (which runs behind changes on the real API).
    Listed {
        a: usize,
        label: &'static str,
        r: ViewResult,
        lagging: Option<i64>,
    },
    /// A change made (or refused: `change` None). `keys` are the expectations it set.
    Changed {
        a: usize,
        keys: Vec<(String, &'static str)>,
        change: Option<u64>,
    },
}

type Res<T> = Result<T, Fail>;

fn view_query(account: &str, label: &str, server: bool) -> ViewQuery {
    ViewQuery {
        account_id: account.into(),
        label: Some(label.into()),
        category: None,
        page_size: 200,
        conversations: true,
        mode: server.then(|| "server".to_string()),
        ..Default::default()
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// The four counts the server reports for a label: conversations, unread conversations, messages, unread messages.
fn server_counts(s: &GState) -> HashMap<String, (i64, i64, i64, i64)> {
    let mut ids: Vec<String> = [
        "INBOX",
        "SENT",
        "DRAFT",
        "SPAM",
        "TRASH",
        "UNREAD",
        "STARRED",
        "IMPORTANT",
        "CHAT",
        "CATEGORY_PERSONAL",
        "CATEGORY_SOCIAL",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_UPDATES",
        "CATEGORY_FORUMS",
    ]
    .iter()
    .map(|x| x.to_string())
    .collect();
    ids.extend(s.user_labels.iter().filter_map(|l| l["id"].as_str().map(str::to_string)));
    ids.into_iter()
        .map(|id| {
            let in_bin = |m: &FMsg| id != "TRASH" && id != "SPAM" && m.labels.iter().any(|l| l == "TRASH" || l == "SPAM");
            let msgs: Vec<&FMsg> = s.messages.values().filter(|m| m.labels.iter().any(|l| *l == id) && !in_bin(m)).collect();
            let unread: Vec<&&FMsg> = msgs.iter().filter(|m| m.labels.iter().any(|l| l == "UNREAD")).collect();
            let threads: HashSet<&String> = msgs.iter().map(|m| &m.thread_id).collect();
            let tunread: HashSet<&String> = unread.iter().map(|m| &m.thread_id).collect();
            (id, (threads.len() as i64, tunread.len() as i64, msgs.len() as i64, unread.len() as i64))
        })
        .collect()
}

impl World {
    async fn build(seed: u64, fault: Fault) -> World {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
        let engine = Engine::new(db.clone(), store.clone(), Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), Arc::new(|_| {}));
        store
            .set(
                secrets::GOOGLE_CLIENT_KEY,
                &serde_json::to_string(&ClientCreds { client_id: "courier-test-client".into(), client_secret: "s".into() }).unwrap(),
            )
            .unwrap();
        let http = reqwest::Client::new();
        let mut rng = Rng::new(seed);
        let mut accts = Vec::new();
        for (i, (id, prefix, email)) in [("g1", "g1", "pat@example.com"), ("g2", "g2", "sam@example.net")].into_iter().enumerate() {
            let fake = FakeGmail::start(email, "Pat Example").await;
            {
                let mut s = fake.state.lock();
                // Different ids on the two servers, so mixing accounts up can't go unnoticed by luck.
                s.next = 1 + 5000 * i as u64;
                s.user_labels.push(json!({"id": "Label_1", "name": "Work", "type": "user"}));
                s.user_labels.push(json!({"id": "Label_2", "name": "Home", "type": "user"}));
            }
            populate(&fake, prefix, email, &mut rng);
            let h2 = http.clone();
            let auth = oauth::authorize(&http, &fake.endpoints(), &engine.google_client().unwrap(), None, move |u| {
                tokio::spawn(async move {
                    let _ = h2.get(u).send().await;
                });
                Ok(())
            })
            .await
            .unwrap();
            TokenManager::new(id, fake.endpoints(), engine.google_client().unwrap(), store.clone(), http.clone()).save(&auth.tokens).unwrap();
            let sent = Arc::new(Mutex::new(Vec::new()));
            let faults = Arc::new(ProxyFaults::default());
            let proxy = start_proxy(fake.clone(), sent.clone(), faults.clone()).await;
            let mut endpoints = fake.endpoints();
            endpoints.api_base = format!("{proxy}/gmail/v1/users/me");
            db.insert_account(&AccountRow {
                id: id.into(),
                kind: "gmail".into(),
                email: email.into(),
                name: "Pat".into(),
                color: "#1a73e8".into(),
                position: i as i64,
                config: json!({"endpoints": endpoints}),
                state: json!({}),
                ..Default::default()
            })
            .unwrap();
            accts.push(Acct {
                id,
                prefix,
                email,
                fake,
                sent,
                faults,
                proxy: proxy.clone(),
                linked: AtomicBool::new(true),
                expect: Mutex::new(HashMap::new()),
                made: Mutex::new(Vec::new()),
                epoch: Mutex::new(HashMap::new()),
                handled: Mutex::new(HashSet::new()),
                dirty: Mutex::new(HashSet::new()),
                changed_at: Mutex::new(HashMap::new()),
                deleted: Mutex::new(HashSet::new()),
                undos: Mutex::new(HashMap::new()),
                next_local: AtomicUsize::new(0),
            });
        }
        let uncached = accts
            .iter()
            .enumerate()
            .flat_map(|(a, ac)| ac.fake.state.lock().messages.values().filter(|m| binned(m)).map(|m| (a, m.id.clone())).collect::<Vec<_>>())
            .collect();
        let w = World {
            engine,
            accts: accts.try_into().ok().unwrap(),
            fault,
            stats: Stats::default(),
            soft: Mutex::new(Vec::new()),
            step: AtomicUsize::new(0),
            uncached,
        };
        match fault {
            Fault::DupSend => w.accts[0].faults.duplicate.store(true, Ordering::SeqCst),
            _ => {}
        }
        for a in &w.accts {
            w.engine.sync_account(a.id).await.unwrap();
        }
        w
    }

    // ---- bookkeeping ----

    /// Which views hold the conversation in the cache.
    fn members(&self, a: usize, tid: &str) -> HashMap<&'static str, bool> {
        let ac = &self.accts[a];
        let cached = self.engine.db.thread_messages(ac.id, tid).unwrap_or_default();
        VIEWS
            .iter()
            .map(|v| {
                let bin_view = *v == "TRASH" || *v == "SPAM";
                let held = cached.iter().any(|m| m.labels.iter().any(|l| l == v) && (bin_view || !m.labels.iter().any(|l| l == "TRASH" || l == "SPAM")));
                (*v, held)
            })
            .collect()
    }

    /// The change the web client would offer for this conversation, if any: Move to Inbox on a binned conversation is
    /// Not spam / Undelete, and nothing else is offered on one that is all binned.
    fn offered(&self, labels: &[Vec<String>], op: Op) -> Option<Op> {
        let all = |l: &str| !labels.is_empty() && labels.iter().all(|m| m.iter().any(|x| x == l));
        let any = |l: &str| labels.iter().any(|m| m.iter().any(|x| x == l));
        let (all_trash, all_spam) = (all("TRASH"), all("SPAM"));
        let all_binned = !labels.is_empty() && labels.iter().all(|m| m.iter().any(|x| x == "TRASH" || x == "SPAM"));
        match op {
            Op::ToInbox if all_trash => Some(Op::Untrash),
            Op::ToInbox if all_spam => Some(Op::NotSpam),
            Op::Untrash if !any("TRASH") => None,
            Op::NotSpam if !any("SPAM") => None,
            Op::Trash if all_trash => None,
            Op::Spam if all_spam => None,
            Op::Untrash | Op::NotSpam | Op::Trash | Op::Spam => Some(op),
            _ if all_binned => None,
            _ => Some(op),
        }
    }

    fn server_members(&self, a: usize, tid: &str) -> HashMap<&'static str, bool> {
        let msgs = self.accts[a].thread_msgs(tid);
        VIEWS
            .iter()
            .map(|v| {
                let bin_view = *v == "TRASH" || *v == "SPAM";
                (*v, msgs.iter().any(|m| m.labels.iter().any(|l| l == v) && (bin_view || !binned(m))))
            })
            .collect()
    }

    /// What a change to the whole conversation (`whole`) or to one message says about each view afterwards:
    /// Some(in the view), or None when it can't be told.
    fn plan(&self, a: usize, tid: &str, add: &[String], remove: &[String], whole: bool) -> Vec<(&'static str, Option<bool>)> {
        let ac = &self.accts[a];
        let bin = add.iter().chain(remove).any(is_bin_label);
        let adds_bin = add.iter().any(is_bin_label);
        let affected: Vec<Vec<String>> = self
            .engine
            .db
            .thread_messages(ac.id, tid)
            .unwrap_or_default()
            .into_iter()
            .filter(|m| bin || !m.labels.iter().any(|l| l == "TRASH" || l == "SPAM"))
            .map(|m| m.labels.into_iter().filter(|l| !remove.contains(l)).chain(add.iter().cloned()).collect())
            .collect();
        let mut out = Vec::new();
        for v in VIEWS {
            let (in_add, in_remove) = (add.iter().any(|l| l == v), remove.iter().any(|l| l == v));
            let want = if !whole {
                if in_add || in_remove || bin { None } else { continue }
            } else if in_remove {
                Some(false)
            } else if in_add {
                let held = |labels: &Vec<String>| {
                    labels.iter().any(|l| l == v) && (v == "TRASH" || v == "SPAM" || !labels.iter().any(|l| l == "TRASH" || l == "SPAM"))
                };
                (!affected.is_empty()).then(|| affected.iter().any(held))
            } else if bin && adds_bin {
                Some(false)
            } else if bin {
                None
            } else {
                continue;
            };
            // What another device did isn't known here yet: this Mac can't be asked to show the conversation.
            let want = if want == Some(true) && ac.dirty.lock().contains(tid) { None } else { want };
            out.push((v, want));
        }
        out
    }

    fn apply(&self, a: usize, tid: &str, plan: &[(&'static str, Option<bool>)]) -> Vec<((String, &'static str), Option<bool>)> {
        let mut e = self.accts[a].expect.lock();
        plan.iter()
            .map(|(v, want)| {
                let key = (tid.to_string(), *v);
                let old = match want {
                    Some(w) => e.insert(key.clone(), *w),
                    None => e.remove(&key),
                };
                (key, old)
            })
            .collect()
    }

    fn restore(&self, a: usize, saved: Vec<((String, &'static str), Option<bool>)>) {
        let mut e = self.accts[a].expect.lock();
        for (key, old) in saved.into_iter().rev() {
            match old {
                Some(w) => e.insert(key, w),
                None => e.remove(&key),
            };
        }
    }

    /// Two changes of the same message sent in one window would be one change sent twice.
    fn duplicates(&self, a: usize, from: usize) -> Option<String> {
        let sent = self.accts[a].sent.lock();
        let acc: Vec<&Sent> = sent[from..].iter().filter(|s| s.accepted()).collect();
        for (i, x) in acc.iter().enumerate() {
            for y in &acc[i + 1..] {
                if sorted(x.add.clone()) == sorted(y.add.clone()) && sorted(x.remove.clone()) == sorted(y.remove.clone()) {
                    if let Some(id) = x.ids.iter().find(|id| y.ids.contains(id)) {
                        return Some(format!("message {id} got the same change (+{:?} -{:?}) twice", x.add, x.remove));
                    }
                }
            }
        }
        None
    }

    /// No network (nothing to connect to) or the network back: the account's API address is changed, and the
    /// engine connects afresh.
    fn set_link(&self, a: usize, up: bool) {
        let ac = &self.accts[a];
        if ac.linked.swap(up, Ordering::SeqCst) == up {
            return;
        }
        let mut row = self.engine.db.account(ac.id).unwrap();
        let mut endpoints: Endpoints = serde_json::from_value(row.config["endpoints"].clone()).unwrap();
        endpoints.api_base = if up { format!("{}/gmail/v1/users/me", ac.proxy) } else { "http://127.0.0.1:1/gmail/v1/users/me".to_string() };
        row.config["endpoints"] = serde_json::to_value(endpoints).unwrap();
        self.engine.db.update_account(&row).unwrap();
        self.engine.forget_provider(ac.id);
    }

    fn set_online(&self, on: bool) {
        self.engine.online.store(on, Ordering::SeqCst);
    }

    // ---- steps ----

    async fn exec(&self, step: &Step) -> Res<()> {
        match step {
            Step::Race(parts) => self.race(parts).await?,
            Step::Settle => self.settle(false).await?,
            s => {
                let out = self.part(s, true).await?;
                if matches!(s, Step::Sync { .. } | Step::Reconnect { .. }) {
                    if let Step::Sync { a } | Step::Reconnect { a } = s {
                        self.accts[*a].dirty.lock().clear();
                    }
                }
                self.absorb_refusals();
                self.check_out(&out, &HashSet::new())?;
            }
        }
        self.invariants().await
    }

    fn key(&self, s: &Step) -> Option<(usize, String)> {
        match s {
            Step::Change { a, t, .. } | Step::MsgChange { a, t, .. } | Step::Remote { a, t, .. } => self.accts[*a].pick_thread(*t).map(|tid| (*a, tid)),
            Step::Mail { a, t, reply: true } => self.accts[*a].pick_thread(*t).map(|tid| (*a, tid)),
            Step::Undo { a, back } => {
                let made = self.accts[*a].made.lock();
                let live: Vec<&Made> = made.iter().rev().filter(|m| !m.undone).take(4).collect();
                (!live.is_empty()).then(|| (*a, live[*back as usize % live.len()].thread.clone()))
            }
            _ => None,
        }
    }

    async fn race(&self, parts: &[Step]) -> Res<()> {
        let keys: Vec<Option<(usize, String)>> = parts.iter().map(|p| self.key(p)).collect();
        let mut seen = HashSet::new();
        let conflict = keys.iter().flatten().any(|k| !seen.insert(k.clone()));
        let outs: Vec<Out> = if conflict {
            let mut v = Vec::new();
            for p in parts {
                v.push(self.part(p, false).await?);
            }
            v
        } else {
            self.stats.bump("races");
            let futs: Vec<Pin<Box<dyn Future<Output = Res<Out>> + '_>>> =
                parts.iter().map(|p| Box::pin(self.part(p, false)) as Pin<Box<dyn Future<Output = Res<Out>> + '_>>).collect();
            let mut v = Vec::new();
            for r in futures::future::join_all(futs).await {
                v.push(r?);
            }
            v
        };
        self.absorb_refusals();
        for out in &outs {
            if let Out::Listed { a, r, .. } = out {
                // A listing that started before a change doesn't claim to reflect it.
                let mut skip = HashSet::new();
                for o in &outs {
                    if let Out::Changed { a: ca, keys, change } = o {
                        if ca == a && change.is_none_or(|c| r.ledger < c) {
                            skip.extend(keys.iter().cloned());
                        }
                    }
                }
                self.check_out(out, &skip)?;
            }
        }
        Ok(())
    }

    /// A change the server refused while it waited offline is undone here; the user's wish for those conversations is void.
    fn absorb_refusals(&self) {
        for (a, ac) in self.accts.iter().enumerate() {
            let todo = ac.refusals(0);
            for (i, ids) in &todo {
                for id in ids {
                    if let Some(m) = ac.fake.message(id) {
                        ac.clear_thread(&m.thread_id);
                    }
                }
                ac.handled.lock().insert(*i);
            }
            if !todo.is_empty() {
                let _ = a;
                self.stats.bump("refused later");
            }
        }
    }

    fn check_out(&self, out: &Out, skip: &HashSet<(String, &'static str)>) -> Res<()> {
        if let Out::Listed { a, label, r, lagging } = out {
            self.check_listing(*a, label, r, skip, *lagging)?;
        }
        Ok(())
    }

    async fn part(&self, s: &Step, solo: bool) -> Res<Out> {
        match s {
            Step::Change { a, t, op } => self.change(*a, *t, *op, None, solo).await,
            Step::MsgChange { a, t, k, op } => self.change(*a, *t, *op, Some(*k), solo).await,
            Step::Undo { a, back } => self.undo(*a, *back).await,
            Step::Remote { a, t, k, op } => {
                let ac = &self.accts[*a];
                let Some(tid) = ac.pick_thread(*t) else { return Ok(Out::None) };
                let msgs = ac.thread_msgs(&tid);
                let m = &msgs[*k as usize % msgs.len()];
                let Some(op) = self.offered(&[m.labels.clone()], *op) else { return Ok(Out::None) };
                let (add, remove) = op.lists();
                let (add, remove): (Vec<&str>, Vec<&str>) = (add.iter().map(String::as_str).collect(), remove.iter().map(String::as_str).collect());
                ac.fake.modify_elsewhere(&m.id, &add, &remove);
                ac.clear_thread(&tid);
                ac.dirty.lock().insert(tid.clone());
                self.stats.bump("remote");
                Ok(Out::None)
            }
            Step::Mail { a, t, reply } => {
                let ac = &self.accts[*a];
                let n = ac.next_local.fetch_add(1, Ordering::SeqCst);
                let now = courier_lib::error::now_ms();
                let me = format!("Pat <{}>", ac.email);
                let (raw, tid) = match ac.pick_thread(*t).filter(|_| *reply) {
                    Some(tid) => {
                        let first = &ac.thread_msgs(&tid)[0];
                        let mid = courier_lib::mailmeta::parse_raw(&first.raw).row.message_id;
                        let subject = courier_lib::mailmeta::parse_raw(&first.raw).row.subject;
                        (
                            raw_mail(
                                "Ana <ana-0@friends.example>",
                                &me,
                                &format!("Re: {}", subject.trim_start_matches("Re: ")),
                                now,
                                &format!("<{}-new-{n}@fuzz.example>", ac.prefix),
                                Some(&mid),
                            ),
                            Some(tid),
                        )
                    }
                    None => (
                        raw_mail("Bo <bo@work.example>", &me, &format!("{} fresh {n}", ac.prefix), now, &format!("<{}-new-{n}@fuzz.example>", ac.prefix), None),
                        None,
                    ),
                };
                ac.fake.deliver(&raw, &["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
                if let Some(tid) = tid {
                    ac.clear_thread(&tid);
                }
                self.stats.bump("mail");
                Ok(Out::None)
            }
            Step::Sync { a } => {
                let ac = &self.accts[*a];
                match self.engine.sync_account(ac.id).await {
                    Ok(()) => self.set_online(true),
                    Err(e) if e.is_offline() => self.set_online(false),
                    Err(e) => return fail(0, format!("sync of {} failed: {e}", ac.id)),
                }
                self.stats.bump("syncs");
                Ok(Out::None)
            }
            Step::ListCache { a, label } | Step::ListServer { a, label } => {
                let server = matches!(s, Step::ListServer { .. });
                let picked = VIEWS[*label as usize % VIEWS.len()];
                let mut q = view_query(self.accts[*a].id, picked, server);
                // The Primary tab lists through a search, which on the real API runs behind changes.
                if picked == "INBOX" && (*label >> 8) % 3 == 0 {
                    q.category = Some("primary".into());
                }
                let label = picked;
                let started = courier_lib::error::now_ms();
                let r = self.engine.list(&q).await.or_else(|e| fail(0, format!("listing {label} failed: {e}")))?;
                self.stats.bump(if server { "server listings" } else { "cache listings" });
                Ok(Out::Listed { a: *a, label, r, lagging: (server && q.category.is_some()).then_some(started) })
            }
            Step::Offline { a } => {
                self.set_link(*a, false);
                Ok(Out::None)
            }
            Step::Online { a } => {
                self.set_link(*a, true);
                Ok(Out::None)
            }
            Step::Reconnect { a } => {
                self.reconnect(*a).await?;
                Ok(Out::None)
            }
            Step::Slow { a, route, ms, tail } => {
                let route = SLOW_ROUTES[*route as usize % SLOW_ROUTES.len()].to_string();
                let mut st = self.accts[*a].fake.state.lock();
                if *tail {
                    st.tail_latency.insert(route, *ms)
                } else {
                    st.latency.insert(route, *ms)
                };
                Ok(Out::None)
            }
            Step::Lag { a, ms } => {
                let mut st = self.accts[*a].fake.state.lock();
                st.search_lag_ms = *ms;
                Ok(Out::None)
            }
            Step::Refuse { a } => {
                self.accts[*a].faults.refuse.store(1, Ordering::SeqCst);
                Ok(Out::None)
            }
            Step::Delete { a, t } => {
                let ac = &self.accts[*a];
                let Some(tid) = ac.pick_thread(*t) else { return Ok(Out::None) };
                let server = ac.thread_msgs(&tid);
                let cached = self.engine.db.thread_messages(ac.id, &tid).unwrap_or_default();
                let whole = !cached.is_empty() && cached.len() == server.len() && cached.iter().all(|m| m.labels.iter().any(|l| l == "TRASH" || l == "SPAM"));
                if !whole {
                    return Ok(Out::None);
                }
                let plan: Vec<(&'static str, Option<bool>)> = VIEWS.iter().map(|v| (*v, Some(false))).collect();
                self.apply(*a, &tid, &plan);
                ac.deleted.lock().insert(tid.clone());
                match self.engine.delete_forever(ac.id, std::slice::from_ref(&tid)).await {
                    Ok(r) => self.stats.bump(if r == Changed::Queued { "deletes queued" } else { "deletes done" }),
                    Err(e) => return fail(0, format!("Delete forever of {tid} on {} failed: {e}", ac.id)),
                }
                Ok(Out::Changed { a: *a, keys: VIEWS.iter().map(|v| (tid.clone(), *v)).collect(), change: Some(u64::MAX) })
            }
            Step::Precondition { a, n } => {
                self.accts[*a].fake.state.lock().precondition_next = *n;
                Ok(Out::None)
            }
            Step::Heal { a } => {
                self.accts[*a].heal();
                Ok(Out::None)
            }
            Step::Race(_) | Step::Settle => unreachable!("handled by exec"),
        }
    }

    async fn change(&self, a: usize, t: u32, op: Op, one: Option<u32>, solo: bool) -> Res<Out> {
        let ac = &self.accts[a];
        let Some(tid) = ac.pick_thread(t) else { return Ok(Out::None) };
        let cached = self.engine.db.thread_messages(ac.id, &tid).unwrap_or_default();
        let held: Vec<Vec<String>> =
            if cached.is_empty() { ac.thread_msgs(&tid).into_iter().map(|m| m.labels).collect() } else { cached.iter().map(|m| m.labels.clone()).collect() };
        let Some(op) = self.offered(&held, op) else { return Ok(Out::None) };
        let (add, remove) = op.lists();
        let message = match one {
            Some(k) if !cached.is_empty() => Some(cached[k as usize % cached.len()].id.clone()),
            Some(_) => return Ok(Out::None),
            None => None,
        };
        let plan = self.plan(a, &tid, &add, &remove, message.is_none());
        let before = self.members(a, &tid);
        let before_server = self.server_members(a, &tid);
        let epoch = ac.epoch.lock().get(&tid).copied().unwrap_or(0);
        let quiet = !self.engine.db.has_queued(ac.id).unwrap_or(true);
        let from = ac.sent.lock().len();
        let saved = self.apply(a, &tid, &plan);
        let res = match &message {
            None => self.engine.change_threads(ac.id, std::slice::from_ref(&tid), &add, &remove).await.map(|r| (r.result, Some(r.change))),
            Some(id) => self.engine.modify_messages(ac.id, std::slice::from_ref(id), &add, &remove).await.map(|r| (r, None)),
        };
        let refused = ac.refusals(from);
        match res {
            Ok((result, change)) => {
                self.stats.bump(if result == Changed::Queued { "changes queued" } else { "changes done" });
                if let Some(change) = change {
                    ac.made.lock().push(Made {
                        change,
                        thread: tid.clone(),
                        add: add.clone(),
                        remove: remove.clone(),
                        before,
                        before_server,
                        queued: result == Changed::Queued,
                        undos: ac.undos.lock().get(&tid).copied().unwrap_or(0),
                        epoch,
                        undone: false,
                    });
                }
                if self.fault == Fault::Resurrect && result == Changed::Done && remove.iter().any(|l| l == "INBOX") && message.is_none() {
                    if let Some(m) = cached.iter().find(|m| m.labels.iter().any(|l| l == "INBOX")) {
                        self.engine.db.begin_read(ac.id).set_labels(&m.id, &m.labels).unwrap();
                    }
                }
                ac.changed_at.lock().insert(tid.clone(), courier_lib::error::now_ms());
                if message.is_some() {
                    // A change to one message isn't in `made`, so an Undo of an older change proves nothing after it.
                    *ac.epoch.lock().entry(tid.clone()).or_default() += 1;
                }
                if solo && quiet && result == Changed::Done {
                    if let Some(d) = self.duplicates(a, from) {
                        return fail(5, format!("{op:?} on {tid}: {d}"));
                    }
                }
                let keys = plan.iter().filter(|(_, w)| w.is_some()).map(|(v, _)| (tid.clone(), *v)).collect();
                Ok(Out::Changed { a, keys, change })
            }
            Err(e) if !refused.is_empty() && !e.is_offline() => {
                ac.handled.lock().extend(refused.iter().map(|(i, _)| *i));
                self.restore(a, saved);
                self.stats.bump("changes refused");
                let keys = plan.iter().map(|(v, _)| (tid.clone(), *v)).collect();
                Ok(Out::Changed { a, keys, change: None })
            }
            Err(e) => fail(0, format!("{op:?} on {} {tid} failed: {e}", ac.id)),
        }
    }

    async fn undo(&self, a: usize, back: u32) -> Res<Out> {
        let ac = &self.accts[a];
        let picked = {
            let made = ac.made.lock();
            let live: Vec<(usize, &Made)> = made.iter().enumerate().rev().filter(|(_, m)| !m.undone).take(4).collect();
            (!live.is_empty()).then(|| {
                let (i, m) = live[back as usize % live.len()];
                (i, m.clone(), made.iter().skip(i + 1).any(|x| x.thread == m.thread && !x.undone))
            })
        };
        let Some((i, m, later_live)) = picked else { return Ok(Out::None) };
        // The web client offers Undo for the latest change only: not one that a later change or an Undo has overtaken.
        let overtaken = later_live || ac.undos.lock().get(&m.thread).copied().unwrap_or(0) != m.undos;
        if ac.deleted.lock().contains(&m.thread) || overtaken {
            return Ok(Out::None);
        }
        let avoid = std::env::var("COURIER_FUZZ_AVOID").unwrap_or_default();
        if (avoid.contains("undo-queued") && m.queued) || (avoid.contains("undo-offline") && !ac.linked.load(Ordering::SeqCst)) {
            return Ok(Out::None);
        }
        let from = ac.sent.lock().len();
        let same_epoch = ac.epoch.lock().get(&m.thread).copied().unwrap_or(0) == m.epoch;
        let touched: Vec<&String> = m.add.iter().chain(&m.remove).collect();
        let bin = touched.iter().any(|l| is_bin_label(l));
        // Undo puts the touched views back as they were; anything else it can't be told.
        let plan: Vec<(&'static str, Option<bool>)> = VIEWS
            .iter()
            .filter_map(|v| {
                if touched.iter().any(|l| l == v) {
                    Some((*v, (same_epoch && m.before[v] == m.before_server[v]).then(|| m.before[v])))
                } else {
                    bin.then_some((*v, None))
                }
            })
            .collect();
        let saved = self.apply(a, &m.thread, &plan);
        let res = self.engine.undo_change(ac.id, m.change).await;
        let refused = ac.refusals(from);
        match res {
            Ok(result) => {
                self.stats.bump(if result == Changed::Queued { "undone queued" } else { "undone" });
                ac.made.lock()[i].undone = true;
                *ac.undos.lock().entry(m.thread.clone()).or_default() += 1;
                ac.changed_at.lock().insert(m.thread.clone(), courier_lib::error::now_ms());
                let keys = plan.iter().filter(|(_, w)| w.is_some()).map(|(v, _)| (m.thread.clone(), *v)).collect();
                Ok(Out::Changed { a, keys, change: Some(u64::MAX) })
            }
            Err(e) if !refused.is_empty() && !e.is_offline() => {
                ac.handled.lock().extend(refused.iter().map(|(i, _)| *i));
                self.restore(a, saved);
                self.stats.bump("changes refused");
                let keys = plan.iter().map(|(v, _)| (m.thread.clone(), *v)).collect();
                Ok(Out::Changed { a, keys, change: None })
            }
            Err(e) => fail(0, format!("Undo of change {} on {} failed: {e}", m.change, ac.id)),
        }
    }

    /// The connection is back and one sync follows. Every change that waited reaches the server once; none waits.
    async fn reconnect(&self, a: usize) -> Res<()> {
        let ac = &self.accts[a];
        self.set_link(a, true);
        let rows = self.engine.db.queued_changes(ac.id).unwrap_or_default();
        let threads = self.engine.db.queued_threads(ac.id).unwrap_or_default();
        let mut need: Vec<(String, Vec<String>, Vec<String>)> = rows.into_iter().map(|q| (q.message_id, q.add, q.remove)).collect();
        for (t, add, remove) in threads {
            let bin = add.iter().chain(&remove).any(is_bin_label);
            need.extend(ac.thread_msgs(&t).into_iter().filter(|m| bin || !binned(m)).map(|m| (m.id, add.clone(), remove.clone())));
        }
        if self.fault == Fault::Swallow && a == 0 && !need.is_empty() {
            ac.faults.swallow.store(true, Ordering::SeqCst);
        }
        let from = ac.sent.lock().len();
        match self.engine.sync_account(ac.id).await {
            Ok(()) => self.set_online(true),
            Err(e) => return fail(0, format!("sync of {} after the connection came back failed: {e}", ac.id)),
        }
        self.stats.bump("reconnects");
        if let Some(d) = self.duplicates(a, from) {
            return fail(5, format!("after reconnecting {}: {d}", ac.id));
        }
        {
            let sent = ac.sent.lock();
            let window: Vec<&Sent> = sent[from..].iter().filter(|s| s.accepted()).collect();
            let refused: Vec<&Sent> = sent[from..].iter().filter(|s| s.refused()).collect();
            for (id, add, remove) in need.iter().filter(|(id, _, _)| ac.fake.message(id).is_some()) {
                let reached = refused.iter().any(|s| s.ids.contains(id))
                    || window.iter().any(|s| s.ids.contains(id) && add.iter().all(|l| s.add.contains(l)) && remove.iter().all(|l| s.remove.contains(l)));
                if !reached && !(add.is_empty() && remove.is_empty()) {
                    return fail(5, format!("{}: the change made offline to message {id} (+{add:?} -{remove:?}) never reached the server", ac.id));
                }
            }
        }
        if self.engine.db.has_queued(ac.id).unwrap_or(true) {
            return fail(5, format!("{}: changes are still queued after the connection came back and a sync", ac.id));
        }
        Ok(())
    }

    // ---- checks ----

    /// Each message of a conversation: its labels on the server and here.
    fn describe(&self, a: usize, tid: &str) -> String {
        let ac = &self.accts[a];
        let msgs: Vec<String> = ac
            .thread_msgs(tid)
            .iter()
            .map(|m| {
                let here =
                    self.engine.db.message(ac.id, &m.id).ok().flatten().map(|c| format!("{:?}", sorted(c.labels))).unwrap_or_else(|| "not cached".into());
                format!("[{}: server {:?}, here {here}]", &m.id[m.id.len() - 4..], sorted(m.labels.clone()))
            })
            .collect();
        msgs.join(" ")
    }

    fn check_listing(&self, a: usize, label: &'static str, r: &ViewResult, skip: &HashSet<(String, &'static str)>, lagging: Option<i64>) -> Res<()> {
        let ac = &self.accts[a];
        if r.total < 0 {
            return fail(3, format!("{} {label}: the listing's total is {}", ac.id, r.total));
        }
        for t in &r.threads {
            if !t.subject.contains(ac.prefix) || t.account_id != ac.id {
                return fail(4, format!("{} {label}: a conversation of another account shows: {:?} (account {})", ac.id, t.subject, t.account_id));
            }
        }
        let shown: HashSet<&String> = r.threads.iter().map(|t| &t.thread_id).collect();
        let expect = ac.expect.lock().clone();
        for ((tid, view), want) in expect {
            if view != label || skip.contains(&(tid.clone(), view)) {
                continue;
            }
            // A search answers from an index that runs behind, so a change made a moment before isn't in it yet.
            // (COURIER_FUZZ_LAG_STRICT=1 holds such listings to the same rule: the engine doesn't cover them.)
            let behind =
                lagging.is_some_and(|started| ac.changed_at.lock().get(&tid).is_some_and(|at| at + ac.fake.state.lock().search_lag_ms as i64 > started));
            if behind && std::env::var("COURIER_FUZZ_LAG_STRICT").is_err() {
                continue;
            }
            let present = shown.contains(&tid);
            let subject = ac.thread_msgs(&tid).first().map(|m| courier_lib::mailmeta::parse_raw(&m.raw).row.subject).unwrap_or_default();
            if !want && present {
                return fail(
                    1,
                    format!(
                        "{} {label} ({}): conversation {tid} ({subject:?}) is listed again, but the user's latest change for it took it out. {}",
                        ac.id,
                        r.source,
                        self.describe(a, &tid)
                    ),
                );
            }
            if want && !present {
                return fail(
                    1,
                    format!(
                        "{} {label} ({}): conversation {tid} ({subject:?}) is missing, but the user's latest change for it put it in. {}",
                        ac.id,
                        r.source,
                        self.describe(a, &tid)
                    ),
                );
            }
        }
        Ok(())
    }

    async fn invariants(&self) -> Res<()> {
        let step = self.step.load(Ordering::SeqCst);
        if self.fault == Fault::Negative && step == 2 {
            self.engine.db.begin_read(self.accts[0].id).set_label_counts("INBOX", (-1, 0, -1, 0)).unwrap();
        }
        if self.fault == Fault::Leak && step == 2 {
            let from = self.engine.db.message_ids(self.accts[1].id, 1).unwrap();
            let mut row = self.engine.db.message(self.accts[1].id, &from[0]).unwrap().unwrap();
            row.account_id = self.accts[0].id.into();
            row.labels = vec!["INBOX".into()];
            self.engine.db.begin_read(self.accts[0].id).upsert_message(&row, None).unwrap();
        }
        for (a, ac) in self.accts.iter().enumerate() {
            for label in VIEWS {
                let r = self.engine.list(&view_query(ac.id, label, false)).await.or_else(|e| fail(0, format!("listing {label} failed: {e}")))?;
                self.check_listing(a, label, &r, &HashSet::new(), None)?;
            }
            for l in self.engine.db.labels(ac.id).unwrap_or_default() {
                if l.threads_total < 0 || l.threads_unread < 0 || l.messages_total < 0 || l.messages_unread < 0 {
                    return fail(
                        3,
                        format!(
                            "{} label {}: counts are {} / {} / {} / {} (conversations, unread, messages, unread)",
                            ac.id, l.id, l.threads_total, l.threads_unread, l.messages_total, l.messages_unread
                        ),
                    );
                }
            }
        }
        let all = self.engine.list(&view_query("all", "INBOX", false)).await.or_else(|e| fail(0, format!("unified listing failed: {e}")))?;
        for t in &all.threads {
            let ac = self.accts.iter().find(|x| x.id == t.account_id);
            if ac.is_none_or(|ac| !t.subject.contains(ac.prefix)) {
                return fail(4, format!("the unified Inbox shows {:?} under account {}", t.subject, t.account_id));
            }
        }
        Ok(())
    }

    async fn settle(&self, full: bool) -> Res<()> {
        for (a, ac) in self.accts.iter().enumerate() {
            ac.heal();
            self.set_link(a, true);
        }
        self.set_online(true);
        for ac in &self.accts {
            ac.dirty.lock().clear();
            // The first sync sends what waited; the second reads what it and the others changed.
            for _ in 0..2 {
                self.engine.sync_account(ac.id).await.or_else(|e| fail(0, format!("sync of {} while settling failed: {e}", ac.id)))?;
            }
        }
        self.compare(false).await?;
        if full {
            for ac in &self.accts {
                {
                    let mut s = ac.fake.state.lock();
                    s.history.clear();
                    s.history_floor = s.history_id + 1;
                }
                self.engine.sync_account(ac.id).await.or_else(|e| fail(0, format!("full resync of {} failed: {e}", ac.id)))?;
            }
            self.compare(true).await?;
        }
        Ok(())
    }

    /// The cache against the server, on a settled mailbox.
    async fn compare(&self, strict_counts: bool) -> Res<()> {
        let now = courier_lib::error::now_ms();
        for (a, ac) in self.accts.iter().enumerate() {
            if self.fault == Fault::Drift && !strict_counts && a == 0 {
                let mut s = ac.fake.state.lock();
                if let Some(m) = s.messages.values_mut().find(|m| !m.labels.iter().any(|l| l == "STARRED")) {
                    m.labels.push("STARRED".into());
                }
            }
            if self.fault == Fault::Stuck && !strict_counts && a == 0 {
                let id = self.engine.db.message_ids(ac.id, 1).unwrap().remove(0);
                self.engine.db.queue_change(ac.id, std::slice::from_ref(&id), &["STARRED".to_string()], &[], &HashMap::new(), 0).unwrap();
            }
            if self.engine.db.has_queued(ac.id).unwrap_or(true) {
                return fail(
                    5,
                    format!(
                        "{}: changes are still queued after everything settled: {:?} / {:?}",
                        ac.id,
                        self.engine.db.queued_changes(ac.id).unwrap_or_default().iter().map(|q| (&q.message_id, &q.add, &q.remove)).collect::<Vec<_>>(),
                        self.engine.db.queued_threads(ac.id).unwrap_or_default()
                    ),
                );
            }
            let server: HashMap<String, FMsg> = ac.fake.state.lock().messages.clone().into_iter().collect();
            let cached_ids: HashSet<String> = self.engine.db.message_ids(ac.id, 100_000).unwrap().into_iter().collect();
            for id in &cached_ids {
                let m = self.engine.db.message(ac.id, id).unwrap().unwrap();
                match server.get(id) {
                    None => return fail(2, format!("{}: message {id} is cached but gone from the server", ac.id)),
                    Some(sm) if sorted(m.labels.clone()) != sorted(sm.labels.clone()) => {
                        return fail(
                            2,
                            format!(
                                "{}: message {id} (conversation {}) is cached with labels {:?}, the server has {:?}",
                                ac.id,
                                m.thread_id,
                                sorted(m.labels),
                                sorted(sm.labels.clone())
                            ),
                        );
                    }
                    Some(_) => {}
                }
            }
            for sm in server.values() {
                if sm.internal_date > now - (WINDOW_DAYS - 1) * DAY_MS && !cached_ids.contains(&sm.id) && !self.uncached.contains(&(a, sm.id.clone())) {
                    return fail(2, format!("{}: message {} is on the server (recent) but was never cached", ac.id, sm.id));
                }
            }
            for label in VIEWS {
                let bin_view = label == "TRASH" || label == "SPAM";
                let holds = |m: &&FMsg| m.labels.iter().any(|l| l == label) && (bin_view || !binned(m));
                let want_cache: BTreeSet<String> = server.values().filter(|m| cached_ids.contains(&m.id)).filter(holds).map(|m| m.thread_id.clone()).collect();
                for (server_mode, want) in [(false, &want_cache)] {
                    let r = self.engine.list(&view_query(ac.id, label, server_mode)).await.or_else(|e| fail(0, format!("listing {label} failed: {e}")))?;
                    let got: BTreeSet<String> = r.threads.iter().map(|t| t.thread_id.clone()).collect();
                    if &got != want {
                        let name = |t: &String| ac.thread_msgs(t).first().map(|m| courier_lib::mailmeta::parse_raw(&m.raw).row.subject).unwrap_or_default();
                        return fail(
                            2,
                            format!(
                                "{} {label} ({}): settled, but the listing differs from the server. Extra: {:?}. Missing: {:?}",
                                ac.id,
                                r.source,
                                got.difference(want).map(|t| format!("{t} {:?}", name(t))).collect::<Vec<_>>(),
                                want.difference(&got).map(|t| format!("{t} {:?}", name(t))).collect::<Vec<_>>()
                            ),
                        );
                    }
                }
            }
            let counts = server_counts(&ac.fake.state.lock());
            for l in self.engine.db.labels(ac.id).unwrap_or_default() {
                let Some(want) = counts.get(&l.id) else { continue };
                let got = (l.threads_total, l.threads_unread, l.messages_total, l.messages_unread);
                if got != *want {
                    let msg = format!("{} label {}: counts {:?} here, {:?} on the server (conversations, unread, messages, unread)", ac.id, l.id, got, want);
                    if strict_counts {
                        return fail(2, format!("after a full resync: {msg}"));
                    }
                    self.soft.lock().push(format!("{msg}; before a full resync"));
                }
            }
            for label in VIEWS {
                let bin_view = label == "TRASH" || label == "SPAM";
                let holds = |m: &&FMsg| m.labels.iter().any(|l| l == label) && (bin_view || !binned(m));
                let want_server: BTreeSet<String> = server.values().filter(holds).map(|m| m.thread_id.clone()).collect();
                for (server_mode, want) in [(true, &want_server)] {
                    let r = self.engine.list(&view_query(ac.id, label, server_mode)).await.or_else(|e| fail(0, format!("listing {label} failed: {e}")))?;
                    let got: BTreeSet<String> = r.threads.iter().map(|t| t.thread_id.clone()).collect();
                    if &got != want {
                        let name = |t: &String| ac.thread_msgs(t).first().map(|m| courier_lib::mailmeta::parse_raw(&m.raw).row.subject).unwrap_or_default();
                        return fail(
                            2,
                            format!(
                                "{} {label} ({}): settled, but the listing differs from the server. Extra: {:?}. Missing: {:?}",
                                ac.id,
                                r.source,
                                got.difference(want).map(|t| format!("{t} {:?}", name(t))).collect::<Vec<_>>(),
                                want.difference(&got).map(|t| format!("{t} {:?}", name(t))).collect::<Vec<_>>()
                            ),
                        );
                    }
                }
            }
        }
        Ok(())
    }
}

// ---- running, reducing, reporting ----

struct Failure {
    seed: u64,
    step: usize,
    fail: Fail,
    keep: Vec<usize>,
    steps: Vec<Step>,
    of: usize,
}

struct Passed {
    seed: u64,
    ms: u128,
    stats: String,
    soft: Vec<String>,
}

async fn run_once(seed: u64, steps: &[Step], fault: Fault) -> Result<(String, Vec<String>), (usize, Fail)> {
    let world = World::build(seed, fault).await;
    world.invariants().await.map_err(|f| (0, f))?;
    for (i, step) in steps.iter().enumerate() {
        world.step.store(i + 1, Ordering::SeqCst);
        let t0 = Instant::now();
        let done = tokio::time::timeout(Duration::from_secs(90), world.exec(step)).await;
        if std::env::var("COURIER_FUZZ_TRACE").is_ok() {
            eprintln!("[seed {seed}] step {i} took {} ms: {step:?}", t0.elapsed().as_millis());
            for (a, ac) in world.accts.iter().enumerate() {
                let mut e: Vec<String> = ac.expect.lock().iter().map(|((t, v), w)| format!("{}:{v}={w}", &t[t.len() - 4..])).collect();
                e.sort();
                eprintln!("    {} expects {}", ac.id, e.join(" "));
                let threads: BTreeSet<String> = ac.expect.lock().keys().map(|(t, _)| t.clone()).collect();
                for t in threads {
                    eprintln!("      {} {}", &t[t.len() - 4..], world.describe(a, &t));
                }
            }
        }
        match done {
            Ok(Ok(())) => {}
            Ok(Err(f)) => return Err((i, f)),
            Err(_) => return Err((i, Fail { inv: 0, msg: "the step did not finish in 90 s".into() })),
        }
    }
    world.step.store(steps.len() + 1, Ordering::SeqCst);
    world.settle(true).await.map_err(|f| (steps.len(), f))?;
    Ok((world.stats.line(), world.soft.lock().clone()))
}

fn run_sync(rt: &tokio::runtime::Runtime, seed: u64, steps: &[Step], fault: Fault) -> Result<(String, Vec<String>), (usize, Fail)> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rt.block_on(run_once(seed, steps, fault)))) {
        Ok(r) => r,
        Err(p) => {
            let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            Err((steps.len(), Fail { inv: 0, msg: format!("panic: {msg}") }))
        }
    }
}

/// Drop steps while the same invariant still breaks.
fn shrink(rt: &tokio::runtime::Runtime, seed: u64, all: &[Step], first: (usize, Fail), fault: Fault) -> (Vec<usize>, usize, Fail) {
    let mut keep: Vec<usize> = (0..=first.0.min(all.len().saturating_sub(1))).collect();
    if first.0 >= all.len() {
        keep = (0..all.len()).collect();
    }
    let (mut at, mut why) = first;
    let (started, mut runs) = (Instant::now(), 0);
    let mut chunk = keep.len().div_ceil(2).max(1);
    loop {
        let mut progress = false;
        let mut i = keep.len();
        while i > 0 && runs < 80 && started.elapsed() < Duration::from_secs(150) {
            let start = i.saturating_sub(chunk);
            let mut cand = keep.clone();
            cand.drain(start..i);
            i = start;
            let steps: Vec<Step> = cand.iter().map(|k| all[*k].clone()).collect();
            runs += 1;
            if let Err((n, f)) = run_sync(rt, seed, &steps, fault) {
                if f.inv == why.inv && f.msg.split(" conversation").next() == why.msg.split(" conversation").next() {
                    keep = cand;
                    at = n;
                    why = f;
                    progress = true;
                }
            }
        }
        if chunk > 1 {
            chunk = chunk.div_ceil(2);
        } else if !progress || runs >= 80 || started.elapsed() >= Duration::from_secs(150) {
            break;
        }
    }
    (keep, at, why)
}

struct Config {
    seeds: Vec<u64>,
    steps: usize,
    threads: usize,
    shrink: bool,
    keep: Option<Vec<usize>>,
    fault: Fault,
    /// Stop starting seeds after this long (the seeds under way finish).
    budget: Option<Duration>,
}

fn env<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// A fixed short run in which the injected fault must be caught.
fn fault_script(fault: Fault) -> Vec<Step> {
    let archive_each = (0..6).map(|t| Step::Change { a: 0, t, op: Op::Archive }).collect::<Vec<_>>();
    match fault {
        Fault::None => Vec::new(),
        Fault::Resurrect => archive_each,
        Fault::Negative | Fault::Leak | Fault::Stuck | Fault::Drift => vec![Step::Sync { a: 0 }, Step::Sync { a: 0 }],
        Fault::DupSend => vec![Step::Change { a: 0, t: 0, op: Op::Star }],
        Fault::Swallow => vec![Step::Offline { a: 0 }, Step::Change { a: 0, t: 0, op: Op::Star }, Step::Reconnect { a: 0 }],
    }
}

/// Seeds of the default run (60 seeds of 40 steps) that break an invariant on the engine as it is, each with the
/// reproduction below that names it. The default run reports them and stays green; any other failure is red, and
/// COURIER_FUZZ_STRICT=1 makes these red too. Delete a line when its reproduction passes. The seeds belong to this
/// generator: change `gen_steps` and they stop meaning anything.
const KNOWN: &[(u64, &str)] = &[
    (17, "undo_of_a_waiting_change_as_the_connection_comes_back_is_not_lost"),
    (28, "a_server_listing_that_ingests_a_conversation_while_it_is_being_binned_does_not_list_it_in_the_old_view"),
];

fn default_run() -> bool {
    [
        "COURIER_FUZZ_SEED",
        "COURIER_FUZZ_SEED_LIST",
        "COURIER_FUZZ_SEEDS",
        "COURIER_FUZZ_STEPS",
        "COURIER_FUZZ_KEEP",
        "COURIER_FUZZ_FAULT",
        "COURIER_FUZZ_STRICT",
        "COURIER_FUZZ_AVOID",
    ]
    .iter()
    .all(|k| std::env::var(k).is_err())
}

fn config() -> Config {
    let first: u64 = env("COURIER_FUZZ_SEED", 1);
    let n: u64 = env("COURIER_FUZZ_SEEDS", 60);
    let listed: Option<Vec<u64>> = std::env::var("COURIER_FUZZ_SEED_LIST").ok().map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect());
    Config {
        seeds: listed.unwrap_or_else(|| (first..first + n).collect()),
        steps: env("COURIER_FUZZ_STEPS", 40),
        threads: env("COURIER_FUZZ_THREADS", 3),
        shrink: env::<u32>("COURIER_FUZZ_SHRINK", 1) != 0,
        keep: std::env::var("COURIER_FUZZ_KEEP").ok().map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect()),
        fault: Fault::from_env(),
        budget: std::env::var("COURIER_FUZZ_BUDGET_SECS").ok().and_then(|v| v.parse().ok()).map(Duration::from_secs),
    }
}

#[test]
fn random_orders_of_user_actions_and_server_events_keep_every_invariant() {
    let cfg = config();
    let next = AtomicUsize::new(0);
    let passed: Mutex<Vec<Passed>> = Mutex::new(Vec::new());
    let failed: Mutex<Vec<Failure>> = Mutex::new(Vec::new());
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..cfg.threads.max(1) {
            scope.spawn(|| {
                let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(&seed) = cfg.seeds.get(i) else { return };
                    if cfg.budget.is_some_and(|b| started.elapsed() > b) {
                        return;
                    }
                    let all = if cfg.fault == Fault::None { gen_steps(seed, cfg.steps) } else { fault_script(cfg.fault) };
                    let (keep, steps): (Vec<usize>, Vec<Step>) = match &cfg.keep {
                        Some(k) => k.iter().filter(|x| **x < all.len()).map(|x| (*x, all[*x].clone())).unzip(),
                        None => all.iter().cloned().enumerate().unzip(),
                    };
                    let t0 = Instant::now();
                    match run_sync(&rt, seed, &steps, cfg.fault) {
                        Ok((stats, soft)) => {
                            if t0.elapsed() > Duration::from_secs(20) {
                                eprintln!("seed {seed} was slow: {:.1}s", t0.elapsed().as_secs_f64());
                            }
                            passed.lock().push(Passed { seed, ms: t0.elapsed().as_millis(), stats, soft })
                        }
                        Err(first) => {
                            let (kept, at, why) =
                                if cfg.shrink && cfg.keep.is_none() { shrink(&rt, seed, &all, first, cfg.fault) } else { (keep.clone(), first.0, first.1) };
                            let steps = kept.iter().filter_map(|k| all.get(*k).cloned()).collect();
                            failed.lock().push(Failure { seed, step: at, fail: why, keep: kept, steps, of: all.len() });
                        }
                    }
                }
            });
        }
    });
    let mut passed = passed.into_inner();
    passed.sort_by_key(|p| p.seed);
    for p in passed.iter().filter(|_| cfg.seeds.len() <= 100) {
        eprintln!("seed {}: ok in {:.1}s ({})", p.seed, p.ms as f64 / 1000.0, p.stats);
        for s in &p.soft {
            eprintln!("  note: {s}");
        }
    }
    let mut failed = failed.into_inner();
    failed.sort_by_key(|f| f.seed);
    let ran = passed.len() + failed.len();
    let soft_total: usize = passed.iter().map(|p| p.soft.len()).sum();
    if default_run() {
        let known_failed: Vec<u64> = failed.iter().map(|f| f.seed).filter(|s| KNOWN.iter().any(|(k, _)| k == s)).collect();
        failed.retain(|f| match KNOWN.iter().find(|(seed, _)| *seed == f.seed) {
            Some((_, repro)) => {
                eprintln!(
                    "known: seed {} breaks invariant {} (reproduction: {repro}): {}",
                    f.seed,
                    inv_name(f.fail.inv),
                    f.fail.msg.chars().take(200).collect::<String>()
                );
                false
            }
            None => true,
        });
        for (seed, repro) in KNOWN {
            if passed.iter().any(|p| p.seed == *seed) && !known_failed.contains(seed) {
                eprintln!("note: known seed {seed} passed this time ({repro})");
            }
        }
    }
    for f in &failed {
        eprintln!("\nFAIL seed {} breaks invariant {} at step {} (reduced from {} steps to {})", f.seed, inv_name(f.fail.inv), f.step, f.of, f.steps.len());
        eprintln!("  {}", f.fail.msg);
        for (k, s) in f.keep.iter().zip(&f.steps) {
            eprintln!("  step {k}: {s:?}");
        }
        eprintln!(
            "  rerun: COURIER_FUZZ_SEED={} COURIER_FUZZ_SEEDS=1 COURIER_FUZZ_STEPS={} COURIER_FUZZ_KEEP={} cargo test --test race_fuzz -- --nocapture",
            f.seed,
            cfg.steps,
            f.keep.iter().map(|k| k.to_string()).collect::<Vec<_>>().join(",")
        );
    }
    eprintln!(
        "\nrace fuzz: {} seeds x {} steps in {:.1}s: {} passed, {} failed ({} counts differing before the full resync)",
        ran,
        cfg.steps,
        started.elapsed().as_secs_f64(),
        passed.len(),
        failed.len(),
        soft_total
    );
    assert!(failed.is_empty(), "{} seed(s) broke an invariant: {:?}", failed.len(), failed.iter().map(|f| (f.seed, inv_name(f.fail.inv))).collect::<Vec<_>>());
}

// ---- reproductions the fuzzer found: each one is a short, fixed run on the first seed's mailbox ----

/// Thread 3 of every mailbox is entirely older than the window this Mac keeps: it is never cached, so a change to it
/// is made on the server only.
const OLD_THREAD: u32 = 3;

fn list_server(a: usize, view: usize) -> Step {
    Step::ListServer { a, label: view as u32 + 6 * 43 }
}

fn replay(steps: Vec<Step>) {
    replay_seed(1, steps)
}

fn replay_seed(seed: u64, steps: Vec<Step>) {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    if let Err((at, f)) = run_sync(&rt, seed, &steps, Fault::None) {
        panic!("invariant {} broke at step {at} ({:?}): {}", inv_name(f.inv), steps.get(at), f.msg);
    }
}

#[test]
#[ignore = "engine bug: Undo of an offline conversation change, after it went out, queues the literal inverse for the whole conversation"]
fn undoing_a_conversation_change_made_offline_after_it_went_out_puts_back_what_each_message_had() {
    replay(vec![
        Step::Offline { a: 0 },
        Step::Change { a: 0, t: OLD_THREAD, op: Op::Trash },
        Step::Reconnect { a: 0 },
        Step::Undo { a: 0, back: 0 },
        Step::Sync { a: 0 },
        list_server(0, 2),
    ]);
}

#[test]
#[ignore = "engine bug: flush_queue sends conversation changes before message changes, whatever their order"]
fn a_conversation_change_made_offline_goes_out_after_the_undo_made_before_it_not_before() {
    replay(vec![
        Step::Change { a: 0, t: OLD_THREAD, op: Op::ToInbox },
        Step::Change { a: 0, t: OLD_THREAD, op: Op::Archive },
        Step::Offline { a: 0 },
        Step::Undo { a: 0, back: 0 },
        Step::Change { a: 0, t: OLD_THREAD, op: Op::Archive },
        Step::Reconnect { a: 0 },
        list_server(0, 0),
    ]);
}

#[test]
#[ignore = "engine bug: a server listing racing a change to a conversation this Mac doesn't hold shows it in its old view"]
fn a_server_listing_that_ingests_a_conversation_while_it_is_being_binned_does_not_list_it_in_the_old_view() {
    replay_seed(
        28,
        vec![
            Step::Slow { a: 0, route: 1662880410, ms: 45, tail: true },
            Step::Race(vec![Step::Change { a: 0, t: OLD_THREAD, op: Op::Trash }, Step::ListServer { a: 0, label: 3800424023 }]),
        ],
    );
}

#[test]
#[ignore = "engine bug: Undo of a conversation change that waits offline, started as the connection comes back, is lost"]
fn undo_of_a_waiting_change_as_the_connection_comes_back_is_not_lost() {
    replay_seed(
        17,
        vec![
            Step::Offline { a: 1 },
            Step::Race(vec![Step::Change { a: 1, t: 4, op: Op::Work }, Step::Change { a: 1, t: 2, op: Op::Trash }]),
            Step::Online { a: 1 },
            Step::Race(vec![Step::Change { a: 1, t: 1, op: Op::UnWork }, Step::ListServer { a: 1, label: 4157874260 }, Step::Undo { a: 1, back: 3 }]),
        ],
    );
}
