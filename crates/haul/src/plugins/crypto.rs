//! Crypto for plugins that QuickJS cannot do fast enough: `ctx.crypto.run(op, args)`.
//! Hex in, hex out. The MEGA login needs all of it (JD MegaConz.apiLogin, pyLoad MegaCoNz
//! account): PBKDF2-SHA512 (v2 accounts), MEGA's old password key (v1), AES encryption, RSA
//! (modular power) for the session id, and the Hashcash proof of work.

use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use anyhow::{anyhow, Result};
use base64::Engine;
use hmac::{Hmac, Mac};
use num_bigint_dig::BigUint;
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};

fn hex_arg(v: &Value, name: &str) -> Result<Vec<u8>> {
    let s = v[name].as_str().ok_or_else(|| anyhow!("{name} missing"))?;
    Ok(hex::decode(s.trim())?)
}

fn key16(v: &Value, name: &str) -> Result<[u8; 16]> {
    hex_arg(v, name)?
        .try_into()
        .map_err(|_| anyhow!("{name} must be 16 bytes"))
}

/// Runs one operation; returns the result as hex (or base64url for the hashcash nonce).
pub fn run(op: &str, args: &Value) -> Result<String> {
    match op {
        "pbkdf2Sha512" => {
            let password = args["password"]
                .as_str()
                .ok_or_else(|| anyhow!("password missing"))?;
            let salt = hex_arg(args, "salt")?;
            let iterations = args["iterations"].as_u64().unwrap_or(0) as u32;
            let length = args["length"].as_u64().unwrap_or(0) as usize;
            if iterations == 0 || length == 0 || length > 256 || iterations > 1_000_000 {
                return Err(anyhow!("bad pbkdf2 parameters"));
            }
            Ok(hex::encode(pbkdf2_sha512(
                password.as_bytes(),
                &salt,
                iterations,
                length,
            )))
        }
        "aesEncrypt" => {
            let key = key16(args, "key")?;
            let mut data = hex_arg(args, "data")?;
            if data.len() % 16 != 0 {
                return Err(anyhow!("data must be a multiple of 16 bytes"));
            }
            let cipher = aes::Aes128::new(&key.into());
            let cbc = args["mode"].as_str() == Some("cbc");
            let mut prev = if args["iv"].is_string() {
                key16(args, "iv")?
            } else {
                [0u8; 16]
            };
            for block in data.chunks_mut(16) {
                if cbc {
                    for (b, p) in block.iter_mut().zip(prev) {
                        *b ^= p;
                    }
                }
                cipher.encrypt_block(GenericArray::from_mut_slice(block));
                if cbc {
                    prev.copy_from_slice(block);
                }
            }
            Ok(hex::encode(data))
        }
        "modPow" => {
            let parse = |s: &str| {
                BigUint::parse_bytes(s.trim().as_bytes(), 16).ok_or_else(|| anyhow!("not hex: {s}"))
            };
            let n = |name: &str| -> Result<BigUint> {
                parse(
                    args[name]
                        .as_str()
                        .ok_or_else(|| anyhow!("{name} missing"))?,
                )
            };
            // The modulus as hex, or as a list of factors (RSA: p and q).
            let modulus = match &args["mod"] {
                Value::Array(factors) if !factors.is_empty() => {
                    factors.iter().try_fold(BigUint::from(1u8), |acc, f| {
                        Ok::<_, anyhow::Error>(
                            acc * parse(
                                f.as_str()
                                    .ok_or_else(|| anyhow!("factor is not a string"))?,
                            )?,
                        )
                    })?
                }
                _ => n("mod")?,
            };
            if modulus == BigUint::from(0u8) {
                return Err(anyhow!("modulus is zero"));
            }
            Ok(n("base")?.modpow(&n("exp")?, &modulus).to_str_radix(16))
        }
        "megaPrepareKey" => {
            let password = args["password"]
                .as_str()
                .ok_or_else(|| anyhow!("password missing"))?;
            Ok(hex::encode(mega_prepare_key(password.as_bytes())))
        }
        "megaUserHashV1" => {
            let email = args["email"]
                .as_str()
                .ok_or_else(|| anyhow!("email missing"))?;
            let key = key16(args, "key")?;
            Ok(mega_user_hash_v1(email.as_bytes(), &key))
        }
        "megaHashcash" => {
            let challenge = args["challenge"]
                .as_str()
                .ok_or_else(|| anyhow!("challenge missing"))?;
            let easiness = args["easiness"]
                .as_u64()
                .ok_or_else(|| anyhow!("easiness missing"))?;
            if easiness > 255 {
                return Err(anyhow!("easiness out of range"));
            }
            mega_hashcash(challenge, easiness as u32)
        }
        other => Err(anyhow!("unknown crypto operation {other}")),
    }
}

/// RFC 8018 PBKDF2 with HMAC-SHA512.
pub fn pbkdf2_sha512(password: &[u8], salt: &[u8], iterations: u32, length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length);
    let mut block = 1u32;
    while out.len() < length {
        let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(password).expect("any key length");
        mac.update(salt);
        mac.update(&block.to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut t = u;
        for _ in 1..iterations {
            let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(password).expect("any key length");
            mac.update(&u);
            u = mac.finalize().into_bytes();
            for (a, b) in t.iter_mut().zip(u.iter()) {
                *a ^= b;
            }
        }
        out.extend_from_slice(&t);
        block += 1;
    }
    out.truncate(length);
    out
}

