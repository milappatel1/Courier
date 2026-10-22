//! Every order of events, checked against the real cache code (db.rs): user changes (to a conversation, which the
//! server applies to a message this Mac doesn't keep as well, and to a single message), the server applying them,
//! acknowledgements, refusals, changes waiting offline and going out later, server reads that start, are answered
//! from the mailbox as it was then, and are written later, and changes made on another device. Each path is replayed
//! on a fresh in-memory cache, and after every step:
//!
//! - **No resurrection**: a message's Inbox label shows what the user's latest change made, unless that change was
//!   refused or another device changed the message's Inbox label after it.
//! - **Settles**: once every change has been answered, every read delivered and one more read made, the cache's labels
//!   equal the server's.
//!
//! Bound: `COURIER_MODEL_DEPTH` events per path (default 6; the long run uses 8). See .claude/skills/verify-ledger.

use courier_lib::db::{Db, MessageRow, Read};
use std::collections::HashMap;

const A: &str = "a";
const MSGS: [&str; 3] = ["m0", "m1", "m2"]; // m0 and m2 are one conversation (t0); m2 is old and not cached at first

#[derive(Clone, Copy, Debug, PartialEq)]
enum Target {
    /// The whole conversation t0: m0 here, m0 and m2 on the server.
    Thread0,
    /// The single message m1.
    Msg1,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Archive,
    Inbox,
}

