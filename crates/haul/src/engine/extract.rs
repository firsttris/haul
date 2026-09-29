//! Unpacks finished packages with `7z` (and `unrar` as fallback for RAR).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use regex::Regex;
use tokio::process::Command;

use super::Engine;
use crate::db::{self, status};
use crate::events::Topic;

/// First volume of each archive set among `names`, plus every file belonging to a set.
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

async fn run_tool(mut cmd: Command) -> Result<(bool, String)> {
    let out = cmd.stdin(std::process::Stdio::null()).output().await?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok((out.status.success(), text))
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
            cmd.arg("x")
                .arg("-y")
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

async fn extract_one(archive: &Path, dest: &Path, passwords: &[String]) -> Result<()> {
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
            match run_tool(command(tool, archive, dest, pw)).await {
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
    pub(super) async fn on_download_finished(self: Arc<Self>, package_id: i64) {
        if !self.settings().auto_extract {
            return;
        }
        let Ok(downloads) = db::package_downloads(&self.db, package_id).await else {
            return;
        };
        if downloads.iter().any(|d| d.status != status::FINISHED) {
            return;
        }
        if let Err(e) = self.extract_package(package_id).await {
            tracing::warn!(package_id, "extract: {e:#}");
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

    pub async fn extract_package(&self, package_id: i64) -> Result<()> {
        let pkg = db::get_package(&self.db, package_id)
            .await?
            .ok_or_else(|| anyhow!("Paket nicht gefunden"))?;
        let names: Vec<String> = db::package_downloads(&self.db, package_id)
            .await?
            .into_iter()
            .filter(|d| d.status == status::FINISHED)
            .map(|d| d.name)
            .collect();
        let (first, all) = find_archives(&names);
        if first.is_empty() {
            return Ok(());
        }
        let claimed = sqlx::query("UPDATE packages SET extract = 'running', extract_error = NULL WHERE id = ? AND (extract IS NULL OR extract != 'running')")
            .bind(package_id)
            .execute(&self.db)
            .await?;
        if claimed.rows_affected() == 0 {
            return Ok(());
        }
        self.events.changed(Topic::Downloads);
        let dir = self.package_dir(&pkg);
        let passwords: Vec<String> = pkg
            .passwords
            .as_deref()
            .unwrap_or("")
            .lines()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect();
        let mut error = None;
        for a in &first {
            if let Err(e) = extract_one(&dir.join(a), &dir, &passwords).await {
                error = Some(format!("{a}: {e:#}"));
                break;
            }
        }
        if error.is_none() && self.settings().delete_archives {
            for a in &all {
                let _ = tokio::fs::remove_file(dir.join(a)).await;
            }
        }
        sqlx::query("UPDATE packages SET extract = ?, extract_error = ? WHERE id = ?")
            .bind(if error.is_some() { "failed" } else { "done" })
            .bind(&error)
            .bind(package_id)
            .execute(&self.db)
            .await?;
        self.events.changed(Topic::Downloads);
        match error {
            Some(e) => Err(anyhow!(e)),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let err = extract_one(&archive, &out, &[])
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("kein Entpacker gefunden"), "{err}");
        assert!(err.contains("apt install 7zip 7zip-rar"), "{err}");

        // Stand-in for 7-Zip: `7zz x -y -o<dir> -p<pw> <archive>`.
        let fake = bin.join("7zz");
        std::fs::write(
            &fake,
            "#!/usr/bin/env python3\nimport sys, zipfile\na = sys.argv[1:]\nassert a[0] == 'x' and a[1] == '-y'\n\
             zipfile.ZipFile(a[4]).extractall(a[2][2:])\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin.display()));
        let tools = available_tools();
        assert_eq!(tools.len(), 1);
        assert!(tools[0].describe().ends_with("/7zz"));
        extract_one(&archive, &out, &[]).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("hello.txt")).unwrap(),
            "hi"
        );
    }
}