/// pyLoad MegaCoNz.get_password_key (JD prepare_key_aLong): 65536 rounds of AES over the
/// constant key, with the password (as 32-bit words, zero-filled) in 16-byte pieces as keys.
pub fn mega_prepare_key(password: &[u8]) -> [u8; 16] {
    let mut key: [u8; 16] = hex::decode("93c467e37db0c7a4d1be3f810152cb56")
        .unwrap()
        .try_into()
        .unwrap();
    // bytes_to_a32 pads the password to whole 32-bit words.
    let mut pw = password.to_vec();
    pw.resize(pw.len().div_ceil(4) * 4, 0);
    let ciphers: Vec<aes::Aes128> = pw
        .chunks(16)
        .map(|c| {
            let mut k = [0u8; 16];
            k[..c.len()].copy_from_slice(c);
            aes::Aes128::new(&k.into())
        })
        .collect();
    for _ in 0..0x10000 {
        for c in &ciphers {
            // CBC with a zero IV over one block = one AES encryption.
            c.encrypt_block(GenericArray::from_mut_slice(&mut key));
        }
    }
    key
}

/// pyLoad MegaCoNz.get_user_hash_v1: the e-mail folded into 16 bytes, 16384 AES rounds with the
/// password key; words 0 and 2 as base64url.
pub fn mega_user_hash_v1(email: &[u8], key: &[u8; 16]) -> String {
    let mut words = [0u32; 4];
    let mut padded = email.to_vec();
    padded.resize(padded.len().div_ceil(4) * 4, 0);
    for (i, w) in padded.chunks(4).enumerate() {
        words[i % 4] ^= u32::from_be_bytes([w[0], w[1], w[2], w[3]]);
    }
    let mut hash = [0u8; 16];
    for (i, w) in words.iter().enumerate() {
        hash[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }
    let cipher = aes::Aes128::new(&(*key).into());
    for _ in 0..0x4000 {
        cipher.encrypt_block(GenericArray::from_mut_slice(&mut hash));
    }
    let mut out = Vec::with_capacity(8);
    out.extend_from_slice(&hash[0..4]);
    out.extend_from_slice(&hash[8..12]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out)
}

/// pyLoad MegaCrypto.solve_hashcash: a 4-byte nonce so that SHA-256(nonce ‖ token×262144)
/// starts with a number below the threshold. Returns the nonce as base64url.
pub fn mega_hashcash(challenge: &str, easiness: u32) -> Result<String> {
    let mut token = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(challenge.trim_end_matches('='))
        .map_err(|e| anyhow!("challenge: {e}"))?;
    token.resize(token.len().div_ceil(16) * 16, 0);
    if token.len() != 48 {
        return Err(anyhow!("invalid token length"));
    }
    let threshold: u64 = (((easiness as u64 & 63) << 1) + 1) << ((easiness as u64 >> 6) * 7 + 3);
    let mut buffer = vec![0u8; 4 + 48 * 0x40000];
    for chunk in buffer[4..].chunks_mut(48) {
        chunk.copy_from_slice(&token);
    }
    let mut nonce: u32 = 0;
    loop {
        nonce = nonce.wrapping_add(1);
        buffer[..4].copy_from_slice(&nonce.to_le_bytes());
        let hash = Sha256::digest(&buffer);
        let value = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) as u64;
        if value <= threshold {
            return Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buffer[..4]));
        }
        if nonce == u32::MAX {
            return Err(anyhow!("hashcash not solvable"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_matches_rfc_style_vector() {
        // Vector from Node's crypto.pbkdf2Sync("password", "salt", 1, 64, "sha512").
        assert_eq!(
            hex::encode(pbkdf2_sha512(b"password", b"salt", 1, 64)),
            "867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce"
        );
    }

    #[test]
    fn mod_pow_and_aes() {
        let r = run(
            "modPow",
            &serde_json::json!({ "base": "4", "exp": "d", "mod": "1f1" }),
        )
        .unwrap();
        assert_eq!(r, "1bd"); // 4^13 mod 497 = 445
                              // AES-128 ECB, FIPS-197 C.1.
        let e = run(
            "aesEncrypt",
            &serde_json::json!({ "mode": "ecb", "key": "000102030405060708090a0b0c0d0e0f", "data": "00112233445566778899aabbccddeeff" }),
        )
        .unwrap();
        assert_eq!(e, "69c4e0d86a7b0430d8cdb78070b4c55a");
    }

    /// Reference values: pyLoad's get_password_key and solve_hashcash, ported 1:1 to Node.
    #[test]
    fn mega_kdf_and_hashcash_match_pyload() {
        assert_eq!(
            hex::encode(mega_prepare_key("Passwört-123 lang genug".as_bytes())),
            "3a92ebd27b559f79afb87fb65eb8c381"
        );
        assert_eq!(
            mega_hashcash(
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v",
                180
            )
            .unwrap(),
            "BAAAAA"
        );
        let key: [u8; 16] = hex::decode("3a92ebd27b559f79afb87fb65eb8c381")
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            mega_user_hash_v1(b"some.user@example.org", &key),
            "r7AiWo_HUdc"
        );
        // RSA-style: the modulus as factors.
        let r = run(
            "modPow",
            &serde_json::json!({ "base": "4", "exp": "d", "mod": ["7", "47"] }),
        )
        .unwrap();
        assert_eq!(r, "1bd");
    }
}
