//! Secrets (OAuth tokens, app passwords, the Google client) live in the macOS Keychain as generic
//! passwords under one service name. The end-to-end run uses an in-memory store so it never touches the
//! user's Keychain.

use crate::error::{Error, Result};
use parking_lot::Mutex;
use std::collections::HashMap;

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
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

#[cfg(target_os = "macos")]
pub struct KeychainStore {
    service: String,
}

#[cfg(target_os = "macos")]
impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        KeychainStore { service: service.into() }
    }
}

#[cfg(target_os = "macos")]
impl SecretStore for KeychainStore {
    fn get(&self, key: &str) -> Result<Option<String>> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(&self.service, key) {
            Ok(bytes) => Ok(Some(String::from_utf8(bytes).map_err(|e| Error::msg(e.to_string()))?)),
            Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
            Err(e) => Err(Error::msg(format!("Keychain: {e}"))),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        security_framework::passwords::set_generic_password(&self.service, key, value.as_bytes()).map_err(|e| Error::msg(format!("Keychain: {e}")))
    }
    fn delete(&self, key: &str) -> Result<()> {
        match security_framework::passwords::delete_generic_password(&self.service, key) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(e) => Err(Error::msg(format!("Keychain: {e}"))),
        }
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
