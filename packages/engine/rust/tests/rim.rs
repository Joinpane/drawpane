//! A fill under an opaque inside stroke stops halfway into the stroke's band (`exec::rim_inset`),
//! so the shape's anti-aliased edge is the stroke's alone, as Figma draws it, not a fill and a
//! stroke compounded (2c - c²). Only where that can't show: a band two device pixels wide or more
//! (thinner, the fill's edge would fall where the stroke covers a pixel in part, and an opaque
//! shape would turn see-through there), and nothing in the record's subtree reading or blending
//! with what lies under the band.

mod common;

use common::{ANY, Entry, Op, Paint, Post, Rec, W};
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

/// The re-check's box: 44 x 39 at (12.35, 16.3), radius `radius`, filled a light yellow (not
/// white, which a multiply blend would leave out), with a 5 unit inside border in black at `ink`
/// alpha.
fn bordered(radius: f32, ink: f32) -> Rec {
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, 12.35, 16.3], [44.0, 39.0]);
    r.paths.push(Entry::Rect {
        w: 44.0,
        h: 39.0,
        radii: [radius; 4],
    });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.95, 0.85, 0.3, 1.0]),
    });
    r.ops.push(Op::Clip {
        path: 0,
        even_odd: false,
    });
    r.ops.push(Op::Stroke {
        path: 0,
        width: 10.0,
        join: 0,
        cap: 0,
        dashes: vec![],
        offset: 0.0,
        paint: Paint::Solid([0.0, 0.0, 0.0, ink]),
    });
    r.ops.push(Op::Unclip);
    r
}

/// A filled `w` x `h` box at (`x`, `y`).
fn square(x: f64, y: f64, w: f32, h: f32, color: [f32; 4]) -> Rec {
    let mut r = Rec::new([1.0, 0.0, 0.0, 1.0, x, y], [w, h]);
    r.paths.push(Entry::Rect { w, h, radii: [0.0; 4] });
    r.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid(color),
    });
    r
}

/// An 82 x 82 CPU frame at 1x of `recs` (id, parent), each parent's children in list order.
fn scene(recs: &[(u32, u32, Rec)]) -> Vec<u8> {
    let mut e = Engine::new(Limits::default());
    let mut w = W::new(ANY, 1);
    w.reset();
    for (id, parent, r) in recs {
        w.set(*id, *parent, r);
    }
    let mut parents: Vec<u32> = recs.iter().map(|(_, p, _)| *p).collect();
    parents.dedup();
    for p in parents {
        let ids: Vec<u32> = recs.iter().filter(|(_, q, _)| *q == p).map(|(id, _, _)| *id).collect();
        w.order(p, &ids);
    }
    e.apply(&w.finish()).expect("list");
    let camera = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let (px, _) = e.render_cpu(82, 82, camera, [0.0; 4], false).expect("frame");
    px.to_vec()
}

fn worst(a: &[u8], b: &[u8]) -> u8 {
    a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0)
}

#[test]
fn a_shape_drawn_into_a_picture_mask_keeps_its_whole_fill() {
    // The re-check's cases: the bordered box in a group that is the mask picture, masking a red
    // square, and the box as the content a mask shows. A mask reads the coverage of whatever is
    // drawn into it, so the fill stays whole on both sides, as main draws it: the opaque border
    // draws as one a hair short of opaque, which never stops the fill. Stopped, an edge pixel of
    // the masked square went from alpha 70 to 38.
    use drawpane_engine::record::{MASK_ALPHA, MASK_LUMINANCE, MASK_OUTLINE_PICTURE};
    for kind in [MASK_ALPHA, MASK_LUMINANCE, MASK_OUTLINE_PICTURE] {
        let picture = |ink: f32| -> Vec<(u32, u32, Rec)> {
            let mut mask = Rec::group();
            mask.mask = kind;
            vec![
                (1, 0, mask),
                (4, 1, Rec::group()),
                (2, 4, bordered(8.0, ink)),
                (3, 0, square(0.0, 0.0, 80.0, 80.0, [1.0, 0.0, 0.0, 1.0])),
            ]
        };
        let content = |ink: f32| -> Vec<(u32, u32, Rec)> {
            let mut mask = square(2.0, 2.0, 76.0, 76.0, [1.0; 4]);
            mask.mask = kind;
            vec![(1, 0, mask), (4, 0, Rec::group()), (2, 4, bordered(8.0, ink))]
        };
        for (side, make) in [
            ("the mask picture", &picture as &dyn Fn(f32) -> Vec<(u32, u32, Rec)>),
            ("the masked content", &content),
        ] {
            let d = worst(&scene(&make(1.0)), &scene(&make(0.999)));
            assert!(d <= 1, "a bordered box in {side} (mask kind {kind}): {d} levels off");
        }
    }
}

