//! The "Fertig" view: browse and tidy up the done folder, and only the done folder.
//!
//! Every path from the browser is relative to the done folder and goes through [`resolve`],
//! which rejects anything that would leave it, including through symlinks.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

/// Maps a path relative to `root` onto the disk. Fails for absolute paths, `..`, and paths
/// whose real location (symlinks resolved) is outside `root`. The path must exist.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel.trim_matches('/'));
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!(crate::tr!("ungültiger Pfad", "invalid path")),
        }
    }
    let root = root.canonicalize()?;
    let full = root
        .join(rel_path)
        .canonicalize()
        .map_err(|_| anyhow!(crate::tr!("nicht gefunden: {}", "not found: {}", rel)))?;
    if !full.starts_with(&root) {
        bail!(crate::tr!(
            "Pfad liegt außerhalb des Fertig-Ordners",
            "path is outside the done folder"
        ));
    }
    Ok(full)
}

/// Like [`resolve`], but the done folder itself is not allowed (nothing may delete or move it).
pub fn resolve_entry(root: &Path, rel: &str) -> Result<PathBuf> {
    let full = resolve(root, rel)?;
    if full == root.canonicalize()? {
        bail!(crate::tr!(
            "der Fertig-Ordner selbst kann nicht bearbeitet werden",
            "the done folder itself cannot be changed"
        ));
    }
    Ok(full)
}

/// `a/b/c` relative to `root`, with `/` separators.
pub fn relative(root: &Path, full: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    full.strip_prefix(&root)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Relative to the done folder.
    pub path: String,
    pub dir: bool,
    /// Bytes; for folders the sum of everything inside.
    pub size: u64,
    /// Unix ms.
    pub modified: Option<i64>,
    /// `archive`, `video`, `other` for files; `null` for folders.
    pub kind: Option<&'static str>,
}

fn kind_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let (first, all) = crate::engine::extract::find_archives(&[name.to_string()]);
    if !first.is_empty() || !all.is_empty() {
        return "archive";
    }
    const VIDEO: [&str; 8] = [
        ".mkv", ".mp4", ".avi", ".m4v", ".mov", ".ts", ".wmv", ".webm",
    ];
    if VIDEO.iter().any(|e| lower.ends_with(e)) {
        "video"
    } else {
        "other"
    }
}

/// Total size of a folder, without following symlinks.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(meta) = e.path().symlink_metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// Folder contents: folders first, then files, each sorted by name.
pub fn list(root: &Path, dir: &Path) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for e in std::fs::read_dir(dir)?.flatten() {
        let path = e.path();
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = meta.is_dir();
        // Where an extraction is running (engine::extract::staging_dir): not the user's.
        if is_dir && name.starts_with(".haul-extract-") {
            continue;
        }
        entries.push(Entry {
            path: relative(root, &path),
            dir: is_dir,
            size: if is_dir { dir_size(&path) } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64),
            kind: (!is_dir).then(|| kind_of(&name)),
            name,
        });
    }
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// File names directly inside `dir` (no subfolders).
pub fn file_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().symlink_metadata().is_ok_and(|m| m.is_file()))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub async fn delete(path: &Path) -> Result<()> {
    let meta = tokio::fs::symlink_metadata(path).await?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(path).await?;
    } else {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

/// A single file or folder name typed by the user: no separators, not `.`/`..`.
pub fn valid_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.contains(['/', '\\', '\0'])
    {
        bail!(crate::tr!("ungültiger Name", "invalid name"));
    }
    Ok(name)
}

