mod api;
mod auth;
mod cnl;
mod config;
mod crypto;
mod db;
mod engine;
mod events;
mod plugins;
mod ui;
mod util;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::api::App;
use crate::config::Config;
use crate::engine::Engine;
use crate::events::Events;
use crate::plugins::PluginManager;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn")),
        )
        .init();

    let cfg = Config::from_env()?;
    for dir in [
        &cfg.config_dir,
        &cfg.tmp_dir,
        &cfg.done_dir,
        &cfg.user_plugins(),
    ] {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let db = db::connect(&cfg.db_path())
        .await
        .context("opening database")?;

    let mut plugin_dirs = Vec::new();
    if let Some(builtin) = &cfg.builtin_plugins {
        plugin_dirs.push((builtin.clone(), true));
    }
    plugin_dirs.push((cfg.user_plugins(), false));
    let plugins = Arc::new(PluginManager::new(plugin_dirs));
    plugins.reload().await;

    let engine = Engine::new(db, cfg.clone(), plugins, Events::new()).await?;
    let app = Arc::new(App {
        engine: engine.clone(),
    });
    auth::ensure_initial_user(&app).await?;

    let router = Router::new()
        .nest("/api", api::router(app.clone()))
        .fallback(ui::serve);
    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("binding {}", cfg.listen))?;
    tracing::info!("web UI on http://{}", cfg.listen);

    if let Some(addr) = cfg.cnl_listen {
        match TcpListener::bind(addr).await {
            Ok(l) => {
                tracing::info!("Click'n'Load on {addr}");
                let cnl: Router = cnl::router(engine.clone());
                tokio::spawn(async move {
                    if let Err(e) = axum::serve(l, cnl).await {
                        tracing::error!("Click'n'Load listener: {e}");
                    }
                });
            }
            Err(e) => tracing::warn!("Click'n'Load disabled, cannot bind {addr}: {e}"),
        }
    }

    let scheduler = tokio::spawn(engine.clone().run());
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("shutting down, saving download progress");
    engine.shutdown().await;
    let _ = scheduler.await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
