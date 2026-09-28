//! Click'n'Load. Web pages POST links to `127.0.0.1:9666`; they land in the Linksammler
//! and are never started automatically.

use std::collections::HashMap;
use std::sync::Arc;

use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
use anyhow::{anyhow, Result};
use axum::extract::{Form, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine as _;

use crate::engine::{parse_links, AddLinks, Engine};
use crate::plugins::host::eval_isolated;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Decrypts a CNL2 payload: `jk` is a JS snippet defining `f()` which returns the key as
/// hex. Key and IV are the same, AES-128-CBC without padding, `crypted` is Base64.
pub fn decrypt_cnl2(crypted: &str, jk: &str) -> Result<Vec<String>> {
    let key_hex = eval_isolated(jk, "String(f())")?;
    let key =
        hex::decode(key_hex.trim()).map_err(|_| anyhow!("jk liefert keinen Hex-Schlüssel"))?;
    if key.len() != 16 {
        return Err(anyhow!("Schlüssel hat {} statt 16 Bytes", key.len()));
    }
    // Form decoding turns an unescaped '+' into a space.
    let cleaned: String = crypted
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .map(|c| if c == ' ' { '+' } else { c })
        .collect();
    let mut data = base64::engine::general_purpose::STANDARD
        .decode(cleaned.trim())
        .map_err(|e| anyhow!("crypted ist kein Base64: {e}"))?;
    let usable = data.len() - data.len() % 16;
    data.truncate(usable);
    let plain = Aes128CbcDec::new(key.as_slice().into(), key.as_slice().into())
        .decrypt_padded_mut::<NoPadding>(&mut data)
        .map_err(|_| anyhow!("Entschlüsselung fehlgeschlagen"))?;
    let text = String::from_utf8_lossy(plain).replace('\0', "");
    Ok(parse_links(&text))
}

fn source_page(form: &HashMap<String, String>, headers: &HeaderMap) -> Option<String> {
    form.get("source")
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| {
            headers
                .get(header::REFERER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
}

fn package_name(form: &HashMap<String, String>, source: Option<&str>) -> Option<String> {
    form.get("package")
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .or_else(|| {
            source
                .and_then(|s| url::Url::parse(s).ok())
                .and_then(|u| u.host_str().map(|h| format!("Click'n'Load {h}")))
        })
}

async fn submit(
    engine: &Arc<Engine>,
    links: Vec<String>,
    form: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Response {
    if links.is_empty() {
        return (StatusCode::BAD_REQUEST, "failed: no links\r\n").into_response();
    }
    let source = source_page(form, headers);
    let req = AddLinks {
        links: links.join("\n"),
        package_name: package_name(form, source.as_deref()),
        target_dir: None,
        start: false,
        source: Some("cnl".into()),
        source_page: source,
        passwords: form.get("passwords").cloned(),
    };
    match engine.add_links(req).await {
        Ok(id) => {
            tracing::info!(
                package = id,
                count = links.len(),
                "Click'n'Load: links added to collector"
            );
            "success\r\n".into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed: {e}\r\n"),
        )
            .into_response(),
    }
}

async fn jdcheck() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        "jdownloader=true;\nvar version='haul';\n",
    )
}

async fn crossdomain() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/xml")],
        r#"<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM "http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>
"#,
    )
}

async fn flash_add(
    State(engine): State<Arc<Engine>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let links = parse_links(form.get("urls").map(String::as_str).unwrap_or(""));
    submit(&engine, links, &form, &headers).await
}

async fn flash_addcrypted2(
    State(engine): State<Arc<Engine>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let (Some(crypted), Some(jk)) = (form.get("crypted"), form.get("jk")) else {
        return (StatusCode::BAD_REQUEST, "failed: missing crypted or jk\r\n").into_response();
    };
    let (crypted, jk) = (crypted.clone(), jk.clone());
    let decrypted = tokio::task::spawn_blocking(move || decrypt_cnl2(&crypted, &jk)).await;
    match decrypted {
        Ok(Ok(links)) => submit(&engine, links, &form, &headers).await,
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, format!("failed: {e}\r\n")).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed: {e}\r\n"),
        )
            .into_response(),
    }
}

/// The CNL routes. Served without auth on the local CNL port and behind the API token
/// under `/api/cnl` for `haul-cnl`.
pub fn router<S: Clone + Send + Sync + 'static>(engine: Arc<Engine>) -> Router<S> {
    Router::new()
        .route("/jdcheck.js", get(jdcheck))
        .route("/crossdomain.xml", get(crossdomain))
        .route("/flash", get(|| async { "JDownloader\r\n" }))
        .route("/flash/", get(|| async { "JDownloader\r\n" }))
        .route("/flash/add", post(flash_add))
        .route("/flash/addcrypted2", post(flash_addcrypted2))
        .with_state(engine)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    #[test]
    fn cnl2_roundtrip() {
        let key = *b"1234567890abcdef";
        let text = "https://ddownload.com/abcdefghijkl\r\nhttps://example.org/file.bin";
        let mut buf = text.as_bytes().to_vec();
        buf.resize(buf.len().div_ceil(16) * 16, 0);
        let len = buf.len();
        let ct = Aes128CbcEnc::new(&key.into(), &key.into())
            .encrypt_padded_mut::<NoPadding>(&mut buf, len)
            .unwrap()
            .to_vec();
        let crypted = base64::engine::general_purpose::STANDARD.encode(ct);
        let jk = format!("function f(){{ return '{}'; }}", hex::encode(key));
        let links = decrypt_cnl2(&crypted.replace('+', " "), &jk).unwrap();
        assert_eq!(
            links,
            vec![
                "https://ddownload.com/abcdefghijkl",
                "https://example.org/file.bin"
            ]
        );
        assert!(decrypt_cnl2(&crypted, "function f(){ return 'zz'; }").is_err());
    }
}
