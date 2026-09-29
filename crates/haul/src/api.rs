use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::sse::{KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::auth;
use crate::db::{self, status, Account, Download, Package, Settings};
use crate::engine::{AddLinks, Engine};
use crate::events::Topic;
use crate::plugins::{LoadError, Plugin};
use crate::util::{self, now_ms};

pub struct App {
    pub engine: Arc<Engine>,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            crate::tr!("nicht gefunden", "not found"),
        )
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        let e = e.into();
        tracing::error!("api: {e:#}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

pub fn router(app: Arc<App>) -> Router {
    let protected = Router::new()
        .route("/packages", get(list_packages))
        .route(
            "/packages/{id}",
            patch(update_package).delete(delete_package),
        )
        .route("/packages/{id}/start", post(start_package))
        .route("/packages/{id}/pause", post(pause_package))
        .route("/packages/{id}/resume", post(resume_package))
        .route("/packages/{id}/check", post(check_package))
        .route("/packages/{id}/extract", post(extract_package))
        .route("/links", post(add_links))
        .route("/downloads/{id}", axum::routing::delete(delete_download))
        .route("/downloads/{id}/pause", post(pause_download))
        .route("/downloads/{id}/resume", post(resume_download))
        .route("/downloads/pause-all", post(pause_all))
        .route("/downloads/resume-all", post(resume_all))
        .route("/downloads/clear-finished", post(clear_finished))
        .route("/stats", get(stats))
        .route("/events", get(events))
        .route("/accounts", get(list_accounts).post(create_account))
        .route(
            "/accounts/{id}",
            patch(update_account).delete(delete_account),
        )
        .route("/accounts/{id}/check", post(check_account))
        .route("/files", get(list_files))
        .route("/files/delete", post(delete_files))
        .route("/files/delete-archives", post(delete_archives))
        .route("/files/extract", post(extract_files))
        .route("/files/move", post(move_files))
        .route("/files/mkdir", post(make_folder))
        .route("/files/folders", get(list_folders))
        .route("/plugins", get(list_plugins))
        .route("/plugins/reload", post(reload_plugins))
        .route("/settings", get(get_settings).put(put_settings))
        .route("/settings/api-token", post(auth::rotate_token))
        .route("/auth/password", post(auth::change_password))
        .nest("/cnl", crate::cnl::router(app.engine.clone()))
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "status": "ok" })) }),
        )
        .route("/auth/state", get(auth::state))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .merge(protected)
        .with_state(app)
}

// ---- packages & downloads ----------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageView {
    #[serde(flatten)]
    package: Package,
    has_passwords: bool,
    downloads: Vec<Download>,
}

#[derive(Deserialize)]
struct ListQuery {
    view: Option<String>,
}

