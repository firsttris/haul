//! One download from start to finish: resolve via plugin, probe, split into range segments,
//! stream the bytes into `<tmp>/<id>.part`, persist progress and move the file when done.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONTENT_DISPOSITION, CONTENT_RANGE, COOKIE, RANGE};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{Engine, Progress};
use crate::db::{self, status, Segment};
use crate::events::Topic;
use crate::plugins::{ErrorKind, PluginError, Resolved};
use crate::util::{self, now_ms};

const MIN_SEGMENT: u64 = 4 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const FLUSH_BYTES: u64 = 8 * 1024 * 1024;
const SEGMENT_RETRIES: u32 = 3;

#[derive(Debug)]
pub enum Failure {
    /// Stopped by pause, delete or shutdown. Whoever cancelled owns the status.
    Cancelled,
    /// Transient; the download goes back to the queue with backoff.
    Retry(String),
    /// Permanent; needs the user.
    Fail(String),
    Offline(String),
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Failure::Retry(format!("Dateifehler: {e}"))
    }
}

impl From<anyhow::Error> for Failure {
    fn from(e: anyhow::Error) -> Self {
        Failure::Retry(format!("{e:#}"))
    }
}

impl From<sqlx::Error> for Failure {
    fn from(e: sqlx::Error) -> Self {
        Failure::Retry(format!("Datenbankfehler: {e}"))
    }
}

impl From<PluginError> for Failure {
    fn from(e: PluginError) -> Self {
        match e.kind {
            ErrorKind::Offline => Failure::Offline(e.message),
            ErrorKind::Temporary | ErrorKind::Account => Failure::Retry(e.message),
            ErrorKind::Fatal => Failure::Fail(e.message),
        }
    }
}

fn http_failure(code: StatusCode) -> Failure {
    match code.as_u16() {
        404 | 410 => Failure::Offline(format!("Datei offline (HTTP {})", code.as_u16())),
        _ => Failure::Retry(format!("HTTP {}", code.as_u16())),
    }
}

fn net_failure(e: reqwest::Error) -> Failure {
    Failure::Retry(format!("Netzwerkfehler: {e}"))
}

/// Where the bytes come from, after the plugin resolved the link.
struct Source {
    client: Client,
    url: String,
    headers: HeaderMap,
}

impl Source {
    fn get(&self, from: u64, to_exclusive: Option<u64>) -> RequestBuilder {
        let range = match to_exclusive {
            Some(end) => format!("bytes={from}-{}", end - 1),
            None => format!("bytes={from}-"),
        };
        self.client
            .get(&self.url)
            .headers(self.headers.clone())
            // Keep bytes as-is: transparent decompression would break ranges and sizes.
            .header(ACCEPT_ENCODING, "identity")
            .header(RANGE, range)
    }
}

struct Seg {
    idx: i64,
    start: u64,
    /// Exclusive; `None` when the size is unknown.
    end: Option<u64>,
    /// Bytes written (live, for the UI).
    done: AtomicU64,
    /// Bytes flushed to the OS; this is what gets persisted for resume.
    safe: AtomicU64,
}

pub struct Probe {
    pub name: Option<String>,
    pub size: Option<i64>,
    pub ranges: bool,
}

fn probe_from(resp: &Response) -> Probe {
    let ranges = resp.status() == StatusCode::PARTIAL_CONTENT;
    let size = if ranges {
        resp.headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<i64>().ok())
    } else {
        resp.content_length().map(|l| l as i64)
    };
    let name = resp
        .headers()
        .get(CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(util::filename_from_disposition);
    Probe { name, size, ranges }
}

/// Cheap HEAD-like probe for the online check: asks for one byte.
pub async fn probe_direct(client: &Client, url: &str) -> Result<Probe> {
    let resp = client
        .get(url)
        .header(ACCEPT_ENCODING, "identity")
        .header(RANGE, "bytes=0-0")
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status().as_u16());
    }
    let mut p = probe_from(&resp);
    if p.name.is_none() {
        p.name = util::filename_from_url(resp.url().as_str());
    }
    Ok(p)
}

