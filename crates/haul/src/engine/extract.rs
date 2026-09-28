//! Unpacks finished packages with `7z` (and `unrar` as fallback for RAR).

use std::path::Path;
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

async fn extract_one(archive: &Path, dest: &Path, passwords: &[String]) -> Result<()> {
    let seven = std::env::var("HAUL_7Z").unwrap_or_else(|_| "7z".into());
    let unrar = std::env::var("HAUL_UNRAR").unwrap_or_else(|_| "unrar".into());
    let mut candidates: Vec<String> = vec![String::new()];
    candidates.extend(passwords.iter().cloned());
    let mut last = String::new();
    for pw in &candidates {
        let mut cmd = Command::new(&seven);
        cmd.arg("x")
            .arg("-y")
            .arg(format!("-o{}", dest.display()))
            .arg(format!("-p{pw}"))
            .arg(archive);
        match run_tool(cmd).await {
            Ok((true, _)) => return Ok(()),
            Ok((false, out)) => last = out,
            Err(e) => last = format!("{seven}: {e}"),
        }
        if archive
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("rar"))
        {
            let mut cmd = Command::new(&unrar);
            cmd.arg("x").arg("-o+").arg(if pw.is_empty() {
                "-p-".to_string()
            } else {
                format!("-p{pw}")
            });
            cmd.arg(archive).arg(format!("{}/", dest.display()));
            if let Ok((true, _)) = run_tool(cmd).await {
                return Ok(());
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
