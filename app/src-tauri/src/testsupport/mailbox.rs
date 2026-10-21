//! Mailboxes shaped like a busy real one, for the fakes: thousands of conversations over the five categories,
//! mostly unread newsletters and notifications, some archived, and long conversations whose first messages are
//! older than the window Courier keeps. Deterministic for a given seed, so a failure reruns the same way.

use super::fake_gmail::{new_id, FMsg, FakeGmail};

/// What to fill a mailbox with.
#[derive(Clone, Debug)]
pub struct Spec {
    pub seed: u64,
    pub conversations: usize,
    /// Conversations spread over this many days back from now.
    pub days: i64,
    /// Share of conversations still in the Inbox (the rest are archived).
    pub inbox: f64,
    /// Share of conversations with unread mail.
    pub unread: f64,
    /// Share of conversations that are long threads starting 31–120 days before their newest message.
    pub long_threads: f64,
}

impl Default for Spec {
    fn default() -> Self {
        Spec { seed: 1, conversations: 3000, days: 90, inbox: 0.7, unread: 0.45, long_threads: 0.06 }
    }
}

/// Category, its share of conversations, and the senders that write in it.
const CATEGORIES: [(&str, f64, &[&str]); 5] = [
    (
        "CATEGORY_PERSONAL",
        0.18,
        &["Ana Lima <ana@friends.example>", "Bo Chen <bo@work.example>", "Cara Diaz <cara@work.example>", "Dev Rao <dev@family.example>"],
    ),
    ("CATEGORY_PROMOTIONS", 0.34, &["Daily Deals <news@deals.example>", "Lakeside Outfitters <deals@lakeside.example>", "Bookshop <offers@books.example>"]),
    ("CATEGORY_SOCIAL", 0.1, &["Social Site <notify@social.example>", "Pinboard <noreply@pinboard.example>"]),
    (
        "CATEGORY_UPDATES",
        0.32,
        &["Billing <billing@shop.example>", "Bank Alerts <alerts@bank.example>", "Build Bot <ci@builds.example>", "Shipping <track@parcel.example>"],
    ),
    ("CATEGORY_FORUMS", 0.06, &["Hill Walkers <list@hill-walkers.example>", "Rust Users <list@rust-users.example>"]),
];

/// xorshift64*: small, fast and reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn raw(from: &str, to: &str, subject: &str, date_ms: i64, msg_id: &str, reply_to: Option<&str>, body: &str) -> Vec<u8> {
    let date = chrono::DateTime::from_timestamp_millis(date_ms).unwrap_or_default().to_rfc2822();
    let refs = reply_to.map(|r| format!("In-Reply-To: {r}\r\nReferences: {r}\r\n")).unwrap_or_default();
    format!("From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: {msg_id}\r\n{refs}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n").into_bytes()
}

/// Fills the fake's mailbox (no history records: this is mail that was there before Courier signed in).
/// Returns the number of messages added.
pub fn fill(g: &FakeGmail, spec: &Spec) -> usize {
    let mut rng = Rng(spec.seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let mut s = g.state.lock();
    let to = format!("{} <{}>", s.name, s.email);
    let now = crate::error::now_ms();
    let day = 86_400_000i64;
    let mut added = 0;
    for c in 0..spec.conversations {
        let pick = rng.unit();
        let mut acc = 0.0;
        let (category, _, senders) = CATEGORIES
            .iter()
            .find(|(_, share, _)| {
                acc += share;
                pick < acc
            })
            .copied()
            .unwrap_or(CATEGORIES[1]);
        let from = senders[rng.below(senders.len())];
        // Newest first by conversation number, a few minutes apart and jittered, over `days`.
        let newest = now - (c as i64 * spec.days * day) / spec.conversations.max(1) as i64 - (rng.below(600_000) as i64);
        let long = rng.unit() < spec.long_threads;
        let n = if long {
            2 + rng.below(5)
        } else if rng.unit() < 0.15 {
            2
        } else {
            1
        };
        let span = if long { (31 + rng.below(90) as i64) * day } else { 3_600_000 };
        let in_inbox = rng.unit() < spec.inbox;
        let unread = rng.unit() < spec.unread;
        let subject = format!("{} {}", subject_for(category, &mut rng), c);
        let thread_id = new_id(&mut s);
        let first_id = format!("<big{}-{c}-0@seed.example>", spec.seed);
        for k in 0..n {
            let date = if n == 1 { newest } else { newest - span + span * k as i64 / (n as i64 - 1) };
            let id = if k == 0 { thread_id.clone() } else { new_id(&mut s) };
            let mut labels = vec![category.to_string()];
            if in_inbox {
                labels.push("INBOX".into());
            }
            if unread && k == n - 1 {
                labels.push("UNREAD".into());
            }
            let msg_id = format!("<big{}-{c}-{k}@seed.example>", spec.seed);
            let subj = if k == 0 { subject.clone() } else { format!("Re: {subject}") };
            let body = format!("Message {} of conversation {c}.", k + 1);
            let bytes = raw(from, &to, &subj, date, &msg_id, (k > 0).then_some(first_id.as_str()), &body);
            s.messages.insert(id.clone(), FMsg { id, thread_id: thread_id.clone(), labels, raw: bytes, internal_date: date });
            added += 1;
        }
    }
    added
}

fn subject_for(category: &str, rng: &mut Rng) -> &'static str {
    let pool: &[&str] = match category {
        "CATEGORY_PERSONAL" => &["Catching up", "Dinner plans", "Notes from today", "Quick question"],
        "CATEGORY_PROMOTIONS" => &["Weekend sale", "New arrivals", "Last chance", "Members save more"],
        "CATEGORY_SOCIAL" => &["New followers", "You were mentioned", "Friend request"],
        "CATEGORY_UPDATES" => &["Your receipt", "Build finished", "Statement ready", "Parcel on its way"],
        _ => &["Weekly digest", "New thread", "Meetup reminder"],
    };
    pool[rng.below(pool.len())]
}
