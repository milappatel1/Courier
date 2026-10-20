//! Local fakes of the mail services (debug and test builds only): the mail REST API with OAuth, an IMAP
//! server and an SMTP server. Used by `cargo test` and by the in-app end-to-end run (COURIER_E2E).

pub mod fake_gmail;
pub mod fake_imap;

pub use fake_gmail::FakeGmail;
pub use fake_imap::{FakeImap, FakeSmtp};

/// A small RFC 822 message for tests.
pub fn sample_mail(from: &str, to: &str, subject: &str, body: &str, extra_headers: &str) -> Vec<u8> {
    let id = crate::error::random_token(6);
    format!(
        // Dated now, so it's always inside the offline window (a fixed date would age out of it).
        "From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{id}@test.example>\r\n{extra_headers}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n",
        date = chrono::Utc::now().to_rfc2822()
    )
    .into_bytes()
}
