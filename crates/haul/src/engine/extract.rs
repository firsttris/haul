//! Unpacks finished packages with `7z` (and `unrar` as fallback for RAR).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use regex::Regex;
use tokio::process::Command;

use super::Engine;
use crate::db::{self, status};
use crate::events::Topic;
use crate::files;

/// First volume of each archive set among `names`, plus every file belonging to a set.
/// Which archive set a file belongs to, and whether it is the set's first volume
/// (`x.part3.rar` → set `x` of `.partN.rar`, not first).
fn set_key(name: &str) -> Option<(String, bool)> {
    let lower = name.to_lowercase();
    let part = Regex::new(r"^(.*)\.part0*(\d+)\.rar$").unwrap();
    let split = Regex::new(r"^(.*\.(?:7z|zip|rar))\.0*(\d+)$").unwrap();
    let rar_old = Regex::new(r"^(.*)\.r\d{2}$").unwrap();
    if let Some(c) = part.captures(&lower) {
        return Some((format!("{}|part", &c[1]), &c[2] == "1"));
    }
    if let Some(c) = split.captures(&lower) {
        return Some((format!("{}|split", &c[1]), &c[2] == "1"));
    }
    if let Some(c) = rar_old.captures(&lower) {
        return Some((format!("{}|rar", &c[1]), false));
    }
    if let Some(stem) = lower.strip_suffix(".rar") {
        return Some((format!("{stem}|rar"), true));
    }
    (lower.ends_with(".zip") || lower.ends_with(".7z")).then(|| (lower.clone(), true))
}

/// First volume and all volumes of one archive set.
pub type ArchiveSet = (String, Vec<String>);

/// The archive set of `name` among `names`: its first volume and all volumes.
/// Clicking any part (`part3.rar`, `.r01`, `.7z.002`) extracts the whole set.
pub fn archive_set(names: &[String], name: &str) -> Option<(String, Vec<String>)> {
    let (key, _) = set_key(name)?;
    let members: Vec<String> = names
        .iter()
        .filter(|n| set_key(n).is_some_and(|(k, _)| k == key))
        .cloned()
        .collect();
    let first = members
        .iter()
        .find(|n| set_key(n).is_some_and(|(_, f)| f))?
        .clone();
    Some((first, members))
}

pub fn find_archives(names: &[String]) -> (Vec<String>, Vec<String>) {
    let part = Regex::new(r"(?i)\.part0*(\d+)\.rar$").unwrap();
    let rar_old = Regex::new(r"(?i)\.r\d{2}$").unwrap();
    let split = Regex::new(r"(?i)\.(7z|zip|rar)\.0*(\d+)$").unwrap();
    let mut first = Vec::new();
    let mut all = Vec::new();
    for n in names {
        let lower = n.to_lowercase();
        if let Some(c) = part.captures(n) {
            all.push(n.clone());
            if &c[1] == "1" {
                first.push(n.clone());
            }
        } else if let Some(c) = split.captures(n) {
            all.push(n.clone());
            if &c[2] == "1" {
                first.push(n.clone());
            }
        } else if rar_old.is_match(n) {
            all.push(n.clone());
        } else if lower.ends_with(".rar") || lower.ends_with(".zip") || lower.ends_with(".7z") {
            all.push(n.clone());
            first.push(n.clone());
        }
    }
    (first, all)
}

/// Last `NN%` in a chunk of tool output (7-Zip `-bsp1` and unrar redraw it with `\b`/`\r`).
fn last_percent(text: &str) -> Option<u8> {
    let re = Regex::new(r"(\d{1,3})%").unwrap();
    re.captures_iter(text)
        .filter_map(|c| c[1].parse::<u8>().ok())
        .filter(|p| *p <= 100)
        .last()
}

/// How an extractor run ended, with its output (progress redraws removed).
struct Run {
    ok: bool,
    code: Option<i32>,
    /// Killed by a signal, e.g. 11 when it crashed (exit status 139 in a shell).
    signal: Option<i32>,
    stdout: String,
    stderr: String,
}

fn clean(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .replace(['\u{8}', '\r'], "\n")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && last_percent(l).is_none_or(|_| l.len() > 12))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Runs an extractor, reporting its percentage while it runs.
async fn run_tool(mut cmd: Command, on_progress: &mut (dyn FnMut(u8) + Send)) -> Result<Run> {
    use tokio::io::AsyncReadExt;
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = stdout.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        if let Some(p) = last_percent(&String::from_utf8_lossy(&chunk[..n])) {
            on_progress(p);
        }
        out.extend_from_slice(&chunk[..n]);
        if out.len() > 256 * 1024 {
            out.drain(..out.len() - 64 * 1024);
        }
    }
    let status = child.wait().await?;
    let err = err_task.await.unwrap_or_default();
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal = None;
    Ok(Run {
        ok: status.success(),
        code: status.code(),
        signal,
        stdout: clean(&out),
        stderr: clean(&err),
    })
}

