//! `haul probe`: runs the plugins against real hosters, the way a download does (QuickJS,
//! reqwest, cookie jars), to see whether they still work. Each case is a test file of our own
//! on one hoster; it is crawled, checked, resolved and downloaded, and compared with what we
//! know about it. Run nightly by the `hoster-probe` workflow; see docs/plugins.md, "Testing on
//! real hosters".
//!
//! The links are private (a GitHub secret), so nothing printed or written to the report names
//! them: cases go by their name, and URLs in messages are cut down to their host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use futures::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONTENT_DISPOSITION, CONTENT_TYPE, COOKIE,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::engine::crypt::Decrypt;
use crate::engine::hash::{self, HashSpec};
use crate::plugins::{AccountCreds, ErrorKind, Job, Plugin, PluginError, PluginManager};

/// Downloads stop here unless a case says otherwise; a test file should be smaller.
const MAX_BYTES: u64 = 64 << 20;
/// For one whole case, waits and download included.
const CASE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const USAGE: &str = "usage: haul probe [--plugins DIR] [--out DIR] [--only NAME,…] [CASES.json]
  CASES.json   the cases; default: the JSON in $HAUL_PROBE_CASES
  --plugins    the built plugins (default plugins/dist)
  --out        report, log and the hoster's pages of failed cases (default probe-out)
  --only       run only these cases";

/// One test file (or folder) on a hoster and what we know about it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    url: String,
    /// The file's name; for a folder, picks the file to download (else the first one).
    name: Option<String>,
    /// The file's size in bytes.
    size: Option<i64>,
    md5: Option<String>,
    sha256: Option<String>,
    /// For a folder link: how many files `crawl` must find.
    files: Option<usize>,
    /// Password of a protected file or folder.
    password: Option<String>,
    /// An account to use, like the one entered in the UI.
    account: Option<CaseAccount>,
    /// Bytes to download at most (default 64 MiB); a larger file is only checked up to there.
    max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseAccount {
    #[serde(default)]
    user: String,
    secret: String,
}

/// The outcome of a case, worst last. Only `Broken`, `Offline` and `Account` need someone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Checked, resolved and downloaded as expected.
    Ok,
    /// Only the online check ran: the plugin needs an account and the case has none.
    Checked,
    /// The plugin got as far as a captcha, which needs a person.
    Captcha,
    /// The hoster was busy, limited or unreachable; not the plugin's fault (as far as we can tell).
    Unavailable,
    /// The account was rejected or is out of traffic.
    Account,
    /// The hoster says the test file is gone: upload it again, or the plugin misreads the page.
    Offline,
    /// The plugin failed or returned something wrong.
    Broken,
}

impl Status {
    pub fn needs_attention(self) -> bool {
        matches!(self, Status::Broken | Status::Offline | Status::Account)
    }
}

#[derive(Debug, Serialize)]
struct Step {
    step: &'static str,
    ok: bool,
    ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseReport {
    case: String,
    plugin: Option<String>,
    plugin_version: Option<String>,
    status: Status,
    message: Option<String>,
    steps: Vec<Step>,
    ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    version: &'static str,
    /// Unix seconds.
    started_at: u64,
    cases: Vec<CaseReport>,
}

/// A failed case: its status and why.
struct Fail(Status, String);

type Outcome = std::result::Result<Status, Fail>;

fn broken(msg: impl Into<String>) -> Fail {
    Fail(Status::Broken, msg.into())
}

impl From<PluginError> for Fail {
    fn from(e: PluginError) -> Self {
        let msg = crate::i18n::plain(&e.message);
        let status = match e.kind {
            ErrorKind::Offline => Status::Offline,
            ErrorKind::Account => Status::Account,
            // What prelude.js throws for a cancelled captcha, or when no one can solve one.
            _ if msg.starts_with("Captcha cancelled")
                || msg.contains("captchas are not available") =>
            {
                Status::Captcha
            }
            ErrorKind::Temporary => Status::Unavailable,
            // A failed `ctx.http` request reaches the plugin as an exception (fatal): the
            // hoster was not reachable, the plugin is not at fault.
            ErrorKind::Fatal if network_error(&msg) => Status::Unavailable,
            ErrorKind::Fatal => Status::Broken,
        };
        Fail(status, msg)
    }
}

/// reqwest's words for a request that never got an answer.
fn network_error(msg: &str) -> bool {
    [
        "error sending request",
        "operation timed out",
        "connection reset",
        "dns error",
    ]
    .iter()
    .any(|m| msg.contains(m))
}

struct Args {
    plugins: PathBuf,
    out: PathBuf,
    only: Option<Vec<String>>,
    cases: Option<PathBuf>,
}

fn parse_args(args: &[String]) -> Result<Args> {
    let mut a = Args {
        plugins: PathBuf::from("plugins/dist"),
        out: PathBuf::from("probe-out"),
        only: None,
        cases: None,
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| anyhow!("{arg} needs a value"))
        };
        match arg.as_str() {
            "--plugins" => a.plugins = value()?.into(),
            "--out" => a.out = value()?.into(),
            "--only" => a.only = Some(value()?.split(',').map(|s| s.trim().to_string()).collect()),
            "-h" | "--help" => bail!("{USAGE}"),
            s if s.starts_with('-') => bail!("unknown option {s}\n{USAGE}"),
            s if a.cases.is_none() => a.cases = Some(s.into()),
            s => bail!("unexpected argument {s}\n{USAGE}"),
        }
    }
    Ok(a)
}

