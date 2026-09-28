pub mod host;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use regex::Regex;
use reqwest::cookie::Jar;
use reqwest::Client;
use serde::{Deserialize, Serialize};

pub use host::{ErrorKind, HttpClients, PluginError};

use crate::db::Account;

pub const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    id: String,
    name: String,
    version: serde_json::Value,
    matches: Vec<MatchSpec>,
    account_required: bool,
    #[serde(default)]
    account: Option<AccountForm>,
    has_check: bool,
    has_check_account: bool,
}

/// Labels and hint for the account form, provided by the plugin.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountForm {
    pub user_label: Option<String>,
    pub secret_label: Option<String>,
    pub help: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MatchSpec {
    pub source: String,
    pub flags: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub matches: Vec<MatchSpec>,
    pub account_required: bool,
    pub account: Option<AccountForm>,
    pub has_check: bool,
    pub has_check_account: bool,
    pub builtin: bool,
    pub file: PathBuf,
    #[serde(skip)]
    regexes: Vec<Regex>,
    #[serde(skip)]
    code: Arc<String>,
}

impl Plugin {
    pub fn matches(&self, url: &str) -> bool {
        self.regexes.iter().any(|r| r.is_match(url))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LoadError {
    pub file: PathBuf,
    pub error: String,
}

/// What `check` returns: online state and, if known, name and size.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CheckResult {
    pub online: Option<bool>,
    pub name: Option<String>,
    pub size: Option<i64>,
}

/// What `resolve` returns: a direct URL the core can download.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub cookies: Option<serde_json::Value>,
    pub name: Option<String>,
    pub size: Option<i64>,
    pub max_connections: Option<u32>,
}

