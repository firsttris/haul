//! Runs plugin code in QuickJS. Every call gets a fresh runtime, so plugins cannot keep
//! state between calls and a misbehaving call cannot poison the next one. State that must
//! survive (logins) lives in the per-account cookie jar on the Rust side.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use reqwest::cookie::CookieStore;
use reqwest::header::HeaderValue;
use reqwest::Client;
use reqwest_cookie_store::CookieStoreMutex;
use rquickjs::prelude::{Async, Func};
use rquickjs::{
    async_with, AsyncContext, AsyncRuntime, CatchResultExt, Context, Function, Promise, Runtime,
};
use serde::{Deserialize, Serialize};

const PRELUDE: &str = include_str!("prelude.js");
const MAX_BODY: usize = 16 * 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// HTTP clients handed to one plugin call; both share the same cookie jar.
#[derive(Clone)]
pub struct HttpClients {
    pub follow: Client,
    pub no_follow: Client,
    /// The cookie store both clients use; plugins read and seed it via `ctx.cookies`.
    pub jar: Option<Arc<CookieStoreMutex>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    form: Option<HashMap<String, String>>,
    json: Option<serde_json::Value>,
    #[serde(default = "yes")]
    follow_redirects: bool,
    timeout_ms: Option<u64>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize)]
struct HttpResp {
    status: u16,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    /// The response is a file, not a page; its body was not read (like JD's
    /// `looksLikeDownloadableContent`). The core downloads it from `url`.
    file: bool,
}

/// Attachments and binary content types are downloads, not pages to parse.
fn looks_like_file(headers: &reqwest::header::HeaderMap) -> bool {
    let get = |h: reqwest::header::HeaderName| {
        headers
            .get(h)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    if get(reqwest::header::CONTENT_DISPOSITION).contains("attachment") {
        return true;
    }
    let ct = get(reqwest::header::CONTENT_TYPE);
    !ct.is_empty()
        && !ct.starts_with("text/")
        && !["json", "xml", "javascript", "x-www-form-urlencoded"]
            .iter()
            .any(|t| ct.contains(t))
}

async fn do_http(clients: &HttpClients, raw: &str) -> Result<HttpResp> {
    let req: HttpReq = serde_json::from_str(raw)?;
    let client = if req.follow_redirects {
        &clients.follow
    } else {
        &clients.no_follow
    };
    let method = reqwest::Method::from_bytes(req.method.as_bytes())?;
    let mut rb = client
        .request(method, &req.url)
        .timeout(Duration::from_millis(
            req.timeout_ms.unwrap_or(60_000).min(300_000),
        ));
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(json) = &req.json {
        rb = rb.json(json);
    } else if let Some(form) = &req.form {
        rb = rb.form(form);
    } else if let Some(body) = req.body {
        rb = rb.body(body);
    }
    let mut resp = rb.send().await?;
    let status = resp.status().as_u16();
    let url = resp.url().to_string();
    let mut headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers() {
        let v = String::from_utf8_lossy(v.as_bytes()).to_string();
        headers
            .entry(k.as_str().to_string())
            .and_modify(|e| {
                e.push_str(if k == reqwest::header::SET_COOKIE {
                    "\n"
                } else {
                    ", "
                });
                e.push_str(&v)
            })
            .or_insert(v);
    }
    if looks_like_file(resp.headers()) {
        return Ok(HttpResp {
            status,
            url,
            headers,
            body: String::new(),
            file: true,
        });
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(anyhow!("response body larger than {MAX_BODY} bytes"));
        }
    }
    Ok(HttpResp {
        status,
        url,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
        file: false,
    })
}

/// Error categories a plugin can signal by throwing the SDK's error classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    /// File is gone; no retry.
    Offline,
    /// Try again later (server busy, limit reached).
    Temporary,
    /// Login failed or account is out of traffic.
    Account,
    Fatal,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PluginError {
    pub kind: ErrorKind,
    pub message: String,
}

