pub mod commands;
pub mod db;
pub mod discovery;
pub mod applog;
pub mod e2e;
pub mod engine;
pub mod error;
pub mod gmail;
pub mod http;
pub mod imap;
pub mod macos;
pub mod mailmeta;
pub mod oauth;
pub mod recon;
pub mod search;
pub mod secrets;
#[cfg(any(test, debug_assertions))]
pub mod testsupport;

use commands::AppState;
use engine::{Engine, EventSink, Notifier, Opener};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::menu::{AboutMetadataBuilder, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

struct TauriEvents(AppHandle);
impl EventSink for TauriEvents {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

struct TauriNotifier {
    app: AppHandle,
    e2e: Option<Arc<e2e::E2e>>,
}
impl Notifier for TauriNotifier {
    fn notify(&self, title: &str, body: &str, account_id: &str, thread_id: &str) {
        if recon::address().is_some() {
            return;
        }
        if let Some(e) = &self.e2e {
            e.notes.lock().push(json!({"title": title, "body": body, "accountId": account_id, "threadId": thread_id}));
            return;
        }
        #[cfg(target_os = "macos")]
        if notify_and_open_on_click(&self.app, title, body, account_id, thread_id) {
            return;
        }
        use tauri_plugin_notification::NotificationExt;
        let _ = self.app.notification().builder().title(title).body(body).show();
    }
}

/// A notification's button: archive the conversation (in the background; the app needn't come forward).
pub(crate) fn notification_action(app: &AppHandle, account: &str, thread: &str, action: &str) {
    if action != "archive" || thread.is_empty() {
        return;
    }
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        let engine = st.engine.clone();
        let (a, t) = (account.to_string(), thread.to_string());
        tauri::async_runtime::spawn(async move {
            let _ = engine.modify_threads(&a, &[t], &[], &["INBOX".into()]).await;
        });
    }
}

/// Notifications waiting for a click (each holds a thread until it's clicked or dismissed); kept small.
#[cfg(target_os = "macos")]
static WAITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Shows the notification and, when it's clicked, opens that conversation (or the account's inbox for a
/// summary). Returns false if the system notifications aren't available, so the plugin's can be used.
#[cfg(target_os = "macos")]
fn notify_and_open_on_click(app: &AppHandle, title: &str, body: &str, account_id: &str, thread_id: &str) -> bool {
    use std::sync::atomic::Ordering;
    static READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let id = app.config().identifier.clone();
    if !*READY.get_or_init(|| mac_notification_sys::set_application(&id).is_ok()) {
        return false;
    }
    let wait = WAITING.load(Ordering::SeqCst) < 16;
    let (app, title, body, account, thread) = (app.clone(), title.to_string(), body.to_string(), account_id.to_string(), thread_id.to_string());
    std::thread::spawn(move || {
        if wait {
            WAITING.fetch_add(1, Ordering::SeqCst);
        }
        let mut n = mac_notification_sys::Notification::new();
        n.title(&title).message(&body).default_sound().wait_for_click(wait);
        // One conversation: an Archive button, as on the phone.
        if wait && !thread.is_empty() {
            n.main_button(mac_notification_sys::MainButton::SingleAction("Archive"));
        }
        let r = n.send();
        if wait {
            WAITING.fetch_sub(1, Ordering::SeqCst);
        }
        match r {
            Ok(mac_notification_sys::NotificationResponse::Click) => deliver_open(&app, json!({"kind": "thread", "accountId": account, "threadId": thread})),
            Ok(mac_notification_sys::NotificationResponse::ActionButton(a)) if a == "Archive" => notification_action(&app, &account, &thread, "archive"),
            _ => {}
        }
    });
    true
}

struct BrowserOpener {
    http: reqwest::Client,
    e2e: Option<Arc<e2e::E2e>>,
}
impl Opener for BrowserOpener {
    fn open(&self, url: &str) -> error::Result<()> {
        if let Some(e) = &self.e2e {
            // The fake OAuth server approves at once; fetching the URL plays the browser's part.
            e.opened.lock().push(url.to_string());
            let http = self.http.clone();
            let url = url.to_string();
            tauri::async_runtime::spawn(async move {
                let _ = http.get(url).send().await;
            });
            return Ok(());
        }
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| error::Error::msg(e.to_string()))
    }
}

