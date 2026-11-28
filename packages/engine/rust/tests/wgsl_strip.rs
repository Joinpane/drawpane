//! The vendored vello_shaders' comment stripper (`vendor/vello_shaders/src/strip.rs`), which the
//! compute module's shaders are embedded through. Its own tests run here: the vendored crate is
//! outside the workspace, and its build checks every bundled shader parses to the same module
//! stripped as whole (`compile::ShaderInfo::new`).

#[path = "../vendor/vello_shaders/src/strip.rs"]
mod strip;
