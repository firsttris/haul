use std::path::Path;
use std::str::FromStr;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};

pub type Db = SqlitePool;

pub async fn connect(path: &Path) -> Result<Db> {
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub mod status {
    /// In the Linksammler, never started automatically.
    pub const COLLECTED: &str = "collected";
    pub const QUEUED: &str = "queued";
    pub const RESOLVING: &str = "resolving";
    pub const DOWNLOADING: &str = "downloading";
    pub const PAUSED: &str = "paused";
    pub const FINISHED: &str = "finished";
    pub const FAILED: &str = "failed";
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub id: i64,
    pub name: String,
    pub target_dir: String,
    pub source: String,
    pub source_page: Option<String>,
    #[serde(skip_serializing)]
    pub passwords: Option<String>,
    pub collector: bool,
    pub extract: Option<String>,
    pub extract_error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: i64,
    pub package_id: i64,
    pub url: String,
    pub plugin_id: Option<String>,
    pub status: String,
    pub online: String,
    pub name: String,
    pub size: Option<i64>,
    pub bytes_done: i64,
    pub error: Option<String>,
    pub attempts: i64,
    pub retry_at: Option<i64>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow)]
pub struct Segment {
    pub idx: i64,
    pub start: i64,
    pub end: Option<i64>,
    pub done: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub plugin_id: String,
    pub user: String,
    #[serde(skip_serializing)]
    pub secret: String,
    pub enabled: bool,
    pub status: String,
    pub premium: Option<bool>,
    pub traffic_left: Option<i64>,
    pub valid_until: Option<i64>,
    pub error: Option<String>,
    pub checked_at: Option<i64>,
    pub created_at: i64,
}

pub async fn get_download(db: &Db, id: i64) -> Result<Option<Download>> {
    Ok(sqlx::query_as("SELECT * FROM downloads WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?)
}

pub async fn get_package(db: &Db, id: i64) -> Result<Option<Package>> {
    Ok(sqlx::query_as("SELECT * FROM packages WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?)
}

pub async fn package_downloads(db: &Db, package_id: i64) -> Result<Vec<Download>> {
    Ok(
        sqlx::query_as("SELECT * FROM downloads WHERE package_id = ? ORDER BY id")
            .bind(package_id)
            .fetch_all(db)
            .await?,
    )
}

pub async fn get_account(db: &Db, id: i64) -> Result<Option<Account>> {
    Ok(sqlx::query_as("SELECT * FROM accounts WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?)
}

pub async fn get_setting(db: &Db, key: &str) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(db)
            .await?,
    )
}

pub async fn set_setting(db: &Db, key: &str, value: &str) -> Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(db)
        .await?;
    Ok(())
}

/// User-tunable settings, stored as key-value rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub max_parallel: u32,
    pub connections_per_file: u32,
    /// KiB/s over all downloads, 0 = unlimited.
    pub speed_limit_kib: u32,
    pub max_retries: u32,
    pub auto_extract: bool,
    pub delete_archives: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_parallel: 3,
            connections_per_file: 4,
            speed_limit_kib: 0,
            max_retries: 5,
            auto_extract: true,
            delete_archives: false,
        }
    }
}

impl Settings {
    pub async fn load(db: &Db) -> Result<Self> {
        Ok(match get_setting(db, "settings").await? {
            Some(json) => serde_json::from_str(&json).unwrap_or_default(),
            None => Self::default(),
        })
    }

    pub async fn save(&self, db: &Db) -> Result<()> {
        set_setting(db, "settings", &serde_json::to_string(self)?).await
    }

    pub fn clamp(mut self) -> Self {
        self.max_parallel = self.max_parallel.clamp(1, 20);
        self.connections_per_file = self.connections_per_file.clamp(1, 16);
        self.max_retries = self.max_retries.min(50);
        self
    }
}