async fn list_packages(
    State(app): State<Arc<App>>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<PackageView>>> {
    let collector = q.view.as_deref() == Some("collector");
    let db = &app.engine.db;
    let packages: Vec<Package> =
        sqlx::query_as("SELECT * FROM packages WHERE collector = ? ORDER BY id")
            .bind(collector)
            .fetch_all(db)
            .await?;
    let downloads: Vec<Download> = sqlx::query_as(
        "SELECT d.* FROM downloads d JOIN packages p ON p.id = d.package_id WHERE p.collector = ? ORDER BY d.id",
    )
    .bind(collector)
    .fetch_all(db)
    .await?;
    let live = app.engine.live_bytes();
    let mut views: Vec<PackageView> = packages
        .into_iter()
        .map(|p| PackageView {
            has_passwords: p.passwords.is_some(),
            package: p,
            downloads: Vec::new(),
        })
        .collect();
    for mut d in downloads {
        if let Some(b) = live.get(&d.id) {
            d.bytes_done = *b as i64;
        }
        if let Some(v) = views.iter_mut().find(|v| v.package.id == d.package_id) {
            v.downloads.push(d);
        }
    }
    Ok(Json(views))
}

async fn add_links(
    State(app): State<Arc<App>>,
    Json(req): Json<AddLinks>,
) -> ApiResult<Json<serde_json::Value>> {
    let id = app
        .engine
        .add_links(req)
        .await
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(serde_json::json!({ "packageId": id })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageUpdate {
    name: Option<String>,
    target_dir: Option<String>,
    passwords: Option<String>,
}

async fn update_package(
    State(app): State<Arc<App>>,
    Path(id): Path<i64>,
    Json(u): Json<PackageUpdate>,
) -> ApiResult<StatusCode> {
    let db = &app.engine.db;
    db::get_package(db, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if let Some(name) = u.name.filter(|n| !n.trim().is_empty()) {
        sqlx::query("UPDATE packages SET name = ? WHERE id = ?")
            .bind(name.trim())
            .bind(id)
            .execute(db)
            .await?;
    }
    if let Some(dir) = u.target_dir {
        sqlx::query("UPDATE packages SET target_dir = ? WHERE id = ?")
            .bind(util::sanitize_rel_dir(&dir))
            .bind(id)
            .execute(db)
            .await?;
    }
    if let Some(pw) = u.passwords {
        sqlx::query("UPDATE packages SET passwords = ? WHERE id = ?")
            .bind(Some(pw).filter(|p| !p.trim().is_empty()))
            .bind(id)
            .execute(db)
            .await?;
    }
    app.engine.events.changed(Topic::Downloads);
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_package(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let ids = app.engine.package_ids(id).await?;
    app.engine.delete(&ids).await?;
    sqlx::query("DELETE FROM packages WHERE id = ?")
        .bind(id)
        .execute(&app.engine.db)
        .await?;
    app.engine.events.changed(Topic::Downloads);
    Ok(StatusCode::NO_CONTENT)
}

async fn start_package(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    app.engine.start_package(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn pause_package(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let ids = app.engine.package_ids(id).await?;
    app.engine.pause(&ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume_package(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let ids = app.engine.package_ids(id).await?;
    app.engine.resume(&ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn check_package(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let engine = app.engine.clone();
    tokio::spawn(async move {
        let _ = engine.check_package(id).await;
    });
    Ok(StatusCode::ACCEPTED)
}

async fn extract_package(
    State(app): State<Arc<App>>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    let engine = app.engine.clone();
    tokio::spawn(async move {
        let _ = engine.extract_package(id).await;
    });
    Ok(StatusCode::ACCEPTED)
}

async fn delete_download(
    State(app): State<Arc<App>>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    app.engine.delete(&[id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn pause_download(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    app.engine.pause(&[id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume_download(
    State(app): State<Arc<App>>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    app.engine.resume(&[id]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn pause_all(State(app): State<Arc<App>>) -> ApiResult<StatusCode> {
    let ids = app
        .engine
        .ids_with_status(&[status::QUEUED, status::RESOLVING, status::DOWNLOADING])
        .await?;
    app.engine.pause(&ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume_all(State(app): State<Arc<App>>) -> ApiResult<StatusCode> {
    let ids = app.engine.ids_with_status(&[status::PAUSED]).await?;
    app.engine.resume(&ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_finished(State(app): State<Arc<App>>) -> ApiResult<StatusCode> {
    app.engine.clear_finished().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- stats & events ----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Storage {
    label: String,
    path: String,
    total: u64,
    free: u64,
}

#[allow(clippy::unnecessary_cast)] // statvfs field types differ between platforms
fn disk_usage(label: &str, path: &std::path::Path) -> Option<Storage> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` is a properly sized out-parameter.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frsize = st.f_frsize as u64;
    Some(Storage {
        label: label.into(),
        path: path.display().to_string(),
        total: st.f_blocks as u64 * frsize,
        free: st.f_bavail as u64 * frsize,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    active: usize,
    slots: u32,
    connections_per_file: u32,
    queued: i64,
    queued_bytes: i64,
    finished_today: i64,
    finished_today_bytes: i64,
    speed_limit_kib: u32,
    storage: Vec<Storage>,
    premium: Vec<PremiumSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PremiumSummary {
    plugin_id: String,
    traffic_left: Option<i64>,
    valid_until: Option<i64>,
}

async fn stats(State(app): State<Arc<App>>) -> ApiResult<Json<Stats>> {
    let db = &app.engine.db;
    let settings = app.engine.settings();
    let (queued, queued_bytes): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(size - bytes_done), 0) FROM downloads WHERE status = ?",
    )
    .bind(status::QUEUED)
    .fetch_one(db)
    .await?;
    let day_start = now_ms() - now_ms().rem_euclid(86_400_000);
    let (finished_today, finished_today_bytes): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM downloads WHERE status = ? AND finished_at >= ?",
    )
    .bind(status::FINISHED)
    .bind(day_start)
    .fetch_one(db)
    .await?;
    let premium: Vec<(String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT plugin_id, SUM(traffic_left), MAX(valid_until) FROM accounts
         WHERE enabled = 1 AND status = 'valid' GROUP BY plugin_id",
    )
    .fetch_all(db)
    .await?;
    let cfg = &app.engine.cfg;
    let storage = [("tmp", &cfg.tmp_dir), ("fertig", &cfg.done_dir)]
        .into_iter()
        .filter_map(|(l, p)| disk_usage(l, p))
        .collect();
    Ok(Json(Stats {
        active: app.engine.active_count(),
        slots: settings.max_parallel,
        connections_per_file: settings.connections_per_file,
        queued,
        queued_bytes,
        finished_today,
        finished_today_bytes,
        speed_limit_kib: settings.speed_limit_kib,
        storage,
        premium: premium
            .into_iter()
            .map(|(plugin_id, traffic_left, valid_until)| PremiumSummary {
                plugin_id,
                traffic_left,
                valid_until,
            })
            .collect(),
    }))
}

async fn events(
    State(app): State<Arc<App>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<axum::response::sse::Event, Infallible>>> {
    let rx = app.engine.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(e) => Some(Ok(axum::response::sse::Event::default()
            .json_data(&e)
            .unwrap_or_default())),
        // A slow client missed events: tell it to refetch everything.
        Err(BroadcastStreamRecvError::Lagged(_)) => {
            Some(Ok(axum::response::sse::Event::default()
                .data(r#"{"type":"changed","topic":"downloads"}"#)))
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

// ---- accounts ----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountView {
    #[serde(flatten)]
    account: Account,
    plugin_name: Option<String>,
}

async fn list_accounts(State(app): State<Arc<App>>) -> ApiResult<Json<Vec<AccountView>>> {
    let rows: Vec<Account> = sqlx::query_as("SELECT * FROM accounts ORDER BY plugin_id, id")
        .fetch_all(&app.engine.db)
        .await?;
    Ok(Json(
        rows.into_iter()
            .map(|a| AccountView {
                plugin_name: app.engine.plugins.get(&a.plugin_id).map(|p| p.name.clone()),
                account: a,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewAccount {
    plugin_id: String,
    #[serde(default)]
    user: String,
    secret: String,
}

async fn create_account(
    State(app): State<Arc<App>>,
    Json(n): Json<NewAccount>,
) -> ApiResult<Json<serde_json::Value>> {
    if app.engine.plugins.get(&n.plugin_id).is_none() {
        return Err(ApiError::bad_request(crate::tr!(
            "unbekanntes Plugin",
            "unknown plugin"
        )));
    }
    if n.secret.is_empty() {
        return Err(ApiError::bad_request(crate::tr!(
            "Passwort oder API-Key fehlt",
            "password or API key missing"
        )));
    }
    let secret = app.engine.secrets.encrypt(&n.secret)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO accounts(plugin_id, user, secret, created_at) VALUES(?, ?, ?, ?) RETURNING id",
    )
    .bind(&n.plugin_id)
    .bind(n.user.trim())
    .bind(secret)
    .bind(now_ms())
    .fetch_one(&app.engine.db)
    .await?;
    app.engine.events.changed(Topic::Accounts);
    spawn_account_check(&app, id);
    Ok(Json(serde_json::json!({ "id": id })))
}

#[derive(Deserialize)]
struct AccountUpdate {
    enabled: Option<bool>,
    user: Option<String>,
    secret: Option<String>,
}

async fn update_account(
    State(app): State<Arc<App>>,
    Path(id): Path<i64>,
    Json(u): Json<AccountUpdate>,
) -> ApiResult<StatusCode> {
    let db = &app.engine.db;
    let acc = db::get_account(db, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if let Some(e) = u.enabled {
        sqlx::query("UPDATE accounts SET enabled = ? WHERE id = ?")
            .bind(e)
            .bind(id)
            .execute(db)
            .await?;
    }
    let mut recheck = false;
    if let Some(user) = u.user {
        sqlx::query("UPDATE accounts SET user = ? WHERE id = ?")
            .bind(user.trim())
            .bind(id)
            .execute(db)
            .await?;
        recheck = true;
    }
    if let Some(secret) = u.secret.filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE accounts SET secret = ? WHERE id = ?")
            .bind(app.engine.secrets.encrypt(&secret)?)
            .bind(id)
            .execute(db)
            .await?;
        recheck = true;
    }
    if recheck {
        // New credentials: the old session belongs to the old login.
        app.engine.plugins.forget_account(&acc.plugin_id, id);
        sqlx::query("UPDATE accounts SET session = NULL WHERE id = ?")
            .bind(id)
            .execute(db)
            .await?;
        spawn_account_check(&app, id);
    }
    app.engine.events.changed(Topic::Accounts);
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_account(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if let Some(acc) = db::get_account(&app.engine.db, id).await? {
        app.engine.plugins.forget_account(&acc.plugin_id, id);
    }
    sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(id)
        .execute(&app.engine.db)
        .await?;
    app.engine.events.changed(Topic::Accounts);
    Ok(StatusCode::NO_CONTENT)
}

async fn check_account(State(app): State<Arc<App>>, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    run_account_check(&app.engine, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn spawn_account_check(app: &App, id: i64) {
    let engine = app.engine.clone();
    tokio::spawn(async move {
        if let Err(e) = run_account_check(&engine, id).await {
            tracing::warn!(id, "account check: {e:#}");
        }
    });
}

pub async fn run_account_check(engine: &Engine, id: i64) -> anyhow::Result<()> {
    let db = &engine.db;
    let Some(acc) = db::get_account(db, id).await? else {
        return Ok(());
    };
    let Some(plugin) = engine.plugins.get(&acc.plugin_id) else {
        anyhow::bail!(crate::tr!(
            "Plugin {} nicht geladen",
            "plugin {} not loaded",
            acc.plugin_id
        ));
    };
    if !plugin.has_check_account {
        return Ok(());
    }
    sqlx::query("UPDATE accounts SET status = 'checking' WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    engine.events.changed(Topic::Accounts);
    let creds = engine.account_creds(&acc)?;
    let result = engine.plugins.check_account(&plugin, &creds).await;
    engine.save_session(&plugin.id, acc.id).await;
    let (status, premium, traffic, until, error) = match result {
        Ok(i) if i.valid => ("valid", i.premium, i.traffic_left, i.valid_until, i.message),
        Ok(i) => (
            "invalid",
            i.premium,
            None,
            None,
            Some(
                i.message
                    .unwrap_or_else(|| crate::tr!("Login fehlgeschlagen", "Login failed")),
            ),
        ),
        Err(e) if e.kind == crate::plugins::ErrorKind::Account => {
            ("invalid", None, None, None, Some(e.message))
        }
        Err(e) => ("error", None, None, None, Some(e.message)),
    };
    sqlx::query(
        "UPDATE accounts SET status = ?, premium = ?, traffic_left = ?, valid_until = ?, error = ?, checked_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(premium)
    .bind(traffic)
    .bind(until)
    .bind(error)
    .bind(now_ms())
    .bind(id)
    .execute(db)
    .await?;
    engine.events.changed(Topic::Accounts);
    Ok(())
}

// ---- Fertig view: the done folder ------------------------------------------------

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderPackage {
    id: i64,
    name: String,
    extract: Option<String>,
    extract_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileView {
    #[serde(flatten)]
    entry: crate::files::Entry,
    /// For folders: the Haul package they belong to.
    package: Option<FolderPackage>,
    /// For folders: archive files directly inside (volumes count one by one).
    archives: usize,
    /// For folders: extraction running, in percent.
    extracting: Option<u8>,
    /// For folders: last extraction error from the Fertig view.
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderView {
    path: String,
    root: String,
    entries: Vec<FileView>,
    /// Extraction running in the listed folder itself, in percent.
    extracting: Option<u8>,
    error: Option<String>,
}

fn bad(e: anyhow::Error) -> ApiError {
    ApiError::bad_request(format!("{e:#}"))
}

async fn list_files(
    State(app): State<Arc<App>>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<FolderView>> {
    let engine = &app.engine;
    let root = engine.cfg.done_dir.clone();
    tokio::fs::create_dir_all(&root).await?;
    let dir = crate::files::resolve(&root, &q.path).map_err(bad)?;
    if !dir.is_dir() {
        return Err(ApiError::bad_request(crate::tr!(
            "kein Ordner",
            "not a folder"
        )));
    }
    let listing = {
        let (root, dir) = (root.clone(), dir.clone());
        tokio::task::spawn_blocking(move || crate::files::list(&root, &dir))
            .await?
            .map_err(bad)?
    };
    // Package folders by their real location.
    let packages: Vec<Package> = sqlx::query_as("SELECT * FROM packages")
        .fetch_all(&engine.db)
        .await?;
    let by_dir: Vec<(std::path::PathBuf, Package)> = packages
        .into_iter()
        .filter_map(|p| engine.package_dir(&p).canonicalize().ok().map(|d| (d, p)))
        .collect();
    let errors = engine.folder_errors.lock().unwrap().clone();
    let entries = listing
        .into_iter()
        .map(|entry| {
            let full = root.join(&entry.path);
            let (package, archives) = if entry.dir {
                let real = full.canonicalize().ok();
                let package =
                    by_dir
                        .iter()
                        .find(|(d, _)| Some(d) == real.as_ref())
                        .map(|(_, p)| FolderPackage {
                            id: p.id,
                            name: p.name.clone(),
                            extract: p.extract.clone(),
                            extract_error: p.extract_error.clone(),
                        });
                let names = crate::files::file_names(&full);
                (
                    package,
                    crate::engine::extract::find_archives(&names).1.len(),
                )
            } else {
                (None, 0)
            };
            FileView {
                extracting: entry
                    .dir
                    .then(|| engine.extract_progress_of(&entry.path))
                    .flatten(),
                error: errors.get(&entry.path).cloned(),
                entry,
                package,
                archives,
            }
        })
        .collect();
    let path = crate::files::relative(&root, &dir);
    Ok(Json(FolderView {
        extracting: engine.extract_progress_of(&path),
        error: errors.get(&path).cloned(),
        path,
        root: root.display().to_string(),
        entries,
    }))
}

#[derive(Deserialize)]
struct PathsBody {
    paths: Vec<String>,
}

async fn delete_files(
    State(app): State<Arc<App>>,
    Json(b): Json<PathsBody>,
) -> ApiResult<StatusCode> {
    let root = &app.engine.cfg.done_dir;
    // Check every path before deleting anything.
    let resolved = b
        .paths
        .iter()
        .map(|p| crate::files::resolve_entry(root, p))
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(bad)?;
    for (path, full) in b.paths.iter().zip(resolved) {
        let folder = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if app.engine.extract_progress_of(path).is_some()
            || app.engine.extract_progress_of(&folder).is_some()
        {
            return Err(ApiError::bad_request(crate::tr!(
                "{}: wird gerade entpackt",
                "{}: extraction in progress",
                path
            )));
        }
        crate::files::delete(&full)
            .await
            .map_err(|e| bad(anyhow::anyhow!("{path}: {e}")))?;
        tracing::info!(path, "deleted from done folder");
    }
    app.engine.events.changed(Topic::Files);
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_archives(
    State(app): State<Arc<App>>,
    Json(b): Json<PathsBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let root = &app.engine.cfg.done_dir;
    let dirs = b
        .paths
        .iter()
        .map(|p| crate::files::resolve(root, p))
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(bad)?;
    let mut deleted = 0;
    for (path, dir) in b.paths.iter().zip(dirs) {
        if !dir.is_dir() {
            continue;
        }
        if app.engine.extract_progress_of(path).is_some() {
            return Err(ApiError::bad_request(crate::tr!(
                "{}: wird gerade entpackt",
                "{}: extraction in progress",
                path
            )));
        }
        let (_, all) = crate::engine::extract::find_archives(&crate::files::file_names(&dir));
        for name in &all {
            tokio::fs::remove_file(dir.join(name)).await?;
        }
        deleted += all.len();
    }
    app.engine.events.changed(Topic::Files);
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

async fn extract_files(
    State(app): State<Arc<App>>,
    Json(b): Json<PathsBody>,
) -> ApiResult<StatusCode> {
    app.engine.extract_paths(&b.paths).map_err(bad)?;
    app.engine.events.changed(Topic::Files);
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
struct MoveBody {
    paths: Vec<String>,
    /// Destination folder, relative to the done folder ("" = top level).
    to: String,
}

async fn move_files(State(app): State<Arc<App>>, Json(b): Json<MoveBody>) -> ApiResult<StatusCode> {
    let root = &app.engine.cfg.done_dir;
    let dest = crate::files::resolve(root, &b.to).map_err(bad)?;
    if !dest.is_dir() {
        return Err(ApiError::bad_request(crate::tr!(
            "Ziel ist kein Ordner",
            "the target is not a folder"
        )));
    }
    let sources = b
        .paths
        .iter()
        .map(|p| crate::files::resolve_entry(root, p))
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(bad)?;
    for (path, src) in b.paths.iter().zip(sources) {
        if app.engine.extract_progress_of(path).is_some() {
            return Err(ApiError::bad_request(crate::tr!(
                "{}: wird gerade entpackt",
                "{}: extraction in progress",
                path
            )));
        }
        crate::files::move_within(&src, &dest)
            .await
            .map_err(|e| bad(anyhow::anyhow!("{path}: {e:#}")))?;
        tracing::info!(from = %path, to = %b.to, "moved inside done folder");
    }
    app.engine.events.changed(Topic::Files);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MkdirBody {
    /// Parent folder, relative to the done folder.
    #[serde(default)]
    path: String,
    name: String,
}

async fn make_folder(
    State(app): State<Arc<App>>,
    Json(b): Json<MkdirBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let root = &app.engine.cfg.done_dir;
    let parent = crate::files::resolve(root, &b.path).map_err(bad)?;
    let name = crate::files::valid_name(&b.name).map_err(bad)?;
    let dir = parent.join(name);
    if dir.exists() {
        return Err(ApiError::bad_request(crate::tr!(
            "„{}“ gibt es hier schon",
            "“{}” already exists here",
            name
        )));
    }
    tokio::fs::create_dir(&dir).await?;
    app.engine.events.changed(Topic::Files);
    Ok(Json(
        serde_json::json!({ "path": crate::files::relative(root, &dir) }),
    ))
}

async fn list_folders(State(app): State<Arc<App>>) -> ApiResult<Json<Vec<String>>> {
    let root = app.engine.cfg.done_dir.clone();
    Ok(Json(
        tokio::task::spawn_blocking(move || crate::files::all_folders(&root)).await?,
    ))
}

// ---- plugins & settings ------------------------------------------------------------

#[derive(Serialize)]
struct PluginList {
    plugins: Vec<Arc<Plugin>>,
    errors: Vec<LoadError>,
}

async fn list_plugins(State(app): State<Arc<App>>) -> Json<PluginList> {
    Json(PluginList {
        plugins: app.engine.plugins.list(),
        errors: app.engine.plugins.errors(),
    })
}

async fn reload_plugins(State(app): State<Arc<App>>) -> Json<PluginList> {
    app.engine.plugins.reload().await;
    app.engine.events.changed(Topic::Plugins);
    list_plugins(State(app)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    tmp_dir: String,
    done_dir: String,
    plugin_dir: String,
    api_token_set: bool,
    version: &'static str,
    /// Installed extractors (7-Zip, unrar, unar), best first.
    extractors: Vec<String>,
}

async fn get_settings(State(app): State<Arc<App>>) -> ApiResult<Json<SettingsView>> {
    let cfg = &app.engine.cfg;
    Ok(Json(SettingsView {
        settings: app.engine.settings(),
        tmp_dir: cfg.tmp_dir.display().to_string(),
        done_dir: cfg.done_dir.display().to_string(),
        plugin_dir: cfg.user_plugins().display().to_string(),
        api_token_set: db::get_setting(&app.engine.db, "auth.api_token")
            .await?
            .is_some(),
        version: env!("CARGO_PKG_VERSION"),
        extractors: crate::engine::extract::available_tools()
            .iter()
            .map(|t| t.describe())
            .collect(),
    }))
}

async fn put_settings(
    State(app): State<Arc<App>>,
    Json(s): Json<Settings>,
) -> ApiResult<Json<Settings>> {
    Ok(Json(app.engine.update_settings(s).await?))
}