/// An in-message jump link (rewritten to ANCHOR_LINK by the sanitiser): scroll the conversation to its spot.
fn anchor_jump(app: &AppHandle, url: &tauri::Url) -> bool {
    if url.host_str() != Some("anchor.courier.invalid") {
        return false;
    }
    if let Some(f) = url.fragment().filter(|f| !f.is_empty()) {
        let _ = app.emit("frame-anchor", json!({"id": percent_encoding::percent_decode_str(f).decode_utf8_lossy()}));
    }
    true
}

/// A link from a message (or anywhere in the app) goes to the default browser or mail handler, never into
/// Courier's own window. The app's own pages and the message frames' srcdoc/blob/data loads stay inside.
fn keeps_inside(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" | "asset" | "ipc" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost") | Some("tauri.localhost") | Some("ipc.localhost")),
        _ => false,
    }
}

pub fn open_link(app: &AppHandle, url: &str) {
    let ok = ["https://", "http://", "mailto:", "tel:"].iter().any(|p| url.to_ascii_lowercase().starts_with(p));
    if !ok {
        return;
    }
    if url.to_ascii_lowercase().starts_with("mailto:") {
        // Courier writes the mail itself.
        let _ = app.emit("open-item", json!({"kind": "mailto", "url": url}));
        return;
    }
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        if let Some(e2e) = &st.e2e {
            e2e.opened.lock().push(url.to_string());
            return;
        }
    }
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
}

/// Where WebKit's own downloads go (Download Image, Download Linked File from a message's context menu):
/// the suggested ~/Downloads path with browser-style numbering, or the run's own folder during tests.
static DOWNLOADS: std::sync::LazyLock<parking_lot::Mutex<std::collections::HashMap<String, std::path::PathBuf>>> = std::sync::LazyLock::new(Default::default);

fn on_download(app: &AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            if let Some(st) = app.try_state::<Arc<AppState>>() {
                if st.e2e.is_some() {
                    let dir = st.data_dir.join("Downloads");
                    let _ = std::fs::create_dir_all(&dir);
                    let name = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
                    *destination = commands::unique_path(&dir, &commands::safe_file_name(&name));
                }
            }
            DOWNLOADS.lock().insert(url.to_string(), destination.clone());
            true
        }
        tauri::webview::DownloadEvent::Finished { url, success, .. } => {
            let path = DOWNLOADS.lock().remove(url.as_str());
            let _ = app.emit("download-finished", json!({"path": path.map(|p| p.display().to_string()), "success": success}));
            true
        }
        _ => true,
    }
}