impl PluginError {
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Fatal,
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
struct InvokeResult {
    ok: bool,
    value: Option<serde_json::Value>,
    kind: Option<ErrorKind>,
    message: Option<String>,
}

async fn new_context() -> Result<(AsyncRuntime, AsyncContext)> {
    let rt = AsyncRuntime::new()?;
    rt.set_memory_limit(64 << 20).await;
    rt.set_max_stack_size(1 << 20).await;
    let ctx = AsyncContext::full(&rt).await?;
    Ok((rt, ctx))
}

/// Evaluates the plugin once and returns its metadata as JSON.
pub async fn read_meta(code: &str) -> Result<String> {
    let (_rt, ctx) = new_context().await?;
    let code = code.to_string();
    async_with!(ctx => |ctx| {
        let run = || -> rquickjs::Result<String> {
            ctx.globals().set("__host_http", Func::from(|| ()))?;
            ctx.globals().set("__host_sleep", Func::from(|| ()))?;
            ctx.globals().set("__host_log", Func::from(|| ()))?;
            ctx.globals().set("__host_cookies", Func::from(|| ()))?;
            ctx.globals().set("__host_set_cookie", Func::from(|| ()))?;
            ctx.globals().set("__host_sha256", Func::from(|| ()))?;
            ctx.eval::<(), _>(PRELUDE)?;
            ctx.eval::<(), _>(code.as_str())?;
            let meta: Function = ctx.globals().get("__haul_meta")?;
            meta.call(())
        };
        run().catch(&ctx).map_err(|e| anyhow!("{e}"))
    })
    .await
}

/// Calls `method(...args, ctx)` on the plugin and returns its JSON result.
pub async fn invoke(
    plugin_id: &str,
    code: &str,
    method: &str,
    args: serde_json::Value,
    env: serde_json::Value,
    clients: HttpClients,
) -> std::result::Result<serde_json::Value, PluginError> {
    let fut = invoke_inner(plugin_id, code, method, args, env, clients);
    let raw = match tokio::time::timeout(CALL_TIMEOUT, fut).await {
        Ok(Ok(raw)) => raw,
        Ok(Err(e)) => return Err(PluginError::fatal(format!("plugin error: {e}"))),
        Err(_) => {
            return Err(PluginError {
                kind: ErrorKind::Temporary,
                message: "plugin timed out".into(),
            })
        }
    };
    let res: InvokeResult = serde_json::from_str(&raw)
        .map_err(|e| PluginError::fatal(format!("bad plugin result: {e}")))?;
    if res.ok {
        Ok(res.value.unwrap_or(serde_json::Value::Null))
    } else {
        Err(PluginError {
            kind: res.kind.unwrap_or(ErrorKind::Fatal),
            message: res.message.unwrap_or_else(|| "unknown plugin error".into()),
        })
    }
}

async fn invoke_inner(
    plugin_id: &str,
    code: &str,
    method: &str,
    args: serde_json::Value,
    env: serde_json::Value,
    clients: HttpClients,
) -> Result<String> {
    let (rt, ctx) = new_context().await?;
    let code = code.to_string();
    let method = method.to_string();
    let plugin_id = plugin_id.to_string();
    let args = args.to_string();
    let env = env.to_string();
    let clients = Arc::new(clients);
    let out = async_with!(ctx => |ctx| {
        let setup = || -> rquickjs::Result<Promise> {
            let g = ctx.globals();
            let c = clients.clone();
            g.set(
                "__host_http",
                Func::from(Async(move |req: String| {
                    let c = c.clone();
                    async move {
                        match do_http(&c, &req).await {
                            Ok(r) => serde_json::to_string(&r).unwrap_or_default(),
                            Err(e) => serde_json::json!({ "error": format!("{e:#}") }).to_string(),
                        }
                    }
                })),
            )?;
            g.set(
                "__host_sleep",
                Func::from(Async(|ms: f64| async move {
                    tokio::time::sleep(Duration::from_millis(ms.clamp(0.0, 600_000.0) as u64)).await;
                })),
            )?;
            let id = plugin_id.clone();
            g.set(
                "__host_log",
                Func::from(move |level: String, msg: String| match level.as_str() {
                    "error" => tracing::error!(plugin = %id, "{msg}"),
                    "warn" => tracing::warn!(plugin = %id, "{msg}"),
                    "debug" => tracing::debug!(plugin = %id, "{msg}"),
                    _ => tracing::info!(plugin = %id, "{msg}"),
                }),
            )?;
            g.set(
                "__host_sha256",
                Func::from(|text: String| -> String {
                    use sha2::Digest;
                    hex::encode(sha2::Sha256::digest(text.as_bytes()))
                }),
            )?;
            let jar = clients.jar.clone();
            g.set(
                "__host_cookies",
                Func::from(move |url: String| -> String {
                    let (Some(jar), Ok(url)) = (&jar, url::Url::parse(&url)) else {
                        return String::new();
                    };
                    jar.cookies(&url)
                        .and_then(|v| v.to_str().ok().map(str::to_string))
                        .unwrap_or_default()
                }),
            )?;
            let jar = clients.jar.clone();
            g.set(
                "__host_set_cookie",
                Func::from(move |url: String, cookie: String| {
                    if let (Some(jar), Ok(url), Ok(value)) =
                        (&jar, url::Url::parse(&url), HeaderValue::from_str(&cookie))
                    {
                        jar.set_cookies(&mut std::iter::once(&value), &url);
                    }
                }),
            )?;
            ctx.eval::<(), _>(PRELUDE)?;
            ctx.eval::<(), _>(code.as_str())?;
            let invoke: Function = g.get("__haul_invoke")?;
            invoke.call((method.as_str(), args.as_str(), env.as_str()))
        };
        let promise = setup().catch(&ctx).map_err(|e| anyhow!("{e}"))?;
        promise.into_future::<String>().await.catch(&ctx).map_err(|e| anyhow!("{e}"))
    })
    .await;
    drop(ctx);
    rt.idle().await;
    out
}

/// Runs an untrusted snippet in an isolated QuickJS instance without any host functions,
/// with tight memory and time limits, and returns the string result of `expr`.
/// Used for the `jk` field of Click'n'Load 2.
pub fn eval_isolated(script: &str, expr: &str) -> Result<String> {
    let rt = Runtime::new()?;
    rt.set_memory_limit(16 << 20);
    rt.set_max_stack_size(256 << 10);
    let deadline = Instant::now() + Duration::from_secs(2);
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let ctx = Context::full(&rt)?;
    ctx.with(|ctx| {
        let run = || -> rquickjs::Result<String> {
            ctx.eval::<(), _>(script)?;
            ctx.eval::<String, _>(expr)
        };
        run().catch(&ctx).map_err(|e| anyhow!("{e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_eval() {
        let s = eval_isolated("function f(){ return '31323334'; }", "f()").unwrap();
        assert_eq!(s, "31323334");
        assert!(eval_isolated("while(true){}", "1").is_err());
        assert!(
            eval_isolated("function f(){ return typeof __host_http; }", "f()").unwrap()
                == "undefined"
        );
    }

    fn clients() -> HttpClients {
        HttpClients {
            follow: Client::new(),
            no_follow: Client::new(),
            jar: Some(Arc::default()),
        }
    }

    const PLUGIN: &str = r#"
        var __plugin = { default: {
            id: "t", version: 2, matches: [/https?:\/\/t\.example\/(\w+)/i],
            async resolve(link, ctx) {
                await ctx.wait(0.01);
                ctx.log("resolving", link);
                const acc = ctx.account.get();
                return { url: link + "?u=" + (acc ? acc.user : "-") };
            },
            async check(link) { const e = new Error("gone"); e.haulKind = "offline"; throw e; },
        }};
    "#;

    #[tokio::test]
    async fn meta_and_invoke() {
        let meta: serde_json::Value =
            serde_json::from_str(&read_meta(PLUGIN).await.unwrap()).unwrap();
        assert_eq!(meta["id"], "t");
        assert_eq!(meta["matches"][0]["flags"], "i");
        let v = invoke(
            "t",
            PLUGIN,
            "resolve",
            serde_json::json!(["http://t.example/x"]),
            serde_json::json!({"pluginId": "t", "account": {"user": "bob"}}),
            clients(),
        )
        .await
        .unwrap();
        assert_eq!(v["url"], "http://t.example/x?u=bob");
        let e = invoke(
            "t",
            PLUGIN,
            "check",
            serde_json::json!(["x"]),
            serde_json::json!({}),
            clients(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Offline);
    }
}

#[cfg(test)]
mod bundled {
    use super::*;

    /// Runs the esbuild bundle of the ddownload plugin in QuickJS (skipped if not built).
    #[tokio::test]
    async fn ddownload_bundle_runs_in_quickjs() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../plugins/dist/ddownload.js"
        );
        let Ok(code) = std::fs::read_to_string(path) else {
            eprintln!("plugins/dist/ddownload.js not built, skipping");
            return;
        };
        let meta: serde_json::Value =
            serde_json::from_str(&read_meta(&code).await.unwrap()).unwrap();
        assert_eq!(meta["id"], "ddownload");
        assert_eq!(meta["accountRequired"], true);
        assert_eq!(meta["hasCheckAccount"], true);
        assert!(meta["account"]["help"].as_str().unwrap().contains("xfss"));
        let clients = HttpClients {
            follow: Client::new(),
            no_follow: Client::new(),
            jar: None,
        };
        let err = invoke(
            "ddownload",
            &code,
            "resolve",
            serde_json::json!(["https://ddownload.com/abcdefghijkl"]),
            serde_json::json!({ "pluginId": "ddownload", "account": null }),
            clients,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Account, "{}", err.message);
    }

    /// The gofile bundle declares `crawl`; `ctx.hash.sha256` works in QuickJS.
    #[tokio::test]
    async fn gofile_bundle_crawls_and_hashes() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../plugins/dist/gofile.js");
        if let Ok(code) = std::fs::read_to_string(path) {
            let meta: serde_json::Value =
                serde_json::from_str(&read_meta(&code).await.unwrap()).unwrap();
            assert_eq!(meta["id"], "gofile");
            assert_eq!(meta["hasCrawl"], true);
            assert_eq!(meta["serial"], true);
            assert_eq!(meta["accountRequired"], false);
        }
        let code = r#"
            var __plugin = { default: { id: "h", version: 1, matches: [],
                async resolve(text, ctx) { return { url: ctx.hash.sha256(text) }; },
            }};
        "#;
        let clients = HttpClients {
            follow: Client::new(),
            no_follow: Client::new(),
            jar: None,
        };
        let v = invoke(
            "h",
            code,
            "resolve",
            serde_json::json!(["abc"]),
            serde_json::json!({}),
            clients,
        )
        .await
        .unwrap();
        assert_eq!(
            v["url"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}

#[cfg(test)]
mod cookie_and_file_tests {
    use super::*;
    use axum::http::{header, HeaderMap};
    use axum::routing::get;

    #[tokio::test]
    async fn cookies_and_file_responses() {
        let app = axum::Router::new()
            .route(
                "/page",
                get(|h: HeaderMap| async move {
                    let sent = h
                        .get(header::COOKIE)
                        .map(|v| v.to_str().unwrap().to_string())
                        .unwrap_or_default();
                    ([(header::SET_COOKIE, "xfss=RENEWED; Path=/")], sent)
                }),
            )
            .route(
                "/file.bin",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "application/octet-stream")],
                        vec![0u8; 20 * 1024 * 1024],
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let jar: Arc<CookieStoreMutex> = Arc::default();
        let build = || {
            Client::builder()
                .cookie_provider(jar.clone())
                .build()
                .unwrap()
        };
        let clients = HttpClients {
            follow: build(),
            no_follow: build(),
            jar: Some(jar.clone()),
        };
        let code = r#"
            var __plugin = { default: { id: "c", version: 1, matches: [],
                async resolve(base, ctx) {
                    ctx.cookies.set(base, "xfss=PASTED; Path=/");
                    const first = (await ctx.http.get(base + "/page")).body;
                    const second = (await ctx.http.get(base + "/page")).body;
                    const file = await ctx.http.get(base + "/file.bin");
                    return { url: [first, second, ctx.cookies.get(base), String(file.file), String(file.body.length)].join("|") };
                },
            }};
        "#;
        let v = invoke(
            "c",
            code,
            "resolve",
            serde_json::json!([base]),
            serde_json::json!({}),
            clients,
        )
        .await
        .unwrap();
        // 20 MB would exceed the page limit: the file is recognised without reading it.
        assert_eq!(v["url"], "xfss=PASTED|xfss=RENEWED|xfss=RENEWED|true|0");
    }
}