pub async fn run(engine: &Arc<Engine>, id: i64, cancel: &CancellationToken, progress: &Arc<Progress>) {
    let outcome = execute(engine, id, cancel, progress).await;
    let result = match outcome {
        Ok(()) | Err(Failure::Cancelled) => Ok(()),
        Err(f) => record_failure(engine, id, f).await,
    };
    if let Err(e) = result {
        tracing::error!(id, "failed to record download state: {e:#}");
    }
}

async fn record_failure(engine: &Engine, id: i64, f: Failure) -> Result<()> {
    let Some(d) = db::get_download(&engine.db, id).await? else { return Ok(()) };
    let max = engine.settings().max_retries as i64;
    let running = [status::RESOLVING, status::DOWNLOADING];
    let (new_status, online, retry_at, attempts, msg) = match f {
        Failure::Offline(m) => (status::FAILED, "offline", None, d.attempts, m),
        Failure::Fail(m) => (status::FAILED, d.online.as_str(), None, d.attempts, m),
        Failure::Retry(m) if d.attempts + 1 > max => {
            (status::FAILED, d.online.as_str(), None, d.attempts + 1, format!("{m} (nach {} Versuchen)", d.attempts + 1))
        }
        Failure::Retry(m) => {
            let backoff = (10_000i64 << d.attempts.min(6)).min(600_000);
            (status::QUEUED, d.online.as_str(), Some(now_ms() + backoff), d.attempts + 1, m)
        }
        Failure::Cancelled => return Ok(()),
    };
    tracing::warn!(id, status = new_status, "download: {msg}");
    sqlx::query(
        "UPDATE downloads SET status = ?, online = ?, retry_at = ?, attempts = ?, error = ?
         WHERE id = ? AND status IN (?, ?)",
    )
    .bind(new_status)
    .bind(online)
    .bind(retry_at)
    .bind(attempts)
    .bind(msg)
    .bind(id)
    .bind(running[0])
    .bind(running[1])
    .execute(&engine.db)
    .await?;
    Ok(())
}

async fn cancellable<T>(cancel: &CancellationToken, fut: impl std::future::Future<Output = T>) -> Result<T, Failure> {
    tokio::select! {
        _ = cancel.cancelled() => Err(Failure::Cancelled),
        v = fut => Ok(v),
    }
}

