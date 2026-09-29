//! Messages for the UI in German and English.
//!
//! A message carries both languages: `\u{2}` German `\u{1f}` English `\u{3}`. The UI shows the
//! part of its language, so a message stored today (a download's error, say) still shows in
//! whatever language the viewer picks later. Such segments can sit inside longer text, e.g. behind
//! a context prefix; plain text (older entries, tool output) is shown as is.

pub const START: char = '\u{2}';
pub const SEP: char = '\u{1f}';
pub const END: char = '\u{3}';

/// A message in German and English.
pub fn tr(de: impl AsRef<str>, en: impl AsRef<str>) -> String {
    let clean = |s: &str| s.replace([START, SEP, END], "");
    format!(
        "{START}{}{SEP}{}{END}",
        clean(de.as_ref()),
        clean(en.as_ref())
    )
}

/// `tr!("Datei {}", "File {}", name)`: both texts formatted with the same arguments.
#[macro_export]
macro_rules! tr {
    ($de:literal, $en:literal $(,)?) => {
        $crate::i18n::tr($de, $en)
    };
    ($de:literal, $en:literal, $($arg:expr),+ $(,)?) => {
        $crate::i18n::tr(format!($de, $($arg),+), format!($en, $($arg),+))
    };
}

/// The text in one language (`en` = true for English), e.g. for logs and tests.
pub fn pick(text: &str, en: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(START) {
        out.push_str(&rest[..start]);
        let seg = &rest[start + START.len_utf8()..];
        let (body, after) = match seg.find(END) {
            Some(end) => (&seg[..end], &seg[end + END.len_utf8()..]),
            None => (seg, ""),
        };
        let (de, en_text) = body.split_once(SEP).unwrap_or((body, body));
        out.push_str(if en { en_text } else { de });
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_languages_inside_other_text() {
        let file = "a.rar";
        let m = tr!("Datei {} offline", "File {} offline", file);
        let chained = format!("Paket 3: {m} (HTTP 404)");
        assert_eq!(
            pick(&chained, false),
            "Paket 3: Datei a.rar offline (HTTP 404)"
        );
        assert_eq!(
            pick(&chained, true),
            "Paket 3: File a.rar offline (HTTP 404)"
        );
        assert_eq!(pick("nur deutsch", true), "nur deutsch");
        // Cut off (e.g. shortened): still readable.
        assert_eq!(pick(&m[..m.len() - 3], true), "File a.rar offli");
        // Markers inside arguments cannot break the frame.
        assert_eq!(pick(&tr(format!("x{END}y"), "z"), false), "xy");
    }
}
