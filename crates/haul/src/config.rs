use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};

/// Runtime configuration, read once from environment variables.
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    /// Click'n'Load listener. `None` disables it.
    pub cnl_listen: Option<SocketAddr>,
    pub config_dir: PathBuf,
    pub tmp_dir: PathBuf,
    pub done_dir: PathBuf,
    /// Directory with plugins shipped in the image; `config_dir/plugins` overrides them by id.
    pub builtin_plugins: Option<PathBuf>,
    pub app_secret: String,
    pub initial_user: Option<(String, String)>,
    /// User-Agent sent to hosters; default: a current desktop browser.
    pub user_agent: Option<String>,
    /// Named folders the "Fertig" view can move things into (`HAUL_MOVE_TARGETS`).
    pub move_targets: Vec<MoveTarget>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MoveTarget {
    pub name: String,
    pub path: PathBuf,
}

/// `Renamer=/media/inbox;Archiv=/mnt/archiv` → targets. Only absolute paths.
pub fn parse_move_targets(value: &str) -> Result<Vec<MoveTarget>> {
    value
        .split([';', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|entry| {
            let (name, path) = entry.split_once('=').ok_or_else(|| {
                anyhow::anyhow!("HAUL_MOVE_TARGETS: '{entry}' ist nicht Name=/pfad")
            })?;
            let path = PathBuf::from(path.trim());
            if !path.is_absolute() {
                anyhow::bail!(
                    "HAUL_MOVE_TARGETS: {} muss ein absoluter Pfad sein",
                    path.display()
                );
            }
            Ok(MoveTarget {
                name: name.trim().to_string(),
                path,
            })
        })
        .collect()
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let config_dir = PathBuf::from(var("HAUL_CONFIG_DIR").unwrap_or_else(|| "/config".into()));
        let listen = var("HAUL_LISTEN")
            .unwrap_or_else(|| "0.0.0.0:8080".into())
            .parse()
            .context("HAUL_LISTEN")?;
        let cnl_listen = match var("HAUL_CNL_LISTEN").as_deref() {
            Some("off") => None,
            Some(v) => Some(v.parse().context("HAUL_CNL_LISTEN")?),
            None => Some("127.0.0.1:9666".parse().unwrap()),
        };
        let app_secret = var("APP_SECRET").context(
            "APP_SECRET is not set; it encrypts stored account passwords and must stay stable",
        )?;
        let initial_user = match (var("HAUL_USER"), var("HAUL_PASSWORD")) {
            (Some(u), Some(p)) => Some((u, p)),
            _ => None,
        };
        Ok(Self {
            listen,
            cnl_listen,
            tmp_dir: PathBuf::from(var("HAUL_TMP_DIR").unwrap_or_else(|| "/downloads/tmp".into())),
            done_dir: PathBuf::from(
                var("HAUL_DONE_DIR").unwrap_or_else(|| "/downloads/done".into()),
            ),
            builtin_plugins: var("HAUL_BUILTIN_PLUGINS").map(PathBuf::from),
            config_dir,
            app_secret,
            initial_user,
            user_agent: var("HAUL_USER_AGENT"),
            move_targets: parse_move_targets(&var("HAUL_MOVE_TARGETS").unwrap_or_default())?,
        })
    }
}

impl Config {
    pub fn user_plugins(&self) -> PathBuf {
        self.config_dir.join("plugins")
    }

    pub fn db_path(&self) -> PathBuf {
        self.config_dir.join("haul.db")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_targets() {
        let t = parse_move_targets(" Renamer = /media/inbox ; Archiv=/mnt/archiv;").unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].name, "Renamer");
        assert_eq!(t[0].path, PathBuf::from("/media/inbox"));
        assert!(parse_move_targets("X=relative/path").is_err());
        assert!(parse_move_targets("nur-ein-name").is_err());
        assert!(parse_move_targets("").unwrap().is_empty());
    }
}
