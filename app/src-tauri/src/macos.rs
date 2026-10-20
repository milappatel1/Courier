//! macOS services the web view can't reach: Dock badge, spell checking (NSSpellChecker), the Share menu,
//! the default mail app (mailto:), wake-from-sleep notifications, Quick Look and App Nap.

#[derive(serde::Serialize, Clone, Debug)]
pub struct SpellIssue {
    pub start: usize,
    pub len: usize,
    pub suggestions: Vec<String>,
}

#[cfg(target_os = "macos")]
pub fn on_main<T: Send + 'static>(app: &tauri::AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    if objc2::MainThreadMarker::new().is_some() {
        return Ok(f());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// Keeps macOS from napping the app while it works in the background (end-to-end runs).
#[cfg(target_os = "macos")]
pub fn disable_app_nap(reason: &str) {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical, &NSString::from_str(reason));
    std::mem::forget(activity);
}

/// Whether Courier is the frontmost (active) app. The end-to-end run checks this to prove it never took focus.
#[cfg(target_os = "macos")]
pub fn app_is_active() -> bool {
    objc2_app_kit::NSRunningApplication::currentApplication().isActive()
}
#[cfg(not(target_os = "macos"))]
pub fn app_is_active() -> bool {
    false
}

/// Unread count on the Dock icon (None or 0 clears it).
#[cfg(target_os = "macos")]
pub fn set_badge(app: &tauri::AppHandle, count: i64) {
    let _ = on_main(app, move || {
        use objc2_app_kit::NSApplication;
        use objc2_foundation::NSString;
        let Some(mtm) = objc2::MainThreadMarker::new() else { return };
        let ns_app = NSApplication::sharedApplication(mtm);
        let tile = ns_app.dockTile();
        let label = if count > 0 { Some(NSString::from_str(&if count > 9999 { "9999+".to_string() } else { count.to_string() })) } else { None };
        tile.setBadgeLabel(label.as_deref());
    });
}

#[cfg(target_os = "macos")]
pub fn spell_check(app: &tauri::AppHandle, texts: Vec<String>) -> Result<Vec<Vec<SpellIssue>>, String> {
    on_main(app, move || {
        use objc2_app_kit::NSSpellChecker;
        use objc2_foundation::{NSRange, NSString, NSTextCheckingType};
        let checker = NSSpellChecker::sharedSpellChecker();
        checker.setAutomaticallyIdentifiesLanguages(true);
        texts
            .iter()
            .map(|text| {
                let s = NSString::from_str(text);
                let results = unsafe {
                    checker.checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(&s, NSRange::new(0, s.length()), NSTextCheckingType::Spelling.0, None, 0, None, std::ptr::null_mut())
                };
                let mut out = Vec::new();
                for r in results.iter() {
                    if r.resultType() != NSTextCheckingType::Spelling {
                        continue;
                    }
                    let range = r.range();
                    let guesses = checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &s, None, 0).map(|g| g.iter().take(5).map(|x| x.to_string()).collect()).unwrap_or_default();
                    // UTF-16 offsets → char offsets for the web view.
                    let prefix: String = String::from_utf16_lossy(&text.encode_utf16().take(range.location).collect::<Vec<_>>());
                    let word: String = String::from_utf16_lossy(&text.encode_utf16().skip(range.location).take(range.length).collect::<Vec<_>>());
                    out.push(SpellIssue { start: prefix.chars().count(), len: word.chars().count(), suggestions: guesses });
                }
                out
            })
            .collect()
    })
}

/// Show the system Share menu for files or text at a point in the window.
#[cfg(target_os = "macos")]
pub fn share(window: &tauri::WebviewWindow, paths: Vec<String>, text: Option<String>, x: f64, y: f64) -> Result<(), String> {
    let ns_view = window.ns_view().map_err(|e| e.to_string())? as usize;
    window
        .run_on_main_thread(move || unsafe {
            use objc2::rc::Retained;
            use objc2::runtime::AnyObject;
            use objc2::AnyThread;
            use objc2_app_kit::{NSSharingServicePicker, NSView};
            use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
            let view: &NSView = &*(ns_view as *const NSView);
            let mut items: Vec<Retained<AnyObject>> = Vec::new();
            for p in &paths {
                let url = NSURL::fileURLWithPath(&NSString::from_str(p));
                items.push(Retained::into_super(Retained::into_super(url)));
            }
            if let Some(t) = &text {
                items.push(Retained::into_super(Retained::into_super(NSString::from_str(t))));
            }
            let arr = NSArray::from_retained_slice(&items);
            let picker = NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &arr);
            // The web view's coordinates are top-left based; NSView is flipped for WKWebView.
            let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(1.0, 1.0));
            picker.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MinY);
            std::mem::forget(picker);
        })
        .map_err(|e| e.to_string())
}

