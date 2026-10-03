//! Messages for the UI.
//!
//! The server does not render texts: a message is its key and inputs,
//! `\u{2}["key",{"name":"value"}]\u{3}`, and the UI renders it in the viewer's language from
//! `ui/messages/*.json` (Paraglide). So a message stored today (a download's error, say) still
//! shows in whatever language the viewer picks later. Messages can sit inside longer text, e.g.
//! behind a context prefix, and an input can be a message itself; plain text (tool output) is
//! shown as is. Entries stored by older versions carry both texts instead:
//! `\u{2}` German `\u{1f}` English `\u{3}`.

pub const START: char = '\u{2}';
pub const SEP: char = '\u{1f}';
pub const END: char = '\u{3}';

/// A message by key; see the top of this module. Inputs are text: a message inside an input
/// stays intact, because JSON escapes the markers.
pub fn msg(key: &str, inputs: &[(&str, String)]) -> String {
    let inputs: serde_json::Map<String, serde_json::Value> = inputs
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.clone())))
        .collect();
    let body = serde_json::to_string(&(key, inputs)).expect("strings serialize");
    format!("{START}{body}{END}")
}

/// `msg!("server_files_notFoundAt", path = rel)`: the key must exist in `ui/messages/*.json`
/// (checked by `every_key_has_a_text`), the inputs are the placeholders of its text.
#[macro_export]
macro_rules! msg {
    ($key:literal $(,)?) => {
        $crate::i18n::msg($key, &[])
    };
    ($key:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::msg($key, &[$((stringify!($name), ($value).to_string())),+])
    };
}

/// Readable text for logs and tests: a message as `key {inputs}`, with messages inside its
/// inputs written the same way; older entries in English.
pub fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(START) {
        out.push_str(&rest[..start]);
        let seg = &rest[start + START.len_utf8()..];
        let (body, after) = match seg.find(END) {
            Some(end) => (&seg[..end], &seg[end + END.len_utf8()..]),
            None => (seg, ""),
        };
        match serde_json::from_str::<(String, serde_json::Map<String, serde_json::Value>)>(body) {
            Ok((key, inputs)) => {
                out.push_str(&key);
                if !inputs.is_empty() {
                    let shown: Vec<String> = inputs
                        .iter()
                        .map(|(k, v)| format!("{k}={}", plain(v.as_str().unwrap_or_default())))
                        .collect();
                    out.push_str(&format!(" {{{}}}", shown.join(", ")));
                }
            }
            Err(_) => out.push_str(body.split_once(SEP).map_or(body, |(_, en)| en)),
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// A text in German from `ui/messages/de.json`, for tests that check what the user reads.
#[cfg(test)]
pub fn german(text: &str) -> String {
    use std::sync::OnceLock;
    static TEXTS: OnceLock<serde_json::Map<String, serde_json::Value>> = OnceLock::new();
    let texts = TEXTS.get_or_init(|| {
        let file = concat!(env!("CARGO_MANIFEST_DIR"), "/../../ui/messages/de.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    });
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(START) {
        out.push_str(&rest[..start]);
        let seg = &rest[start + START.len_utf8()..];
        let (body, after) = match seg.find(END) {
            Some(end) => (&seg[..end], &seg[end + END.len_utf8()..]),
            None => (seg, ""),
        };
        match serde_json::from_str::<(String, serde_json::Map<String, serde_json::Value>)>(body) {
            Ok((key, inputs)) => {
                let mut t = texts[&key].as_str().expect("a plain text").to_string();
                for (name, value) in &inputs {
                    t = t.replace(
                        &format!("{{{name}}}"),
                        &german(value.as_str().unwrap_or_default()),
                    );
                }
                out.push_str(&t.replace("\\{", "{").replace("\\}", "}"));
            }
            Err(_) => out.push_str(body.split_once(SEP).map_or(body, |(de, _)| de)),
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_inside_other_text() {
        let file = "a.rar";
        let m = crate::msg!("server_files_notFoundAt", path = file);
        let chained = format!("Paket 3: {m} (HTTP 404)");
        assert_eq!(
            plain(&chained),
            "Paket 3: server_files_notFoundAt {path=a.rar} (HTTP 404)"
        );
        assert_eq!(plain("unrar: CRC failed"), "unrar: CRC failed");
        // A message as input stays intact, markers in plain inputs cannot break the frame.
        let code = crate::msg!("server_extract_code", code = 2);
        let line = crate::msg!(
            "server_extract_failed",
            detail = format!("7-Zip ({code}): x{END}y")
        );
        assert_eq!(line.matches(START).count(), 1);
        assert_eq!(
            plain(&line),
            "server_extract_failed {detail=7-Zip (server_extract_code {code=2}): x\u{3}y}"
        );
        // Older entries: the English part; cut off: still readable.
        assert_eq!(
            plain("\u{2}Datei offline\u{1f}File offline\u{3}"),
            "File offline"
        );
        assert_eq!(plain("\u{2}Datei offline\u{1f}File off"), "File off");
    }

    /// Every key used in the server has a text in every language of the UI.
    #[test]
    fn every_key_has_a_text() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let mut used = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src"
        ))];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let src = std::fs::read_to_string(&path).unwrap();
                    for part in src.split("msg!(\"").skip(1) {
                        used.push(part.split('"').next().unwrap().to_string());
                    }
                }
            }
        }
        assert!(used.len() > 50, "found {} keys", used.len());
        for lang in ["de", "en"] {
            let file = format!("{root}/ui/messages/{lang}.json");
            let texts: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            let missing: Vec<&String> = used.iter().filter(|k| !texts.contains_key(*k)).collect();
            assert!(missing.is_empty(), "{lang}: no text for {missing:?}");
        }
    }
}
