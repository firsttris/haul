//! Queue manager: decides which downloads run, keeps live progress and exposes the
//! operations the API needs (add, pause, resume, delete, online check).

pub mod extract;
mod limiter;
mod worker;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures::StreamExt;
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::crypto::SecretBox;
use crate::db::{self, status, Db, Download, Settings};
use crate::events::{Event, Events, ExtractProgress, ProgressItem, Topic};
use crate::plugins::{AccountCreds, ErrorKind, PluginManager};
use crate::util::{self, now_ms};

pub use limiter::Limiter;

/// Live counters of a running download, shared between worker and progress ticker.
#[derive(Default)]
pub struct Progress {
    pub done: AtomicU64,
    /// -1 while unknown.
    pub size: AtomicI64,
}

struct Active {
    cancel: CancellationToken,
    progress: Arc<Progress>,
    /// Flips to true when the worker task has exited.
    exited: watch::Receiver<bool>,
}

pub struct Engine {
    pub db: Db,
    pub cfg: Config,
    pub plugins: Arc<PluginManager>,
    pub events: Events,
    pub secrets: SecretBox,
    settings: RwLock<Settings>,
    active: Mutex<HashMap<i64, Active>>,
    wake: Notify,
    limiter: Limiter,
    shutdown: CancellationToken,
    /// Extraction progress per folder (relative to the done folder) and its package.
    extracting: Mutex<HashMap<String, (Option<i64>, u8)>>,
    /// Last extraction error of folders without a package (Fertig view).
    pub(crate) folder_errors: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AddLinks {
    pub links: String,
    pub package_name: Option<String>,
    pub target_dir: Option<String>,
    /// Queue immediately instead of keeping the links in the Linksammler.
    pub start: bool,
    pub source: Option<String>,
    pub source_page: Option<String>,
    pub passwords: Option<String>,
}

impl Engine {
    pub async fn new(
        db: Db,
        cfg: Config,
        plugins: Arc<PluginManager>,
        events: Events,
    ) -> Result<Arc<Self>> {
        let settings = Settings::load(&db).await?;
        let limiter = Limiter::new(settings.speed_limit_kib);
        // Anything that was running when the process stopped goes back to the queue;
        // segment progress in the database makes it resume where it left off.
        sqlx::query("UPDATE downloads SET status = ? WHERE status IN (?, ?)")
            .bind(status::QUEUED)
            .bind(status::RESOLVING)
            .bind(status::DOWNLOADING)
            .execute(&db)
            .await?;
        sqlx::query("UPDATE packages SET extract = 'pending' WHERE extract = 'running'")
            .execute(&db)
            .await?;
        Ok(Arc::new(Self {
            secrets: SecretBox::new(&cfg.app_secret),
            db,
            cfg,
            plugins,
            events,
            settings: RwLock::new(settings),
            active: Mutex::new(HashMap::new()),
            wake: Notify::new(),
            limiter,
            shutdown: CancellationToken::new(),
            extracting: Mutex::new(HashMap::new()),
            folder_errors: Mutex::new(HashMap::new()),
        }))
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    pub async fn update_settings(&self, s: Settings) -> Result<Settings> {
        let s = s.clamp();
        s.save(&self.db).await?;
        self.limiter.set_limit(s.speed_limit_kib);
        *self.settings.write().unwrap() = s.clone();
        self.events.changed(Topic::Settings);
        self.wake.notify_one();
        Ok(s)
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn set_extract_progress(
        &self,
        rel: &str,
        package_id: Option<i64>,
        percent: Option<u8>,
    ) {
        let mut map = self.extracting.lock().unwrap();
        match percent {
            Some(p) => {
                map.insert(rel.to_string(), (package_id, p));
            }
            None => {
                map.remove(rel);
            }
        }
    }

    pub fn extract_progress_of(&self, rel: &str) -> Option<u8> {
        self.extracting.lock().unwrap().get(rel).map(|(_, p)| *p)
    }

    pub fn active_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }

    pub fn tmp_path(&self, id: i64) -> PathBuf {
        self.cfg.tmp_dir.join(format!("{id}.part"))
    }

    pub fn package_dir(&self, pkg: &db::Package) -> PathBuf {
        let rel = util::sanitize_rel_dir(&pkg.target_dir);
        if rel.is_empty() {
            self.cfg.done_dir.clone()
        } else {
            self.cfg.done_dir.join(rel)
        }
    }

    /// Scheduler loop plus the progress ticker. Runs until shutdown.
    pub async fn run(self: Arc<Self>) {
        let ticker = tokio::spawn(self.clone().progress_loop());
        let this = self.clone();
        tokio::spawn(async move { this.resume_pending_extractions().await });
        loop {
            if let Err(e) = self.fill_slots().await {
                tracing::error!("scheduler: {e:#}");
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            }
        }
        ticker.abort();
    }

    /// Stops all workers and waits until they have written their progress.
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let waits: Vec<_> = {
            let active = self.active.lock().unwrap();
            active
                .values()
                .map(|a| {
                    a.cancel.cancel();
                    a.exited.clone()
                })
                .collect()
        };
        for mut w in waits {
            let _ = tokio::time::timeout(Duration::from_secs(10), w.wait_for(|x| *x)).await;
        }
    }