impl Resolved {
    /// Cookies as a single `Cookie` header value.
    pub fn cookie_header(&self) -> Option<String> {
        match self.cookies.as_ref()? {
            serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
            serde_json::Value::Object(map) if !map.is_empty() => Some(
                map.iter()
                    .map(|(k, v)| {
                        format!(
                            "{k}={}",
                            v.as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| v.to_string())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
            ),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountInfo {
    pub valid: bool,
    pub premium: Option<bool>,
    pub traffic_left: Option<i64>,
    pub valid_until: Option<i64>,
    pub message: Option<String>,
}

/// Decrypted account handed to plugins.
#[derive(Debug, Clone, Serialize)]
pub struct AccountCreds {
    pub id: i64,
    pub user: String,
    pub secret: String,
}

impl AccountCreds {
    pub fn from_account(a: &Account, secret: String) -> Self {
        Self {
            id: a.id,
            user: a.user.clone(),
            secret,
        }
    }
}

pub struct PluginManager {
    dirs: Vec<(PathBuf, bool)>,
    plugins: RwLock<Vec<Arc<Plugin>>>,
    errors: RwLock<Vec<LoadError>>,
    /// Cookie jars per plugin and account, so logins survive between calls.
    clients: Mutex<HashMap<String, HttpClients>>,
    direct: HttpClients,
}

fn build_clients(jar: Option<Arc<Jar>>) -> HttpClients {
    let build = |follow: bool| {
        let mut b = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(20))
            .redirect(if follow {
                reqwest::redirect::Policy::limited(10)
            } else {
                reqwest::redirect::Policy::none()
            });
        if let Some(jar) = &jar {
            b = b.cookie_provider(jar.clone());
        }
        b.build().expect("http client")
    };
    HttpClients {
        follow: build(true),
        no_follow: build(false),
    }
}

fn to_regex(m: &MatchSpec) -> Result<Regex> {
    let mut prefix = String::new();
    for f in m.flags.chars() {
        match f {
            'i' => prefix.push_str("(?i)"),
            's' => prefix.push_str("(?s)"),
            'm' => prefix.push_str("(?m)"),
            _ => {}
        }
    }
    // JS escapes `/` inside regex literals; Rust's regex does not need it.
    let source = m.source.replace("\\/", "/");
    Ok(Regex::new(&format!("{prefix}{source}"))?)
}

impl PluginManager {
    /// `dirs` in load order; later directories override plugins with the same id.
    pub fn new(dirs: Vec<(PathBuf, bool)>) -> Self {
        Self {
            dirs,
            plugins: RwLock::new(Vec::new()),
            errors: RwLock::new(Vec::new()),
            clients: Mutex::new(HashMap::new()),
            direct: build_clients(Some(Arc::new(Jar::default()))),
        }
    }

    pub async fn reload(&self) {
        let mut by_id: HashMap<String, Arc<Plugin>> = HashMap::new();
        let mut errors = Vec::new();
        for (dir, builtin) in &self.dirs {
            let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
                Ok(rd) => rd
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|e| e == "js"))
                    .collect(),
                Err(_) => continue,
            };
            files.sort();
            for file in files {
                match load_plugin(&file, *builtin).await {
                    Ok(p) => {
                        tracing::info!(id = %p.id, version = %p.version, file = %file.display(), "plugin loaded");
                        by_id.insert(p.id.clone(), Arc::new(p));
                    }
                    Err(e) => {
                        tracing::warn!(file = %file.display(), "plugin failed to load: {e:#}");
                        errors.push(LoadError {
                            file,
                            error: format!("{e:#}"),
                        });
                    }
                }
            }
        }
        let mut list: Vec<_> = by_id.into_values().collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        *self.plugins.write().unwrap() = list;
        *self.errors.write().unwrap() = errors;
    }

    pub fn list(&self) -> Vec<Arc<Plugin>> {
        self.plugins.read().unwrap().clone()
    }

    pub fn errors(&self) -> Vec<LoadError> {
        self.errors.read().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Plugin>> {
        self.plugins
            .read()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    pub fn find_for(&self, url: &str) -> Option<Arc<Plugin>> {
        self.plugins
            .read()
            .unwrap()
            .iter()
            .find(|p| p.matches(url))
            .cloned()
    }

    /// Clients for plain HTTP downloads without a plugin.
    pub fn direct_clients(&self) -> HttpClients {
        self.direct.clone()
    }

    /// Clients with the cookie jar of `plugin` + `account`.
    pub fn clients_for(&self, plugin: &str, account: Option<i64>) -> HttpClients {
        let key = format!(
            "{plugin}:{}",
            account.map(|a| a.to_string()).unwrap_or_default()
        );
        self.clients
            .lock()
            .unwrap()
            .entry(key)
            .or_insert_with(|| build_clients(Some(Arc::new(Jar::default()))))
            .clone()
    }

    /// Drops the cookie jar of an account, e.g. after its credentials changed.
    pub fn forget_account(&self, plugin: &str, account: i64) {
        self.clients
            .lock()
            .unwrap()
            .remove(&format!("{plugin}:{account}"));
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        plugin: &Plugin,
        method: &str,
        args: serde_json::Value,
        account: Option<&AccountCreds>,
    ) -> std::result::Result<T, PluginError> {
        let env = serde_json::json!({ "pluginId": plugin.id, "account": account });
        let clients = self.clients_for(&plugin.id, account.map(|a| a.id));
        let value = host::invoke(&plugin.id, &plugin.code, method, args, env, clients).await?;
        serde_json::from_value(value).map_err(|e| {
            PluginError::fatal(format!(
                "{} returned an unexpected value from {method}: {e}",
                plugin.id
            ))
        })
    }

    pub async fn check(
        &self,
        plugin: &Plugin,
        link: &str,
        account: Option<&AccountCreds>,
    ) -> std::result::Result<CheckResult, PluginError> {
        self.call(plugin, "check", serde_json::json!([link]), account)
            .await
    }

    pub async fn resolve(
        &self,
        plugin: &Plugin,
        link: &str,
        account: Option<&AccountCreds>,
    ) -> std::result::Result<Resolved, PluginError> {
        self.call(plugin, "resolve", serde_json::json!([link]), account)
            .await
    }

    pub async fn check_account(
        &self,
        plugin: &Plugin,
        account: &AccountCreds,
    ) -> std::result::Result<AccountInfo, PluginError> {
        self.call(plugin, "checkAccount", serde_json::json!([]), Some(account))
            .await
    }
}

async fn load_plugin(file: &Path, builtin: bool) -> Result<Plugin> {
    let code = tokio::fs::read_to_string(file).await?;
    let meta: Meta = serde_json::from_str(&host::read_meta(&code).await?)?;
    if meta.id.is_empty()
        || !meta
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(anyhow!("invalid plugin id {:?}", meta.id));
    }
    let regexes = meta
        .matches
        .iter()
        .map(to_regex)
        .collect::<Result<Vec<_>>>()?;
    Ok(Plugin {
        id: meta.id,
        name: meta.name,
        version: match meta.version {
            serde_json::Value::String(s) => s,
            v => v.to_string(),
        },
        matches: meta.matches,
        account_required: meta.account_required,
        account: meta.account,
        has_check: meta.has_check,
        has_check_account: meta.has_check_account,
        builtin,
        file: file.to_path_buf(),
        regexes,
        code: Arc::new(code),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_regex_to_rust() {
        let r = to_regex(&MatchSpec {
            source: r"https?:\/\/(?:www\.)?ddownload\.com\/([a-z0-9]{12})".into(),
            flags: "i".into(),
        })
        .unwrap();
        assert!(r.is_match("https://DDownload.com/abcdefghijkl"));
        assert!(!r.is_match("https://example.com/abcdefghijkl"));
    }
}
