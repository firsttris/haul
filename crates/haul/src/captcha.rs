//! Captchas solved by the user in their own browser, like JD's browser solver.
//!
//! reCaptcha, hCaptcha and Turnstile tokens are bound to the hoster's domain, so the widget has
//! to run on the hoster's page. A plugin that meets one calls `ctx.captcha.solve(…)`; the call
//! waits here while the UI offers the captcha. "Solve" opens the hoster page with the challenge
//! in the URL fragment; the userscript `haul-captcha.user.js` (the role of JD's browser
//! extension) replaces the page with the widget and sends the token back with the challenge's
//! one-time secret.
//!
//! Download passwords are asked the same way (JD's `getUserInput("Password?")`): the plugin calls
//! `ctx.password.get()`, the UI shows an input field and answers with the challenge's secret.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::events::{Events, Topic};

/// How long a challenge waits for the user (JD's default dialog timeout is similar).
pub const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What a plugin asks for (`ctx.captcha.solve`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptchaRequest {
    /// `recaptcha`, `hcaptcha` or `turnstile`.
    pub kind: String,
    pub site_key: String,
    /// The page with the captcha: its domain is what the token is bound to.
    pub page_url: String,
    /// reCaptcha Enterprise (another script).
    #[serde(default)]
    pub enterprise: bool,
}

/// A waiting challenge, as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptchaView {
    pub id: String,
    /// Proof for the userscript, which reports without the UI's login.
    pub secret: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub kind: String,
    pub site_key: String,
    pub page_url: String,
    pub host: String,
    pub enterprise: bool,
    /// The link the plugin works on.
    pub link: Option<String>,
    /// The download's name, for a password question.
    pub name: Option<String>,
    /// A password question after a wrong password.
    pub wrong: bool,
    pub created_at: i64,
    pub expires_at: i64,
}

struct Pending {
    view: CaptchaView,
    tx: oneshot::Sender<Result<String, String>>,
}

pub struct Captchas {
    pending: Mutex<HashMap<String, Pending>>,
    events: Events,
}

/// Who asks: the plugin and the link of the current call.
#[derive(Clone)]
pub struct Asker {
    pub captchas: std::sync::Arc<Captchas>,
    pub plugin_id: String,
    pub plugin_name: String,
    pub link: Option<String>,
    pub name: Option<String>,
    /// The download password of the call; `None`: the call may not ask for one.
    pub password: Option<Password>,
}

/// The download password during a plugin call: the saved one, replaced by what the user enters.
/// The caller saves it afterwards if it changed.
#[derive(Clone, Default)]
pub struct Password(std::sync::Arc<Mutex<PasswordState>>);

#[derive(Default)]
struct PasswordState {
    value: Option<String>,
    changed: bool,
}

impl Password {
    pub fn new(saved: Option<String>) -> Self {
        let p = Self::default();
        p.0.lock().unwrap().value = saved.filter(|s| !s.is_empty());
        p
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().value.clone()
    }

    pub fn set(&self, value: Option<String>) {
        let mut s = self.0.lock().unwrap();
        if s.value != value {
            s.value = value;
            s.changed = true;
        }
    }

    /// The password to save, if the call changed it (`Some(None)`: forget it).
    pub fn changed(&self) -> Option<Option<String>> {
        let s = self.0.lock().unwrap();
        s.changed.then(|| s.value.clone())
    }
}

/// Compares without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

impl Captchas {
    pub fn new(events: Events) -> Self {
        Self {
            pending: Mutex::default(),
            events,
        }
    }

    /// Waits until the user solved the captcha, cancelled it or `TIMEOUT` passed.
    pub async fn request(&self, asker: &Asker, req: CaptchaRequest) -> Result<String, String> {
        let kind = req.kind.to_lowercase();
        if !["recaptcha", "hcaptcha", "turnstile"].contains(&kind.as_str()) {
            return Err(format!("unknown captcha kind {kind}"));
        }
        let url = url::Url::parse(&req.page_url).map_err(|e| format!("page url: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") || req.site_key.trim().is_empty() {
            return Err("captcha needs an http(s) page and a site key".into());
        }
        let now = now_ms();
        let view = CaptchaView {
            id: crate::crypto::random_token()[..16].to_string(),
            secret: crate::crypto::random_token(),
            plugin_id: asker.plugin_id.clone(),
            plugin_name: asker.plugin_name.clone(),
            kind,
            site_key: req.site_key.trim().to_string(),
            page_url: req.page_url.clone(),
            host: url.host_str().unwrap_or_default().to_string(),
            enterprise: req.enterprise,
            link: asker.link.clone(),
            name: None,
            wrong: false,
            created_at: now,
            expires_at: now + TIMEOUT.as_millis() as i64,
        };
        self.wait(&asker.plugin_id, view).await
    }

    /// The download password for the asker's link, like JD's `getUserInput("Password?")`.
    /// `wrong`: the last one was rejected by the hoster.
    pub async fn ask_password(&self, asker: &Asker, wrong: bool) -> Result<String, String> {
        let link = asker.link.clone().unwrap_or_default();
        let host = url::Url::parse(&link)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let now = now_ms();
        let view = CaptchaView {
            id: crate::crypto::random_token()[..16].to_string(),
            secret: crate::crypto::random_token(),
            plugin_id: asker.plugin_id.clone(),
            plugin_name: asker.plugin_name.clone(),
            kind: "password".into(),
            site_key: String::new(),
            page_url: link,
            host,
            enterprise: false,
            link: asker.link.clone(),
            name: asker.name.clone(),
            wrong,
            created_at: now,
            expires_at: now + TIMEOUT.as_millis() as i64,
        };
        self.wait(&asker.plugin_id, view).await
    }

    async fn wait(&self, plugin: &str, view: CaptchaView) -> Result<String, String> {
        let id = view.id.clone();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending { view, tx });
        tracing::info!(%plugin, %id, "waiting for the user");
        self.events.changed(Topic::Captchas);
        let result = match tokio::time::timeout(TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("cancelled".into()),
            Err(_) => Err("timeout".into()),
        };
        self.pending.lock().unwrap().remove(&id);
        self.events.changed(Topic::Captchas);
        result
    }