    async fn fill_slots(self: &Arc<Self>) -> Result<()> {
        if self.shutdown.is_cancelled() {
            return Ok(());
        }
        let max = self.settings().max_parallel as usize;
        let running = self.active_count();
        if running >= max {
            return Ok(());
        }
        let ids: Vec<i64> = sqlx::query_scalar(
            "SELECT d.id FROM downloads d JOIN packages p ON p.id = d.package_id
             WHERE d.status = ? AND (d.retry_at IS NULL OR d.retry_at <= ?)
             ORDER BY p.id, d.id LIMIT ?",
        )
        .bind(status::QUEUED)
        .bind(now_ms())
        .bind((max - running + 8) as i64)
        .fetch_all(&self.db)
        .await?;
        let mut started = 0;
        for id in ids {
            if running + started >= max {
                break;
            }
            if self.start_worker(id) {
                started += 1;
            }
        }
        Ok(())
    }

    fn start_worker(self: &Arc<Self>, id: i64) -> bool {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(&id) {
            return false;
        }
        let cancel = self.shutdown.child_token();
        let progress = Arc::new(Progress {
            done: AtomicU64::new(0),
            size: AtomicI64::new(-1),
        });
        let (tx, rx) = watch::channel(false);
        active.insert(
            id,
            Active {
                cancel: cancel.clone(),
                progress: progress.clone(),
                exited: rx,
            },
        );
        drop(active);
        let this = self.clone();
        tokio::spawn(async move {
            worker::run(&this, id, &cancel, &progress).await;
            this.active.lock().unwrap().remove(&id);
            let _ = tx.send(true);
            this.events.changed(Topic::Downloads);
            this.wake.notify_one();
        });
        true
    }

