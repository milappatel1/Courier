//! Courier's own log: sync progress, errors and Keychain events, one line each with a timestamp. Never message
//! content (error texts come from the servers). It lives in the app's log folder
//! (~/Library/Logs/com.milappatel.courier/courier.log), is capped at 1 MB with one older file kept, and is also
//! echoed to stderr for runs from a terminal.

use parking_lot::Mutex;
use std::io::Write;
use std::path::PathBuf;

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_BYTES: u64 = 1024 * 1024;

pub fn init(path: PathBuf) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    *LOG.lock() = Some(path);
}

pub fn info(msg: &str) {
    write("INFO", msg);
}
pub fn warn(msg: &str) {
    write("WARN", msg);
}
pub fn error(msg: &str) {
    write("ERROR", msg);
}

fn write(level: &str, msg: &str) {
    let line = format!("{} {level} {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg.replace('\n', " "));
    eprint!("{line}");
    let guard = LOG.lock();
    let Some(path) = guard.as_ref() else { return };
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_lines_and_rotates() {
        let dir = std::env::temp_dir().join(format!("courier-log-{}", crate::error::random_token(6)));
        let path = dir.join("courier.log");
        super::init(path.clone());
        super::info("hello");
        super::warn("two\nlines");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(" INFO hello\n") && text.contains(" WARN two lines\n"));
        std::fs::write(&path, vec![b'x'; (super::MAX_BYTES + 1) as usize]).unwrap();
        super::error("after rotation");
        assert!(path.with_extension("log.1").exists());
        assert!(std::fs::read_to_string(&path).unwrap().ends_with(" ERROR after rotation\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
