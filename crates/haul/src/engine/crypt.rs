//! Files a hoster stores encrypted and the plugin can decrypt: mega.nz (AES-128-CTR, like JD's
//! MegaConz and pyLoad's MegaCoNz). CTR decrypts at any byte offset, so every segment decrypts
//! on its own, also when a download resumes.

use aes::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};
use serde::Deserialize;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

/// What a plugin's `resolve` gives in `decrypt` (key and initial counter as hex).
#[derive(Debug, Clone, Deserialize)]
pub struct DecryptSpec {
    pub cipher: String,
    pub key: String,
    pub iv: String,
}

#[derive(Clone)]
pub struct Decrypt {
    key: [u8; 16],
    iv: [u8; 16],
}

impl Decrypt {
    pub fn from_spec(spec: &DecryptSpec) -> Result<Self, String> {
        if !spec.cipher.eq_ignore_ascii_case("aes-128-ctr") {
            return Err(format!("unsupported cipher {}", spec.cipher));
        }
        let bytes = |s: &str| -> Result<[u8; 16], String> {
            hex::decode(s.trim())
                .map_err(|e| e.to_string())?
                .try_into()
                .map_err(|_| "key and iv must be 16 bytes".to_string())
        };
        Ok(Self {
            key: bytes(&spec.key)?,
            iv: bytes(&spec.iv)?,
        })
    }

    /// Decrypts `data`, which sits at byte `offset` of the file, in place.
    pub fn apply(&self, offset: u64, data: &mut [u8]) {
        let mut c = Aes128Ctr::new(&self.key.into(), &self.iv.into());
        c.seek(offset);
        c.apply_keystream(data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_at_any_offset() {
        let spec = DecryptSpec {
            cipher: "aes-128-ctr".into(),
            key: "000102030405060708090a0b0c0d0e0f".into(),
            iv: "f0f1f2f3f4f5f6f70000000000000000".into(),
        };
        let d = Decrypt::from_spec(&spec).unwrap();
        let plain: Vec<u8> = (0..100u8).collect();
        let mut enc = plain.clone();
        d.apply(0, &mut enc);
        assert_ne!(enc, plain);
        // Pieces decrypted separately, split off a block boundary, give the whole back.
        let (a, b) = enc.split_at_mut(37);
        d.apply(0, a);
        d.apply(37, b);
        assert_eq!(enc, plain);
        assert!(Decrypt::from_spec(&DecryptSpec {
            cipher: "aes-256-gcm".into(),
            ..spec
        })
        .is_err());
    }

    /// NIST SP 800-38A F.5.1 (AES-128 CTR), the counter as MEGA's `nonce ‖ block` (big endian).
    #[test]
    fn nist_vector() {
        let d = Decrypt::from_spec(&DecryptSpec {
            cipher: "aes-128-ctr".into(),
            key: "2b7e151628aed2a6abf7158809cf4f3c".into(),
            iv: "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff".into(),
        })
        .unwrap();
        let mut c = hex::decode("874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff")
            .unwrap();
        d.apply(0, &mut c);
        assert_eq!(
            hex::encode(c),
            "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51"
        );
    }
}
