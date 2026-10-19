//! Secrets (OAuth tokens, app passwords, the Google client) live in the macOS Keychain, all in one item (see
//! `VaultStore`). The end-to-end run uses an in-memory store so it never touches the user's Keychain.

use crate::error::{Error, Result};
use parking_lot::Mutex;
use std::collections::HashMap;

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
    /// A message for the user when saved secrets couldn't be opened (waits for the first load).
    fn notice(&self) -> Option<String> {
        None
    }
}

pub const SERVICE: &str = "com.milappatel.courier";

/// Keys used across the app.
pub fn oauth_key(account_id: &str) -> String {
    format!("oauth:{account_id}")
}
pub fn password_key(account_id: &str) -> String {
    format!("password:{account_id}")
}
pub fn smtp_password_key(account_id: &str) -> String {
    format!("smtp-password:{account_id}")
}
pub const GOOGLE_CLIENT_KEY: &str = "google-client";

// ---- the Keychain vault ----
//
// Every secret lives in ONE Keychain item (a JSON map), read once per launch and kept in memory, with access
// serialised so two requests never put up two prompts. macOS asks for the Keychain password when a different app
// reads an item, and an ad-hoc-signed update counts as a different app, so:
// - after an update the vault read may prompt once (the only prompt Courier ever causes); it is then re-saved as a
//   new item made by this build, so later launches don't ask again; clean-up of old items never prompts;
// - secrets 1.0 kept one per item are brought over only where macOS allows it without asking (an item per prompt
//   was a stream of prompts); the rest just mean signing in again;
// - if access is refused, that's remembered (no prompt every sync); accounts then ask to sign in again, and the
//   next save starts a new item instead of touching the one Courier can't open.
// The item's generation and the build that wrote it are kept in a small state file next to the database (no secrets).

/// What a raw Keychain call can say besides success.
#[derive(Debug)]
pub enum RawError {
    NotFound,
    /// Refused, cancelled, wrong Keychain password, or any other failure: don't retry on our own.
    Refused(String),
}

/// The few Keychain operations the vault needs (a fake stands in for tests).
pub trait RawKeychain: Send + Sync {
    fn read(&self, account: &str) -> std::result::Result<Vec<u8>, RawError>;
    /// Add the item, or replace the data of one this build made.
    fn write(&self, account: &str, data: &[u8]) -> std::result::Result<(), RawError>;
    fn remove(&self, account: &str) -> std::result::Result<(), RawError>;
    /// Like `read`, but never puts up a prompt: an item that would need one is reported as refused.
    fn read_quiet(&self, account: &str) -> std::result::Result<Vec<u8>, RawError> {
        self.read(account)
    }
    /// Like `remove`, but never puts up a prompt (housekeeping only).
    fn remove_quiet(&self, account: &str) -> std::result::Result<(), RawError> {
        self.remove(account)
    }
}

#[cfg(target_os = "macos")]
pub struct LoginKeychain {
    service: String,
    /// None = the user's default (login) keychain; tests pass a throwaway keychain file.
    keychain: Option<security_framework::os::macos::keychain::SecKeychain>,
}

#[cfg(target_os = "macos")]
impl LoginKeychain {
    pub fn new(service: impl Into<String>) -> Self {
        LoginKeychain { service: service.into(), keychain: None }
    }
    pub fn in_keychain(service: impl Into<String>, keychain: security_framework::os::macos::keychain::SecKeychain) -> Self {
        LoginKeychain { service: service.into(), keychain: Some(keychain) }
    }
    fn find(&self, account: &str) -> std::result::Result<(Vec<u8>, security_framework::os::macos::keychain_item::SecKeychainItem), RawError> {
        let list = self.keychain.as_ref().map(std::slice::from_ref);
        match security_framework::os::macos::passwords::find_generic_password(list, &self.service, account) {
            Ok((pw, item)) => Ok((pw.to_vec(), item)),
            Err(e) if e.code() == -25300 => Err(RawError::NotFound),
            Err(e) => Err(RawError::Refused(format!("{e} ({})", e.code()))),
        }
    }
}

// The Keychain API is thread-safe, and the vault only calls it under its own lock.
#[cfg(target_os = "macos")]
unsafe impl Send for LoginKeychain {}
#[cfg(target_os = "macos")]
unsafe impl Sync for LoginKeychain {}

