//! Captchas solved by the user in their own browser, like JD's browser solver.
//!
//! reCaptcha, hCaptcha and Turnstile tokens are bound to the hoster's domain, so the widget has
//! to run on the hoster's page. A plugin that meets one calls `ctx.captcha.solve(…)`; the call
//! waits here while the UI offers the captcha. "Solve" opens the hoster page with the challenge
//! in the URL fragment; the userscript `haul-captcha.user.js` (the role of JD's browser
//! extension) replaces the page with the widget and sends the token back with the challenge's
//! one-time secret.

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
        let id = crate::crypto::random_token()[..16].to_string();
        let now = now_ms();
        let view = CaptchaView {
            id: id.clone(),
            secret: crate::crypto::random_token(),
            plugin_id: asker.plugin_id.clone(),
            plugin_name: asker.plugin_name.clone(),
            kind,
            site_key: req.site_key.trim().to_string(),
            page_url: req.page_url.clone(),
            host: url.host_str().unwrap_or_default().to_string(),
            enterprise: req.enterprise,
            link: asker.link.clone(),
            created_at: now,
            expires_at: now + TIMEOUT.as_millis() as i64,
        };
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending { view, tx });
        tracing::info!(plugin = %asker.plugin_id, %id, "captcha waiting for the user");
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
        let ok = pending
            .get(id)
            .is_some_and(|p| same(p.view.secret.as_bytes(), secret.as_bytes()));
        if !ok || token.trim().is_empty() {
            return false;
        }
        let p = pending.remove(id).unwrap();
        let _ = p.tx.send(Ok(token.trim().to_string()));
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
}
