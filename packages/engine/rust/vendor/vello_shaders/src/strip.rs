// Copyright 2026 the Drawpane Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Drawpane: WGSL without its comments, blank lines or indentation, for the shaders the compute
//! module embeds (`compile::ShaderInfo::new`). Comments follow the WGSL spec ("Comments",
//! "Blankspace and Line Breaks"): a line-ending comment runs from `//` to the next line break,
//! any of the seven WGSL line break characters; a block comment runs from `/*` to its matching
//! `*/`, nesting, across lines, and `//` inside it is plain text, as `/*` is inside a line-ending
//! comment. WGSL has no string literals, so nothing else can hold a comment marker. Each comment
//! is blankspace, so a block comment becomes a space and a line-ending comment ends its line.
//!
//! A shader holding the preprocessor's stand-in for an `enable` directive (a line comment
//! `//__#enable ...`, which `postprocess` makes the directive again) ships as it is: the
//! directive turns live only after naga, which can't read it, has checked the source, so no
//! check could vouch for stripping around it.

use std::borrow::Cow;

/// The preprocessor's stand-in for an `enable` directive (`compile::preprocess`).
pub const ENABLE: &str = "//__#enable";

/// The preprocessed shader `src` as it ships, before `postprocess`: without its comments
/// (`strip_comments`), unless it holds the `enable` stand-in anywhere.
pub fn shipped(src: &str) -> Cow<'_, str> {
    if src.contains(ENABLE) {
        Cow::Borrowed(src)
    } else {
        Cow::Owned(strip_comments(src))
    }
}

/// Turns the preprocessor's `enable` stand-ins back into directives: a workaround for
/// gfx-rs/wgpu#5476 (naga can't handle the `enable` directive), so other WGSL compilers get it.
/// Remove it once naga supports the directive. (Upstream's `compile::postprocess`, moved here.)
pub fn postprocess(wgsl: &str) -> String {
    let mut output = String::with_capacity(wgsl.len());
    for line in wgsl.lines() {
        if line.starts_with("//__#enable") {
            output.push_str(&line["//__#".len()..]);
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    output
}

/// Whether `c` is a WGSL line break (CR LF counts as one, which `strip` gets by dropping the
/// empty line between them).
fn is_line_break(c: char) -> bool {
    matches!(
        c,
        '\u{000A}' | '\u{000B}' | '\u{000C}' | '\u{000D}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
    )
}

/// Whether `c` is WGSL blankspace.
fn is_blankspace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\u{200E}' | '\u{200F}') || is_line_break(c)
}

/// `src` with its comments replaced as blankspace, then cut into lines at every line break, each
/// trimmed of blankspace, and the empty ones left out.
pub fn strip_comments(src: &str) -> String {
    let mut code = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(c) = rest.chars().next() {
        if rest.starts_with("//") {
            // The line break itself is the next character.
            rest = &rest[rest.find(is_line_break).unwrap_or(rest.len())..];
        } else if rest.starts_with("/*") {
            let mut depth = 0usize;
            let mut at = 0;
            let bytes = rest.as_bytes();
            while at < bytes.len() {
                if bytes[at..].starts_with(b"/*") {
                    depth += 1;
                    at += 2;
                } else if bytes[at..].starts_with(b"*/") {
                    depth -= 1;
                    at += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    at += 1;
                }
            }
            // An unclosed comment runs to the end (naga refuses the original source anyway).
            rest = rest.get(at..).unwrap_or("");
            code.push(' ');
        } else {
            code.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    let mut out = String::with_capacity(code.len());
    for line in code.split(is_line_break) {
        let line = line.trim_matches(is_blankspace);
        if !line.is_empty() {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::strip_comments;

    #[test]
    fn a_nested_block_comment_runs_across_lines() {
        // The re-check's case: the outer comment opens on one line, an inner one opens and
        // closes on the next ones, and the outer closes on a line that starts with `//`, plain
        // text inside a block comment. Losing count would expose `x = 1u;`.
        let src = "fn f() -> u32 {\n    var x = 2u;\n    /* outer\n    /* inner\n    */ x = 1u;\n    // still the outer comment */\n    return x;\n}\n";
        assert_eq!(strip_comments(src), "fn f() -> u32 {\nvar x = 2u;\nreturn x;\n}\n");
    }

    #[test]
    fn block_comments_nest_and_close_on_one_line_or_many() {
        assert_eq!(strip_comments("a /* b /* c */ d */ e\n"), "a   e\n");
        assert_eq!(strip_comments("a/**/b\n"), "a b\n");
        // A comment over lines is one space: what's either side of it shares a line.
        assert_eq!(strip_comments("a /* b\n/* c\nd */\ne */ f\n"), "a   f\n");
        assert_eq!(strip_comments("a /* // b */ c\n"), "a   c\n");
        assert_eq!(strip_comments("a /* b */ // c /* d\ne\n"), "a\ne\n");
    }

    #[test]
    fn a_line_ending_comment_stops_at_every_line_break() {
        // LF, VT, FF, CR, CR LF, NEL, line separator and paragraph separator.
        for br in ["\n", "\u{B}", "\u{C}", "\r", "\r\n", "\u{85}", "\u{2028}", "\u{2029}"] {
            let src = format!("let a = 1; // gone{br}let b = 2;{br}");
            assert_eq!(strip_comments(&src), "let a = 1;\nlet b = 2;\n", "{br:?}");
        }
        // `/*` in a line-ending comment opens nothing.
        assert_eq!(strip_comments("a // b /* c\nd */ e\n"), "a\nd */ e\n");
    }

    #[test]
    fn indentation_and_blank_lines_go_but_the_code_stays() {
        assert_eq!(
            strip_comments("\n\t fn  f() {\n\n  \u{200E}return;\u{200F} \n}\n"),
            "fn  f() {\nreturn;\n}\n"
        );
        assert_eq!(strip_comments("a"), "a\n");
        assert_eq!(strip_comments(""), "");
    }

    #[test]
    fn a_shader_holding_an_enable_stand_in_ships_whole() {
        use super::{postprocess, shipped};
        // The re-check's cases: a block comment after the directive closing on a line that starts
        // `//` (stripping kept the opener with the directive and dropped the closer, leaving the
        // emitted shader an unclosed comment), and stand-in text in an ordinary comment, indented
        // or after a U+2028 line break, which stripping would have made a live directive.
        for src in [
            "//__#enable f16;  /* why\n// continued */\nfn f() {}\n",
            "fn f() {}\n    //__#enable imaginary;\n",
            "fn f() {} // note\u{2028}//__#enable imaginary;\n",
        ] {
            assert_eq!(shipped(src), src);
        }
        assert_eq!(postprocess("//__#enable f16;\nfn f() {}\n"), "enable f16;\nfn f() {}\n");
        // Without one, stripped, and nothing for `postprocess` to change.
        let stripped = shipped("fn f() {} /* a\n// b */\n// c\n");
        assert_eq!(stripped, "fn f() {}\n");
        assert_eq!(postprocess(&stripped), stripped);
    }
}
