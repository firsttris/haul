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
    /// Seconds until the next try, when the hoster said (`TemporaryError(msg, seconds)`).
    pub wait_secs: Option<u64>,
    /// The wait holds for every download from this hoster (`HosterLimitError`).
    pub hoster_wide: bool,
}

impl PluginError {
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Fatal,
            message: message.into(),
            wait_secs: None,
            hoster_wide: false,
        }
    }
}

#[derive(Deserialize)]
struct InvokeResult {
    ok: bool,
    value: Option<serde_json::Value>,
    kind: Option<ErrorKind>,
    message: Option<String>,
    wait: Option<f64>,
    scope: Option<String>,
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
            ctx.globals().set("__host_captcha", Func::from(|| ()))?;
            ctx.globals().set("__host_password", Func::from(|| ()))?;
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
#[cfg(test)]
pub async fn invoke(
    plugin_id: &str,
    code: &str,
    method: &str,
    args: serde_json::Value,
    env: serde_json::Value,
    clients: HttpClients,
) -> std::result::Result<serde_json::Value, PluginError> {
    invoke_with(plugin_id, code, method, args, env, clients, None).await
}

/// Like [`invoke`], with `ctx.captcha` answered by the user through `asker`.
pub async fn invoke_with(
    plugin_id: &str,
    code: &str,
    method: &str,
    args: serde_json::Value,
    env: serde_json::Value,
    clients: HttpClients,
    asker: Option<crate::captcha::Asker>,
) -> std::result::Result<serde_json::Value, PluginError> {
    // The time limit does not count time spent waiting for the user to solve a captcha.
    let deadline = Arc::new(std::sync::Mutex::new(
        tokio::time::Instant::now() + CALL_TIMEOUT,
    ));
    let fut = invoke_inner(
        plugin_id,
        code,
        method,
        args,
        env,
        clients,
        asker,
        deadline.clone(),
    );
    tokio::pin!(fut);
    let raw = loop {
        let until = *deadline.lock().unwrap();
        tokio::select! {
            r = &mut fut => break r,
            _ = tokio::time::sleep_until(until) => {
                if *deadline.lock().unwrap() <= tokio::time::Instant::now() {
                    return Err(PluginError {
                        kind: ErrorKind::Temporary,
                        message: crate::tr!("Plugin-Zeitlimit überschritten", "plugin timed out"),
                        wait_secs: None,
                        hoster_wide: false,
                    });
                }
            }
        }
    };
    let raw = match raw {
        Ok(raw) => raw,
        Err(e) => return Err(PluginError::fatal(format!("plugin error: {e}"))),
    };
    let res: InvokeResult = serde_json::from_str(&raw)
        .map_err(|e| PluginError::fatal(format!("bad plugin result: {e}")))?;
    if res.ok {
        Ok(res.value.unwrap_or(serde_json::Value::Null))
    } else {
        Err(PluginError {
            kind: res.kind.unwrap_or(ErrorKind::Fatal),
            message: res.message.unwrap_or_else(|| "unknown plugin error".into()),
            // At most a day: a hoster's number is not trusted blindly.
            wait_secs: res
                .wait
                .filter(|w| *w > 0.0)
                .map(|w| (w.ceil() as u64).min(86_400)),
            hoster_wide: res.scope.as_deref() == Some("hoster"),
        })
    }
}

#[allow(clippy::too_many_arguments)]
async fn invoke_inner(
    plugin_id: &str,
    code: &str,
    method: &str,
    args: serde_json::Value,
    env: serde_json::Value,
    clients: HttpClients,
    asker: Option<crate::captcha::Asker>,
    deadline: Arc<std::sync::Mutex<tokio::time::Instant>>,
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
            let (a, d) = (asker.clone(), deadline.clone());
            g.set(
                "__host_captcha",
                Func::from(Async(move |req: String| {
                    let asker = a.clone();
                    let deadline = d.clone();
                    async move {
                        let Some(asker) = asker else {
                            return serde_json::json!({ "error": "captchas are not available here" }).to_string();
                        };
                        let req: crate::captcha::CaptchaRequest = match serde_json::from_str(&req) {
                            Ok(r) => r,
                            Err(e) => return serde_json::json!({ "error": format!("bad captcha request: {e}") }).to_string(),
                        };
                        {
                            let mut d = deadline.lock().unwrap();
                            *d += crate::captcha::TIMEOUT;
                        }
                        match asker.captchas.request(&asker, req).await {
                            Ok(token) => serde_json::json!({ "token": token }).to_string(),
                            Err(e) => serde_json::json!({ "error": e }).to_string(),
                        }
                    }
                })),
            )?;
            let (a, d) = (asker.clone(), deadline.clone());
            g.set(
                "__host_password",
                // mode: `get` (saved or ask), `wrong` (forget, ask again), `forget`, `saved`.
                Func::from(Async(move |mode: String| {
                    let asker = a.clone();
                    let deadline = d.clone();
                    async move {
                        let Some((asker, password)) = asker.and_then(|a| a.password.clone().map(|p| (a, p))) else {
                            return if mode == "saved" {
                                "{}".to_string()
                            } else {
                                serde_json::json!({ "error": "unavailable" }).to_string()
                            };
                        };
                        if mode == "saved" {
                            return serde_json::json!({ "password": password.get() }).to_string();
                        }
                        let wrong = mode != "get";
                        if wrong {
                            password.set(None);
                        } else if let Some(saved) = password.get() {
                            return serde_json::json!({ "password": saved }).to_string();
                        }
                        if mode == "forget" {
                            return "{}".to_string();
                        }
                        {
                            let mut d = deadline.lock().unwrap();
                            *d += crate::captcha::TIMEOUT;
                        }
                        match asker.captchas.ask_password(&asker, wrong).await {
                            Ok(p) => {
                                password.set(Some(p.clone()));
                                serde_json::json!({ "password": p }).to_string()
                            }
                            Err(e) => serde_json::json!({ "error": e }).to_string(),
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
        assert!(meta["account"]["help"]["de"]
            .as_str()
            .unwrap()
            .contains("xfss"));
        assert!(meta["account"]["help"]["en"]
            .as_str()
            .unwrap()
            .contains("xfss"));
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

    /// The 1fichier bundle's error handling in QuickJS: waits with their seconds, the link.
    #[tokio::test]
    async fn onefichier_bundle_in_quickjs() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../plugins/dist/1fichier.js"
        );
        let Ok(code) = std::fs::read_to_string(path) else {
            eprintln!("plugins/dist/1fichier.js not built, skipping");
            return;
        };
        let code = format!(
            r#"{code}
            __plugin.default.resolve = async (html) => {{
                if (html.startsWith("rows:")) return {{ url: JSON.stringify(__plugin.folderRows(html.slice(5))) }};
                const res = {{ status: 200, url: "https://1fichier.com/?x", body: html, file: false, headers: {{}} }};
                try {{ __plugin.checkErrors(res); }} catch (e) {{ return {{ url: e.haulKind + ":" + (e.haulWait || 0) }}; }}
                return {{ url: "link:" + __plugin.downloadLink(html) }};
            }};"#
        );
        let run = |html: &str| {
            let clients = HttpClients {
                follow: Client::new(),
                no_follow: Client::new(),
                jar: None,
            };
            invoke(
                "1fichier",
                &code,
                "resolve",
                serde_json::json!([html]),
                serde_json::json!({}),
                clients,
            )
        };
        let url = |v: serde_json::Value| v["url"].as_str().unwrap().to_string();
        assert_eq!(
            url(run("<p> You must wait 7 minutes</p>").await.unwrap()),
            "temporary:420"
        );
        assert_eq!(
            url(run("<b> IP Locked</b>").await.unwrap()),
            "temporary:3600"
        );
        assert_eq!(
            url(run("<p> File not found !</p>").await.unwrap()),
            "offline:0"
        );
        assert_eq!(
            url(
                run(r#"<a href="https://a-1.1fichier.com/c1">Click here to download</a>"#)
                    .await
                    .unwrap()
            ),
            "link:https://a-1.1fichier.com/c1"
        );
        // Files of a password-protected folder, read from its HTML (JD's regex).
        let rows = url(
            run(r#"rows:<a href="https://1fichier.com/?abcde12345">a &amp; b.rar</a></td> <td>1.5 GB</td>"#)
                .await
                .unwrap(),
        );
        assert_eq!(
            rows,
            r#"[{"url":"https://1fichier.com/?abcde12345","name":"a & b.rar","size":1610612736}]"#
        );
    }

    /// Google Drive's confirm-link parsing in QuickJS (no URL class there).
    #[tokio::test]
    async fn gdrive_bundle_in_quickjs() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../plugins/dist/gdrive.js");
        let Ok(code) = std::fs::read_to_string(path) else {
            eprintln!("plugins/dist/gdrive.js not built, skipping");
            return;
        };
        let code = format!(
            r#"{code}
            __plugin.default.resolve = async (html) => ({{ url: String(__plugin.confirmUrl(html, "https://drive.usercontent.google.com/download?id=x")) }});"#
        );
        let clients = HttpClients {
            follow: Client::new(),
            no_follow: Client::new(),
            jar: None,
        };
        let html = r#"<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="abc"><input type="hidden" name="confirm" value="t"></form>"#;
        let v = invoke(
            "gdrive",
            &code,
            "resolve",
            serde_json::json!([html]),
            serde_json::json!({}),
            clients,
        )
        .await
        .unwrap();
        assert_eq!(
            v["url"],
            "https://drive.usercontent.google.com/download?id=abc&confirm=t"
        );
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