    /// Cancels a running worker and waits until it has persisted its state.
    async fn stop_worker(&self, id: i64) {
        let exited = {
            let active = self.active.lock().unwrap();
            active.get(&id).map(|a| {
                a.cancel.cancel();
                a.exited.clone()
            })
        };
        if let Some(mut rx) = exited {
            let _ = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|x| *x)).await;
        }
    }

    async fn progress_loop(self: Arc<Self>) {
        let mut last: HashMap<i64, (u64, f64)> = HashMap::new();
        let mut extracted_before = false;
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let snapshot: Vec<(i64, u64, i64)> = {
                let active = self.active.lock().unwrap();
                active
                    .iter()
                    .map(|(id, a)| {
                        (
                            *id,
                            a.progress.done.load(Ordering::Relaxed),
                            a.progress.size.load(Ordering::Relaxed),
                        )
                    })
                    .collect()
            };
            let mut items = Vec::with_capacity(snapshot.len());
            let mut next = HashMap::new();
            let mut total = 0u64;
            for (id, done, size) in snapshot {
                let (prev_done, prev_speed) = last.get(&id).copied().unwrap_or((done, 0.0));
                let delta = done.saturating_sub(prev_done) as f64;
                // Exponential moving average keeps the number readable.
                let speed = if prev_speed == 0.0 {
                    delta
                } else {
                    prev_speed * 0.6 + delta * 0.4
                };
                next.insert(id, (done, speed));
                total += speed as u64;
                items.push(ProgressItem {
                    id,
                    bytes_done: done,
                    size: (size >= 0).then_some(size as u64),
                    speed: speed as u64,
                });
            }
            last = next;
            let extract: Vec<ExtractProgress> = self
                .extracting
                .lock()
                .unwrap()
                .iter()
                .map(|(path, &(package_id, percent))| ExtractProgress {
                    path: path.clone(),
                    package_id,
                    percent,
                })
                .collect();
            if !items.is_empty() || !last.is_empty() || !extract.is_empty() || extracted_before {
                self.events.send(Event::Progress {
                    items,
                    total_speed: total,
                    extract: extract.clone(),
                });
            }
            extracted_before = !extract.is_empty();
        }
    }

    /// Current total speed in bytes/s (sum of the last progress tick's per-download speed
    /// is kept in the UI; this is a cheap fallback for `/api/stats`).
    pub fn live_bytes(&self) -> HashMap<i64, u64> {
        let active = self.active.lock().unwrap();
        active
            .iter()
            .map(|(id, a)| (*id, a.progress.done.load(Ordering::Relaxed)))
            .collect()
    }

    pub async fn pick_account(&self, plugin_id: &str) -> Result<Option<AccountCreds>> {
        let acc: Option<db::Account> = sqlx::query_as(
            "SELECT * FROM accounts WHERE plugin_id = ? AND enabled = 1 AND status != 'invalid'
             ORDER BY traffic_left IS NULL, traffic_left DESC, id LIMIT 1",
        )
        .bind(plugin_id)
        .fetch_optional(&self.db)
        .await?;
        match acc {
            Some(a) => Ok(Some(self.account_creds(&a)?)),
            None => Ok(None),
        }
    }

    /// Decrypts an account for a plugin call and brings back its saved session, so a login
    /// survives restarts (like JD's saved account cookies).
    pub fn account_creds(&self, a: &db::Account) -> Result<AccountCreds> {
        if !self.plugins.has_session(&a.plugin_id, a.id) {
            if let Some(stored) = &a.session {
                let restored = self
                    .secrets
                    .decrypt(stored)
                    .and_then(|json| self.plugins.restore_session(&a.plugin_id, a.id, &json));
                if let Err(e) = restored {
                    tracing::warn!(account = a.id, "saved session not usable: {e:#}");
                }
            }
        }
        let secret = self.secrets.decrypt(&a.secret)?;
        Ok(AccountCreds::from_account(a, secret))
    }

    /// Persists an account's cookies after a plugin call.
    pub async fn save_session(&self, plugin_id: &str, account: i64) {
        let Some(json) = self.plugins.session_json(plugin_id, account) else {
            return;
        };
        let saved = match self.secrets.encrypt(&json) {
            Ok(enc) => sqlx::query("UPDATE accounts SET session = ? WHERE id = ?")
                .bind(enc)
                .bind(account)
                .execute(&self.db)
                .await
                .map(|_| ()),
            Err(e) => {
                tracing::warn!(account, "cannot encrypt session: {e:#}");
                return;
            }
        };
        if let Err(e) = saved {
            tracing::warn!(account, "cannot save session: {e:#}");
        }
    }

    // ---- operations used by the API ------------------------------------------------

    pub async fn add_links(self: &Arc<Self>, req: AddLinks) -> Result<i64> {
        let links = parse_links(&req.links);
        if links.is_empty() {
            return Err(anyhow!("keine gültigen Links gefunden"));
        }
        let names: Vec<String> = links
            .iter()
            .map(|l| util::filename_from_url(l).unwrap_or_else(|| "download".into()))
            .collect();
        let name = req
            .package_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| guess_package_name(&names));
        let target_dir = req
            .target_dir
            .filter(|d| !d.trim().is_empty())
            .map(|d| util::sanitize_rel_dir(&d))
            .unwrap_or_else(|| util::sanitize_filename(&name));
        let now = now_ms();
        let mut tx = self.db.begin().await?;
        let pkg_id: i64 = sqlx::query_scalar(
            "INSERT INTO packages(name, target_dir, source, source_page, passwords, collector, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(&name)
        .bind(&target_dir)
        .bind(req.source.as_deref().unwrap_or("manual"))
        .bind(&req.source_page)
        .bind(req.passwords.as_deref().filter(|p| !p.trim().is_empty()))
        .bind(!req.start)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        for (link, fname) in links.iter().zip(names) {
            let plugin = self.plugins.find_for(link).map(|p| p.id.clone());
            sqlx::query(
                "INSERT INTO downloads(package_id, url, plugin_id, status, name, created_at) VALUES(?, ?, ?, ?, ?, ?)",
            )
            .bind(pkg_id)
            .bind(link)
            .bind(plugin)
            .bind(if req.start { status::QUEUED } else { status::COLLECTED })
            .bind(fname)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.events.changed(Topic::Downloads);
        if req.start {
            self.wake();
        } else {
            let this = self.clone();
            tokio::spawn(async move {
                if let Err(e) = this.check_package(pkg_id).await {
                    tracing::warn!("online check: {e:#}");
                }
            });
        }
        Ok(pkg_id)
    }

    /// Online check for all downloads of a package: plugin `check` or an HTTP probe.
    pub async fn check_package(self: &Arc<Self>, package_id: i64) -> Result<()> {
        let downloads = db::package_downloads(&self.db, package_id).await?;
        futures::stream::iter(downloads)
            .for_each_concurrent(4, |d| {
                let this = self.clone();
                async move {
                    if let Err(e) = this.check_download(&d).await {
                        tracing::debug!(id = d.id, "check failed: {e:#}");
                    }
                }
            })
            .await;
        self.events.changed(Topic::Downloads);
        Ok(())
    }

    async fn check_download(&self, d: &Download) -> Result<()> {
        let plugin = self.plugins.find_for(&d.url);
        let (online, name, size, err) = match &plugin {
            Some(p) if p.has_check => {
                // Like JD's and pyLoad's link check: anonymous, without the premium session.
                // Logged in, hosters like ddownload redirect the file page straight to the file
                // ("direct downloads"), so name and size never show up.
                match self.plugins.check(p, &d.url, None).await {
                    Ok(r) => (
                        if r.online.unwrap_or(true) {
                            "online"
                        } else {
                            "offline"
                        },
                        r.name.map(|n| util::sanitize_filename(&n)),
                        r.size,
                        None,
                    ),
                    Err(e) if e.kind == ErrorKind::Offline => {
                        ("offline", None, None, Some(e.message))
                    }
                    Err(e) => ("unknown", None, None, Some(e.message)),
                }
            }
            Some(_) => ("unknown", None, None, None),
            None => match worker::probe_direct(&self.plugins.direct_clients().follow, &d.url).await
            {
                Ok(p) => ("online", p.name, p.size, None),
                Err(e) => {
                    let offline = e.to_string().contains("404") || e.to_string().contains("410");
                    (
                        if offline { "offline" } else { "unknown" },
                        None,
                        None,
                        Some(format!("{e:#}")),
                    )
                }
            },
        };
        sqlx::query(
            "UPDATE downloads SET online = ?, name = COALESCE(?, name), size = COALESCE(?, size),
             plugin_id = ?, error = CASE WHEN status IN ('collected','queued') THEN ? ELSE error END WHERE id = ?",
        )
        .bind(online)
        .bind(name)
        .bind(size)
        .bind(plugin.map(|p| p.id.clone()))
        .bind(err)
        .bind(d.id)
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// Moves a package from the Linksammler into the queue.
    pub async fn start_package(&self, id: i64) -> Result<()> {
        sqlx::query("UPDATE packages SET collector = 0 WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await?;
        sqlx::query("UPDATE downloads SET status = ? WHERE package_id = ? AND status = ? AND online != 'offline'")
            .bind(status::QUEUED)
            .bind(id)
            .bind(status::COLLECTED)
            .execute(&self.db)
            .await?;
        self.events.changed(Topic::Downloads);
        self.wake();
        Ok(())
    }

    pub async fn pause(&self, ids: &[i64]) -> Result<()> {
        for &id in ids {
            let res =
                sqlx::query("UPDATE downloads SET status = ? WHERE id = ? AND status IN (?, ?, ?)")
                    .bind(status::PAUSED)
                    .bind(id)
                    .bind(status::QUEUED)
                    .bind(status::RESOLVING)
                    .bind(status::DOWNLOADING)
                    .execute(&self.db)
                    .await?;
            if res.rows_affected() > 0 {
                self.stop_worker(id).await;
            }
        }
        self.events.changed(Topic::Downloads);
        Ok(())
    }

    pub async fn resume(&self, ids: &[i64]) -> Result<()> {
        for &id in ids {
            sqlx::query(
                "UPDATE downloads SET status = ?, attempts = 0, retry_at = NULL, error = NULL
                 WHERE id = ? AND status IN (?, ?)",
            )
            .bind(status::QUEUED)
            .bind(id)
            .bind(status::PAUSED)
            .bind(status::FAILED)
            .execute(&self.db)
            .await?;
        }
        self.events.changed(Topic::Downloads);
        self.wake();
        Ok(())
    }

    pub async fn ids_with_status(&self, statuses: &[&str]) -> Result<Vec<i64>> {
        let placeholders = vec!["?"; statuses.len()].join(",");
        let sql = format!("SELECT id FROM downloads WHERE status IN ({placeholders})");
        let mut q = sqlx::query_scalar(&sql);
        for s in statuses {
            q = q.bind(*s);
        }
        Ok(q.fetch_all(&self.db).await?)
    }

    pub async fn package_ids(&self, package_id: i64) -> Result<Vec<i64>> {
        Ok(
            sqlx::query_scalar("SELECT id FROM downloads WHERE package_id = ?")
                .bind(package_id)
                .fetch_all(&self.db)
                .await?,
        )
    }

    /// Removes downloads and their partial files. Finished files stay on disk.
    pub async fn delete(&self, ids: &[i64]) -> Result<()> {
        for &id in ids {
            sqlx::query("UPDATE downloads SET status = ? WHERE id = ?")
                .bind(status::PAUSED)
                .bind(id)
                .execute(&self.db)
                .await?;
            self.stop_worker(id).await;
            let _ = tokio::fs::remove_file(self.tmp_path(id)).await;
            sqlx::query("DELETE FROM downloads WHERE id = ?")
                .bind(id)
                .execute(&self.db)
                .await?;
        }
        sqlx::query("DELETE FROM packages WHERE NOT EXISTS (SELECT 1 FROM downloads d WHERE d.package_id = packages.id)")
            .execute(&self.db)
            .await?;
        self.events.changed(Topic::Downloads);
        Ok(())
    }

    pub async fn clear_finished(&self) -> Result<()> {
        let ids = self.ids_with_status(&[status::FINISHED]).await?;
        self.delete(&ids).await
    }
}

/// Extracts http(s) links from free text, one per whitespace-separated token, deduplicated.
pub fn parse_links(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    // Control characters separate too: decrypted Click'n'Load payloads end in padding bytes.
    text.split(|c: char| {
        c.is_whitespace() || c.is_control() || c == '"' || c == '\'' || c == '<' || c == '>'
    })
    .map(|t| t.trim_matches(|c: char| c == ',' || c == ';'))
    .filter(|t| t.starts_with("http://") || t.starts_with("https://"))
    .filter(|t| url::Url::parse(t).is_ok())
    .filter(|t| seen.insert(t.to_string()))
    .map(str::to_string)
    .collect()
}

/// `Foo.part1.rar`, `Foo.part2.rar` → `Foo`; mixed files → `first (+n)`.
pub fn guess_package_name(names: &[String]) -> String {
    let re = regex::Regex::new(
        r"(?i)(\.part\d+)?\.(rar|zip|7z|r\d\d|\d{3}|iso|mkv|mp4|avi|bin|tar|gz)$",
    )
    .unwrap();
    let stems: Vec<String> = names
        .iter()
        .map(|n| re.replace(n, "").to_string())
        .collect();
    if let Some(first) = stems.first() {
        if !first.is_empty() && stems.iter().all(|s| s == first) {
            return first.clone();
        }
    }
    match stems.first() {
        Some(first) if !first.is_empty() => format!("{first} (+{})", stems.len() - 1),
        _ => "Neues Paket".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_and_names() {
        let l = parse_links(
            "foo https://a.com/x.rar\nhttps://a.com/x.rar, http://b.org/y ftp://c <https://d.io/z>",
        );
        assert_eq!(
            l,
            vec!["https://a.com/x.rar", "http://b.org/y", "https://d.io/z"]
        );
        assert_eq!(
            guess_package_name(&["Foto.part1.rar".into(), "Foto.part2.rar".into()]),
            "Foto"
        );
        assert_eq!(
            guess_package_name(&["a.iso".into(), "b.iso".into()]),
            "a (+1)"
        );
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, HeaderMap, StatusCode};
    use axum::response::Response;
    use axum::routing::get;

    /// Serves `data` at `/file.bin` with Range support, slowly enough to pause mid-way.
    /// `requests` counts the requests to `/file.bin`.
    async fn range_server(data: Arc<Vec<u8>>, requests: Arc<AtomicU64>) -> String {
        let app = axum::Router::new()
            .route(
                "/file.bin",
                get(move |headers: HeaderMap| {
                    let data = data.clone();
                    requests.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let len = data.len();
                        let (start, end) = headers
                            .get(header::RANGE)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.strip_prefix("bytes="))
                            .and_then(|v| v.split_once('-'))
                            .map(|(a, b)| (a.parse().unwrap_or(0), b.parse().unwrap_or(len - 1)))
                            .unwrap_or((0, len - 1));
                        let slice = data[start..=end].to_vec();
                        let stream = futures::stream::iter(
                            slice
                                .chunks(64 * 1024)
                                .map(|c| c.to_vec())
                                .collect::<Vec<_>>(),
                        )
                        .then(|c| async move {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            Ok::<_, std::io::Error>(c)
                        });
                        Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                            .header(header::CONTENT_LENGTH, end - start + 1)
                            .header(
                                header::CONTENT_DISPOSITION,
                                "attachment; filename=\"file.bin\"",
                            )
                            .body(Body::from_stream(stream))
                            .unwrap()
                    }
                }),
            )
            .route("/missing.bin", get(|| async { StatusCode::NOT_FOUND }))
            // Like a hoster link from a crypter: only the file id, redirecting to a CDN URL
            // that carries the name but no Content-Disposition.
            .route(
                "/ry772kx58yfh",
                get(|| async { axum::response::Redirect::to("/d/HASH/Movie.2026.part1.rar") }),
            )
            .route(
                "/d/HASH/Movie.2026.part1.rar",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "application/octet-stream")],
                        "Rar!\u{1a}\u{7}\u{1}\u{0}",
                    )
                }),
            )
            .route(
                "/page.bin",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                        "<html><body><h1>Oops!</h1><p>Link expired</p></body></html>",
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    async fn engine(dir: &std::path::Path) -> Arc<Engine> {
        let cfg = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            cnl_listen: None,
            config_dir: dir.join("config"),
            tmp_dir: dir.join("tmp"),
            done_dir: dir.join("done"),
            builtin_plugins: None,
            app_secret: "test".into(),
            initial_user: None,
            user_agent: None,
            move_targets: vec![],
        };
        std::fs::create_dir_all(&cfg.config_dir).unwrap();
        let db = db::connect(&cfg.db_path()).await.unwrap();
        let plugins = Arc::new(PluginManager::new(vec![], None));
        let e = Engine::new(db, cfg, plugins, Events::new()).await.unwrap();
        tokio::spawn(e.clone().run());
        e
    }

    async fn wait_for(e: &Engine, id: i64, want: &str) -> Download {
        for _ in 0..600 {
            let d = db::get_download(&e.db, id).await.unwrap().unwrap();
            if d.status == want {
                return d;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("download {id} never reached {want}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn segmented_download_with_pause_and_resume() {
        let data: Arc<Vec<u8>> = Arc::new(
            (0..24 * 1024 * 1024u32)
                .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
                .collect(),
        );
        let base = range_server(data.clone(), Arc::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let e = engine(dir.path()).await;

        let pkg = e
            .add_links(AddLinks {
                links: format!("{base}/file.bin\n{base}/missing.bin"),
                package_name: Some("Pkg".into()),
                start: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let ids = e.package_ids(pkg).await.unwrap();
        let (file, missing) = (ids[0], ids[1]);

        wait_for(&e, file, status::DOWNLOADING).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        e.pause(&[file]).await.unwrap();
        let paused = db::get_download(&e.db, file).await.unwrap().unwrap();
        assert_eq!(paused.status, status::PAUSED);
        let segments: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM segments WHERE download_id = ?")
                .bind(file)
                .fetch_one(&e.db)
                .await
                .unwrap();
        assert_eq!(segments, 4, "24 MiB with 4 connections → 4 segments");
        assert!(
            paused.bytes_done > 0 && paused.bytes_done < data.len() as i64,
            "{}",
            paused.bytes_done
        );

        e.resume(&[file]).await.unwrap();
        let done = wait_for(&e, file, status::FINISHED).await;
        assert_eq!(done.size, Some(data.len() as i64));
        let written = std::fs::read(dir.path().join("done/Pkg/file.bin")).unwrap();
        assert!(written == *data, "file content differs");
        assert!(!e.tmp_path(file).exists());

        let m = wait_for(&e, missing, status::FAILED).await;
        assert_eq!(m.online, "offline");
        e.shutdown().await;
    }

    /// Hosters like ddownload allow one connection per file: then the probe request itself
    /// must carry the whole download, without a second request.
    #[tokio::test(flavor = "multi_thread")]
    async fn single_connection_uses_one_request() {
        let data: Arc<Vec<u8>> = Arc::new((0..6 * 1024 * 1024u32).map(|i| i as u8).collect());
        let requests = Arc::new(AtomicU64::new(0));
        let base = range_server(data.clone(), requests.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let e = engine(dir.path()).await;
        let mut s = e.settings();
        s.connections_per_file = 1;
        e.update_settings(s).await.unwrap();

        let pkg = e
            .add_links(AddLinks {
                links: format!("{base}/file.bin\n{base}/page.bin"),
                package_name: Some("One".into()),
                start: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let ids = e.package_ids(pkg).await.unwrap();
        wait_for(&e, ids[0], status::FINISHED).await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(std::fs::read(dir.path().join("done/One/file.bin")).unwrap() == *data);

        // A web page instead of the file is an error, not a finished download.
        for _ in 0..100 {
            let d = db::get_download(&e.db, ids[1]).await.unwrap().unwrap();
            if let Some(err) = d.error {
                assert!(err.contains("Webseite statt der Datei"), "{err}");
                assert!(err.contains("Link expired"), "{err}");
                assert_ne!(d.status, status::FINISHED);
                e.shutdown().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("HTML response was not reported");
    }

    /// The file id from a crypter link is only a placeholder: even when the online check
    /// marked the link online, the real name from the download wins (here: the CDN URL).
    #[tokio::test(flavor = "multi_thread")]
    async fn placeholder_name_is_replaced() {
        let base = range_server(Arc::new(vec![0u8; 16]), Arc::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let e = engine(dir.path()).await;
        let pkg = e
            .add_links(AddLinks {
                links: format!("{base}/ry772kx58yfh"),
                package_name: Some("Crypt".into()),
                start: false,
                ..Default::default()
            })
            .await
            .unwrap();
        let id = e.package_ids(pkg).await.unwrap()[0];
        // Let the automatic online check finish, then put the download into the state from the
        // log: online, but named after the file id.
        for _ in 0..100 {
            if db::get_download(&e.db, id).await.unwrap().unwrap().online != "unknown" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        sqlx::query("UPDATE downloads SET online = 'online', name = 'ry772kx58yfh' WHERE id = ?")
            .bind(id)
            .execute(&e.db)
            .await
            .unwrap();
        e.start_package(pkg).await.unwrap();
        let d = wait_for(&e, id, status::FINISHED).await;
        assert_eq!(d.name, "Movie.2026.part1.rar");
        assert!(dir.path().join("done/Crypt/Movie.2026.part1.rar").exists());
        e.shutdown().await;
    }
}