/// What went wrong in a failed run, as far as it can be told from the output.
#[derive(Default, Clone, Copy)]
struct Causes {
    crashed: bool,
    wrong_password: bool,
    unsupported: bool,
    no_space: bool,
    damaged: bool,
}

/// The lines of a failed run that say what went wrong: everything on stderr, and the lines
/// of stdout that read like an error (7-Zip and unrar print a lot of archive info there).
fn error_lines(run: &Run) -> Vec<String> {
    let re = Regex::new(
        r"(?i)error|cannot|can't|wrong password|incorrect password|unsupported|crc failed|checksum|corrupt|damaged|no space|denied|unexpected end|failed|is not supported",
    )
    .unwrap();
    let mut lines: Vec<String> = run.stderr.lines().map(str::to_string).collect();
    lines.extend(
        run.stdout
            .lines()
            .filter(|l| re.is_match(l))
            .map(str::to_string),
    );
    let mut seen = std::collections::HashSet::new();
    lines.retain(|l| seen.insert(l.clone()));
    lines
}

fn causes(run: &Run) -> Causes {
    let text = format!("{}\n{}", run.stdout, run.stderr).to_lowercase();
    Causes {
        // A shell reports a signal as 128 + n (139 = segfault).
        crashed: run.signal.is_some() || run.code.is_some_and(|c| c > 128),
        // Any mention of a password, like pyLoad's UnRar extractor (`_RE_BADPWD = "password"`):
        // unrar says "The specified password is incorrect." or "wrong password", 7-Zip "Wrong
        // password", unar "requires a password".
        wrong_password: text.contains("password") || text.contains("encrypted file"),
        unsupported: text.contains("unsupported method") || text.contains("is not supported"),
        no_space: text.contains("no space left") || text.contains("disk full"),
        damaged: text.contains("crc failed")
            || text.contains("is corrupt")
            || text.contains("unexpected end"),
    }
}