impl Op {
    fn add_remove(self) -> (Vec<String>, Vec<String>) {
        match self {
            Op::Archive => (vec![], vec!["INBOX".into()]),
            Op::Inbox => (vec!["INBOX".into()], vec![]),
        }
    }
    fn inbox(self) -> bool {
        self == Op::Inbox
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Ev {
    /// The user makes a change (`begin_change` on what this Mac has).
    Local(Target, Op),
    /// Change i reaches the server.
    Send(usize),
    /// The server's acknowledgement of change i arrives (`end_change` ok, plus a mark for m2).
    Ack(usize),
    /// The server refuses change i (`end_change` not ok).
    Refuse(usize),
    /// No connection: change i waits (`queue_change`).
    Offline(usize),
    /// The connection is back: waiting changes go out and are acknowledged (`change_sent`).
    Flush,
    /// A read starts: stamp now, answer = the server's labels now.
    Issue,
    /// Read i's answer is written (`Read::set_labels`, `Read::upsert_message` for m2).
    Deliver(usize),
    /// Another device sets or clears a message's Inbox label.
    Remote(usize, Op),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum State {
    InFlight,
    Sent,
    Queued,
    Done,
    Refused,
}

struct Change {
    target: Target,
    op: Op,
    token: u64,
    state: State,
    /// Each cached message's labels before the change, as the engine records them for the queue.
    had: HashMap<String, Vec<String>>,
}

struct World<'a> {
    db: &'a Db,
    server: HashMap<&'static str, Vec<String>>,
    changes: Vec<Change>,
    reads: Vec<Option<(Read<'a>, HashMap<&'static str, Vec<String>>)>>,
    /// Per message: what the user's latest standing change says about the Inbox label.
    expect: HashMap<&'static str, Option<bool>>,
    remotes: usize,
}

fn row(id: &str, thread: &str, labels: &[String]) -> MessageRow {
    MessageRow { account_id: A.into(), id: id.into(), thread_id: thread.into(), labels: labels.to_vec(), ..Default::default() }
}

fn covers(t: Target) -> (Vec<&'static str>, Vec<&'static str>) {
    // (cached ids it changes here, ids the server changes)
    match t {
        Target::Thread0 => (vec!["m0"], vec!["m0", "m2"]),
        Target::Msg1 => (vec!["m1"], vec!["m1"]),
    }
}

fn apply(labels: &[String], op: Op) -> Vec<String> {
    let (add, remove) = op.add_remove();
    let mut out: Vec<String> = labels.iter().filter(|l| !remove.contains(l)).cloned().collect();
    for a in add {
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}

fn shown(db: &Db, id: &str) -> Option<Vec<String>> {
    db.message(A, id).unwrap().map(|m| m.labels)
}

impl<'a> World<'a> {
    fn new(db: &'a Db) -> World<'a> {
        let inbox = vec!["INBOX".to_string()];
        {
            let r = db.begin_read(A);
            r.upsert_message(&row("m0", "t0", &inbox), None).unwrap();
            r.upsert_message(&row("m1", "t1", &inbox), None).unwrap();
        }
        let server = MSGS.iter().map(|m| (*m, inbox.clone())).collect();
        World { db, server, changes: vec![], reads: vec![], expect: MSGS.iter().map(|m| (*m, None)).collect(), remotes: 0 }
    }

    fn cached(&self, ids: &[&str]) -> Vec<String> {
        ids.iter().filter(|id| shown(self.db, id).is_some()).map(|s| s.to_string()).collect()
    }

    fn step(&mut self, ev: Ev) {
        match ev {
            Ev::Local(t, op) => {
                let (here, server) = covers(t);
                let (add, remove) = op.add_remove();
                let ids = self.cached(&here);
                let had = ids.iter().map(|id| (id.clone(), shown(self.db, id).unwrap())).collect();
                let token = self.db.begin_change(A, &ids, &add, &remove).unwrap();
                self.changes.push(Change { target: t, op, token, state: State::InFlight, had });
                for m in server {
                    self.expect.insert(m, Some(op.inbox()));
                }
            }
            Ev::Send(i) => {
                let c = &mut self.changes[i];
                c.state = State::Sent;
                let (op, t) = (c.op, c.target);
                for m in covers(t).1 {
                    let l = apply(&self.server[m], op);
                    self.server.insert(m, l);
                }
            }
            Ev::Ack(i) => {
                let (t, op, token) = (self.changes[i].target, self.changes[i].op, self.changes[i].token);
                self.changes[i].state = State::Done;
                let (here, server) = covers(t);
                let (add, remove) = op.add_remove();
                let ids = self.cached(&here);
                self.db.end_change(A, &ids, token, true).unwrap();
                let uncached: Vec<String> = server.iter().filter(|m| !here.contains(m) && shown(self.db, m).is_none()).map(|s| s.to_string()).collect();
                self.db.mark_landed(A, &uncached, &add, &remove);
            }
            Ev::Refuse(i) => {
                let (t, op, token) = (self.changes[i].target, self.changes[i].op, self.changes[i].token);
                self.changes[i].state = State::Refused;
                let ids = self.cached(&covers(t).0);
                self.db.end_change(A, &ids, token, false).unwrap();
                // The user's wish didn't happen: nothing to hold any more for messages whose latest change this was.
                if !self.changes[i + 1..].iter().any(|c| covers(c.target).1.iter().any(|m| covers(t).1.contains(m))) {
                    for m in covers(t).1 {
                        self.expect.insert(m, None);
                    }
                }
                let _ = op;
            }
            Ev::Offline(i) => {
                let (t, op, token) = (self.changes[i].target, self.changes[i].op, self.changes[i].token);
                self.changes[i].state = State::Queued;
                let (add, remove) = op.add_remove();
                let ids = self.cached(&covers(t).0);
                let had = self.changes[i].had.clone();
                self.db.queue_change(A, &ids, &add, &remove, &had, token).unwrap();
            }
            Ev::Flush => {
                for i in 0..self.changes.len() {
                    if self.changes[i].state != State::Queued {
                        continue;
                    }
                    let (t, op) = (self.changes[i].target, self.changes[i].op);
                    self.changes[i].state = State::Done;
                    let (here, server) = covers(t);
                    for m in &server {
                        let l = apply(&self.server[m], op);
                        self.server.insert(m, l);
                    }
                    let (add, remove) = op.add_remove();
                    let ids = self.cached(&here);
                    let queued: Vec<_> = self.db.queued_changes(A).unwrap();
                    for q in queued.iter().filter(|q| ids.contains(&q.message_id)) {
                        self.db.change_sent(A, std::slice::from_ref(&q.message_id), &q.add, &q.remove).unwrap();
                    }
                    let uncached: Vec<String> = server.iter().filter(|m| !here.contains(m) && shown(self.db, m).is_none()).map(|s| s.to_string()).collect();
                    self.db.mark_landed(A, &uncached, &add, &remove);
                }
            }
            Ev::Issue => {
                let read = self.db.begin_read(A);
                self.reads.push(Some((read, self.server.clone())));
            }
            Ev::Deliver(i) => {
                let (read, snapshot) = self.reads[i].take().unwrap();
                for m in MSGS {
                    let labels = &snapshot[m];
                    if shown(self.db, m).is_some() {
                        read.set_labels(m, labels).unwrap();
                    } else {
                        read.upsert_message(&row(m, if m == "m1" { "t1" } else { "t0" }, labels), None).unwrap();
                    }
                }
            }
            Ev::Remote(m, op) => {
                let id = MSGS[m];
                let l = apply(&self.server[id], op);
                self.server.insert(id, l);
                self.expect.insert(id, None);
                self.remotes += 1;
            }
        }
    }

    fn enabled(&self, max_local: usize, max_reads: usize) -> Vec<Ev> {
        let mut out = Vec::new();
        if self.changes.len() < max_local {
            for t in [Target::Thread0, Target::Msg1] {
                for op in [Op::Archive, Op::Inbox] {
                    out.push(Ev::Local(t, op));
                }
            }
        }
        // Changes go out in order, one at a time, as the engine sends them.
        if let Some(i) = self.changes.iter().position(|c| c.state == State::InFlight || c.state == State::Sent) {
            match self.changes[i].state {
                State::InFlight => {
                    if !self.changes.iter().any(|c| c.state == State::Queued) {
                        out.push(Ev::Send(i));
                        out.push(Ev::Refuse(i));
                    }
                    out.push(Ev::Offline(i));
                }
                _ => out.push(Ev::Ack(i)),
            }
        }
        if self.changes.iter().any(|c| c.state == State::Queued) && !self.changes.iter().any(|c| c.state == State::InFlight || c.state == State::Sent) {
            out.push(Ev::Flush);
        }
        if self.reads.len() < max_reads {
            out.push(Ev::Issue);
        }
        for (i, r) in self.reads.iter().enumerate() {
            if r.is_some() {
                out.push(Ev::Deliver(i));
            }
        }
        if self.remotes == 0 {
            out.push(Ev::Remote(0, Op::Inbox));
            out.push(Ev::Remote(1, Op::Archive));
        }
        out
    }

    fn safe(&self) -> Result<(), String> {
        for m in MSGS {
            if let (Some(Some(want)), Some(labels)) = (self.expect.get(m), shown(self.db, m)) {
                let has = labels.iter().any(|l| l == "INBOX");
                if has != *want {
                    return Err(format!("{m} shows Inbox={has}, but the user's latest standing change says {want} (labels {labels:?})"));
                }
            }
        }
        Ok(())
    }

    /// Answer everything, deliver every read, read once more: the cache must equal the server.
    fn settle(&mut self) -> Result<(), String> {
        while let Some(i) = self.changes.iter().position(|c| c.state == State::InFlight || c.state == State::Sent) {
            if self.changes[i].state == State::InFlight {
                self.step(Ev::Send(i));
            }
            self.step(Ev::Ack(i));
        }
        if self.changes.iter().any(|c| c.state == State::Queued) {
            self.step(Ev::Flush);
        }
        for i in 0..self.reads.len() {
            if self.reads[i].is_some() {
                self.step(Ev::Deliver(i));
            }
        }
        self.step(Ev::Issue);
        let last = self.reads.len() - 1;
        self.step(Ev::Deliver(last));
        for m in MSGS {
            if let Some(labels) = shown(self.db, m) {
                let (mut a, mut b) = (labels.clone(), self.server[m].clone());
                a.sort();
                b.sort();
                if a != b {
                    return Err(format!("settled, but {m} shows {a:?} while the server has {b:?}"));
                }
            }
        }
        Ok(())
    }
}

/// Replays `path` on a fresh cache; Err names the step that broke an invariant.
fn run(path: &[Ev], settle: bool) -> Result<Vec<Ev>, String> {
    let db = Db::open_in_memory().unwrap();
    let mut w = World::new(&db);
    for (n, ev) in path.iter().enumerate() {
        w.step(*ev);
        w.safe().map_err(|e| format!("after step {} ({ev:?}): {e}", n + 1))?;
    }
    let next = w.enabled(2, 2);
    if settle {
        w.settle().map_err(|e| format!("at the end: {e}"))?;
    }
    Ok(next)
}

fn explore(path: &mut Vec<Ev>, depth: usize, count: &mut usize) -> Result<(), String> {
    *count += 1;
    let leaf = path.len() == depth;
    let next = run(path, true).map_err(|e| format!("{e}\n  path: {path:?}"))?;
    if leaf {
        return Ok(());
    }
    for ev in next {
        path.push(ev);
        explore(path, depth, count)?;
        path.pop();
    }
    Ok(())
}

#[test]
fn no_order_of_events_brings_a_removed_message_back_and_the_cache_settles_to_the_server() {
    let depth: usize = std::env::var("COURIER_MODEL_DEPTH").ok().and_then(|v| v.parse().ok()).unwrap_or(6);
    let mut count = 0;
    let r = explore(&mut Vec::new(), depth, &mut count);
    eprintln!("ledger model: {count} paths checked to depth {depth}");
    if let Err(e) = r {
        panic!("{e}");
    }
}