#[cfg(target_os = "macos")]
impl RawKeychain for LoginKeychain {
    fn read(&self, account: &str) -> std::result::Result<Vec<u8>, RawError> {
        self.find(account).map(|(data, _)| data)
    }
    fn write(&self, account: &str, data: &[u8]) -> std::result::Result<(), RawError> {
        let refused = |e: security_framework::base::Error| RawError::Refused(format!("{e} ({})", e.code()));
        match self.find(account) {
            Ok((_, mut item)) => item.set_password(data).map_err(refused),
            Err(RawError::NotFound) => {
                let kc = match &self.keychain {
                    Some(k) => k.clone(),
                    None => security_framework::os::macos::keychain::SecKeychain::default().map_err(refused)?,
                };
                kc.add_generic_password(&self.service, account, data).map_err(refused)
            }
            Err(e) => Err(e),
        }
    }
    fn remove(&self, account: &str) -> std::result::Result<(), RawError> {
        match self.find(account) {
            Ok((_, item)) => {
                item.delete();
                Ok(())
            }
            Err(RawError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }
    fn read_quiet(&self, account: &str) -> std::result::Result<Vec<u8>, RawError> {
        let _no_prompts = security_framework::os::macos::keychain::SecKeychain::disable_user_interaction().map_err(|e| RawError::Refused(e.to_string()))?;
        self.read(account)
    }
    fn remove_quiet(&self, account: &str) -> std::result::Result<(), RawError> {
        let _no_prompts = security_framework::os::macos::keychain::SecKeychain::disable_user_interaction().map_err(|e| RawError::Refused(e.to_string()))?;
        self.remove(account)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct VaultState {
    generation: u32,
    build: String,
}

#[derive(Default)]
struct Vault {
    loaded: bool,
    map: std::collections::BTreeMap<String, String>,
    generation: u32,
    /// The current generation's item exists but couldn't be opened: the next save starts a new one.
    unreadable: bool,
    notice: Option<String>,
}

pub struct VaultStore {
    raw: Box<dyn RawKeychain>,
    state_path: std::path::PathBuf,
    build: String,
    legacy_keys: Vec<String>,
    inner: Mutex<Vault>,
}

fn vault_item(generation: u32) -> String {
    format!("vault-{generation}")
}

/// Identifies this build of the app (its executable's size and modification time), so the vault knows when an
/// update has to re-save it.
pub fn current_build_id() -> String {
    std::env::current_exe()
        .and_then(std::fs::metadata)
        .map(|m| {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            format!("{}-{t}", m.len())
        })
        .unwrap_or_default()
}

impl VaultStore {
    /// `legacy_keys`: secrets 1.0.x kept one per Keychain item, brought over on the first launch.
    pub fn new(raw: Box<dyn RawKeychain>, state_path: impl Into<std::path::PathBuf>, build: impl Into<String>, legacy_keys: Vec<String>) -> Self {
        VaultStore { raw, state_path: state_path.into(), build: build.into(), legacy_keys, inner: Mutex::new(Vault::default()) }
    }

    fn ensure_loaded(&self, v: &mut Vault) {
        if v.loaded {
            return;
        }
        v.loaded = true;
        let st: VaultState = std::fs::read(&self.state_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        v.generation = st.generation;
        if st.generation > 0 {
            match self.raw.read(&vault_item(st.generation)) {
                Ok(bytes) => {
                    v.map = serde_json::from_slice(&bytes).unwrap_or_default();
                    if st.build != self.build {
                        // Written by another build: save it again as an item made by this one.
                        let old = st.generation;
                        v.generation = old + 1;
                        if self.persist(v).is_ok() {
                            let _ = self.raw.remove_quiet(&vault_item(old));
                        } else {
                            v.generation = old;
                        }
                    }
                }
                Err(RawError::NotFound) => {}
                Err(RawError::Refused(why)) => self.refused(v, &why),
            }
        } else {
            let mut migrated = Vec::new();
            let mut skipped = false;
            for k in &self.legacy_keys {
                match self.raw.read_quiet(k) {
                    Ok(bytes) => {
                        if let Ok(s) = String::from_utf8(bytes) {
                            v.map.insert(k.clone(), s);
                            migrated.push(k.clone());
                        }
                    }
                    Err(RawError::NotFound) => {}
                    Err(RawError::Refused(_)) => skipped = true,
                }
            }
            if skipped {
                v.notice = Some("Courier now keeps its saved sign-ins in one place in your Keychain. Some couldn't be moved without asking for your Keychain password, so those accounts will ask you to sign in again.".into());
            }
            if !v.map.is_empty() && self.persist(v).is_ok() {
                for k in migrated {
                    let _ = self.raw.remove_quiet(&k);
                }
            }
        }
    }

    fn refused(&self, v: &mut Vault, why: &str) {
        v.unreadable = true;
        v.map.clear();
        v.notice = Some(format!(
            "Courier couldn't open its saved sign-ins in your Keychain ({why}). Accounts that need them will ask you to sign in again."
        ));
    }

    fn persist(&self, v: &mut Vault) -> Result<()> {
        if v.generation == 0 || v.unreadable {
            // Never write over an item Courier can't open: start a new one.
            v.generation += 1;
        }
        let data = serde_json::to_vec(&v.map)?;
        match self.raw.write(&vault_item(v.generation), &data) {
            Ok(()) => {}
            Err(RawError::NotFound) => return Err(Error::msg("Keychain: item vanished")),
            Err(RawError::Refused(why)) => return Err(Error::msg(format!("Couldn't save to the Keychain: {why}"))),
        }
        v.unreadable = false;
        let st = VaultState { generation: v.generation, build: self.build.clone() };
        if let Some(dir) = self.state_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.state_path, serde_json::to_vec(&st)?)?;
        Ok(())
    }
}

impl SecretStore for VaultStore {
    fn notice(&self) -> Option<String> {
        let mut v = self.inner.lock();
        self.ensure_loaded(&mut v);
        v.notice.clone()
    }
    fn get(&self, key: &str) -> Result<Option<String>> {
        let mut v = self.inner.lock();
        self.ensure_loaded(&mut v);
        Ok(v.map.get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut v = self.inner.lock();
        self.ensure_loaded(&mut v);
        let before = v.map.insert(key.to_string(), value.to_string());
        if let Err(e) = self.persist(&mut v) {
            match before {
                Some(b) => v.map.insert(key.to_string(), b),
                None => v.map.remove(key),
            };
            return Err(e);
        }
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        let mut v = self.inner.lock();
        self.ensure_loaded(&mut v);
        if v.map.remove(key).is_some() {
            self.persist(&mut v)?;
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.map.lock().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.map.lock().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.map.lock().remove(key);
        Ok(())
    }
}

/// Remove every secret that belongs to an account (sign-out).
pub fn forget_account(store: &dyn SecretStore, account_id: &str) -> Result<()> {
    store.delete(&oauth_key(account_id))?;
    store.delete(&password_key(account_id))?;
    store.delete(&smtp_password_key(account_id))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Behaves like the login keychain for one app: reading an item another build made puts up a prompt, which
    /// the test either allows or refuses; changing or deleting such an item does too.
    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<String, (Vec<u8>, String)>>,
        reads: AtomicUsize,
        prompts: AtomicUsize,
    }
    struct As {
        fake: Arc<Fake>,
        build: String,
        refuse: bool,
    }
    impl As {
        fn prompt(&self, creator: &str) -> std::result::Result<(), RawError> {
            if creator == self.build {
                return Ok(());
            }
            self.fake.prompts.fetch_add(1, Ordering::SeqCst);
            if self.refuse { Err(RawError::Refused("denied (-25293)".into())) } else { Ok(()) }
        }
    }
    impl As {
        /// What macOS does with interaction disabled: anything that would prompt fails at once.
        fn quiet(&self, account: &str) -> std::result::Result<(), RawError> {
            match self.fake.items.lock().get(account) {
                Some((_, creator)) if *creator != self.build => Err(RawError::Refused("interaction not allowed (-25308)".into())),
                _ => Ok(()),
            }
        }
    }
    impl RawKeychain for As {
        fn read_quiet(&self, account: &str) -> std::result::Result<Vec<u8>, RawError> {
            self.quiet(account)?;
            self.read(account)
        }
        fn remove_quiet(&self, account: &str) -> std::result::Result<(), RawError> {
            self.quiet(account)?;
            self.remove(account)
        }
        fn read(&self, account: &str) -> std::result::Result<Vec<u8>, RawError> {
            self.fake.reads.fetch_add(1, Ordering::SeqCst);
            let item = self.fake.items.lock().get(account).cloned().ok_or(RawError::NotFound)?;
            self.prompt(&item.1)?;
            Ok(item.0)
        }
        fn write(&self, account: &str, data: &[u8]) -> std::result::Result<(), RawError> {
            let existing = self.fake.items.lock().get(account).map(|i| i.1.clone());
            if let Some(creator) = &existing {
                self.prompt(creator)?;
            }
            self.fake.items.lock().insert(account.into(), (data.to_vec(), existing.unwrap_or_else(|| self.build.clone())));
            Ok(())
        }
        fn remove(&self, account: &str) -> std::result::Result<(), RawError> {
            let existing = self.fake.items.lock().get(account).map(|i| i.1.clone());
            if let Some(creator) = existing {
                self.prompt(&creator)?;
                self.fake.items.lock().remove(account);
            }
            Ok(())
        }
    }

    fn open(fake: &Arc<Fake>, dir: &std::path::Path, build: &str, refuse: bool, legacy: &[&str]) -> VaultStore {
        VaultStore::new(
            Box::new(As { fake: fake.clone(), build: build.into(), refuse }),
            dir.join("vault.json"),
            build,
            legacy.iter().map(|s| s.to_string()).collect(),
        )
    }

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("courier-vault-{}", crate::error::random_token(8)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn one_item_read_once_and_no_prompts_for_the_same_build() {
        let (fake, dir) = (Arc::new(Fake::default()), tmp());
        let v = open(&fake, &dir, "A", false, &[]);
        v.set("google-client", "{}").unwrap();
        v.set("oauth:g1", "tokens").unwrap();
        assert_eq!(fake.items.lock().len(), 1, "all secrets share one item");
        let again = open(&fake, &dir, "A", false, &[]);
        for _ in 0..20 {
            assert_eq!(again.get("oauth:g1").unwrap().as_deref(), Some("tokens"));
        }
        assert_eq!(fake.reads.load(Ordering::SeqCst), 1, "read once per launch");
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 0);
        again.delete("oauth:g1").unwrap();
        assert_eq!(open(&fake, &dir, "A", false, &[]).get("oauth:g1").unwrap(), None);
    }

    #[test]
    fn after_an_update_one_prompt_then_none() {
        let (fake, dir) = (Arc::new(Fake::default()), tmp());
        open(&fake, &dir, "A", false, &[]).set("oauth:g1", "tokens").unwrap();
        let b = open(&fake, &dir, "B", false, &[]);
        assert_eq!(b.get("oauth:g1").unwrap().as_deref(), Some("tokens"));
        assert_eq!(b.get("oauth:g1").unwrap().as_deref(), Some("tokens"));
        // One prompt to read A's item; clearing it away afterwards never asks.
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 1);
        assert!(fake.items.lock().get("vault-2").is_some_and(|i| i.1 == "B"), "re-saved by the new build");
        let b2 = open(&fake, &dir, "B", false, &[]);
        assert_eq!(b2.get("oauth:g1").unwrap().as_deref(), Some("tokens"));
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 1, "no prompt on the next launch");
    }

    #[test]
    fn refused_once_is_remembered_and_signing_in_again_works() {
        let (fake, dir) = (Arc::new(Fake::default()), tmp());
        open(&fake, &dir, "A", false, &[]).set("oauth:g1", "old").unwrap();
        let b = open(&fake, &dir, "B", true, &[]);
        for _ in 0..10 {
            assert_eq!(b.get("oauth:g1").unwrap(), None);
        }
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 1, "no prompt storm");
        assert!(b.notice().unwrap().contains("sign in again"));
        // Signing in again saves to a new item without touching the one it can't open.
        b.set("oauth:g1", "new").unwrap();
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 1);
        assert_eq!(fake.items.lock().len(), 2);
        let b2 = open(&fake, &dir, "B", true, &[]);
        assert_eq!(b2.get("oauth:g1").unwrap().as_deref(), Some("new"));
        assert_eq!(b2.notice(), None);
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn secrets_from_1_0_items_move_into_the_vault() {
        let (fake, dir) = (Arc::new(Fake::default()), tmp());
        for (k, val) in [("google-client", "client"), ("oauth:g1", "tokens")] {
            fake.items.lock().insert(k.into(), (val.as_bytes().to_vec(), "B".into()));
        }
        let v = open(&fake, &dir, "B", false, &["google-client", "oauth:g1", "password:g1"]);
        assert_eq!(v.get("google-client").unwrap().as_deref(), Some("client"));
        assert_eq!(v.get("oauth:g1").unwrap().as_deref(), Some("tokens"));
        let items = fake.items.lock();
        assert_eq!(items.keys().cloned().collect::<Vec<_>>(), vec!["vault-1".to_string()], "old items removed");
    }

    #[test]
    fn items_from_another_build_move_only_where_no_prompt_is_needed() {
        let (fake, dir) = (Arc::new(Fake::default()), tmp());
        // The user already allowed this build to read the client; the tokens would need a prompt.
        fake.items.lock().insert("google-client".into(), (b"client".to_vec(), "B".into()));
        fake.items.lock().insert("oauth:g1".into(), (b"tokens".to_vec(), "A".into()));
        let v = open(&fake, &dir, "B", false, &["google-client", "oauth:g1", "password:g1"]);
        assert_eq!(v.get("google-client").unwrap().as_deref(), Some("client"));
        assert_eq!(v.get("oauth:g1").unwrap(), None, "needs signing in again");
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 0, "no prompts at all");
        assert!(v.notice().unwrap().contains("sign in again"));
        // Signing in again stores the tokens in the vault; the next launch asks nothing.
        v.set("oauth:g1", "fresh").unwrap();
        let again = open(&fake, &dir, "B", false, &[]);
        assert_eq!(again.get("oauth:g1").unwrap().as_deref(), Some("fresh"));
        assert_eq!(fake.prompts.load(Ordering::SeqCst), 0);
    }
}