/// `dir/name`, or `dir/name (1)` … when taken.
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.contains(' ') && e.len() <= 5 => {
            (s.to_string(), format!(".{e}"))
        }
        _ => (name.to_string(), String::new()),
    };
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Moves `src` into `dest_dir` (both inside the done folder, so a rename). A taken name
/// gets a suffix; a folder cannot go into itself.
pub async fn move_within(src: &Path, dest_dir: &Path) -> Result<PathBuf> {
    if dest_dir.starts_with(src) {
        bail!(crate::tr!(
            "ein Ordner kann nicht in sich selbst verschoben werden",
            "a folder cannot be moved into itself"
        ));
    }
    if src.parent() == Some(dest_dir) {
        return Ok(src.to_path_buf());
    }
    let name = src
        .file_name()
        .ok_or_else(|| anyhow!(crate::tr!("ungültiger Pfad", "invalid path")))?
        .to_string_lossy()
        .to_string();
    let dest = free_name(dest_dir, &name);
    tokio::fs::rename(src, &dest).await?;
    Ok(dest)
}

/// Every folder below `root` (relative, sorted), as move destinations.
pub fn all_folders(root: &Path) -> Vec<String> {
    // Walk the real path, so `relative` can strip it (the configured root may be relative).
    let root = &root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            if e.path().symlink_metadata().is_ok_and(|m| m.is_dir()) {
                out.push(relative(root, &e.path()));
                stack.push(e.path());
            }
        }
        if out.len() > 5000 {
            break;
        }
    }
    out.sort_by_key(|p| p.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_inside_the_done_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("done");
        std::fs::create_dir_all(root.join("Pkg/sub")).unwrap();
        std::fs::write(root.join("Pkg/a.rar"), "x").unwrap();
        std::fs::write(tmp.path().join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(tmp.path(), root.join("escape")).unwrap();

        assert!(resolve(&root, "Pkg/a.rar").is_ok());
        assert!(resolve(&root, "/Pkg/sub/").is_ok());
        assert_eq!(resolve(&root, "").unwrap(), root.canonicalize().unwrap());
        for bad in [
            "../secret",
            "Pkg/../../secret",
            "/etc/passwd",
            "escape/secret",
            "escape",
            "nope",
        ] {
            assert!(resolve(&root, bad).is_err(), "{bad} must be rejected");
        }
        assert!(resolve_entry(&root, "").is_err());
        assert!(resolve_entry(&root, ".").is_err());
        assert!(resolve_entry(&root, "Pkg").is_ok());
    }

    #[tokio::test]
    async fn moves_inside_the_done_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("A/sub")).unwrap();
        std::fs::create_dir_all(root.join("B")).unwrap();
        std::fs::write(root.join("A/film.mkv"), "x").unwrap();
        std::fs::write(root.join("B/film.mkv"), "y").unwrap();
        let dest = move_within(&root.join("A/film.mkv"), &root.join("B"))
            .await
            .unwrap();
        assert_eq!(dest, root.join("B/film (1).mkv"));
        assert!(move_within(&root.join("A"), &root.join("A/sub"))
            .await
            .is_err());
        assert!(move_within(&root.join("A"), &root.join("A")).await.is_err());
        assert_eq!(all_folders(root), ["A", "A/sub", "B"]);
        // A non-canonical root, like the relative ./.data/done in development.
        assert_eq!(all_folders(&root.join("A/..")), ["A", "A/sub", "B"]);
        assert!(valid_name("Neu").is_ok());
        for bad in ["", " ", ".", "..", "a/b", "a\\b"] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn lists_folders_first_with_sizes_and_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("B/inner")).unwrap();
        std::fs::write(root.join("B/inner/x.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("B/Movie.part1.rar"), vec![0u8; 50]).unwrap();
        std::fs::write(root.join("a.mkv"), "12").unwrap();
        let top = list(root, root).unwrap();
        assert_eq!(
            top.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["B", "a.mkv"]
        );
        assert_eq!(top[0].size, 150);
        assert_eq!(top[1].kind, Some("video"));
        let inner = list(root, &root.join("B")).unwrap();
        assert_eq!(inner[1].path, "B/Movie.part1.rar");
        assert_eq!(inner[1].kind, Some("archive"));
    }
}