async fn execute(engine: &Arc<Engine>, id: i64, cancel: &CancellationToken, progress: &Arc<Progress>) -> Result<(), Failure> {
    let d = db::get_download(&engine.db, id).await?.ok_or(Failure::Cancelled)?;
    let pkg = db::get_package(&engine.db, d.package_id).await?.ok_or(Failure::Cancelled)?;
    let marked = sqlx::query("UPDATE downloads SET status = ?, error = NULL WHERE id = ? AND status = ?")
        .bind(status::RESOLVING)
        .bind(id)
        .bind(status::QUEUED)
        .execute(&engine.db)
        .await?;
    if marked.rows_affected() == 0 {
        return Err(Failure::Cancelled);
    }
    engine.events.changed(Topic::Downloads);

    // 1. Resolve the link to a direct URL.
    let (resolved, client, max_conns) = match engine.plugins.find_for(&d.url) {
        Some(plugin) => {
            let acc = engine.pick_account(&plugin.id).await.map_err(|e| Failure::Fail(format!("{e:#}")))?;
            if plugin.account_required && acc.is_none() {
                return Err(Failure::Fail(format!("Kein aktiver Account für {}", plugin.name)));
            }
            let r = cancellable(cancel, engine.plugins.resolve(&plugin, &d.url, acc.as_ref())).await??;
            let clients = engine.plugins.clients_for(&plugin.id, acc.as_ref().map(|a| a.id));
            let conns = r.max_connections;
            (r, clients.follow, conns)
        }
        None => (
            Resolved { url: d.url.clone(), headers: Default::default(), cookies: None, name: None, size: None, max_connections: None },
            engine.plugins.direct_clients().follow,
            None,
        ),
    };
    let mut headers = HeaderMap::new();
    for (k, v) in &resolved.headers {
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            headers.insert(k, v);
        }
    }
    if let Some(c) = resolved.cookie_header().and_then(|c| HeaderValue::from_str(&c).ok()) {
        headers.insert(COOKIE, c);
    }
    let source = Arc::new(Source { client, url: resolved.url.clone(), headers });

    // 2. Probe: size, range support, file name.
    let resp = cancellable(cancel, source.get(0, None).send()).await?.map_err(net_failure)?;
    if !resp.status().is_success() {
        return Err(http_failure(resp.status()));
    }
    let probe = probe_from(&resp);
    let name = probe
        .name
        .clone()
        .or_else(|| resolved.name.as_deref().map(util::sanitize_filename))
        .or_else(|| (d.online == "online").then(|| d.name.clone()))
        .or_else(|| util::filename_from_url(resp.url().as_str()))
        .unwrap_or_else(|| d.name.clone());
    let total = probe.size.or(resolved.size).filter(|s| *s >= 0).map(|s| s as u64);
    let ranges = probe.ranges && total.is_some();

    // 3. Segments: reuse persisted ones to resume, otherwise plan fresh.
    let path = engine.tmp_path(id);
    tokio::fs::create_dir_all(&engine.cfg.tmp_dir).await?;
    let existing: Vec<Segment> = sqlx::query_as("SELECT idx, start, \"end\", done FROM segments WHERE download_id = ? ORDER BY idx")
        .bind(id)
        .fetch_all(&engine.db)
        .await?;
    let file_len = tokio::fs::metadata(&path).await.map(|m| m.len()).ok();
    let reuse = ranges && !existing.is_empty() && d.size.map(|s| s as u64) == total && file_len == total;
    let segs: Vec<Arc<Seg>> = if reuse {
        existing
            .into_iter()
            .map(|s| {
                Arc::new(Seg {
                    idx: s.idx,
                    start: s.start as u64,
                    end: s.end.map(|e| e as u64),
                    done: AtomicU64::new(s.done as u64),
                    safe: AtomicU64::new(s.done as u64),
                })
            })
            .collect()
    } else {
        let conns = engine.settings().connections_per_file.min(max_conns.unwrap_or(u32::MAX)).max(1) as u64;
        let plan = plan_segments(total, ranges, conns);
        let file = tokio::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&path).await?;
        if let Some(t) = total {
            file.set_len(t).await?;
        }
        let mut tx = engine.db.begin().await?;
        sqlx::query("DELETE FROM segments WHERE download_id = ?").bind(id).execute(&mut *tx).await?;
        for (i, (start, end)) in plan.iter().enumerate() {
            sqlx::query("INSERT INTO segments(download_id, idx, start, \"end\", done) VALUES(?, ?, ?, ?, 0)")
                .bind(id)
                .bind(i as i64)
                .bind(*start as i64)
                .bind(end.map(|e| e as i64))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        plan.into_iter()
            .enumerate()
            .map(|(i, (start, end))| {
                Arc::new(Seg { idx: i as i64, start, end, done: AtomicU64::new(0), safe: AtomicU64::new(0) })
            })
            .collect()
    };

    let already: u64 = segs.iter().map(|s| s.done.load(Ordering::Relaxed)).sum();
    progress.done.store(already, Ordering::Relaxed);
    progress.size.store(total.map(|t| t as i64).unwrap_or(-1), Ordering::Relaxed);
    let res = sqlx::query("UPDATE downloads SET status = ?, name = ?, size = ?, bytes_done = ? WHERE id = ? AND status = ?")
        .bind(status::DOWNLOADING)
        .bind(&name)
        .bind(total.map(|t| t as i64))
        .bind(already as i64)
        .bind(id)
        .bind(status::RESOLVING)
        .execute(&engine.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(Failure::Cancelled);
    }
    engine.events.changed(Topic::Downloads);

    // 4. Transfer. Without range support the probe response is the download itself.
    let mut first = if ranges { None } else { Some(resp) };
    let seg_cancel = cancel.child_token();
    let mut set = JoinSet::new();
    for seg in &segs {
        if seg.end.is_some_and(|e| seg.start + seg.done.load(Ordering::Relaxed) >= e) {
            continue;
        }
        let ctx = SegCtx {
            engine: engine.clone(),
            source: source.clone(),
            path: path.clone(),
            seg: seg.clone(),
            progress: progress.clone(),
            cancel: seg_cancel.clone(),
            ranges,
        };
        let first = first.take();
        set.spawn(async move { run_segment(ctx, first).await });
    }

    let mut failure: Option<Failure> = None;
    let mut persist = tokio::time::interval(Duration::from_secs(3));
    loop {
        tokio::select! {
            joined = set.join_next() => match joined {
                None => break,
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(f))) => {
                    seg_cancel.cancel();
                    if failure.is_none() || matches!(failure, Some(Failure::Cancelled)) {
                        failure = Some(f);
                    }
                }
                Some(Err(e)) => {
                    seg_cancel.cancel();
                    failure.get_or_insert(Failure::Retry(format!("interner Fehler: {e}")));
                }
            },
            _ = persist.tick() => {
                let _ = persist_segments(engine, id, &segs).await;
            }
        }
    }
    persist_segments(engine, id, &segs).await?;
    if cancel.is_cancelled() {
        return Err(Failure::Cancelled);
    }
    if let Some(f) = failure {
        return Err(f);
    }
    let written: u64 = segs.iter().map(|s| s.done.load(Ordering::Relaxed)).sum();
    if let Some(t) = total {
        if written != t {
            return Err(Failure::Retry(format!("unvollständig: {written} von {t} Bytes")));
        }
    }

    // 5. Move into the package folder.
    let dir = engine.package_dir(&pkg);
    tokio::fs::create_dir_all(&dir).await?;
    let dest = unique_path(&dir, &name).await;
    move_file(&path, &dest).await?;
    sqlx::query(
        "UPDATE downloads SET status = ?, size = ?, bytes_done = ?, finished_at = ?, error = NULL, name = ?
         WHERE id = ?",
    )
    .bind(status::FINISHED)
    .bind(written as i64)
    .bind(written as i64)
    .bind(now_ms())
    .bind(dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name))
    .bind(id)
    .execute(&engine.db)
    .await?;
    sqlx::query("DELETE FROM segments WHERE download_id = ?").bind(id).execute(&engine.db).await?;
    tracing::info!(id, file = %dest.display(), "download finished");
    let e = engine.clone();
    tokio::spawn(async move { e.on_download_finished(pkg.id).await });
    Ok(())
}

