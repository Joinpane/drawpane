//! Native timing of the CPU path on a display list file: `cargo run --release --example bench -- <file.dl>`.
use std::time::Instant;
fn main() {
    let path = std::env::args().nth(1).expect("a display list file");
    let bytes = std::fs::read(path).unwrap();
    let list = drawpane_engine_spike::dl::decode(&bytes).unwrap();
    for _ in 0..3 {
        let t = Instant::now();
        let (_p, s) = drawpane_engine_spike::cpu::render(&list).unwrap();
        println!("{:?} {:?}", t.elapsed(), s);
    }
    // An empty scene over the whole page, as a flush with nothing new costs.
    use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};
    let mut pix = Pixmap::new(list.width, list.height);
    let mut res = Resources::new();
    let ctx = RenderContext::new(list.width, list.height);
    let t = Instant::now();
    for _ in 0..20 {
        ctx.render_with(&mut pix, &mut res, RasterizerSettings { target_init: TargetInit::SrcOver, ..Default::default() });
    }
    println!("empty scene render: {:?} each", t.elapsed() / 20);
}