/// Whether Courier is the default handler for mailto: links.
#[cfg(target_os = "macos")]
pub fn is_default_mail_app() -> bool {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSString, NSURL};
    let ws = NSWorkspace::sharedWorkspace();
    let Some(probe) = NSURL::URLWithString(&NSString::from_str("mailto:someone@example.com")) else { return false };
    let Some(handler) = ws.URLForApplicationToOpenURL(&probe) else { return false };
    let ours = NSBundle::mainBundle().bundleURL();
    handler.path().map(|p| p.to_string()) == ours.path().map(|p| p.to_string())
}

/// Ask macOS to make Courier the default mail app (macOS shows its own confirmation).
#[cfg(target_os = "macos")]
pub fn set_default_mail_app(app: &tauri::AppHandle) -> Result<(), String> {
    on_main(app, || {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSBundle, NSString};
        let ws = NSWorkspace::sharedWorkspace();
        let ours = NSBundle::mainBundle().bundleURL();
        ws.setDefaultApplicationAtURL_toOpenURLsWithScheme_completionHandler(&ours, &NSString::from_str("mailto"), None);
    })
}

/// Call `f` after the Mac wakes from sleep (sync and IDLE reconnect).
#[cfg(target_os = "macos")]
pub fn on_wake(f: impl Fn() + Send + Sync + 'static) {
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;
    let block = block2::RcBlock::new(move |_n: std::ptr::NonNull<NSNotification>| f());
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &block) };
    std::mem::forget(token);
    std::mem::forget(block);
}

/// End-to-end runs only: if macOS makes Courier the active app anyway, hand the focus straight back (hiding the
/// app returns activation to the app the user was in), show the window again without activating, and report it
/// so the run fails.
#[cfg(target_os = "macos")]
pub fn yield_focus_when_activated(on_activated: impl Fn() + 'static) {
    use objc2_app_kit::{NSApplication, NSApplicationDidBecomeActiveNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    let block = block2::RcBlock::new(move |_n: std::ptr::NonNull<NSNotification>| {
        on_activated();
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            app.hide(None);
            app.unhideWithoutActivation();
            for w in app.windows().iter() {
                w.orderBack(None);
            }
        }
    });
    let center = NSNotificationCenter::defaultCenter();
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSApplicationDidBecomeActiveNotification), None, None, &block) };
    std::mem::forget(token);
    std::mem::forget(block);
}

/// End-to-end runs only: put the window behind every other window, so it can't be clicked by accident.
#[cfg(target_os = "macos")]
pub fn order_back(window: &tauri::WebviewWindow) {
    if let Ok(ptr) = window.ns_window() {
        // Called on the main thread from setup; the pointer is the live NSWindow.
        let w = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
        w.orderBack(None);
    }
}

/// Two-finger swipes go back and forward, as in Safari and the web client (Courier's screens are history entries).
/// Tauri doesn't pass this WebKit option through yet, so it's set on the native web view.
#[cfg(target_os = "macos")]
pub fn enable_swipe_navigation(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|pv| {
        let wk = pv.inner() as *mut objc2::runtime::AnyObject;
        if !wk.is_null() {
            // SAFETY: on macOS `inner()` is the live WKWebView, and this runs on the main thread.
            unsafe {
                let _: () = objc2::msg_send![&*wk, setAllowsBackForwardNavigationGestures: true];
            }
        }
    });
}


/// Read back the setting above (end-to-end check).
#[cfg(target_os = "macos")]
pub async fn swipe_navigation_enabled(window: &tauri::WebviewWindow) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _ = window.with_webview(move |pv| {
        let wk = pv.inner() as *mut objc2::runtime::AnyObject;
        // SAFETY: as above.
        let on: bool = !wk.is_null() && unsafe { objc2::msg_send![&*wk, allowsBackForwardNavigationGestures] };
        let _ = tx.send(on);
    });
    rx.await.unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn set_badge(_app: &tauri::AppHandle, _count: i64) {}
