//! haul-cnl: a tiny Click'n'Load forwarder for the desktop.
//!
//! Web pages send Click'n'Load requests to `127.0.0.1:9666` on the machine running the
//! browser. Haul runs on a server, so this program listens there and forwards the requests
//! to the server's `/api/cnl` endpoints, authenticated with an API token.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

const USAGE: &str = "\
haul-cnl – leitet Click'n'Load vom Desktop an einen Haul-Server weiter

Verwendung:
  haul-cnl --server <URL> --token <API-TOKEN> [--listen 127.0.0.1:9666]

Alternativ per Umgebung: HAUL_SERVER, HAUL_TOKEN, HAUL_CNL_LISTEN.
Das API-Token wird in der Haul-Weboberfläche unter Einstellungen erstellt.";

struct Config {
    server: String,
    token: String,
    listen: SocketAddr,
}

fn parse_args() -> Result<Config> {
    let mut server = std::env::var("HAUL_SERVER").ok();
    let mut token = std::env::var("HAUL_TOKEN").ok();
    let mut listen = std::env::var("HAUL_CNL_LISTEN").ok();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--server" => server = args.next(),
            "--token" => token = args.next(),
            "--listen" => listen = args.next(),
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => bail!("unbekanntes Argument {other}\n\n{USAGE}"),
        }
    }
    let (Some(server), Some(token)) = (server, token) else {
        bail!("--server und --token sind nötig\n\n{USAGE}");
    };
    let listen: SocketAddr = listen
        .as_deref()
        .unwrap_or("127.0.0.1:9666")
        .parse()
        .context("--listen")?;
    if !listen.ip().is_loopback() {
        eprintln!("Warnung: {listen} ist nicht nur lokal erreichbar; jede Seite im Netz könnte Links schicken.");
    }
    Ok(Config {
        server: server.trim_end_matches('/').to_string(),
        token,
        listen,
    })
}

struct Forwarder {
    cfg: Config,
    client: reqwest::Client,
}

async fn jdcheck() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        "jdownloader=true;\nvar version='haul-cnl';\n",
    )
}

async fn crossdomain() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/xml")],
        "<?xml version=\"1.0\"?>\n<cross-domain-policy><allow-access-from domain=\"*\" /></cross-domain-policy>\n",
    )
}

/// Answers the browser's CORS / Private Network Access preflight; sites send Click'n'Load
/// with `fetch` from their own https origin.
async fn cors(req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .or_else(|| req.headers().get(header::REFERER))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string();
    tracing::info!("{} {} von {origin}", req.method(), req.uri().path());
    let mut resp = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let h = resp.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    h.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    h.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    resp
}

async fn forward(
    State(f): State<Arc<Forwarder>>,
    Path(action): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !action.chars().all(|c| c.is_ascii_alphanumeric()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let url = format!("{}/api/cnl/flash/{action}", f.cfg.server);
    let mut req = f.client.post(&url).bearer_auth(&f.cfg.token).body(body);
    for h in [header::CONTENT_TYPE, header::REFERER] {
        if let Some(v) = headers.get(&h) {
            req = req.header(h, v);
        }
    }
    match req.send().await {
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let text = resp.text().await.unwrap_or_default();
            if status.is_success() {
                tracing::info!("{action}: an {} weitergeleitet", f.cfg.server);
            } else {
                tracing::warn!("{action}: Server antwortete {status}: {}", text.trim());
            }
            (status, text).into_response()
        }
        Err(e) => {
            tracing::error!("{action}: Server nicht erreichbar: {e}");
            (StatusCode::BAD_GATEWAY, format!("failed: {e}\r\n")).into_response()
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cfg = match parse_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(cfg).await {
        eprintln!("Fehler: {e:#}");
        std::process::exit(1);
    }
}

async fn run(cfg: Config) -> Result<()> {
    let listen = cfg.listen;
    let server = cfg.server.clone();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // Fail early on a wrong token or URL instead of on the first click.
    match client
        .get(format!("{server}/api/stats"))
        .bearer_auth(&cfg.token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => tracing::info!("verbunden mit {server}"),
        Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
            bail!("API-Token wird von {server} abgelehnt")
        }
        Ok(r) => tracing::warn!("{server} antwortet mit {}", r.status()),
        Err(e) => {
            tracing::warn!("{server} nicht erreichbar ({e}); versuche es bei jedem Klick erneut")
        }
    }

    let state = Arc::new(Forwarder { cfg, client });
    let app = Router::new()
        .route("/jdcheck.js", get(jdcheck))
        .route("/crossdomain.xml", get(crossdomain))
        .route("/flash", get(|| async { "JDownloader\r\n" }))
        .route("/flash/", get(|| async { "JDownloader\r\n" }))
        .route("/flash/{action}", post(forward))
        .layer(middleware::from_fn(cors))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("Port {listen} belegt?"))?;
    tracing::info!("Click'n'Load lauscht auf {listen}");
    axum::serve(listener, app).await?;
    Ok(())
}
