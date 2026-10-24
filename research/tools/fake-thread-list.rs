// The fake mail API's threads.list ordering (app/src-tauri/src/testsupport/fake_gmail.rs) before and after P12.5, on a
// mailbox shaped like mailbox.rs's 20,000 conversations (research/PERF.md). Run: rustc -O --edition 2021 \
// research/tools/fake-thread-list.rs -o /tmp/fake-thread-list && /tmp/fake-thread-list
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

struct M {
    thread: String,
    date: i64,
    labels: Vec<String>,
}

fn old(all: &BTreeMap<String, M>, msgs: &[&M]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for m in msgs {
        if !seen.contains(&m.thread) {
            seen.push(m.thread.clone());
        }
    }
    let newest =
        |t: &String| all.values().filter(|m| &m.thread == t && !m.labels.iter().any(|l| l == "SPAM" || l == "TRASH")).map(|m| m.date).max().unwrap_or(0);
    seen.sort_by_key(|t| std::cmp::Reverse(newest(t)));
    seen
}

fn new(all: &BTreeMap<String, M>, msgs: &[&M]) -> Vec<String> {
    let mut listed = HashSet::new();
    let mut seen: Vec<String> = msgs.iter().filter(|m| listed.insert(&m.thread)).map(|m| m.thread.clone()).collect();
    let mut newest: HashMap<&String, i64> = HashMap::new();
    for m in all.values().filter(|m| listed.contains(&m.thread) && !m.labels.iter().any(|l| l == "SPAM" || l == "TRASH")) {
        let n = newest.entry(&m.thread).or_insert(0);
        *n = (*n).max(m.date);
    }
    seen.sort_by_key(|t| std::cmp::Reverse(newest.get(t).copied().unwrap_or(0)));
    seen
}

fn main() {
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15u64.wrapping_mul(11) | 1;
    let mut rnd = || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut all = BTreeMap::new();
    let mut next = 1u64;
    for c in 0..20_000i64 {
        let cat = if rnd() < 0.18 { "CATEGORY_PERSONAL" } else { "CATEGORY_UPDATES" };
        let n = if rnd() < 0.06 {
            2 + (rnd() * 5.0) as i64
        } else if rnd() < 0.15 {
            2
        } else {
            1
        };
        let inbox = rnd() < 0.7;
        let thread = format!("{:016x}", 0x18f0_0000_0000u64 + next);
        for k in 0..n {
            let id = format!("{:016x}", 0x18f0_0000_0000u64 + next);
            next += 1;
            let mut labels = vec![cat.to_string()];
            if inbox {
                labels.push("INBOX".into());
            }
            all.insert(id, M { thread: thread.clone(), date: 1_800_000_000_000 - c * 388_800 - k, labels });
        }
    }
    for (what, filter) in [("All Mail", None), ("Inbox, Primary", Some("CATEGORY_PERSONAL"))] {
        let mut msgs: Vec<&M> =
            all.values().filter(|m| filter.map_or(true, |f| m.labels.iter().any(|l| l == f) && m.labels.iter().any(|l| l == "INBOX"))).collect();
        msgs.sort_by(|a, b| b.date.cmp(&a.date));
        let t = Instant::now();
        let a = new(&all, &msgs);
        let tn = t.elapsed();
        let t = Instant::now();
        let b = old(&all, &msgs);
        let to = t.elapsed();
        println!(
            "{what}: {} messages, {} conversations listed; before {:.1} ms, after {:.1} ms; same order: {}",
            msgs.len(),
            a.len(),
            to.as_secs_f64() * 1e3,
            tn.as_secs_f64() * 1e3,
            a == b
        );
    }
    println!("{} messages in the mailbox", all.len());
}