/// One line for a failed run: the tool, how it ended and its error lines.
fn describe_run(tool: &Tool, run: &Run) -> String {
    let how = match (run.signal, run.code) {
        (Some(sig), _) => crate::tr!("abgestürzt (Signal {})", "crashed (signal {})", sig),
        (None, Some(c)) if c > 128 => crate::tr!("abgestürzt (Code {})", "crashed (code {})", c),
        (None, Some(c)) => crate::tr!("Code {}", "code {}", c),
        (None, None) => String::new(),
    };
    let mut lines = error_lines(run);
    if lines.is_empty() {
        // Nothing that reads like an error: the last lines, which at least show how far it got.
        lines = run
            .stdout
            .lines()
            .rev()
            .take(2)
            .map(str::to_string)
            .collect();
        lines.reverse();
    }
    lines.truncate(3);
    let detail = lines.join(" · ");
    let name = tool.name();
    if detail.is_empty() {
        format!("{name} ({how})")
    } else {
        format!("{name} ({how}): {detail}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    SevenZip,
    Unrar,
    Unar,
}

#[derive(Debug, Clone)]
pub struct Tool {
    kind: Kind,
    path: PathBuf,
}

impl Tool {
    pub fn describe(&self) -> String {
        self.path.display().to_string()
    }

    fn name(&self) -> &'static str {
        match self.kind {
            Kind::SevenZip => "7-Zip",
            Kind::Unrar => "unrar",
            Kind::Unar => "unar",
        }
    }
}

/// Resolves a program name through `PATH` (or takes an explicit path as-is).
fn find_program(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let p = PathBuf::from(name);
        return p.is_file().then_some(p);
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// Installed extractors, best first. `HAUL_7Z` / `HAUL_UNRAR` override the lookup.
pub fn available_tools() -> Vec<Tool> {
    let mut tools = Vec::new();
    let pick = |var: &str, names: &[&str]| match std::env::var(var).ok().filter(|v| !v.is_empty()) {
        Some(v) => find_program(&v),
        None => names.iter().find_map(|n| find_program(n)),
    };
    if let Some(path) = pick("HAUL_UNRAR", &["unrar"]) {
        tools.push(Tool {
            kind: Kind::Unrar,
            path,
        });
    }
    // 7zz is current 7-Zip; 7z/7za are p7zip.
    if let Some(path) = pick("HAUL_7Z", &["7zz", "7z", "7za"]) {
        tools.push(Tool {
            kind: Kind::SevenZip,
            path,
        });
    }
    if let Some(path) = find_program("unar") {
        tools.push(Tool {
            kind: Kind::Unar,
            path,
        });
    }
    tools
}

fn is_rar(archive: &Path) -> bool {
    archive
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("rar"))
}

fn command(tool: &Tool, archive: &Path, dest: &Path, pw: &str) -> Command {
    let mut cmd = Command::new(&tool.path);
    match tool.kind {
        Kind::SevenZip => {
            // -bsp1: progress in percent on stdout.
            cmd.arg("x")
                .arg("-y")
                .arg("-bsp1")
                .arg(format!("-o{}", dest.display()))
                .arg(format!("-p{pw}"))
                .arg(archive);
        }
        Kind::Unrar => {
            let pw = if pw.is_empty() {
                "-p-".to_string()
            } else {
                format!("-p{pw}")
            };
            cmd.arg("x")
                .arg("-o+")
                .arg(pw)
                .arg(archive)
                .arg(format!("{}/", dest.display()));
        }
        Kind::Unar => {
            cmd.arg("-q").arg("-f").arg("-D").arg("-o").arg(dest);
            if !pw.is_empty() {
                cmd.arg("-p").arg(pw);
            }
            cmd.arg(archive);
        }
    }
    cmd
}

/// Why an archive could not be extracted: the message for the UI, and whether a password
/// is what is missing (then another one may still open it).
#[derive(Debug)]
struct Failed {
    message: String,
    wrong_password: bool,
}

/// Tries `candidates` in order (`""`: no password) with each extractor; the password that
/// opened the archive.
async fn extract_one(
    archive: &Path,
    dest: &Path,
    candidates: &[String],
    on_progress: &mut (dyn FnMut(u8) + Send),
) -> Result<String, Failed> {
    // unrar handles RAR best (RAR5, volumes); 7-Zip builds without the RAR codec cannot.
    let tools: Vec<Tool> = available_tools()
        .into_iter()
        .filter(|t| t.kind != Kind::Unrar || is_rar(archive))
        .collect();
    if tools.is_empty() {
        return Err(Failed {
            message: crate::tr!(
                "kein Entpacker gefunden. Empfohlen: 7-Zip und unrar, unter Ubuntu/Debian \
                 „sudo apt install 7zip unrar“; im Docker-Image ist alles enthalten",
                "no extractor found. Recommended: 7-Zip and unrar, on Ubuntu/Debian \
                 “sudo apt install 7zip unrar”; the Docker image has everything"
            ),
            wrong_password: false,
        });
    }
    // Per tool, its first failure (without password) says the most; the others add causes.
    let mut failures: Vec<(Kind, String)> = Vec::new();
    let mut found = Causes::default();
    for pw in candidates {
        for tool in &tools {
            let line = match run_tool(command(tool, archive, dest, pw), on_progress).await {
                Ok(run) if run.ok => return Ok(pw.clone()),
                Ok(run) => {
                    let c = causes(&run);
                    found.crashed |= c.crashed;
                    found.wrong_password |= c.wrong_password;
                    found.unsupported |= c.unsupported;
                    found.no_space |= c.no_space;
                    found.damaged |= c.damaged;
                    let tail: String = format!("{}\n{}", run.stdout, run.stderr);
                    let tail = &tail[tail.floor_char_boundary(tail.len().saturating_sub(4000))..];
                    tracing::warn!(
                        archive = %archive.display(),
                        tool = %tool.describe(),
                        code = ?run.code,
                        signal = ?run.signal,
                        "extractor failed, its output:\n{tail}"
                    );
                    describe_run(tool, &run)
                }
                Err(e) => format!("{}: {e}", tool.name()),
            };
            if !failures.iter().any(|(k, _)| *k == tool.kind) {
                failures.push((tool.kind, line));
            }
        }
    }
    let has_unrar = tools.iter().any(|t| t.kind == Kind::Unrar);
    let lines = failures.into_iter().map(|(_, l)| l).collect();
    Err(Failed {
        message: failure_message(is_rar(archive), has_unrar, found, lines),
        wrong_password: found.wrong_password && !found.no_space,
    })
}

/// The archive's name without volume and type (`x.part01.rar`, `x.7z.001` → `x`), which JD
/// tries as a password too (ExtractionController: `passwordList.add(archive.getName())`).
fn archive_name(file: &str) -> String {
    let re = Regex::new(r"(?i)(?:\.part0*\d+)?\.(?:rar|zip|7z)(?:\.\d+)?$").unwrap();
    re.replace(file, "").to_string()
}

/// The passwords to try, in JD's order (ExtractionController): none, the package's, the
/// archive's name, the archive password list. Each also trimmed if that differs (JD: "try
/// trimmed password"); no duplicates.
fn candidates(package: &[String], archive_file: &str, list: &[String]) -> Vec<String> {
    let name = archive_name(archive_file);
    let mut out: Vec<String> = vec![String::new()];
    for pw in package.iter().chain([&name]).chain(list) {
        for p in [pw.as_str(), pw.trim()] {
            if !p.is_empty() && !out.iter().any(|o| o == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// A list as the user typed it: without empty lines and duplicates, order kept.
fn clean_passwords(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.trim_end_matches(['\r', '\n']).to_string();
        if !p.trim().is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// The error for the UI: what to do about it (most likely cause first), then what each
/// extractor said.
fn failure_message(rar: bool, has_unrar: bool, found: Causes, failures: Vec<String>) -> String {
    let hint = if found.no_space {
        Some(crate::tr!(
            "kein Speicherplatz mehr frei",
            "no space left on the disk"
        ))
    } else if found.wrong_password {
        Some(crate::tr!(
            "Passwort fehlt oder ist falsch: unter Einstellungen → Archiv-Passwörter eintragen oder beim erneuten Entpacken eingeben",
            "password missing or wrong: add it under Settings → Archive passwords or enter it when extracting again"
        ))
    } else if rar && !has_unrar && (found.crashed || found.unsupported) {
        Some(crate::tr!(
            "7-Zip kann dieses RAR-Archiv nicht entpacken; unrar installieren („sudo apt install unrar“), Haul nimmt es für RAR zuerst",
            "7-Zip cannot extract this RAR archive; install unrar (“sudo apt install unrar”), Haul uses it first for RAR"
        ))
    } else if found.crashed {
        Some(crate::tr!(
            "der Entpacker ist abgestürzt",
            "the extractor crashed"
        ))
    } else if found.damaged {
        Some(crate::tr!(
            "Archiv beschädigt oder unvollständig",
            "archive damaged or incomplete"
        ))
    } else {
        None
    };
    let detail = failures.join("; ");
    match hint {
        Some(h) => crate::tr!(
            "Entpacken fehlgeschlagen: {}. {}",
            "Extraction failed: {}. {}",
            h,
            detail
        ),
        None => crate::tr!(
            "Entpacken fehlgeschlagen: {}",
            "Extraction failed: {}",
            detail
        ),
    }
}

impl Engine {
    /// A download finished: once the whole package is done, extract it and/or move it.
    pub(super) async fn on_download_finished(self: Arc<Self>, package_id: i64) {
        let Ok(downloads) = db::package_downloads(&self.db, package_id).await else {
            return;
        };
        if downloads.iter().any(|d| d.status != status::FINISHED) {
            return;
        }
        let Ok(Some(pkg)) = db::get_package(&self.db, package_id).await else {
            return;
        };
        let dir = self.package_dir(&pkg);
        let (archives, _) = find_archives(&files::file_names(&dir));
        if self.settings().auto_extract && !archives.is_empty() {
            if let Err(e) = self.extract_package(package_id).await {
                tracing::warn!(package_id, "extract: {e:#}");
            }
        }
    }

    pub(super) async fn resume_pending_extractions(self: Arc<Self>) {
        let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM packages WHERE extract = 'pending'")
            .fetch_all(&self.db)
            .await
            .unwrap_or_default();
        for id in ids {
            let _ = self.extract_package(id).await;
        }
    }

    /// Extracts the archives in the package folder (whatever is on disk there, so renamed or
    /// added files count too) and records the result on the package.
    pub async fn extract_package(&self, package_id: i64) -> Result<()> {
        let pkg = db::get_package(&self.db, package_id)
            .await?
            .ok_or_else(|| anyhow!(crate::tr!("Paket nicht gefunden", "Package not found")))?;
        let dir = self.package_dir(&pkg);
        if find_archives(&files::file_names(&dir)).0.is_empty() {
            return Ok(());
        }
        let claimed = sqlx::query(
            "UPDATE packages SET extract = 'running', extract_error = NULL
             WHERE id = ? AND (extract IS NULL OR extract != 'running')",
        )
        .bind(package_id)
        .execute(&self.db)
        .await?;
        if claimed.rows_affected() == 0 {
            return Ok(());
        }
        self.events.changed(Topic::Downloads);
        let passwords: Vec<String> = pkg
            .passwords
            .as_deref()
            .unwrap_or("")
            .lines()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect();
        let rel = files::relative(&self.cfg.done_dir, &dir);
        let error = self
            .extract_dir(&dir, &rel, Some(package_id), &passwords, None)
            .await
            .err()
            .map(|e| format!("{e:#}"));
        sqlx::query("UPDATE packages SET extract = ?, extract_error = ? WHERE id = ?")
            .bind(if error.is_some() { "failed" } else { "done" })
            .bind(&error)
            .bind(package_id)
            .execute(&self.db)
            .await?;
        self.events.changed(Topic::Downloads);
        self.events.changed(Topic::Files);
        match error {
            Some(e) => Err(anyhow!(e)),
            None => Ok(()),
        }
    }

    /// Extracts every archive set directly inside `dir` (or only the set `only`: first volume
    /// and all volumes), reporting the overall percentage under `rel` (the folder relative to
    /// the done folder).
    async fn extract_dir(
        &self,
        dir: &Path,
        rel: &str,
        package_id: Option<i64>,
        passwords: &[String],
        only: Option<(String, Vec<String>)>,
    ) -> Result<()> {
        let (first, all) = match only {
            Some((first, members)) => (vec![first], members),
            None => find_archives(&files::file_names(dir)),
        };
        let n = first.len().max(1) as u32;
        self.set_extract_progress(rel, package_id, Some(0));
        let mut result = Ok(());
        for (i, a) in first.iter().enumerate() {
            let mut report = |p: u8| {
                self.set_extract_progress(
                    rel,
                    package_id,
                    Some(((i as u32 * 100 + p as u32) / n) as u8),
                );
            };
            if let Err(e) = self
                .extract_archive(dir, a, package_id, passwords, &mut report)
                .await
            {
                result = Err(anyhow!("{a}: {e:#}"));
                break;
            }
        }
        self.set_extract_progress(rel, package_id, None);
        if result.is_ok() && self.settings().delete_archives {
            for a in &all {
                let _ = tokio::fs::remove_file(dir.join(a)).await;
            }
        }
        result
    }

    /// One archive set in `dir`: the known passwords first, then, if none opens it and asking
    /// is on, the user (JD: ExtractionController `PASSWORD_NEEDED_TO_CONTINUE`, answered by
    /// ExtractPasswordDialog in ExtractionListenerList). JD asks once; Haul asks again after a
    /// wrong answer, up to three times like for download passwords. The password that opened
    /// it goes to the front of the archive password list (JD ExtractionExtension.addPassword).
    async fn extract_archive(
        &self,
        dir: &Path,
        file: &str,
        package_id: Option<i64>,
        package_passwords: &[String],
        on_progress: &mut (dyn FnMut(u8) + Send),
    ) -> Result<()> {
        let archive = dir.join(file);
        let known = candidates(package_passwords, file, &self.archive_passwords().await);
        let mut failed = match extract_one(&archive, dir, &known, on_progress).await {
            Ok(pw) => {
                self.remember_archive_password(&pw).await;
                return Ok(());
            }
            Err(f) => f,
        };
        let asker = self.plugins.captchas();
        if !failed.wrong_password || !self.settings().ask_archive_password || asker.is_none() {
            return Err(anyhow!(failed.message));
        }
        let asker = asker.unwrap();
        let package = match package_id {
            Some(id) => db::get_package(&self.db, id)
                .await
                .ok()
                .flatten()
                .map(|p| p.name),
            None => None,
        };
        for attempt in 0..3 {
            let pw = match asker
                .ask_archive_password(file, package.as_deref(), attempt > 0)
                .await
            {
                Ok(pw) => pw,
                // Cancelled or no answer in time: the failure as it was.
                Err(_) => break,
            };
            match extract_one(&archive, dir, std::slice::from_ref(&pw), on_progress).await {
                Ok(pw) => {
                    self.remember_archive_password(&pw).await;
                    return Ok(());
                }
                Err(f) => {
                    let again = f.wrong_password;
                    failed = f;
                    if !again {
                        break;
                    }
                }
            }
        }
        Err(anyhow!(failed.message))
    }

    /// The archive password list (Settings → Archive passwords).
    pub async fn archive_passwords(&self) -> Vec<String> {
        db::get_setting(&self.db, db::ARCHIVE_PASSWORDS)
            .await
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    /// Replaces the archive password list; empty lines and duplicates are dropped.
    pub async fn set_archive_passwords(&self, list: Vec<String>) -> Result<Vec<String>> {
        let _lock = self.archive_passwords.lock().await;
        let list = clean_passwords(list);
        db::set_setting(
            &self.db,
            db::ARCHIVE_PASSWORDS,
            &serde_json::to_string(&list)?,
        )
        .await?;
        self.events.changed(Topic::Settings);
        Ok(list)
    }

    /// A password that opened an archive: first in the list from now on (JD addPassword:
    /// "avoid duplicates", `add(0, pw)`).
    async fn remember_archive_password(&self, pw: &str) {
        if pw.is_empty() {
            return;
        }
        let _lock = self.archive_passwords.lock().await;
        let mut list = self.archive_passwords().await;
        if list.first().is_some_and(|p| p == pw) {
            return;
        }
        list.retain(|p| p != pw);
        list.insert(0, pw.to_string());
        match serde_json::to_string(&list) {
            Ok(json) => {
                if let Err(e) = db::set_setting(&self.db, db::ARCHIVE_PASSWORDS, &json).await {
                    tracing::warn!("saving the archive password: {e:#}");
                }
                self.events.changed(Topic::Settings);
            }
            Err(e) => tracing::warn!("saving the archive password: {e:#}"),
        }
    }

    /// "Entpacken" in the Fertig view for the selected entries. A folder: all archive sets in it
    /// (through its package if it has one, which keeps passwords and status). A file: the set
    /// it belongs to, whichever volume was picked; several volumes of one set run once. Runs in
    /// the background, one job after the other.
    pub fn extract_paths(self: &Arc<Self>, paths: &[String]) -> Result<()> {
        let mut jobs: Vec<(PathBuf, Option<ArchiveSet>)> = Vec::new();
        for rel in paths {
            let path = files::resolve(&self.cfg.done_dir, rel)?;
            let job = if path.is_dir() {
                (path, None)
            } else {
                let dir = path
                    .parent()
                    .ok_or_else(|| anyhow!(crate::tr!("ungültiger Pfad", "invalid path")))?
                    .to_path_buf();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let set = archive_set(&files::file_names(&dir), &name).ok_or_else(|| {
                    anyhow!(crate::tr!(
                        "{} ist kein Archiv oder der erste Teil fehlt",
                        "{} is not an archive or its first part is missing",
                        name
                    ))
                })?;
                (dir, Some(set))
            };
            // A whole folder covers its sets; a set is only needed once.
            let covered = jobs.iter().any(|(d, s)| {
                *d == job.0
                    && (s.is_none() || s.as_ref().map(|x| &x.0) == job.1.as_ref().map(|x| &x.0))
            });
            if !covered {
                if job.1.is_none() {
                    jobs.retain(|(d, _)| *d != job.0);
                }
                jobs.push(job);
            }
        }
        if jobs.is_empty() {
            anyhow::bail!(crate::tr!(
                "nichts zum Entpacken ausgewählt",
                "nothing selected to extract"
            ));
        }
        for (dir, _) in &jobs {
            if self
                .extract_progress_of(&files::relative(&self.cfg.done_dir, dir))
                .is_some()
            {
                anyhow::bail!(crate::tr!(
                    "in {} wird bereits entpackt",
                    "{} is already being extracted",
                    dir.display()
                ));
            }
        }
        let this = self.clone();
        tokio::spawn(async move {
            for (dir, set) in jobs {
                let folder = files::relative(&this.cfg.done_dir, &dir);
                let package = this.package_for_dir(&dir).await;
                let result = match (package, set) {
                    (Some(id), None) => this.extract_package(id).await,
                    (package, set) => {
                        let passwords = match package {
                            Some(id) => db::get_package(&this.db, id)
                                .await
                                .ok()
                                .flatten()
                                .and_then(|p| p.passwords)
                                .map(|p| {
                                    p.lines()
                                        .map(str::trim)
                                        .filter(|l| !l.is_empty())
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default(),
                            None => Vec::new(),
                        };
                        this.extract_dir(&dir, &folder, package, &passwords, set)
                            .await
                    }
                };
                let mut errors = this.folder_errors.lock().unwrap();
                match result {
                    Ok(()) => errors.remove(&folder),
                    Err(e) => errors.insert(folder.clone(), format!("{e:#}")),
                };
                drop(errors);
                this.events.changed(Topic::Files);
            }
        });
        Ok(())
    }

    /// The package whose folder `dir` is, if any.
    pub async fn package_for_dir(&self, dir: &Path) -> Option<i64> {
        let packages: Vec<db::Package> = sqlx::query_as("SELECT * FROM packages")
            .fetch_all(&self.db)
            .await
            .ok()?;
        let dir = dir.canonicalize().ok()?;
        packages
            .into_iter()
            .find(|p| self.package_dir(p).canonicalize().is_ok_and(|d| d == dir))
            .map(|p| p.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_parsing() {
        assert_eq!(
            last_percent("  3% 1 - a.mkv\u{8}\u{8}\u{8}\u{8} 17% 1 - a.mkv"),
            Some(17)
        );
        assert_eq!(
            last_percent("Extracting  a.mkv   45%\u{8}\u{8}\u{8}\u{8}  46%"),
            Some(46)
        );
        assert_eq!(last_percent("Everything is Ok"), None);
    }

    #[test]
    fn set_of_any_volume() {
        let names: Vec<String> = [
            "X.part1.rar",
            "X.part2.rar",
            "X.part3.rar",
            "Y.part1.rar",
            "old.rar",
            "old.r00",
            "a.7z.001",
            "a.7z.002",
            "m.mkv",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (first, members) = archive_set(&names, "X.part3.rar").unwrap();
        assert_eq!(first, "X.part1.rar");
        assert_eq!(members, ["X.part1.rar", "X.part2.rar", "X.part3.rar"]);
        assert_eq!(archive_set(&names, "old.r00").unwrap().0, "old.rar");
        assert_eq!(archive_set(&names, "a.7z.002").unwrap().1.len(), 2);
        assert!(archive_set(&names, "m.mkv").is_none());
        // First part missing: nothing to start with.
        assert!(archive_set(&names[1..3], "X.part2.rar").is_none());
    }

    /// JD's order: none, the package's, the archive's name, the list; trimmed variants, no
    /// duplicates.
    #[test]
    fn password_candidates() {
        assert_eq!(archive_name("Film.part01.rar"), "Film");
        assert_eq!(archive_name("a.7z.001"), "a");
        assert_eq!(archive_name("x.ZIP"), "x");
        let got = candidates(
            &["pkg ".into(), "".into()],
            "Film.part1.rar",
            &["list".into(), "pkg".into(), "Film".into()],
        );
        assert_eq!(got, ["", "pkg ", "pkg", "Film", "list"]);
        assert_eq!(
            clean_passwords(vec![
                " a".into(),
                "".into(),
                "  ".into(),
                " a".into(),
                "b\r".into()
            ]),
            [" a", "b"]
        );
    }

    #[test]
    fn archive_sets() {
        let names: Vec<String> = [
            "a.part1.rar",
            "a.part2.rar",
            "b.part01.rar",
            "b.part02.rar",
            "c.zip",
            "d.7z.001",
            "d.7z.002",
            "e.rar",
            "e.r00",
            "movie.mkv",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (first, all) = find_archives(&names);
        assert_eq!(
            first,
            vec!["a.part1.rar", "b.part01.rar", "c.zip", "d.7z.001", "e.rar"]
        );
        assert_eq!(all.len(), 9);
    }
}

/// Held by tests that change `PATH` or need the real extractors on it.
#[cfg(test)]
pub(crate) static PATH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tool_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Finds extractors on PATH, calls them with 7-Zip's arguments and explains a missing one.
    /// (One test, because it changes the process-wide PATH.)
    #[tokio::test]
    async fn discovery_and_missing_tools() {
        let _path = PATH_LOCK.lock().await;
        let saved_path = std::env::var_os("PATH");
        std::env::remove_var("HAUL_7Z");
        std::env::remove_var("HAUL_UNRAR");
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let out = dir.path().join("out");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let archive = dir.path().join("a.zip");
        std::process::Command::new("python3")
            .args(["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('hello.txt','hi'); z.close()"])
            .arg(&archive)
            .status()
            .unwrap();

        std::env::set_var("PATH", &bin);
        assert!(available_tools().is_empty());
        let none = [String::new()];
        let err = extract_one(&archive, &out, &none, &mut |_| {})
            .await
            .unwrap_err()
            .message;
        assert!(err.contains("kein Entpacker gefunden"), "{err}");
        assert!(err.contains("apt install 7zip unrar"), "{err}");

        // Stand-in for 7-Zip: `7zz x -y -bsp1 -o<dir> -p<pw> <archive>`, printing progress like 7-Zip.
        let fake = bin.join("7zz");
        std::fs::write(
            &fake,
            "#!/usr/bin/env python3\nimport sys, zipfile\na = sys.argv[1:]\nassert a[:3] == ['x', '-y', '-bsp1']\n\
             for p in (0, 40, 80):\n    sys.stdout.write('%3d%% 1 - hello.txt' % p + '\\b' * 20); sys.stdout.flush()\n\
             zipfile.ZipFile(a[-1]).extractall(next(x[2:] for x in a if x.startswith('-o')))\n\
             print('Everything is Ok')\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin.display()));
        let tools = available_tools();
        assert_eq!(tools.len(), 1);
        assert!(tools[0].describe().ends_with("/7zz"));
        let mut seen = Vec::new();
        assert_eq!(
            extract_one(&archive, &out, &none, &mut |p| seen.push(p))
                .await
                .unwrap(),
            ""
        );
        assert_eq!(seen.last(), Some(&80), "{seen:?}");
        assert_eq!(
            std::fs::read_to_string(out.join("hello.txt")).unwrap(),
            "hi"
        );

        // 7-Zip crashing on a RAR archive (seen with 7-Zip 23.01's RAR module): the archive
        // info, then a segfault. The message names the crash and recommends unrar.
        std::fs::write(
            &fake,
            "#!/usr/bin/env python3\nimport os, signal, sys\n\
             print('Extracting archive: a.rar'); print('Type = Rar'); print('Blocks = 125'); print('Volumes = 1')\n\
             sys.stdout.flush(); os.kill(os.getpid(), signal.SIGSEGV)\n",
        )
        .unwrap();
        let rar = dir.path().join("a.rar");
        std::fs::write(&rar, b"Rar!").unwrap();
        let err = extract_one(&rar, &out, &none, &mut |_| {})
            .await
            .unwrap_err();
        assert!(!err.wrong_password);
        let de = crate::i18n::pick(&err.message, false);
        assert!(de.contains("Signal 11"), "{de}");
        assert!(de.contains("unrar installieren"), "{de}");
        match saved_path {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
    }
}

#[cfg(test)]
mod message_tests {
    use super::*;

    fn run(code: Option<i32>, signal: Option<i32>, stdout: &str, stderr: &str) -> Run {
        Run {
            ok: false,
            code,
            signal,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    const SEVEN: Tool = Tool {
        kind: Kind::SevenZip,
        path: PathBuf::new(),
    };

    /// 7-Zip 23.01's RAR module crashing: only the archive info on stdout, no error line.
    #[test]
    fn crash_names_the_signal_and_recommends_unrar_for_rar() {
        let r = run(
            None,
            Some(11),
            "Extracting archive: a.rar\nType = Rar\nSolid = -\nBlocks = 125\nMultivolume = -\nVolumes = 1",
            "",
        );
        let c = causes(&r);
        assert!(c.crashed);
        let line = describe_run(&SEVEN, &r);
        assert_eq!(
            crate::i18n::pick(&line, false),
            "7-Zip (abgestürzt (Signal 11)): Multivolume = - · Volumes = 1"
        );
        let msg = failure_message(true, false, c, vec![line.clone()]);
        let de = crate::i18n::pick(&msg, false);
        assert!(de.contains("unrar installieren"), "{de}");
        assert!(de.contains("Signal 11"), "{de}");
        // With unrar present (it failed too) or for a zip, no unrar advice.
        assert!(
            !crate::i18n::pick(&failure_message(true, true, c, vec![line.clone()]), false)
                .contains("unrar installieren")
        );
        assert!(
            !crate::i18n::pick(&failure_message(false, false, c, vec![line]), false)
                .contains("unrar installieren")
        );
        // A shell reports the same crash as 139.
        assert!(causes(&run(Some(139), None, "", "")).crashed);
    }

    #[test]
    fn error_lines_come_from_stderr_and_error_like_stdout() {
        let r = run(
            Some(2),
            None,
            "Type = 7z\nSolid = +\nSub items Errors: 1\nArchives with Errors: 1",
            "ERROR: Data Error in encrypted file. Wrong password? : film.mkv",
        );
        let c = causes(&r);
        assert!(c.wrong_password && !c.crashed);
        let line = crate::i18n::pick(&describe_run(&SEVEN, &r), false);
        assert!(
            line.starts_with(
                "7-Zip (Code 2): ERROR: Data Error in encrypted file. Wrong password? : film.mkv"
            ),
            "{line}"
        );
        let msg = crate::i18n::pick(&failure_message(false, false, c, vec![]), false);
        assert!(msg.contains("Archiv-Passwörter"), "{msg}");
        // unrar's wordings.
        for out in [
            "The specified password is incorrect.",
            "CRC failed in the encrypted file x.mkv. Corrupt file or wrong password.",
        ] {
            assert!(
                causes(&run(Some(11), None, "", out)).wrong_password,
                "{out}"
            );
        }
        assert!(!causes(&run(Some(2), None, "", "Unexpected end of archive")).wrong_password);
    }
}
