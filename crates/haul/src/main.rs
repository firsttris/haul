mod api;
mod auth;
mod captcha;
mod cnl;
mod config;
mod crypto;
mod db;
mod engine;
mod events;
mod files;
mod i18n;
mod plugins;
mod probe;
mod ui;
mod util;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use tokio::net::TcpListener;
use tower_http::compression::predicate::{NotForContentType, Predicate};
use tower_http::compression::{CompressionLayer, DefaultPredicate};
use tower_http::CompressionLevel;
use tracing_subscriber::EnvFilter;

use crate::api::App;
use crate::config::Config;
use crate::engine::Engine;
use crate::events::Events;
use crate::plugins::PluginManager;

#[tokio::main]
async fn main() -> Result<()> {
    // `haul probe …`: tries the plugins on real hosters (see probe.rs), then exits.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("probe") {
        let code = probe::main(&args[1..]).await?;
        std::process::exit(code);
    }
    // For development: read `.env` from the working directory (or a parent). Variables that
    // are already set in the environment win, so Docker/systemd configuration is unaffected.
    let dotenv = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn")),
        )
        .init();

    if let Ok(path) = &dotenv {
        tracing::info!("loaded {}", path.display());
    }
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
    let plugins = Arc::new(PluginManager::new(plugin_dirs, cfg.user_agent.clone()));
    plugins.reload().await;
    let events = Events::new();
    let captchas = Arc::new(captcha::Captchas::new(events.clone()));
    plugins.set_captchas(captchas.clone());

    let engine = Engine::new(db, cfg.clone(), plugins, events).await?;
    let app = Arc::new(App {
        engine: engine.clone(),
        captchas,
    });
    auth::ensure_initial_user(&app).await?;

    let router = Router::new()
        .nest("/api", api::router(app.clone()))
        .fallback(ui::serve)
        // gzip/br for the UI bundle and JSON. The default predicate already leaves out
        // `text/event-stream` (the live events stay unbuffered), images and tiny bodies;
        // woff2 fonts are compressed already. Level 6 is gzip's default; brotli's default in
        // tower-http (4) is hardly smaller than gzip, 6 is about 6% smaller and still fast.
        .layer(
            CompressionLayer::new()
                .quality(CompressionLevel::Precise(6))
                .compress_when(DefaultPredicate::new().and(NotForContentType::const_new("font/"))),
        );
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
