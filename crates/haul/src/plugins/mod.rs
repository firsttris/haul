pub mod host;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use regex::Regex;
use reqwest::Client;
use reqwest_cookie_store::CookieStoreMutex;
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
    #[serde(default)]
    has_crawl: bool,
    #[serde(default)]
    serial: bool,
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
    pub has_crawl: bool,
    /// Calls without an account run one at a time as well.
    pub serial: bool,
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

/// What `crawl` returns: the files behind a folder link.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CrawlResult {
    pub package_name: Option<String>,
    pub files: Vec<CrawledFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CrawledFile {
    pub url: String,
    pub name: Option<String>,
    pub size: Option<i64>,
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
    clients: Mutex<HashMap<String, Session>>,
    direct: HttpClients,
    user_agent: String,
}

/// HTTP clients of one plugin + account and the cookie store they share.
struct Session {
    clients: HttpClients,
    cookies: Arc<CookieStoreMutex>,
    /// Plugin calls of one account run one after another, like JD's `synchronized (account)`:
    /// parallel logins or page loads of the same session confuse some hosters.
    busy: Arc<tokio::sync::Mutex<()>>,
}

fn session_key(plugin: &str, account: Option<i64>) -> String {
    format!(
        "{plugin}:{}",
        account.map(|a| a.to_string()).unwrap_or_default()
    )
}

fn build_clients(user_agent: &str, jar: Option<Arc<CookieStoreMutex>>) -> HttpClients {
    let build = |follow: bool| {
        let mut b = Client::builder()
            .user_agent(user_agent)
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
        jar,
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
    /// `user_agent` overrides the browser-like default sent to hosters.
    pub fn new(dirs: Vec<(PathBuf, bool)>, user_agent: Option<String>) -> Self {
        let user_agent = user_agent.unwrap_or_else(|| USER_AGENT.to_string());
        Self {
            dirs,
            plugins: RwLock::new(Vec::new()),
            errors: RwLock::new(Vec::new()),
            clients: Mutex::new(HashMap::new()),
            direct: build_clients(&user_agent, Some(Arc::default())),
            user_agent,
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
        self.session_parts(plugin, account).0
    }

    fn session_parts(
        &self,
        plugin: &str,
        account: Option<i64>,
    ) -> (HttpClients, Arc<tokio::sync::Mutex<()>>) {
        let mut sessions = self.clients.lock().unwrap();
        let s = sessions
            .entry(session_key(plugin, account))
            .or_insert_with(|| self.new_session(cookie_store::CookieStore::default()));
        (s.clients.clone(), s.busy.clone())
    }

    fn new_session(&self, store: cookie_store::CookieStore) -> Session {
        let cookies = Arc::new(CookieStoreMutex::new(store));
        Session {
            clients: build_clients(&self.user_agent, Some(cookies.clone())),
            cookies,
            busy: Arc::default(),
        }
    }

    /// Whether this account's session is already in memory.
    pub fn has_session(&self, plugin: &str, account: i64) -> bool {
        self.clients
            .lock()
            .unwrap()
            .contains_key(&session_key(plugin, Some(account)))
    }

    /// Restores an account's cookies saved by [`Self::session_json`], e.g. after a restart.
    pub fn restore_session(&self, plugin: &str, account: i64, json: &str) -> Result<()> {
        let store =
            cookie_store::serde::json::load_all(json.as_bytes()).map_err(|e| anyhow!("{e}"))?;
        let session = self.new_session(store);
        self.clients
            .lock()
            .unwrap()
            .insert(session_key(plugin, Some(account)), session);
        Ok(())
    }

    /// All cookies of an account's session (including session cookies), to persist them.
    pub fn session_json(&self, plugin: &str, account: i64) -> Option<String> {
        let cookies = self
            .clients
            .lock()
            .unwrap()
            .get(&session_key(plugin, Some(account)))?
            .cookies
            .clone();
        let store = cookies.lock().ok()?;
        let mut out = Vec::new();
        cookie_store::serde::json::save_incl_expired_and_nonpersistent(&store, &mut out).ok()?;
        String::from_utf8(out).ok()
    }

    /// Drops the cookie jar of an account, e.g. after its credentials changed.
    pub fn forget_account(&self, plugin: &str, account: i64) {
        self.clients
            .lock()
            .unwrap()
            .remove(&session_key(plugin, Some(account)));
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        plugin: &Plugin,
        method: &str,
        args: serde_json::Value,
        account: Option<&AccountCreds>,
    ) -> std::result::Result<T, PluginError> {
        let env = serde_json::json!({ "pluginId": plugin.id, "account": account });
        let (clients, busy) = self.session_parts(&plugin.id, account.map(|a| a.id));
        let _serial = if account.is_some() || plugin.serial {
            Some(busy.lock_owned().await)
        } else {
            None
        };
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

    /// Expands a folder link into its files; runs without an account.
    pub async fn crawl(
        &self,
        plugin: &Plugin,
        link: &str,
    ) -> std::result::Result<CrawlResult, PluginError> {
        self.call(plugin, "crawl", serde_json::json!([link]), None)
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
        has_crawl: meta.has_crawl,
        serial: meta.serial,
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

#[cfg(test)]
mod session_tests {
    use super::*;
    use axum::http::{header, HeaderMap};
    use axum::routing::get;

    /// A login sets a session cookie; after saving and restoring (= server restart) the new
    /// client must still send it.
    #[tokio::test]
    async fn session_survives_restart() {
        let app = axum::Router::new()
            .route(
                "/login",
                get(|| async {
                    (
                        [(header::SET_COOKIE, "xfss=SESSION123; path=/; HttpOnly")],
                        "ok",
                    )
                }),
            )
            .route(
                "/whoami",
                get(|h: HeaderMap| async move {
                    h.get(header::COOKIE)
                        .map(|v| v.to_str().unwrap().to_string())
                        .unwrap_or_default()
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let first = PluginManager::new(vec![], None);
        let c = first.clients_for("ddownload", Some(7));
        c.follow.get(format!("{base}/login")).send().await.unwrap();
        let saved = first.session_json("ddownload", 7).unwrap();
        assert!(saved.contains("SESSION123"));

        let restarted = PluginManager::new(vec![], Some("Test/1".into()));
        assert!(!restarted.has_session("ddownload", 7));
        restarted.restore_session("ddownload", 7, &saved).unwrap();
        let c = restarted.clients_for("ddownload", Some(7));
        let cookie = c
            .follow
            .get(format!("{base}/whoami"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(cookie, "xfss=SESSION123");
        // Other accounts do not see it.
        let other = restarted.clients_for("ddownload", Some(8));
        let cookie = other
            .follow
            .get(format!("{base}/whoami"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(cookie, "");
    }
}
