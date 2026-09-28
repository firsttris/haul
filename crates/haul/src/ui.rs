use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct Assets;

/// Serves the built UI; unknown paths get `index.html` so client-side routes work.
pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(file) = Assets::get(path).filter(|_| !path.is_empty()) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, mime.as_ref()),
                (header::CACHE_CONTROL, cache),
            ],
            file.data,
        )
            .into_response();
    }
    if path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    match Assets::get("index.html") {
        Some(index) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            index.data,
        )
            .into_response(),
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
