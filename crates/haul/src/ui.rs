use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use rust_embed::{EmbeddedFile, RustEmbed};

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct Assets;

/// Serves the built UI; unknown paths get `index.html` so client-side routes work.
pub async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(file) = Assets::get(path).filter(|_| !path.is_empty()) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return embedded(&headers, file, mime.as_ref(), cache);
    }
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    match Assets::get("index.html") {
        Some(index) => embedded(&headers, index, "text/html; charset=utf-8", "no-cache"),
        None => match std::env::var("HAUL_DEV_UI").ok().filter(|v| !v.is_empty()) {
            // `pnpm dev`: the UI is served by Vite; send the browser there.
            Some(dev) => Redirect::temporary(&format!("{}{}", dev.trim_end_matches('/'), uri))
                .into_response(),
            None => (
                StatusCode::NOT_FOUND,
                "UI not built. Run `pnpm build`, or use `pnpm dev` and open http://localhost:5173.",
            )
                .into_response(),
        },
    }
}

/// An embedded file with an ETag from its build-time SHA-256; a matching `If-None-Match`
/// gets `304 Not Modified` without a body. The tag is weak because the compression layer
/// sends the same file in several encodings.
fn embedded(headers: &HeaderMap, file: EmbeddedFile, mime: &str, cache: &'static str) -> Response {
    let etag = format!("W/\"{}\"", hex::encode(file.metadata.sha256_hash()));
    let cache = HeaderValue::from_static(cache);
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| etag_matches(v, &etag));
    let etag = HeaderValue::from_str(&etag).expect("hex is a valid header value");
    if fresh {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, etag), (header::CACHE_CONTROL, cache)],
        )
            .into_response();
    }
    let mime = HeaderValue::from_str(mime).expect("mime type is a valid header value");
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, cache),
            (header::ETAG, etag),
        ],
        file.data,
    )
        .into_response()
}

/// Weak comparison as for `If-None-Match` (RFC 9110 13.1.2): `*` or any listed tag, `W/` ignored.
fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    fn opaque(t: &str) -> &str {
        t.trim().trim_start_matches("W/")
    }
    let ours = opaque(etag);
    if_none_match
        .split(',')
        .any(|t| t.trim() == "*" || opaque(t) == ours)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn if_none_match() {
        let etag = "W/\"abc\"";
        assert!(etag_matches("W/\"abc\"", etag));
        assert!(etag_matches("\"abc\"", etag));
        assert!(etag_matches("\"x\", W/\"abc\"", etag));
        assert!(etag_matches("*", etag));
        assert!(!etag_matches("\"abcd\"", etag));
        assert!(!etag_matches("", etag));
    }
}