/// `haul probe …`; returns the process exit code: 1 when a case needs attention.
pub async fn main(args: &[String]) -> Result<i32> {
    let args = parse_args(args)?;
    let json = match &args.cases {
        Some(p) => {
            std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?
        }
        None => std::env::var("HAUL_PROBE_CASES")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| anyhow!("no cases: pass a file or set HAUL_PROBE_CASES\n{USAGE}"))?,
    };
    let mut cases: BTreeMap<String, Case> =
        serde_json::from_str(&json).context("reading the cases")?;
    if let Some(only) = &args.only {
        cases.retain(|name, _| only.contains(name));
    }
    if cases.is_empty() {
        bail!("no cases to run");
    }

    std::fs::create_dir_all(&args.out)?;
    // The pages a plugin got are only recorded with debug logging on. The log names links,
    // so it goes to a file with the pages, not to the console.
    let log = std::fs::File::create(args.out.join("haul.log"))?;
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("warn,haul=debug"))
        .with_ansi(false)
        .with_writer(std::sync::Mutex::new(log))
        .init();

    let plugins = Arc::new(PluginManager::new(
        vec![(args.plugins.clone(), true)],
        std::env::var("HAUL_USER_AGENT")
            .ok()
            .filter(|v| !v.is_empty()),
    ));
    plugins.reload().await;
    let answering = no_one_answers(&plugins);
    for e in plugins.errors() {
        eprintln!("plugin {} failed to load: {}", e.file.display(), e.error);
    }
    if plugins.list().is_empty() {
        bail!(
            "no plugins in {} (pnpm build:plugins)",
            args.plugins.display()
        );
    }

    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    // Hosters in parallel, the cases of one hoster one after another: like the downloads,
    // and gentler on the hoster.
    let mut groups: BTreeMap<String, Vec<(String, Case)>> = BTreeMap::new();
    for (i, (name, case)) in cases.into_iter().enumerate() {
        let key = plugins
            .find_for(&case.url)
            .map(|p| p.id.clone())
            .unwrap_or_else(|| format!("~{i}"));
        groups.entry(key).or_default().push((name, case));
    }
    let out = Arc::new(args.out.clone());
    let runs = groups.into_values().map(|group| {
        let (plugins, out) = (plugins.clone(), out.clone());
        async move {
            let mut reports = Vec::new();
            for (name, case) in group {
                reports.push(run_case(&plugins, &out, name, case, reports.len()).await);
            }
            reports
        }
    });
    let mut reports: Vec<CaseReport> = futures::future::join_all(runs)
        .await
        .into_iter()
        .flatten()
        .collect();
    reports.sort_by(|a, b| a.case.cmp(&b.case));
    answering.abort();

    let report = Report {
        version: env!("CARGO_PKG_VERSION"),
        started_at,
        cases: reports,
    };
    std::fs::write(
        args.out.join("report.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    std::fs::write(args.out.join("summary.md"), summary(&report))?;
    for c in &report.cases {
        println!(
            "{:<12} {:<24} {:<12} {:>6.1}s  {}",
            format!("{:?}", c.status).to_lowercase(),
            c.case,
            c.plugin.as_deref().unwrap_or("-"),
            c.ms as f64 / 1000.0,
            c.message.as_deref().unwrap_or("")
        );
    }
    Ok(if report.cases.iter().any(|c| c.status.needs_attention()) {
        1
    } else {
        0
    })
}

/// Gives plugins the case's password (`ctx.password`). Nobody is there to solve a captcha or
/// type another password: every question is cancelled at once, which the plugin reports.
fn no_one_answers(plugins: &PluginManager) -> tokio::task::JoinHandle<()> {
    let captchas = Arc::new(crate::captcha::Captchas::new(crate::events::Events::new()));
    plugins.set_captchas(captchas.clone());
    tokio::spawn(async move {
        loop {
            for q in captchas.list() {
                captchas.cancel(&q.id);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
}

/// A Markdown table for the workflow's summary page.
fn summary(report: &Report) -> String {
    let mut s =
        String::from("| Case | Plugin | Status | Time | Message |\n|---|---|---|---:|---|\n");
    for c in &report.cases {
        let icon = match c.status {
            Status::Ok | Status::Checked | Status::Captcha => "✅",
            Status::Unavailable => "⚠️",
            _ => "❌",
        };
        s.push_str(&format!(
            "| {} | {} {} | {icon} {:?} | {:.1}s | {} |\n",
            c.case,
            c.plugin.as_deref().unwrap_or("-"),
            c.plugin_version
                .as_deref()
                .map(|v| format!("v{v}"))
                .unwrap_or_default(),
            c.status,
            c.ms as f64 / 1000.0,
            c.message.as_deref().unwrap_or("").replace('|', "\\|"),
        ));
    }
    s
}

async fn run_case(
    plugins: &PluginManager,
    out: &Path,
    name: String,
    case: Case,
    index: usize,
) -> CaseReport {
    let started = Instant::now();
    let plugin = plugins.find_for(&case.url);
    let mut probe = Probe {
        plugins,
        out: out.join(&name),
        case: &case,
        steps: Vec::new(),
        secrets: secrets(&case),
    };
    let result = match &plugin {
        None => Err(broken("no plugin handles this link")),
        Some(p) => match tokio::time::timeout(CASE_TIMEOUT, probe.run(p, index as i64 + 1)).await {
            Ok(r) => r,
            Err(_) => Err(Fail(Status::Unavailable, "timed out".into())),
        },
    };
    let (status, message) = match result {
        Ok(s) => (s, None),
        Err(Fail(s, m)) => (s, Some(probe.redact(&m))),
    };
    CaseReport {
        case: name,
        plugin: plugin.as_ref().map(|p| p.id.clone()),
        plugin_version: plugin.as_ref().map(|p| p.version.clone()),
        status,
        message,
        steps: probe.steps,
        ms: started.elapsed().as_millis(),
    }
}

fn secrets(case: &Case) -> Vec<String> {
    let mut s = vec![case.url.clone()];
    s.extend(case.password.clone());
    if let Some(a) = &case.account {
        s.push(a.secret.clone());
        s.push(a.user.clone());
    }
    s.retain(|v| v.len() >= 4);
    s
}

struct Probe<'a> {
    plugins: &'a PluginManager,
    /// Where the hoster's pages of a failed step go.
    out: PathBuf,
    case: &'a Case,
    steps: Vec<Step>,
    secrets: Vec<String>,
}

impl Probe<'_> {
    /// Messages go into a public log: no links, passwords or accounts in them.
    fn redact(&self, text: &str) -> String {
        static URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r#"https?://([^/\s"'<>]+)[^\s"'<>]*"#).unwrap()
        });
        let mut t = text.to_string();
        for s in &self.secrets {
            t = t.replace(s.as_str(), "…");
        }
        URL.replace_all(&t, "https://$1/…").into_owned()
    }

    fn step(&mut self, step: &'static str, started: Instant, detail: Option<String>, ok: bool) {
        let detail = detail.map(|d| self.redact(&d));
        self.steps.push(Step {
            step,
            ok,
            ms: started.elapsed().as_millis(),
            detail,
        });
    }

    /// Records a plugin call and, when it failed, saves the pages the hoster sent for it.
    async fn call<T>(
        &mut self,
        step: &'static str,
        plugin: &Plugin,
        link: &str,
        started: Instant,
        r: std::result::Result<T, PluginError>,
    ) -> std::result::Result<T, Fail> {
        let pages = crate::plugins::host::take_pages(&plugin.id, link);
        match r {
            Ok(v) => {
                self.step(step, started, None, true);
                Ok(v)
            }
            Err(e) => {
                let fail = Fail::from(e);
                self.step(step, started, Some(fail.1.clone()), false);
                if fail.0 != Status::Unavailable {
                    for (n, p) in pages.iter().enumerate() {
                        let text =
                            format!("<!-- {} {} {} -->\n{}", p.method, p.status, p.url, p.body);
                        self.save(&format!("{step}-{}.html", n + 1), text.as_bytes())
                            .await;
                    }
                }
                Err(fail)
            }
        }
    }

    async fn save(&self, file: &str, bytes: &[u8]) {
        let _ = tokio::fs::create_dir_all(&self.out).await;
        let _ = tokio::fs::write(self.out.join(file), bytes).await;
    }

    async fn run(&mut self, plugin: &Plugin, account_id: i64) -> Outcome {
        let case = self.case;
        let account = case.account.as_ref().map(|a| AccountCreds {
            id: account_id,
            user: a.user.clone(),
            secret: a.secret.clone(),
        });
        let password = crate::captcha::Password::new(case.password.clone());
        let job = Job {
            name: None,
            password: &password,
        };

        if let (Some(acc), true) = (&account, plugin.has_check_account) {
            let t = Instant::now();
            let r = self.plugins.check_account(plugin, acc).await;
            let info = self.call("account", plugin, "", t, r).await?;
            if !info.valid {
                let why = info
                    .message
                    .map(|m| crate::i18n::plain(&m))
                    .unwrap_or_default();
                return Err(Fail(Status::Account, format!("account not valid {why}")));
            }
        }

        // A folder: its files, and the one to try.
        let mut link = case.url.clone();
        let mut reported = Reported::default();
        if plugin.has_crawl {
            let t = Instant::now();
            let r = self
                .plugins
                .crawl(plugin, &case.url, account.as_ref(), &job)
                .await;
            let crawl = self.call("crawl", plugin, &case.url, t, r).await?;
            let folder = !(crawl.files.len() == 1 && crawl.files[0].url == case.url);
            if crawl.files.is_empty() {
                return Err(broken("crawl found no files"));
            }
            if let Some(n) = case.files {
                if crawl.files.len() != n {
                    return Err(broken(format!(
                        "crawl found {} files, expected {n}",
                        crawl.files.len()
                    )));
                }
            }
            if folder {
                let file = match &case.name {
                    Some(name) => crawl
                        .files
                        .iter()
                        .find(|f| f.name.as_deref() == Some(name.as_str()))
                        .ok_or_else(|| broken(format!("crawl did not find {name}")))?,
                    None => &crawl.files[0],
                };
                link = file.url.clone();
                reported.add("crawl", file.name.clone(), file.size, file.hash.clone());
            }
        } else if case.files.is_some() {
            return Err(broken("the plugin cannot crawl folders"));
        }

        if plugin.has_check {
            let t = Instant::now();
            let r = self.plugins.check(plugin, &link, account.as_ref()).await;
            let check = self.call("check", plugin, &link, t, r).await?;
            if check.online == Some(false) {
                return Err(Fail(
                    Status::Offline,
                    "check says the file is offline".into(),
                ));
            }
            reported.add("check", check.name, check.size, check.hash);
            reported.verify(case)?;
        }
        if plugin.account_required && account.is_none() {
            return Ok(Status::Checked);
        }

        let t = Instant::now();
        let r = self
            .plugins
            .resolve(plugin, &link, account.as_ref(), &job)
            .await;
        let resolved = self.call("resolve", plugin, &link, t, r).await?;
        reported.add(
            "resolve",
            resolved.name.clone(),
            resolved.size,
            resolved.hash.clone(),
        );
        reported.verify(case)?;

        let t = Instant::now();
        let client = self
            .plugins
            .clients_for(&plugin.id, account.as_ref().map(|a| a.id))
            .follow;
        let r = self.download(&client, &resolved, &mut reported).await;
        let detail = r.as_ref().err().map(|f| f.1.clone());
        self.step("download", t, detail, r.is_ok());
        r?;
        reported.verify(case)?;
        Ok(Status::Ok)
    }

    /// Downloads the file like the worker does (headers, cookies, decryption) and checks it.
    async fn download(
        &self,
        client: &reqwest::Client,
        resolved: &crate::plugins::Resolved,
        reported: &mut Reported,
    ) -> std::result::Result<(), Fail> {
        let unavailable = |e: reqwest::Error| Fail(Status::Unavailable, format!("download: {e}"));
        let mut headers = HeaderMap::new();
        for (k, v) in &resolved.headers {
            if let (Ok(k), Ok(v)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(k, v);
            }
        }
        if let Some(c) = resolved
            .cookie_header()
            .and_then(|c| HeaderValue::from_str(&c).ok())
        {
            headers.insert(COOKIE, c);
        }
        let decrypt = match &resolved.decrypt {
            Some(spec) => Some(Decrypt::from_spec(spec).map_err(broken)?),
            None => None,
        };
        let resp = client
            .get(&resolved.url)
            .headers(headers)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(unavailable)?;
        let status = resp.status();
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(Fail(
                Status::Unavailable,
                format!("download: HTTP {}", status.as_u16()),
            ));
        }
        if !status.is_success() {
            return Err(broken(format!("download: HTTP {}", status.as_u16())));
        }
        let header = |h| {
            resp.headers()
                .get(h)
                .and_then(|v: &HeaderValue| v.to_str().ok())
                .map(str::to_string)
        };
        let disposition = header(CONTENT_DISPOSITION);
        let html = header(CONTENT_TYPE).is_some_and(|t| t.starts_with("text/html"));
        let complete_size = resp.content_length();
        reported.add(
            "download",
            disposition
                .as_deref()
                .and_then(crate::util::filename_from_disposition)
                .filter(|_| decrypt.is_none()),
            None,
            None,
        );

        let max = self.case.max_bytes.unwrap_or(MAX_BYTES);
        let _ = tokio::fs::create_dir_all(&self.out).await;
        let path = self.out.join("download.bin");
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|e| broken(e.to_string()))?;
        let mut stream = resp.bytes_stream();
        let mut got: u64 = 0;
        let mut cut = false;
        while let Some(chunk) = stream.next().await {
            let mut chunk = chunk.map_err(unavailable)?.to_vec();
            if got + chunk.len() as u64 > max {
                chunk.truncate((max - got) as usize);
                cut = true;
            }
            if let Some(d) = &decrypt {
                d.apply(got, &mut chunk);
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| broken(e.to_string()))?;
            got += chunk.len() as u64;
            if cut {
                break;
            }
        }
        file.flush().await.map_err(|e| broken(e.to_string()))?;
        drop(file);

        // On failure download.bin stays, to look at what came instead of the file.
        if html && disposition.is_none() {
            return Err(broken(
                "download: the hoster sent a web page instead of the file (saved as download.bin)",
            ));
        }
        if got == 0 {
            return Err(broken("download: empty"));
        }
        if let Some(len) = complete_size.filter(|len| !cut && *len != got) {
            return Err(Fail(
                Status::Unavailable,
                format!("download: {got} of {len} bytes"),
            ));
        }
        if !cut {
            reported.add("download", None, Some(got as i64), None);
            let mut specs: Vec<(String, HashSpec)> = reported.hashes.clone();
            if let Some(v) = &self.case.md5 {
                specs.push((
                    "case".into(),
                    HashSpec {
                        kind: "md5".into(),
                        value: v.clone(),
                    },
                ));
            }
            if let Some(v) = &self.case.sha256 {
                specs.push((
                    "case".into(),
                    HashSpec {
                        kind: "sha256".into(),
                        value: v.clone(),
                    },
                ));
            }
            for (from, spec) in specs.into_iter().filter(|(_, s)| s.usable()) {
                let p = path.clone();
                let s = spec.clone();
                let ok = tokio::task::spawn_blocking(move || hash::verify(&p, &s))
                    .await
                    .map_err(|e| broken(e.to_string()))?
                    .map_err(|e| broken(e.to_string()))?;
                if !ok {
                    return Err(broken(format!(
                        "{} checksum from {from} does not match",
                        spec.kind
                    )));
                }
            }
        }
        let _ = tokio::fs::remove_file(&path).await;
        Ok(())
    }
}

