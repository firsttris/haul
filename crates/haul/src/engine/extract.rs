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

/// Runs an extractor, reporting its percentage while it runs. Returns success and the
/// output without the progress redraws, for error messages.
async fn run_tool(
    mut cmd: Command,
    on_progress: &mut (dyn FnMut(u8) + Send),
) -> Result<(bool, String)> {
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
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    )
    .replace(['\u{8}', '\r'], "\n");
    let text = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && last_percent(l).is_none_or(|_| l.len() > 12))
        .collect::<Vec<_>>()
        .join("\n");
    Ok((status.success(), text))
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

async fn extract_one(
    archive: &Path,
    dest: &Path,
    passwords: &[String],
    on_progress: &mut (dyn FnMut(u8) + Send),
) -> Result<()> {
    // unrar handles RAR best (RAR5, volumes); 7-Zip builds without the RAR codec cannot.
    let tools: Vec<Tool> = available_tools()
        .into_iter()
        .filter(|t| t.kind != Kind::Unrar || is_rar(archive))
        .collect();
    if tools.is_empty() {
        return Err(anyhow!(
            "kein Entpacker gefunden. Empfohlen: 7-Zip mit RAR-Modul, unter Ubuntu/Debian \
             „sudo apt install 7zip 7zip-rar“ (alternativ „7zip unrar“); im Docker-Image ist alles enthalten"));
    }
    let mut candidates: Vec<String> = vec![String::new()];
    candidates.extend(passwords.iter().cloned());
    let mut last = String::new();
    for pw in &candidates {
        for tool in &tools {
            match run_tool(command(tool, archive, dest, pw), on_progress).await {
                Ok((true, _)) => return Ok(()),
                Ok((false, out)) => last = format!("{}: {out}", tool.describe()),
                Err(e) => last = format!("{}: {e}", tool.describe()),
            }
        }
    }
    let tail: String = last
        .lines()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" ");
    Err(anyhow!("Entpacken fehlgeschlagen: {tail}"))
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
            .ok_or_else(|| anyhow!("Paket nicht gefunden"))?;
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
            if let Err(e) = extract_one(&dir.join(a), dir, passwords, &mut report).await {
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
                    .ok_or_else(|| anyhow!("ungültiger Pfad"))?
                    .to_path_buf();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let set = archive_set(&files::file_names(&dir), &name)
                    .ok_or_else(|| anyhow!("{name} ist kein Archiv oder der erste Teil fehlt"))?;
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
            anyhow::bail!("nichts zum Entpacken ausgewählt");
        }
        for (dir, _) in &jobs {
            if self
                .extract_progress_of(&files::relative(&self.cfg.done_dir, dir))
                .is_some()
            {
                anyhow::bail!("in {} wird bereits entpackt", dir.display());
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

#[cfg(test)]
mod tool_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Finds extractors on PATH, calls them with 7-Zip's arguments and explains a missing one.
    /// (One test, because it changes the process-wide PATH.)
    #[tokio::test]
    async fn discovery_and_missing_tools() {
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
        let err = extract_one(&archive, &out, &[], &mut |_| {})
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("kein Entpacker gefunden"), "{err}");
        assert!(err.contains("apt install 7zip 7zip-rar"), "{err}");

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
        extract_one(&archive, &out, &[], &mut |p| seen.push(p))
            .await
            .unwrap();
        assert_eq!(seen.last(), Some(&80), "{seen:?}");
        assert_eq!(
            std::fs::read_to_string(out.join("hello.txt")).unwrap(),
            "hi"
        );
    }
}
