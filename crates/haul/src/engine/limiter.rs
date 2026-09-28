use std::num::NonZeroU32;
use std::sync::{Arc, RwLock};

use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};

/// Global bandwidth limit shared by all segments. One cell = 1 KiB.
pub struct Limiter {
    inner: RwLock<Option<(Arc<DefaultDirectRateLimiter>, u32)>>,
}

impl Limiter {
    pub fn new(kib_per_sec: u32) -> Self {
        let l = Self {
            inner: RwLock::new(None),
        };
        l.set_limit(kib_per_sec);
        l
    }

    pub fn set_limit(&self, kib_per_sec: u32) {
        let new = NonZeroU32::new(kib_per_sec)
            .map(|n| (Arc::new(RateLimiter::direct(Quota::per_second(n))), n.get()));
        *self.inner.write().unwrap() = new;
    }

    /// Waits until `bytes` may pass. Returns immediately without a limit.
    pub async fn consume(&self, bytes: usize) {
        let current = self.inner.read().unwrap().clone();
        let Some((limiter, burst)) = current else {
            return;
        };
        let mut cells = bytes.div_ceil(1024) as u32;
        while cells > 0 {
            let n = cells.min(burst);
            // `n <= burst`, so this cannot fail with InsufficientCapacity.
            let _ = limiter.until_n_ready(NonZeroU32::new(n).unwrap()).await;
            cells -= n;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn limits() {
        let l = Limiter::new(0);
        let t = Instant::now();
        l.consume(10 << 20).await;
        assert!(t.elapsed().as_millis() < 50);

        l.set_limit(100);
        let t = Instant::now();
        // First 100 KiB is the burst, the next 50 KiB need ~0.5 s.
        l.consume(100 * 1024).await;
        l.consume(50 * 1024).await;
        let ms = t.elapsed().as_millis();
        assert!((400..900).contains(&ms), "{ms}");
    }
}