#[test]
fn scopes_that_composite_a_shape_whole_keep_its_inset_to_the_edge() {
    // Above the record, an isolated fading group, a multiply layer blend, a layer blur, a frame
    // clipping its content and an outline mask each take the fill and the stroke into one target
    // at the device's scale: the fill still stops under the band there (the opaque border draws
    // unlike one a hair short of opaque, at the box's edge), and nowhere the box covers whole,
    // its band included, does that show. A blur spreads the edge's change by its reach.
    use drawpane_engine::record::{FLAG_ISOLATE, MASK_OUTLINE_NONZERO};
    let backdrop = || square(0.0, 0.0, 82.0, 82.0, [0.2, 0.5, 0.8, 1.0]);
    let in_group = |g: Rec, ink: f32| vec![(9, 0, backdrop()), (1, 0, g), (2, 1, bordered(0.0, ink))];
    let isolated = |ink: f32| {
        let mut g = Rec::group();
        g.flags |= FLAG_ISOLATE;
        g.opacity = 0.6;
        in_group(g, ink)
    };
    let blended = |ink: f32| {
        let mut g = Rec::group();
        g.layer_blend = 1;
        in_group(g, ink)
    };
    let blurred = |ink: f32| {
        let mut g = Rec::group();
        g.post.push(Post::LayerBlur(2.0));
        in_group(g, ink)
    };
    let clipped = |ink: f32| {
        let mut f = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [80.0, 80.0]);
        f.paths.push(Entry::Rect {
            w: 80.0,
            h: 80.0,
            radii: [0.0; 4],
        });
        f.ops = vec![
            Op::Clip {
                path: 0,
                even_odd: false,
            },
            Op::Children,
            Op::Unclip,
        ];
        in_group(f, ink)
    };
    let outlined = |ink: f32| -> Vec<(u32, u32, Rec)> {
        let mut mask = square(2.0, 2.0, 76.0, 76.0, [1.0; 4]);
        mask.mask = MASK_OUTLINE_NONZERO;
        vec![(9, 0, backdrop()), (1, 0, mask), (2, 0, bordered(0.0, ink))]
    };
    type Make<'a> = &'a dyn Fn(f32) -> Vec<(u32, u32, Rec)>;
    let scopes: [(&str, Make, f64); 5] = [
        ("an isolated fading group", &isolated, 0.0),
        ("a multiply layer blend", &blended, 0.0),
        ("a layer blur", &blurred, 8.0),
        ("a frame clipping its content", &clipped, 0.0),
        ("an outline mask", &outlined, 0.0),
    ];
    for (name, make, reach) in scopes {
        let (a, b) = (scene(&make(1.0)), scene(&make(0.999)));
        assert!(worst(&a, &b) > 1, "{name}: the fill no longer stops under the band");
        // Pixels at least a pixel (and the blur's reach) inside the box's edge, band included.
        let (x0, x1) = (
            (12.35 + 1.0 + reach).ceil() as usize,
            (56.35 - 1.0 - reach).floor() as usize,
        );
        let (y0, y1) = (
            (16.3 + 1.0 + reach).ceil() as usize,
            (55.3 - 1.0 - reach).floor() as usize,
        );
        for y in y0..y1 {
            for x in x0..x1 {
                let i = (y * 82 + x) * 4;
                let d = worst(&a[i..i + 4], &b[i..i + 4]);
                assert!(
                    d <= 1,
                    "{name}: pixel ({x}, {y}), which the box covers whole, is {d} levels off"
                );
            }
        }
    }
}