/// Names, sizes and checksums the plugin (and the download) reported, by where from.
#[derive(Default)]
struct Reported {
    names: Vec<(&'static str, String)>,
    sizes: Vec<(&'static str, i64)>,
    hashes: Vec<(String, HashSpec)>,
}

impl Reported {
    fn add(
        &mut self,
        from: &'static str,
        name: Option<String>,
        size: Option<i64>,
        hash: Option<HashSpec>,
    ) {
        self.names.extend(name.map(|n| (from, n)));
        self.sizes
            .extend(size.filter(|s| *s > 0).map(|s| (from, s)));
        self.hashes.extend(hash.map(|h| (from.to_string(), h)));
    }

    fn verify(&self, case: &Case) -> std::result::Result<(), Fail> {
        if let Some(want) = &case.name {
            if let Some((from, got)) = self.names.iter().find(|(_, n)| n != want) {
                return Err(broken(format!(
                    "{from} says the name is {got:?}, expected {want:?}"
                )));
            }
        }
        if let Some(want) = case.size {
            if let Some((from, got)) = self.sizes.iter().find(|(_, s)| *s != want) {
                return Err(broken(format!(
                    "{from} says the size is {got}, expected {want}"
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(json: &str) -> Case {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn redacts_links_and_secrets() {
        let c = case(r#"{"url":"https://ddownload.com/abcdefghijkl/f.bin","password":"hunter22"}"#);
        let p = Probe {
            plugins: &PluginManager::new(vec![], None),
            out: PathBuf::new(),
            case: &c,
            steps: vec![],
            secrets: secrets(&c),
        };
        assert_eq!(
            p.redact("got https://ddownload.com/abcdefghijkl/f.bin and https://cdn.example.com/x?t=1 (pw hunter22)"),
            "got … and https://cdn.example.com/… (pw …)"
        );
    }

    #[test]
    fn plugin_errors_map_to_statuses() {
        let e = |kind, m: &str| {
            Fail::from(PluginError {
                kind,
                message: m.into(),
                wait_secs: None,
                hoster_wide: false,
            })
            .0
        };
        assert_eq!(e(ErrorKind::Offline, "gone"), Status::Offline);
        assert_eq!(
            e(
                ErrorKind::Temporary,
                "Captcha: captchas are not available here"
            ),
            Status::Captcha
        );
        assert_eq!(e(ErrorKind::Temporary, "busy"), Status::Unavailable);
        assert_eq!(e(ErrorKind::Fatal, "no link found"), Status::Broken);
        assert_eq!(
            e(
                ErrorKind::Fatal,
                "\u{2}Captcha abgebrochen\u{1f}Captcha cancelled\u{3}"
            ),
            Status::Captcha
        );
        assert_eq!(
            e(
                ErrorKind::Fatal,
                "error sending request for url (https://x.test/): connect"
            ),
            Status::Unavailable
        );
        assert!(Status::Broken.needs_attention() && !Status::Captcha.needs_attention());
    }

    #[test]
    fn compares_what_the_plugin_reported() {
        let c = case(r#"{"url":"https://x.test/f","name":"a.bin","size":10}"#);
        let mut r = Reported::default();
        r.add("check", Some("a.bin".into()), Some(10), None);
        assert!(r.verify(&c).is_ok());
        r.add("resolve", None, Some(11), None);
        assert_eq!(
            r.verify(&c).unwrap_err().1,
            "resolve says the size is 11, expected 10"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        assert!(serde_json::from_str::<Case>(r#"{"url":"x","md":"y"}"#).is_err());
    }

    /// A fake hoster and plugin: the whole run, from crawl to the checked download.
    #[tokio::test]
    async fn runs_a_case_end_to_end() {
        use axum::routing::get;
        let app = axum::Router::new()
            .route(
                "/bin",
                get(|| async {
                    (
                        [("content-type", "application/octet-stream")],
                        "hello world",
                    )
                }),
            )
            .route(
                "/page",
                get(|| async { ([("content-type", "text/html")], "<html>Log in</html>") }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("plugins");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("fake.js"),
            r#"var __plugin = { default: {
              id: "fake", version: 1, matches: [/127\.0\.0\.1:\d+\/(f|d)\//],
              async check(link) {
                return link.includes("gone") ? { online: false } : { online: true, name: "a.bin", size: 11 };
              },
              async crawl(link) {
                if (!link.includes("/d/")) return { files: [{ url: link }] };
                var f = link.replace("/d/", "/f/");
                return { files: [{ url: f + "-1", name: "a.bin", size: 11 }, { url: f + "-2", name: "b.bin" }] };
              },
              async resolve(link, ctx) {
                if (link.includes("cap")) await ctx.captcha.solve({ kind: "turnstile", siteKey: "k", pageUrl: link });
                if (link.includes("pw") && (await ctx.password.get()) !== "s3cret") throw new Error("wrong password");
                return { url: link.split("/f/")[0] + (link.includes("page") ? "/page" : "/bin"), name: "a.bin" };
              }
            } };"#,
        )
        .unwrap();
        let pm = PluginManager::new(vec![(dir, true)], None);
        pm.reload().await;
        assert!(pm.errors().is_empty(), "{:?}", pm.errors());
        let _answering = no_one_answers(&pm);

        let md5 = "5eb63bbbe01eeed093cb22bb8f5acdc3";
        let run = |name: &str, json: String| {
            let (pm, out, name) = (&pm, tmp.path().join("out"), name.to_string());
            async move { run_case(pm, &out, name, case(&json), 0).await }
        };
        let ok = run(
            "ok",
            format!(r#"{{"url":"{base}/f/x","name":"a.bin","size":11,"md5":"{md5}"}}"#),
        )
        .await;
        assert_eq!(ok.status, Status::Ok, "{:?}", ok.message);
        let steps: Vec<_> = ok.steps.iter().map(|s| s.step).collect();
        assert_eq!(steps, ["crawl", "check", "resolve", "download"]);
        assert!(!tmp.path().join("out/ok/download.bin").exists());

        let folder = run(
            "folder",
            format!(r#"{{"url":"{base}/d/x","files":2,"name":"a.bin","md5":"{md5}"}}"#),
        )
        .await;
        assert_eq!(folder.status, Status::Ok, "{:?}", folder.message);
        let count = run("count", format!(r#"{{"url":"{base}/d/x","files":3}}"#)).await;
        assert_eq!(
            count.message.as_deref(),
            Some("crawl found 2 files, expected 3")
        );

        let sum = run(
            "sum",
            format!(r#"{{"url":"{base}/f/x","md5":"{}"}}"#, "0".repeat(32)),
        )
        .await;
        assert_eq!(sum.status, Status::Broken);
        assert_eq!(
            sum.message.as_deref(),
            Some("md5 checksum from case does not match")
        );
        let name = run("name", format!(r#"{{"url":"{base}/f/x","name":"z.bin"}}"#)).await;
        assert_eq!(
            name.message.as_deref(),
            Some(r#"check says the name is "a.bin", expected "z.bin""#)
        );
        let page = run("page", format!(r#"{{"url":"{base}/f/page"}}"#)).await;
        assert_eq!(page.status, Status::Broken);
        assert!(tmp.path().join("out/page/download.bin").exists());
        let pw = run(
            "pw",
            format!(r#"{{"url":"{base}/f/pw","password":"s3cret"}}"#),
        )
        .await;
        assert_eq!(pw.status, Status::Ok, "{:?}", pw.message);
        let no_pw = run("no-pw", format!(r#"{{"url":"{base}/f/pw"}}"#)).await;
        assert_eq!(no_pw.status, Status::Broken, "{:?}", no_pw.message);
        let cap = run("cap", format!(r#"{{"url":"{base}/f/cap"}}"#)).await;
        assert_eq!(cap.status, Status::Captcha, "{:?}", cap.message);
        let gone = run("gone", format!(r#"{{"url":"{base}/f/gone"}}"#)).await;
        assert_eq!(gone.status, Status::Offline);
    }
}
