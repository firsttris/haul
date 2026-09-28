//! Runs plugin code in QuickJS. Every call gets a fresh runtime, so plugins cannot keep
//! state between calls and a misbehaving call cannot poison the next one. State that must
//! survive (logins) lives in the per-account cookie jar on the Rust side.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use reqwest::Client;
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
}
