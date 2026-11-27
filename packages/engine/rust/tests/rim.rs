//! A fill under an opaque inside stroke stops halfway into the stroke's band (`exec::rim_inset`),
//! so the shape's anti-aliased edge is the stroke's alone, as Figma draws it, not a fill and a
//! stroke compounded (2c - c²). Only where that can't show: a band two device pixels wide or more
//! (thinner, the fill's edge would fall where the stroke covers a pixel in part, and an opaque
//! shape would turn see-through there), and nothing in the record's subtree reading or blending
//! with what lies under the band.

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::limits::Limits;

const FILL: [f32; 4] = [0.96, 0.96, 0.96, 1.0];
const INK: [f32; 4] = [0.9, 0.9, 0.9, 1.0];

/// A `w` x `h` box (radius `r`, or an ellipse when `r` is None) filled, and stroked `weight`
/// inside in `ink` when given, as the builder encodes an inside stroke.
fn shape(w: f32, h: f32, r: Option<f32>, weight: f32, ink: Option<[f32; 4]>, children: bool) -> Rec {
    let mut rec = Rec::new([1.0, 0.0, 0.0, 1.0, 2.0, 2.0], [w, h]);
    rec.paths.push(match r {
        Some(r) => Entry::Rect { w, h, radii: [r; 4] },
        None => Entry::Ellipse { w, h },
    });
    rec.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid(FILL),
    });
    if children {
        // As the builder encodes a frame that clips its content: the clip round the children
        // comes before the stroke's own.
        rec.ops.push(Op::Clip {
            path: 0,
            even_odd: false,
        });
        rec.ops.push(Op::Children);
        rec.ops.push(Op::Unclip);
    }
    if let Some(ink) = ink {
        rec.ops.push(Op::Clip {
            path: 0,
            even_odd: false,
        });
        rec.ops.push(Op::Stroke {
            path: 0,
            width: weight * 2.0,
            join: 0,
            cap: 0,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Solid(ink),
        });
        rec.ops.push(Op::Unclip);
    }
    rec
}

fn render(recs: &[(u32, u32, Rec)], size: (u32, u32), zoom: f64, at: (f64, f64)) -> Vec<u8> {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    for (id, parent, r) in recs {
        w.set(*id, *parent, r);
    }
    e.apply(&w.finish()).expect("list");
    let camera = Camera {
        zoom,
        x: at.0,
        y: at.1,
        dpr: 1.0,
    };
    let (px, _) = e.render_cpu(size.0, size.1, camera, [0.0; 4], false).expect("frame");
    px.to_vec()
}

fn alpha(px: &[u8]) -> Vec<u8> {
    px.as_chunks::<4>().0.iter().map(|p| p[3]).collect()
}

#[test]
fn a_bordered_shape_covers_its_edge_once_where_the_band_is_wide() {
    // The shadcn Carousel button: a 28 unit circle with a 1 unit border, at 2x (a 2 px band).
    for (r, name, frame) in [
        (Some(9999.0), "circle", false),
        (Some(9999.0), "frame clipping its content", true),
        (Some(6.0), "rounded box", false),
        (None, "ellipse", false),
    ] {
        let plain = alpha(&render(
            &[(1, 0, shape(28.0, 28.0, r, 1.0, None, frame))],
            (64, 64),
            2.0,
            (0.0, 0.0),
        ));
        let bordered = alpha(&render(
            &[(1, 0, shape(28.0, 28.0, r, 1.0, Some(INK), frame))],
            (64, 64),
            2.0,
            (0.0, 0.0),
        ));
        let worst = plain
            .iter()
            .zip(&bordered)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        // Compounded, an edge pixel the shape covers 60/255 of came out 98.
        assert!(worst <= 1, "{name}: an edge pixel {worst} levels off the fill alone");
    }
}

#[test]
fn an_opaque_bordered_box_stays_opaque_however_thin_its_band() {
    // The review's case: a black box at integer and fractional spots, its border 0.25 to 3 device
    // pixels wide. Every pixel the box covers whole must stay opaque.
    for weight in [0.25f32, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0] {
        for (zoom, at) in [
            (1.0, (0.0, 0.0)),
            (1.0, (-0.3, -0.7)),
            (0.5, (-0.25, 0.0)),
            (2.0, (-0.6, -0.1)),
        ] {
            let black = [0.0, 0.0, 0.0, 1.0];
            let mut rec = shape(32.0, 28.0, Some(0.0), weight / zoom as f32, Some(black), false);
            rec.ops[0] = Op::Fill {
                path: 0,
                even_odd: false,
                paint: Paint::Solid(black),
            };
            let a = alpha(&render(&[(1, 0, rec)], (80, 72), zoom, at));
            // Device pixels wholly inside the box (the camera adds its offset): [2·zoom + at, 34·zoom + at).
            let (x0, x1) = (
                (2.0 * zoom + at.0).ceil() as usize,
                ((34.0 * zoom) + at.0).floor() as usize,
            );
            let (y0, y1) = (
                (2.0 * zoom + at.1).ceil() as usize,
                ((30.0 * zoom) + at.1).floor() as usize,
            );
            for y in y0..y1 {
                for x in x0..x1 {
                    let v = a[y * 80 + x];
                    assert_eq!(
                        v, 255,
                        "a {weight} px border at zoom {zoom}, offset {at:?}: pixel ({x}, {y}) is {v}"
                    );
                }
            }
        }
    }
}

#[test]
fn a_border_over_a_backdrop_reader_leaves_the_fill_whole() {
    // The review's case: a red frame with a 20 unit black border holding a child that blurs what's
    // behind it. Stopped under the band, the fill would leave the child's blur to sample through
    // to the page, a light halo some 16 pixels into the frame.
    let scene = |ink: [f32; 4]| {
        let mut frame = shape(100.0, 76.0, Some(0.0), 20.0, Some(ink), true);
        frame.ops[0] = Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
        };
        let mut child = Rec::new([1.0, 0.0, 0.0, 1.0, 10.0, 10.0], [80.0, 56.0]);
        child.paths.push(Entry::Rect {
            w: 80.0,
            h: 56.0,
            radii: [0.0; 4],
        });
        child.ops.push(Op::BackgroundBlur {
            paths: vec![0],
            even_odd: false,
            radius: 20.0,
        });
        child.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([1.0, 1.0, 1.0, 5.0 / 255.0]),
        });
        render(&[(1, 0, frame), (2, 1, child)], (112, 88), 1.0, (0.0, 0.0))
    };
    // A border a hair short of opaque never stops the fill: the opaque one must draw the same.
    let opaque = scene([0.0, 0.0, 0.0, 1.0]);
    let translucent = scene([0.0, 0.0, 0.0, 0.999]);
    let worst = opaque
        .iter()
        .zip(&translucent)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(worst <= 1, "the child's blur sees another backdrop: {worst} levels off");
}
