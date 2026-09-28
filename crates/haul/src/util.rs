use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

/// Turns an arbitrary string into something safe to use as a single path component.
pub fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.chars().take(240).collect()
    }
}

/// Sanitizes a relative directory like `Filme/2025`, keeping the separators but dropping
/// anything that could escape the base directory.
pub fn sanitize_rel_dir(dir: &str) -> String {
    dir.split(['/', '\\'])
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .map(sanitize_filename)
        .collect::<Vec<_>>()
        .join("/")
}

/// Best-effort file name from a URL's last path segment.
pub fn filename_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.rfind(|s| !s.is_empty())?.to_string();
    let decoded = percent_encoding::percent_decode_str(&last).decode_utf8_lossy().to_string();
    Some(sanitize_filename(&decoded))
}

/// Parses `Content-Disposition` for `filename*=` (RFC 5987) or `filename=`.
pub fn filename_from_disposition(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').map(str::trim) {
        let (k, v) = match part.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let k = k.trim().to_ascii_lowercase();
        let v = v.trim();
        if k == "filename*" {
            let raw = v.splitn(3, '\'').nth(2).unwrap_or(v);
            let decoded = percent_encoding::percent_decode_str(raw.trim_matches('"'))
                .decode_utf8_lossy()
                .to_string();
            return Some(sanitize_filename(&decoded));
        }
        if k == "filename" {
            plain = Some(sanitize_filename(v.trim_matches('"')));
        }
    }
    plain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames() {
        assert_eq!(sanitize_filename("../a/b?.rar"), "_a_b_.rar");
        assert_eq!(sanitize_rel_dir("../Filme//2025/./x"), "Filme/2025/x");
        assert_eq!(filename_from_url("https://x.org/a/Some%20File.iso?x=1").unwrap(), "Some File.iso");
        assert_eq!(
            filename_from_disposition("attachment; filename=\"a b.zip\"").unwrap(),
            "a b.zip"
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=x; filename*=UTF-8''%C3%A4.zip").unwrap(),
            "ä.zip"
        );
    }
}
