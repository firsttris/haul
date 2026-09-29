use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};

use crate::api::{ApiError, ApiResult, App};
use crate::crypto::{hash_password, random_token, sha256_hex, verify_password};
use crate::db;
use crate::util::now_ms;

pub const SESSION_COOKIE: &str = "haul_session";
const SESSION_DAYS: i64 = 30;

pub async fn ensure_initial_user(app: &App) -> anyhow::Result<()> {
    if let Some((user, pass)) = &app.engine.cfg.initial_user {
        if db::get_setting(&app.engine.db, "auth.user")
            .await?
            .is_none()
        {
            db::set_setting(&app.engine.db, "auth.user", user).await?;
            db::set_setting(&app.engine.db, "auth.password", &hash_password(pass)?).await?;
            tracing::info!("created user {user} from HAUL_USER/HAUL_PASSWORD");
        }
    }
    Ok(())
}

async fn session_valid(app: &App, token: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?")
        .bind(sha256_hex(token))
        .bind(now_ms())
        .fetch_optional(&app.engine.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

pub async fn token_valid(app: &App, token: &str) -> bool {
    match db::get_setting(&app.engine.db, "auth.api_token").await {
        Ok(Some(hash)) => hash == sha256_hex(token),
        _ => false,
    }
}

/// Accepts a session cookie (browser) or `Authorization: Bearer <api token>` (haul-cnl, scripts).
pub async fn require_auth(
    State(app): State<Arc<App>>,
    jar: CookieJar,
    req: Request,
    next: Next,
) -> Response {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        if session_valid(&app, c.value()).await {
            return next.run(req).await;
        }
    }
    let bearer = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    if let Some(token) = bearer {
        if token_valid(&app, token.trim()).await {
            return next.run(req).await;
        }
    }
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": crate::tr!("nicht angemeldet", "not logged in") })),
    )
        .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    setup_required: bool,
    logged_in: bool,
    user: Option<String>,
}

pub async fn state(State(app): State<Arc<App>>, jar: CookieJar) -> ApiResult<Json<AuthState>> {
    let user = db::get_setting(&app.engine.db, "auth.user").await?;
    let logged_in = match jar.get(SESSION_COOKIE) {
        Some(c) => session_valid(&app, c.value()).await,
        None => false,
    };
    Ok(Json(AuthState {
        setup_required: user.is_none(),
        logged_in,
        user: logged_in.then_some(user).flatten(),
    }))
}

#[derive(Deserialize)]
pub struct Credentials {
    user: String,
    password: String,
}

async fn new_session(app: &App, jar: CookieJar) -> ApiResult<CookieJar> {
    let token = random_token();
    sqlx::query("INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?)")
        .bind(sha256_hex(&token))
        .bind(now_ms() + SESSION_DAYS * 86_400_000)
        .execute(&app.engine.db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(now_ms())
        .execute(&app.engine.db)
        .await?;
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time_days(SESSION_DAYS))
        .build();
    Ok(jar.add(cookie))
}

fn time_days(days: i64) -> time::Duration {
    time::Duration::days(days)
}

pub async fn setup(
    State(app): State<Arc<App>>,
    jar: CookieJar,
    Json(c): Json<Credentials>,
) -> ApiResult<(CookieJar, StatusCode)> {
    if db::get_setting(&app.engine.db, "auth.user")
        .await?
        .is_some()
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            crate::tr!("Benutzer existiert bereits", "The user already exists"),
        ));
    }
    if c.user.trim().is_empty() || c.password.len() < 8 {
        return Err(ApiError::bad_request(crate::tr!(
            "Benutzername und ein Passwort mit mindestens 8 Zeichen angeben",
            "Enter a user name and a password with at least 8 characters"
        )));
    }
    db::set_setting(&app.engine.db, "auth.user", c.user.trim()).await?;
    db::set_setting(
        &app.engine.db,
        "auth.password",
        &hash_password(&c.password)?,
    )
    .await?;
    Ok((new_session(&app, jar).await?, StatusCode::NO_CONTENT))
}

pub async fn login(
    State(app): State<Arc<App>>,
    jar: CookieJar,
    Json(c): Json<Credentials>,
) -> ApiResult<(CookieJar, StatusCode)> {
    let user = db::get_setting(&app.engine.db, "auth.user").await?;
    let hash = db::get_setting(&app.engine.db, "auth.password").await?;
    let ok = matches!((user, hash), (Some(u), Some(h)) if u == c.user.trim() && verify_password(&c.password, &h));
    if !ok {
        tokio::time::sleep(Duration::from_millis(700)).await;
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            crate::tr!(
                "Benutzername oder Passwort falsch",
                "Wrong user name or password"
            ),
        ));
    }
    Ok((new_session(&app, jar).await?, StatusCode::NO_CONTENT))
}

pub async fn logout(
    State(app): State<Arc<App>>,
    jar: CookieJar,
) -> ApiResult<(CookieJar, StatusCode)> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(sha256_hex(c.value()))
            .execute(&app.engine.db)
            .await?;
    }
    Ok((
        jar.remove(Cookie::build(SESSION_COOKIE).path("/")),
        StatusCode::NO_CONTENT,
    ))
}

#[derive(Deserialize)]
pub struct PasswordChange {
    current: String,
    new: String,
}

pub async fn change_password(
    State(app): State<Arc<App>>,
    Json(p): Json<PasswordChange>,
) -> ApiResult<StatusCode> {
    let hash = db::get_setting(&app.engine.db, "auth.password")
        .await?
        .unwrap_or_default();
    if !verify_password(&p.current, &hash) {
        return Err(ApiError::bad_request(crate::tr!(
            "aktuelles Passwort falsch",
            "wrong current password"
        )));
    }
    if p.new.len() < 8 {
        return Err(ApiError::bad_request(crate::tr!(
            "neues Passwort braucht mindestens 8 Zeichen",
            "the new password needs at least 8 characters"
        )));
    }
    db::set_setting(&app.engine.db, "auth.password", &hash_password(&p.new)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct NewToken {
    token: String,
}

/// Creates a new API token (for haul-cnl). Only its hash is stored; the token is shown once.
pub async fn rotate_token(State(app): State<Arc<App>>) -> ApiResult<Json<NewToken>> {
    let token = random_token();
    db::set_setting(&app.engine.db, "auth.api_token", &sha256_hex(&token)).await?;
    Ok(Json(NewToken { token }))
}