/// Splits `total` bytes into up to `conns` ranges of at least `MIN_SEGMENT`.
fn plan_segments(total: Option<u64>, ranges: bool, conns: u64) -> Vec<(u64, Option<u64>)> {
    match total {
        Some(t) if ranges && t > 0 => {
            let n = conns.min(t / MIN_SEGMENT).max(1);
            let size = t / n;
            (0..n)
                .map(|i| {
                    let start = i * size;
                    let end = if i == n - 1 { t } else { start + size };
                    (start, Some(end))
                })
                .collect()
        }
        _ => vec![(0, total)],
    }
}

async fn persist_segments(engine: &Engine, id: i64, segs: &[Arc<Seg>]) -> Result<(), Failure> {
    let mut tx = engine.db.begin().await?;
    let mut sum = 0u64;
    for s in segs {
        let safe = s.safe.load(Ordering::Relaxed);
        sum += safe;
        sqlx::query("UPDATE segments SET done = ? WHERE download_id = ? AND idx = ?")
            .bind(safe as i64)
            .bind(id)
            .bind(s.idx)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE downloads SET bytes_done = ? WHERE id = ?").bind(sum as i64).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

struct SegCtx {
    engine: Arc<Engine>,
    source: Arc<Source>,
    path: PathBuf,
    seg: Arc<Seg>,
    progress: Arc<Progress>,
    cancel: CancellationToken,
    ranges: bool,
}

async fn run_segment(ctx: SegCtx, mut first: Option<Response>) -> Result<(), Failure> {
    let seg = &ctx.seg;
    let mut file = tokio::fs::OpenOptions::new().write(true).open(&ctx.path).await?;
    let mut attempt = 0;
    loop {
        let pos = seg.start + seg.done.load(Ordering::Relaxed);
        if seg.end.is_some_and(|e| pos >= e) {
            return Ok(());
        }
        let resp = match first.take() {
            Some(r) => r,
            None => {
                let r = cancellable(&ctx.cancel, ctx.source.get(pos, seg.end).send()).await?.map_err(net_failure);
                match r {
                    Ok(r) if r.status() == StatusCode::PARTIAL_CONTENT => Ok(r),
                    Ok(r) if r.status().is_success() => Err(Failure::Retry("Server ignoriert Range-Anfrage".into())),
                    Ok(r) => Err(http_failure(r.status())),
                    Err(e) => Err(e),
                }?
            }
        };
        file.seek(SeekFrom::Start(pos)).await?;
        let result = pump(&ctx, resp, &mut file).await;
        file.flush().await?;
        seg.safe.store(seg.done.load(Ordering::Relaxed), Ordering::Relaxed);
        let err = match result {
            Ok(()) => match seg.end {
                None => return Ok(()),
                Some(e) if seg.start + seg.done.load(Ordering::Relaxed) >= e => return Ok(()),
                Some(_) => Failure::Retry("Verbindung vorzeitig geschlossen".into()),
            },
            Err(e) => e,
        };
        match err {
            Failure::Retry(msg) if ctx.ranges && attempt < SEGMENT_RETRIES => {
                attempt += 1;
                tracing::debug!(seg = seg.idx, attempt, "segment retry: {msg}");
                cancellable(&ctx.cancel, tokio::time::sleep(Duration::from_secs(2 * attempt as u64))).await?;
            }
            other => return Err(other),
        }
    }
}

async fn pump(ctx: &SegCtx, resp: Response, file: &mut tokio::fs::File) -> Result<(), Failure> {
    let seg = &ctx.seg;
    let mut stream = resp.bytes_stream();
    let mut unflushed = 0u64;
    let mut last_flush = Instant::now();
    loop {
        let next = cancellable(&ctx.cancel, tokio::time::timeout(READ_TIMEOUT, stream.next())).await?;
        let chunk = match next {
            Err(_) => return Err(Failure::Retry("Zeitüberschreitung beim Lesen".into())),
            Ok(None) => return Ok(()),
            Ok(Some(Err(e))) => return Err(net_failure(e)),
            Ok(Some(Ok(c))) => c,
        };
        let mut data = &chunk[..];
        if let Some(end) = seg.end {
            let remaining = end.saturating_sub(seg.start + seg.done.load(Ordering::Relaxed));
            if remaining == 0 {
                return Ok(());
            }
            data = &data[..data.len().min(remaining as usize)];
        }
        cancellable(&ctx.cancel, ctx.engine.limiter.consume(data.len())).await?;
        file.write_all(data).await?;
        let n = data.len() as u64;
        seg.done.fetch_add(n, Ordering::Relaxed);
        ctx.progress.done.fetch_add(n, Ordering::Relaxed);
        unflushed += n;
        if unflushed >= FLUSH_BYTES || last_flush.elapsed() > Duration::from_secs(2) {
            file.flush().await?;
            seg.safe.store(seg.done.load(Ordering::Relaxed), Ordering::Relaxed);
            unflushed = 0;
            last_flush = Instant::now();
        }
        if seg.end.is_some_and(|e| seg.start + seg.done.load(Ordering::Relaxed) >= e) {
            return Ok(());
        }
    }
}

/// `dir/name`, or `dir/name (1).ext` etc. if taken.
async fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if tokio::fs::metadata(&first).await.is_err() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for i in 1.. {
        let p = dir.join(format!("{stem} ({i}){ext}"));
        if tokio::fs::metadata(&p).await.is_err() {
            return p;
        }
    }
    unreachable!()
}

/// Rename, or copy + delete when tmp and target are on different file systems.
async fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match tokio::fs::rename(from, to).await {
        Ok(()) => Ok(()),
        Err(_) => {
            tokio::fs::copy(from, to).await?;
            tokio::fs::remove_file(from).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans() {
        assert_eq!(plan_segments(None, false, 4), vec![(0, None)]);
        assert_eq!(plan_segments(Some(1000), true, 4), vec![(0, Some(1000))]);
        let p = plan_segments(Some(40 * 1024 * 1024 + 3), true, 4);
        assert_eq!(p.len(), 4);
        assert_eq!(p[0].0, 0);
        assert_eq!(p[3].1, Some(40 * 1024 * 1024 + 3));
        for w in p.windows(2) {
            assert_eq!(w[0].1, Some(w[1].0));
        }
    }
}
