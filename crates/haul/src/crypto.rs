use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Result};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Encrypts account secrets at rest. The key is derived from `APP_SECRET`, so the
/// database alone is not enough to recover passwords or API keys.
#[derive(Clone)]
pub struct SecretBox {
    cipher: Aes256Gcm,
}

impl SecretBox {
    pub fn new(app_secret: &str) -> Self {
        let key = Sha256::digest(format!("haul-accounts:{app_secret}").as_bytes());
        Self {
            cipher: Aes256Gcm::new_from_slice(&key).expect("32 byte key"),
        }
    }

    pub fn encrypt(&self, plain: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .map_err(|_| anyhow!("encryption failed"))?;
        let mut out = nonce.to_vec();
        out.extend(ct);
        Ok(B64.encode(out))
    }

    pub fn decrypt(&self, stored: &str) -> Result<String> {
        let raw = B64.decode(stored)?;
        if raw.len() < 12 {
            return Err(anyhow!(crate::msg!("server_crypto_secretTooShort")));
        }
        let (nonce, ct) = raw.split_at(12);
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| anyhow!(crate::msg!("server_crypto_cannotDecrypt")))?;
        Ok(String::from_utf8(plain)?)
    }
}

pub fn random_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow!("{e}"))?
        .to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let b = SecretBox::new("s3cret");
        let enc = b.encrypt("hunter2").unwrap();
        assert_eq!(b.decrypt(&enc).unwrap(), "hunter2");
        assert!(SecretBox::new("other").decrypt(&enc).is_err());
        let h = hash_password("pw").unwrap();
        assert!(verify_password("pw", &h));
        assert!(!verify_password("nope", &h));
    }
}
