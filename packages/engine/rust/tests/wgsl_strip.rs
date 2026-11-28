//! The vendored vello_shaders' comment stripper (`vendor/vello_shaders/src/strip.rs`), which the
//! compute module's shaders are embedded through. Its own tests run here: the vendored crate is
//! outside the workspace, and its build checks every bundled shader parses to the same module
//! stripped as whole (`compile::ShaderInfo::new`).

#[path = "../vendor/vello_shaders/src/strip.rs"]
mod strip;

/// The vendored preprocessor, with its `log` calls kept quiet (its import loader goes unused).
#[allow(dead_code)]
mod preprocess {
    mod log {
        macro_rules! quiet {
            ($($t:tt)*) => {{
                let _ = format!($($t)*);
            }};
        }
        pub(crate) use quiet as warn;
    }
    include!("../vendor/vello_shaders/src/compile/preprocess.rs");
}

#[test]
fn a_shader_with_an_enable_directive_ships_as_the_preprocessor_wrote_it() {
    use std::collections::{HashMap, HashSet};
    // The re-check's shader: a block comment after `#enable f16;` whose closer sits on a line
    // that starts `//`. Stripped, the opener stayed with the directive and the closer went, and
    // the emitted shader was an unclosed comment.
    let src =
        "#enable f16; /* explanation\n// continued */\n@compute @workgroup_size(1)\nfn main() {\n    // body\n}\n";
    let pre = preprocess::preprocess(src, "probe", &HashSet::new(), &HashMap::new());
    assert!(pre.starts_with(strip::ENABLE), "the preprocessor's stand-in: {pre:?}");
    let shipped = strip::shipped(&pre);
    assert_eq!(shipped, pre, "a shader with an enable stand-in ships whole");
    let emitted = strip::postprocess(&shipped);
    assert_eq!(emitted, strip::postprocess(&pre));
    assert!(
        emitted.starts_with("enable f16; /* explanation\n// continued */\n"),
        "{emitted:?}"
    );

    // The same shader without the directive is stripped, and `postprocess` leaves it as it is.
    let pre = preprocess::preprocess(&src["#enable f16; ".len()..], "probe", &HashSet::new(), &HashMap::new());
    let shipped = strip::shipped(&pre);
    assert_eq!(shipped, "@compute @workgroup_size(1)\nfn main() {\n}\n");
    assert_eq!(strip::postprocess(&shipped), shipped);
}
