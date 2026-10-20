//! One error type for commands, sync and tests. Commands return it to the webview as a string with a
//! short machine-readable prefix ("offline:", "auth:", …) so the UI can react (outbox, re-sign-in).

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    /// No network (connect/timeout/DNS); operations that send are queued in the outbox.
    #[error("offline: {0}")]
    Offline(String),
    #[error("network: {0}")]
    Network(String),
    /// The provider is limiting requests: try again later (not "offline").
    #[error("{0}")]
    RateLimited(String),
    /// The account needs signing in again (expired/revoked tokens, bad password).
    #[error("auth: {0}")]
    Auth(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("server: {0}")]
    Server(String),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("imap: {0}")]
    Imap(String),
    #[error("smtp: {0}")]
    Smtp(String),
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
    pub fn is_offline(&self) -> bool {
        matches!(self, Error::Offline(_))
    }
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, Error::RateLimited(_))
    }
    pub fn is_auth(&self) -> bool {
        matches!(self, Error::Auth(_))
    }
    /// The kind of failure, for the log (the text itself can carry a server's words about a message).
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Msg(_) => "refused",
            Error::Offline(_) => "offline",
            Error::Network(_) => "network",
            Error::RateLimited(_) => "rate limited",
            Error::Auth(_) => "needs sign-in",
            Error::NotFound(_) => "not found",
            Error::Server(_) => "server refused",
            Error::Db(_) => "database",
            Error::Io(_) => "file",
            Error::Json(_) => "bad data",
            Error::Imap(_) => "IMAP refused",
            Error::Smtp(_) => "SMTP refused",
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() || e.is_timeout() {
            Error::Offline(e.to_string())
        } else {
            Error::Network(e.to_string())
        }
    }
}

impl From<async_imap::error::Error> for Error {
    fn from(e: async_imap::error::Error) -> Self {
        use async_imap::error::Error as E;
        match e {
            E::Io(io) => io_error(io),
            E::ConnectionLost => Error::Offline("connection lost".into()),
            E::No(s) if s.to_ascii_uppercase().contains("AUTH") || s.to_ascii_lowercase().contains("credentials") => Error::Auth(s),
            other => Error::Imap(other.to_string()),
        }
    }
}

impl From<lettre::transport::smtp::Error> for Error {
    fn from(e: lettre::transport::smtp::Error) -> Self {
        let s = e.to_string();
        if e.is_permanent() && (s.contains("535") || s.to_ascii_lowercase().contains("auth")) {
            Error::Auth(s)
        } else if e.is_transient() || s.to_ascii_lowercase().contains("connection") || s.contains("Connection") {
            Error::Offline(s)
        } else {
            Error::Smtp(s)
        }
    }
}

/// Network-ish io errors are "offline", the rest stay io errors.
pub fn io_error(e: std::io::Error) -> Error {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::ConnectionRefused | K::ConnectionReset | K::ConnectionAborted | K::NotConnected | K::TimedOut | K::BrokenPipe | K::UnexpectedEof | K::HostUnreachable | K::NetworkUnreachable | K::NetworkDown => {
            Error::Offline(e.to_string())
        }
        _ => Error::Io(e),
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Current time in milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Random URL-safe token (ids, PKCE verifiers, OAuth state).
pub fn random_token(bytes: usize) -> String {
    use base64::Engine as _;
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("system randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}
