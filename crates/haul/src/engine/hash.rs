//! Checksums a hoster publishes, verified after the download like JD's HashInfo ("CRC OK"):
//! MD5 (Gofile, Google Drive), SHA-1, SHA-256 (Mediafire, Google Drive, Send) and MEGA's
//! CBC-MAC (the meta MAC in the file key, pyLoad MegaCrypto.Checksum).

use std::io::Read;
use std::path::Path;

use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use serde::{Deserialize, Serialize};
use sha2::Digest;

/// What a plugin reports: `{ type: "md5" | "sha1" | "sha256" | "mega", value }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HashSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

impl HashSpec {
    /// Stored as `type:value` in the downloads table.
    pub fn to_db(&self) -> String {
        format!(
            "{}:{}",
            self.kind.to_lowercase(),
            self.value.trim().to_lowercase()
        )
    }

    pub fn from_db(s: &str) -> Option<Self> {
        let (kind, value) = s.split_once(':')?;
        Some(Self {
            kind: kind.into(),
            value: value.into(),
        })
    }

    /// Known type and a value of the right length; anything else is ignored.
    pub fn usable(&self) -> bool {
        let len = match self.kind.to_lowercase().as_str() {
            "md5" => 32,
            "sha1" => 40,
            "sha256" => 64,
            // The whole 32-byte MEGA file key (hex).
            "mega" => 64,
            _ => return false,
        };
        let v = self.value.trim();
        v.len() == len && v.chars().all(|c| c.is_ascii_hexdigit())
    }
}

/// True if the file matches. Reads the whole file: call it off the async runtime.
pub fn verify(path: &Path, spec: &HashSpec) -> std::io::Result<bool> {
    let want = spec.value.trim().to_lowercase();
    let got = match spec.kind.to_lowercase().as_str() {
        "md5" => digest::<md5::Md5>(path)?,
        "sha1" => digest::<sha1::Sha1>(path)?,
        "sha256" => digest::<sha2::Sha256>(path)?,
        "mega" => {
            let key = hex::decode(&want).map_err(std::io::Error::other)?;
            return Ok(mega_mac(path, &key)? == key[24..32]);
        }
        other => {
            return Err(std::io::Error::other(format!(
                "unknown checksum type {other}"
            )))
        }
    };
    Ok(got == want)
}

fn digest<D: Digest>(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = D::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// MEGA's chunks (pyLoad get_chunks): 128 KiB, growing by 128 KiB up to 1 MiB, then 1 MiB.
fn chunks(size: u64) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let (mut start, mut len) = (0u64, 0x20000u64);
    while start + len < size {
        out.push((start, len));
        start += len;
        if len < 0x100000 {
            len += 0x20000;
        }
    }
    if start < size {
        out.push((start, size - start));
    }
    out
}

/// pyLoad MegaCrypto.Checksum: a CBC-MAC per chunk (IV = key bytes 16..24 twice, last block
/// zero-padded), chained with AES over the chunk MACs; the 8-byte result is word0^word1,
/// word2^word3.
fn mega_mac(path: &Path, key: &[u8]) -> std::io::Result<[u8; 8]> {
    if key.len() != 32 {
        return Err(std::io::Error::other("MEGA key must be 32 bytes"));
    }
    let k: Vec<u8> = (0..16).map(|i| key[i] ^ key[16 + i]).collect();
    let aes = aes::Aes128::new(GenericArray::from_slice(&k));
    let mut iv = [0u8; 16];
    iv[..8].copy_from_slice(&key[16..24]);
    iv[8..].copy_from_slice(&key[16..24]);
    let size = std::fs::metadata(path)?.len();
    let mut file = std::fs::File::open(path)?;
    let mut file_mac = [0u8; 16];
    let mut buf = Vec::new();
    for (_, len) in chunks(size) {
        buf.resize(len as usize, 0);
        file.read_exact(&mut buf)?;
        let mut mac = iv;
        for block in buf.chunks(16) {
            for (m, b) in mac.iter_mut().zip(block) {
                *m ^= b;
            }
            aes.encrypt_block(GenericArray::from_mut_slice(&mut mac));
        }
        for (f, m) in file_mac.iter_mut().zip(mac) {
            *f ^= m;
        }
        aes.encrypt_block(GenericArray::from_mut_slice(&mut file_mac));
    }
    let mut out = [0u8; 8];
    for i in 0..4 {
        out[i] = file_mac[i] ^ file_mac[4 + i];
        out[4 + i] = file_mac[8 + i] ^ file_mac[12 + i];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(data: &[u8]) -> tempfile::NamedTempFile {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), data).unwrap();
        f
    }

    #[test]
    fn standard_digests() {
        let f = file(b"abc");
        let ok = |kind: &str, value: &str| {
            let spec = HashSpec {
                kind: kind.into(),
                value: value.into(),
            };
            assert!(spec.usable(), "{kind}");
            verify(f.path(), &spec).unwrap()
        };
        assert!(ok("md5", "900150983CD24FB0D6963F7D28E17F72"));
        assert!(ok("sha1", "a9993e364706816aba3e25717850c26c9cd0d89d"));
        assert!(ok(
            "sha256",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
        assert!(!ok("md5", "00000000000000000000000000000000"));
        assert!(!HashSpec {
            kind: "whirlpool".into(),
            value: "ab".into()
        }
        .usable());
        let spec = HashSpec::from_db("md5:ABC").unwrap();
        assert_eq!(spec.to_db(), "md5:abc");
    }

    #[test]
    fn mega_chunks_like_pyload() {
        let c = chunks(0x20000 + 0x40000 + 5);
        assert_eq!(c, vec![(0, 0x20000), (0x20000, 0x40000), (0x60000, 5)]);
        assert_eq!(chunks(10), vec![(0, 10)]);
    }

    /// Reference value from pyLoad's MegaCrypto.Checksum, ported 1:1 to Node's AES.
    #[test]
    fn mega_mac_matches_pyload() {
        let n = 0x20000 + 0x40000 + 0x60000 + 777u64;
        let data: Vec<u8> = (0..n).map(|i| ((i * 2654435761) >> 13) as u8).collect();
        let f = file(&data);
        let mut key: Vec<u8> = (0..32u32).map(|i| ((i * 7 + 3) & 0xff) as u8).collect();
        assert_eq!(
            hex::encode(mega_mac(f.path(), &key).unwrap()),
            "426a3ed147ccd30e"
        );
        // A real MEGA key: [aes key XOR (iv ‖ mac), iv, mac]; same AES key and IV as above.
        let aes_key: Vec<u8> = (0..16).map(|i| key[i] ^ key[16 + i]).collect();
        key[24..].copy_from_slice(&hex::decode("426a3ed147ccd30e").unwrap());
        for i in 0..16 {
            key[i] = aes_key[i] ^ key[16 + i];
        }
        let spec = HashSpec {
            kind: "mega".into(),
            value: hex::encode(&key),
        };
        assert!(spec.usable());
        assert!(verify(f.path(), &spec).unwrap());
        key[31] ^= 1;
        let wrong = HashSpec {
            kind: "mega".into(),
            value: hex::encode(&key),
        };
        assert!(!verify(f.path(), &wrong).unwrap());
    }
}