    pub fn list(&self) -> Vec<CaptchaView> {
        let mut v: Vec<_> = self
            .pending
            .lock()
            .unwrap()
            .values()
            .map(|p| p.view.clone())
            .collect();
        v.sort_by_key(|c| c.created_at);
        v
    }

    /// The userscript's answer; false for an unknown id or a wrong secret.
    pub fn solve(&self, id: &str, secret: &str, token: &str) -> bool {
        let mut pending = self.pending.lock().unwrap();
        let Some(p) = pending
            .get(id)
            .filter(|p| same(p.view.secret.as_bytes(), secret.as_bytes()))
        else {
            return false;
        };
        // A password is taken as typed; a token never has spaces around it.
        let answer = if p.view.kind == "password" {
            token
        } else {
            token.trim()
        };
        if answer.is_empty() {
            return false;
        }
        let answer = answer.to_string();
        let p = pending.remove(id).unwrap();
        let _ = p.tx.send(Ok(answer));
        true
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.pending.lock().unwrap().remove(id) {
            Some(p) => {
                let _ = p.tx.send(Err("cancelled".into()));
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn asker(c: &Arc<Captchas>) -> Asker {
        Asker {
            captchas: c.clone(),
            plugin_id: "fk".into(),
            plugin_name: "Filekeeper".into(),
            link: Some("https://filekeeper.net/abc".into()),
            name: Some("file.rar".into()),
            password: None,
        }
    }

    fn req() -> CaptchaRequest {
        CaptchaRequest {
            kind: "reCaptcha".into(),
            site_key: "6Lkey".into(),
            page_url: "https://filekeeper.net/abc".into(),
            enterprise: false,
        }
    }

    #[tokio::test]
    async fn solved_with_the_secret_only() {
        let c = Arc::new(Captchas::new(Events::new()));
        let wait = tokio::spawn({
            let c = c.clone();
            async move { c.request(&asker(&c), req()).await }
        });
        let view = loop {
            if let Some(v) = c.list().pop() {
                break v;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(
            (view.kind.as_str(), view.host.as_str()),
            ("recaptcha", "filekeeper.net")
        );
        assert!(!c.solve(&view.id, "wrong", "TOKEN"));
        assert!(c.solve(&view.id, &view.secret, "TOKEN"));
        assert_eq!(wait.await.unwrap(), Ok("TOKEN".into()));
        assert!(c.list().is_empty());
    }

    #[tokio::test]
    async fn cancelled_and_rejected() {
        let c = Arc::new(Captchas::new(Events::new()));
        let bad = CaptchaRequest {
            kind: "image".into(),
            ..req()
        };
        assert!(c.request(&asker(&c), bad).await.is_err());
        let wait = tokio::spawn({
            let c = c.clone();
            async move { c.request(&asker(&c), req()).await }
        });
        while c.list().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(c.cancel(&c.list()[0].id));
        assert_eq!(wait.await.unwrap(), Err("cancelled".into()));
    }

    #[tokio::test]
    async fn password_taken_as_typed() {
        let c = Arc::new(Captchas::new(Events::new()));
        let wait = tokio::spawn({
            let c = c.clone();
            async move { c.ask_password(&asker(&c), true).await }
        });
        let view = loop {
            if let Some(v) = c.list().pop() {
                break v;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(view.kind, "password");
        assert_eq!(view.name.as_deref(), Some("file.rar"));
        assert!(view.wrong);
        assert!(!c.solve(&view.id, &view.secret, ""));
        assert!(c.solve(&view.id, &view.secret, " pw "));
        assert_eq!(wait.await.unwrap(), Ok(" pw ".into()));
    }

    #[test]
    fn password_slot_reports_changes_only() {
        let p = Password::new(Some("a".into()));
        p.set(Some("a".into()));
        assert_eq!(p.changed(), None);
        p.set(None);
        assert_eq!(p.changed(), Some(None));
        p.set(Some("b".into()));
        assert_eq!(
            (p.get(), p.changed()),
            (Some("b".into()), Some(Some("b".into())))
        );
    }
}