/// Main and secondary windows: overlay title bar, traffic lights inside the 64 px header.
pub fn window_builder<'a>(app: &'a AppHandle, label: &str, url: &str, title: &str, e2e: bool) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1280.0, 800.0)
        .min_inner_size(380.0, 480.0)
        .focused(!e2e)
        .background_throttling(if e2e { BackgroundThrottlingPolicy::Disabled } else { BackgroundThrottlingPolicy::Suspend })
        .disable_drag_drop_handler()
        .on_new_window({
            let app = app.clone();
            move |url, _| {
                if !anchor_jump(&app, &url) {
                    open_link(&app, url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
        .on_download({
            let app = app.clone();
            move |_, event| on_download(&app, event)
        })
        .on_navigation({
            let app = app.clone();
            move |url| {
                if anchor_jump(&app, url) {
                    return false;
                }
                if keeps_inside(url) {
                    return true;
                }
                open_link(&app, url.as_str());
                false
            }
        });
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(LogicalPosition::new(20.0, 26.0));
    b
}

pub fn open_window(app: &AppHandle, kind: &str, id: &str, title: &str, e2e: bool) -> error::Result<()> {
    let label = format!("{kind}-{id}");
    let url = format!("index.html?{kind}={id}");
    let mut b = window_builder(app, &label, &url, title, e2e);
    if kind == "compose" {
        b = b.inner_size(640.0, 640.0).min_inner_size(420.0, 360.0);
    } else if kind == "print" {
        b = b.inner_size(820.0, 900.0);
    }
    let _w = b.build().map_err(|e| error::Error::msg(e.to_string()))?;
    #[cfg(target_os = "macos")]
    if kind == "thread" {
        macos::enable_swipe_navigation(&_w);
    }
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, text: &str, acc: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, text);
        match acc {
            Some(a) => b.accelerator(a).build(app),
            None => b.build(app),
        }
    };
    let about = AboutMetadataBuilder::new().name(Some("Courier")).version(Some(env!("CARGO_PKG_VERSION"))).copyright(Some("© 2026 Milap Patel")).build();
    let app_menu = SubmenuBuilder::new(app, "Courier")
        .item(&PredefinedMenuItem::about(app, Some("About Courier"), Some(about))?)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .item(&item("default-mail", "Make Courier the Default Mail App", None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("compose", "New Message", Some("CmdOrCtrl+N"))?)
        .item(&item("open-eml", "Open Message File…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save-eml", "Save Message As…", Some("CmdOrCtrl+S"))?)
        .item(&item("print", "Print…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&item("paste-plain", "Paste and Match Style", Some("CmdOrCtrl+Alt+Shift+V"))?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&item("find", "Search Mail", Some("CmdOrCtrl+F"))?)
        .item(&item("advanced-search", "Advanced Search…", Some("CmdOrCtrl+Alt+F"))?)
        .separator()
        .item(&item("spelling", "Check Spelling", Some("CmdOrCtrl+;"))?)
        .build()?;
    let reading = SubmenuBuilder::new(app, "Reading Pane").item(&item("pane-none", "No Split", None)?).item(&item("pane-right", "Right of Inbox", None)?).item(&item("pane-below", "Below Inbox", None)?).build()?;
    let density = SubmenuBuilder::new(app, "Density").item(&item("density-default", "Default", None)?).item(&item("density-comfortable", "Comfortable", None)?).item(&item("density-compact", "Compact", None)?).build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle-nav", "Show/Hide Main Menu", Some("CmdOrCtrl+Ctrl+S"))?)
        .item(&reading)
        .item(&density)
        .item(&CheckMenuItemBuilder::with_id("conversation-view", "Conversation View").checked(true).build(app)?)
        .separator()
        .item(&item("theme-light", "Light Theme", None)?)
        .item(&item("theme-dark", "Dark Theme", None)?)
        .item(&item("themes", "Themes…", None)?)
        .separator()
        .item(&item("refresh", "Get New Mail", Some("CmdOrCtrl+Shift+N"))?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let mut mailbox = SubmenuBuilder::new(app, "Mailbox")
        .item(&item("go-inbox", "Inbox", None)?)
        .item(&item("go-starred", "Starred", None)?)
        .item(&item("go-snoozed", "Snoozed", None)?)
        .item(&item("go-sent", "Sent", None)?)
        .item(&item("go-drafts", "Drafts", None)?)
        .item(&item("go-all", "All Mail", None)?)
        .separator()
        .item(&item("all-inboxes", "All Inboxes", Some("CmdOrCtrl+0"))?);
    for i in 1..=9 {
        mailbox = mailbox.item(&item(&format!("account-{i}"), &format!("Account {i}"), Some(&format!("CmdOrCtrl+{i}")))?);
    }
    let mailbox = mailbox.separator().item(&item("empty-trash", "Empty Trash", None)?).build()?;
    let message = SubmenuBuilder::new(app, "Message")
        .item(&item("reply", "Reply", Some("CmdOrCtrl+R"))?)
        .item(&item("reply-all", "Reply All", Some("CmdOrCtrl+Shift+R"))?)
        .item(&item("forward", "Forward", Some("CmdOrCtrl+Shift+F"))?)
        .item(&item("forward-attachment", "Forward as Attachment", None)?)
        .separator()
        .item(&item("archive", "Archive", Some("CmdOrCtrl+Ctrl+A"))?)
        .item(&item("delete", "Delete", Some("CmdOrCtrl+Backspace"))?)
        .item(&item("spam", "Report Spam", Some("CmdOrCtrl+Shift+J"))?)
        .item(&item("mark-unread", "Mark as Unread", Some("CmdOrCtrl+Shift+U"))?)
        .item(&item("mark-read", "Mark as Read", None)?)
        .item(&item("star", "Add Star", Some("CmdOrCtrl+Shift+L"))?)
        .item(&item("important", "Mark as Important", None)?)
        .item(&item("snooze", "Snooze…", None)?)
        .item(&item("mute", "Mute", None)?)
        .separator()
        .item(&item("show-original", "Show Original", Some("CmdOrCtrl+Alt+U"))?)
        .item(&item("unsubscribe", "Unsubscribe", None)?)
        .item(&item("share", "Share…", None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").item(&PredefinedMenuItem::minimize(app, None)?).item(&PredefinedMenuItem::maximize(app, None)?).separator().item(&item("bring-front", "Bring All to Front", None)?).build()?;
    let help = SubmenuBuilder::new(app, "Help").item(&item("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?).item(&item("help", "Courier Help", None)?).build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &mailbox, &message, &window, &help]).build()
}

fn focused_or_main(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows.values().find(|w| w.is_focused().unwrap_or(false)).cloned().or_else(|| app.get_webview_window("main"))
}

/// What the OS hands Courier: mailto: links, .eml files to read, and any other files, which become a new
/// message with them attached (Open With, or another app's "Email this file").
fn open_item_for(urls: &[String]) -> Vec<Value> {
    let mut items = Vec::new();
    let mut attach = Vec::new();
    for url in urls {
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("mailto:") {
            items.push(json!({"kind": "mailto", "url": url}));
        } else if lower.ends_with(".eml") {
            items.push(json!({"kind": "eml", "path": url}));
        } else if lower.starts_with("file://") {
            attach.push(url.clone());
        }
    }
    if !attach.is_empty() {
        items.push(json!({"kind": "attach", "paths": attach}));
    }
    items
}

pub(crate) fn handle_opened(app: &AppHandle, urls: &[String]) {
    for item in open_item_for(urls) {
        deliver_open(app, item);
    }
}

fn handle_open(app: &AppHandle, url: &str) {
    handle_opened(app, &[url.to_string()]);
}

fn deliver_open(app: &AppHandle, item: Value) {
    let mut testing = false;
    if let Some(st) = app.try_state::<Arc<AppState>>() {
        st.pending_open.lock().push(item.clone());
        testing = st.e2e.is_some();
    }
    let _ = app.emit("open-item", item);
    // Bring the window forward for the person who opened something, never during an end-to-end run.
    if testing {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let e2e_report = e2e::report_path();
    let builder = tauri::Builder::default();
    // End-to-end runs stay in the background instead of taking focus, and macOS mustn't nap them.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(e2e_report.is_none());
    #[cfg(target_os = "macos")]
    if e2e_report.is_some() {
        macos::disable_app_nap("Courier end-to-end tests");
    }
    let builder = if e2e_report.is_none() && recon::address().is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for a in argv.iter().skip(1) {
                handle_open(app, a);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
    } else {
        builder
    };
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_drag::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if id == "bring-front" {
                for w in app.webview_windows().values() {
                    let _ = w.show();
                }
                return;
            }
            if let Some(w) = focused_or_main(app) {
                let _ = w.emit("menu", json!({"id": id}));
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let e2e_state: Option<Arc<e2e::E2e>> = match &e2e_report {
                #[cfg(debug_assertions)]
                Some(path) => Some(Arc::new(tauri::async_runtime::block_on(e2e::E2e::start(path.clone())))),
                _ => None,
            };
            let recon = recon::address();
            let installed_dir = handle.path().app_data_dir()?;
            let data_dir = match &e2e_report {
                Some(path) => std::path::Path::new(path).parent().map(|p| p.join("data")).unwrap_or_else(std::env::temp_dir),
                // Recon mode never opens the installed app's cache, log or Keychain item.
                None if recon.is_some() => installed_dir.with_file_name(format!("{}.recon", app.config().identifier)),
                None => installed_dir.clone(),
            };
            std::fs::create_dir_all(&data_dir)?;
            let log_path = match &e2e_report {
                Some(_) => data_dir.join("courier.log"),
                None if recon.is_some() => data_dir.join("courier.log"),
                None => handle.path().app_log_dir().unwrap_or_else(|_| data_dir.clone()).join("courier.log"),
            };
            gmail::TIMING.store(recon.is_some(), std::sync::atomic::Ordering::Relaxed);
            applog::init(log_path);
            applog::info(&format!("Courier {} started", env!("CARGO_PKG_VERSION")));
            let db = Arc::new(db::Db::open(&data_dir.join("courier.db"))?);
            let store: Arc<dyn secrets::SecretStore> = if e2e_state.is_some() {
                Arc::new(secrets::MemoryStore::default())
            } else if recon.is_some() {
                let file: Arc<dyn secrets::SecretStore> = Arc::new(recon::FileStore::open(data_dir.join("recon-secrets.json")));
                if file.get(secrets::GOOGLE_CLIENT_KEY).ok().flatten().is_none() {
                    #[cfg(target_os = "macos")]
                    if let Some(c) = recon::installed_google_client(&installed_dir) {
                        let _ = file.set(secrets::GOOGLE_CLIENT_KEY, &c);
                    }
                }
                file
            } else {
                #[cfg(target_os = "macos")]
                {
                    let mut legacy = vec![secrets::GOOGLE_CLIENT_KEY.to_string()];
                    for a in db.accounts().unwrap_or_default() {
                        legacy.extend([secrets::oauth_key(&a.id), secrets::password_key(&a.id), secrets::smtp_password_key(&a.id)]);
                    }
                    let vault: Arc<dyn secrets::SecretStore> = Arc::new(secrets::VaultStore::new(
                        Box::new(secrets::LoginKeychain::new(secrets::SERVICE)),
                        data_dir.join("vault.json"),
                        secrets::current_build_id(),
                        legacy,
                    ));
                    // Open the vault off the main thread: if macOS asks for the Keychain password, the window stays usable.
                    let warm = vault.clone();
                    std::thread::spawn(move || {
                        let _ = warm.get("");
                    });
                    vault
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Arc::new(secrets::MemoryStore::default())
                }
            };
            let http = reqwest::Client::new();
            let h2 = handle.clone();
            let engine = Engine::new(
                db,
                store,
                Arc::new(TauriEvents(handle.clone())),
                Arc::new(TauriNotifier { app: handle.clone(), e2e: e2e_state.clone() }),
                Arc::new(BrowserOpener { http, e2e: e2e_state.clone() }),
                Arc::new(move |n| macos::set_badge(&h2, n)),
            );
            if let Some(e) = &e2e_state {
                #[cfg(debug_assertions)]
                {
                    *engine.google_endpoints.write() = e.gmail.endpoints();
                    *engine.sync_interval.write() = std::time::Duration::from_secs(2);
                }
                let _ = e;
            } else if let Some(n) = engine.db.kv_get("syncSeconds").ok().flatten().and_then(|v| v.as_u64()) {
                *engine.sync_interval.write() = std::time::Duration::from_secs(n.clamp(10, 3600));
            }
            #[cfg(target_os = "macos")]
            if let Some(e) = &e2e_state {
                let e = e.clone();
                macos::yield_focus_when_activated(move || {
                    e.activations.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    eprintln!("[e2e] macOS made Courier the active app; handing focus back");
                });
            }
            let state = Arc::new(AppState { engine: engine.clone(), data_dir: data_dir.clone(), e2e: e2e_state.clone(), handoff: Default::default(), pending_open: Default::default() });
            app.manage(state);
            {
                let e = engine.clone();
                tauri::async_runtime::spawn(async move { e.start() });
            }
            {
                let e = engine.clone();
                tauri::async_runtime::spawn(async move { recon::when_ready(e).await });
            }
            if recon.is_some() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_title("Courier recon test build");
                }
            }
            #[cfg(target_os = "macos")]
            {
                let e = engine.clone();
                macos::on_wake(move || e.on_wake());
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        handle_open(&h, u.as_str());
                    }
                });
            }
            let main = window_builder(&handle, "main", "index.html", "Courier", e2e_state.is_some());
            let main = if e2e_state.is_some() { main.position(40.0, 60.0) } else { main };
            let main = main.build()?;
            #[cfg(target_os = "macos")]
            {
                macos::enable_swipe_navigation(&main);
                if e2e_state.is_some() {
                    macos::order_back(&main);
                } else {
                    macos::remember_frame(&main, "CourierMain");
                }
            }
            let _ = main;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::accounts_list,
            commands::google_client_status,
            commands::google_client_set,
            commands::google_client_clear,
            commands::secrets_notice,
            commands::account_add_gmail,
            commands::account_discover,
            commands::account_test_imap,
            commands::account_add_imap,
            commands::account_update,
            commands::account_remove,
            commands::labels_list,
            commands::tab_news,
            commands::tab_seen,
            commands::label_create,
            commands::label_update,
            commands::label_delete,
            commands::list_threads,
            commands::thread_get,
            commands::message_raw,
            commands::modify_threads,
            commands::modify_messages,
            commands::change_threads,
            commands::undo_change,
            commands::delete_forever,
            commands::empty_label,
            commands::snooze_threads,
            commands::unsnooze_threads,
            commands::mute_threads,
            commands::star_message,
            commands::block_sender,
            commands::unblock_sender,
            commands::blocked_list,
            commands::send_message,
            commands::outbox_cancel,
            commands::outbox_list,
            commands::outbox_send_now,
            commands::outbox_raw,
            commands::draft_save,
            commands::draft_delete,
            commands::contacts_search,
            commands::templates_list,
            commands::template_save,
            commands::template_delete,
            commands::signatures_list,
            commands::signature_save,
            commands::signature_delete,
            commands::signature_defaults_set,
            commands::settings_all,
            commands::settings_set,
            commands::filters_list,
            commands::filter_create,
            commands::filter_delete,
            commands::server_settings_get,
            commands::server_settings_set,
            commands::sendas_list,
            commands::sendas_save,
            commands::sendas_delete,
            commands::forwarding_list,
            commands::forwarding_add,
            commands::forwarding_remove,
            commands::unsubscribe_one_click,
            commands::sender_lists,
            commands::unsubscribed_senders,
            commands::sync_now,
            commands::temp_file,
            commands::write_file,
            commands::read_file,
            commands::subscriptions,
            commands::mark_unsubscribed,
            commands::bulk_modify,
            commands::bulk_delete_forever,
            commands::clipboard_text,
            commands::save_download,
            commands::open_file,
            commands::reveal_file,
            commands::open_external,
            commands::spell_check,
            commands::share,
            commands::default_mail_app,
            commands::set_default_mail_app,
            commands::badge_refresh,
            commands::window_open,
            commands::window_take,
            commands::pending_opens,
            commands::print_window,
            commands::e2e_info,
            commands::e2e_control,
            commands::e2e_log,
            commands::e2e_finish,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Courier");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            handle_opened(app, &urls.iter().map(|u| u.to_string()).collect::<Vec<_>>());
        }
        if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
            if !has_visible_windows {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }
        let _ = (app, &event);
    });
}

#[cfg(test)]
mod open_tests {
    use super::open_item_for;

    #[test]
    fn files_handed_over_become_one_message_and_eml_files_open_to_read() {
        let items = open_item_for(&["mailto:ana@x.io?subject=Hi".into(), "file:///tmp/a.docx".into(), "file:///tmp/b%20c.pdf".into(), "file:///tmp/m.EML".into()]);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["kind"], "mailto");
        assert_eq!(items[1]["kind"], "eml");
        assert_eq!(items[2]["kind"], "attach");
        assert_eq!(items[2]["paths"].as_array().unwrap().len(), 2);
    }
}
