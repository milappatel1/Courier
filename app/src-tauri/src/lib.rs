pub mod db;
pub mod discovery;
pub mod engine;
pub mod error;
pub mod gmail;
pub mod imap;
pub mod macos;
pub mod http;
pub mod mailmeta;
pub mod oauth;
pub mod search;
pub mod secrets;
#[cfg(any(test, debug_assertions))]
pub mod testsupport;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Courier");
}
