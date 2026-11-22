//! Strips comments and blank lines from bundled WGSL shaders into `OUT_DIR`
//! so source files stay documented without inflating WebAssembly binaries.

use std::env;
use std::fs;
use std::path::Path;

const SHADERS: &[&str] = &[
    "blend.wgsl",
    "blur.wgsl",
    "noise.wgsl",
    "readers.wgsl",
    "shadow.wgsl",
    "texture.wgsl",
];

fn minify_wgsl(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for line in src.lines() {
        let code = line.split("//").next().unwrap_or("").trim();
        if !code.is_empty() {
            out.push_str(code);
            out.push('\n');
        }
    }
    out
}

fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let out_root = Path::new(&out_dir);
    for name in SHADERS {
        let src_path = Path::new("src").join(name);
        println!("cargo:rerun-if-changed={}", src_path.display());
        let src = fs::read_to_string(&src_path).expect("read wgsl");
        fs::write(out_root.join(name), minify_wgsl(&src)).expect("write minified wgsl");
    }
}
