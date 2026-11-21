//! Verification of corner smoothing against all 455 Figma-checked vectors in
//! `packages/editor/test/fixtures/corner-vectors.json`, plus end-to-end CPU tests for
//! diamond gradients and outside text strokes (phase 3C geometry items).

mod common;

use common::{ANY, Entry, Op, Paint, Rec, W};
use drawpane_engine::engine::{Camera, Engine};
use drawpane_engine::geometry::{BoxCommand, box_commands, fit_corners};
use drawpane_engine::limits::Limits;

/// Minimal zero-dependency JSON parser covering `corner-vectors.json`.
enum Json {
    Null,
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn as_f64(&self) -> f64 {
        match self {
            Json::Num(v) => *v,
            _ => panic!("expected number"),
        }
    }
    fn as_str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            _ => panic!("expected string"),
        }
    }
    fn as_arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            _ => panic!("expected array"),
        }
    }
    fn get(&self, key: &str) -> &Json {
        match self {
            Json::Obj(pairs) => &pairs.iter().find(|(k, _)| k == key).expect(key).1,
            _ => panic!("expected object"),
        }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && self.b[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn parse(&mut self) -> Json {
        self.ws();
        match self.b[self.i] {
            b'{' => {
                self.i += 1;
                let mut pairs = Vec::new();
                loop {
                    self.ws();
                    if self.b[self.i] == b'}' {
                        self.i += 1;
                        return Json::Obj(pairs);
                    }
                    let key = match self.parse() {
                        Json::Str(s) => s,
                        _ => panic!("object key"),
                    };
                    self.ws();
                    assert_eq!(self.b[self.i], b':');
                    self.i += 1;
                    let val = self.parse();
                    pairs.push((key, val));
                    self.ws();
                    if self.b[self.i] == b',' {
                        self.i += 1;
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                loop {
                    self.ws();
                    if self.b[self.i] == b']' {
                        self.i += 1;
                        return Json::Arr(items);
                    }
                    items.push(self.parse());
                    self.ws();
                    if self.b[self.i] == b',' {
                        self.i += 1;
                    }
                }
            }
            b'"' => {
                self.i += 1;
                let mut s = String::new();
                while self.b[self.i] != b'"' {
                    if self.b[self.i] == b'\\' {
                        self.i += 1;
                        match self.b[self.i] {
                            b'"' => s.push('"'),
                            b'\\' => s.push('\\'),
                            b'n' => s.push('\n'),
                            b't' => s.push('\t'),
                            c => s.push(c as char),
                        }
                    } else {
                        s.push(self.b[self.i] as char);
                    }
                    self.i += 1;
                }
                self.i += 1;
                Json::Str(s)
            }
            b'n' => {
                self.i += 4;
                Json::Null
            }
            b't' => {
                self.i += 4;
                Json::Num(1.0)
            }
            b'f' => {
                self.i += 5;
                Json::Num(0.0)
            }
            _ => {
                let start = self.i;
                while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'0'..=b'9' | b'e' | b'E')
                {
                    self.i += 1;
                }
                let txt = std::str::from_utf8(&self.b[start..self.i]).unwrap();
                Json::Num(txt.parse::<f64>().unwrap())
            }
        }
    }
}

#[test]
fn corner_geometry_matches_all_455_test_vectors_within_1e_6() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../editor/test/fixtures/corner-vectors.json"
    ))
    .expect("read corner-vectors.json");
    let root = Parser {
        b: raw.as_bytes(),
        i: 0,
    }
    .parse();
    let vectors = root.get("vectors").as_arr();
    assert!(
        vectors.len() >= 455,
        "expected at least 455 vectors, got {}",
        vectors.len()
    );
    let near = |a: f64, b: f64| (a - b).abs() <= 1e-6;
    for (idx, v) in vectors.iter().enumerate() {
        let w = v.get("w").as_f64();
        let h = v.get("h").as_f64();
        let r_arr = v.get("radii").as_arr();
        let radii = [
            r_arr[0].as_f64(),
            r_arr[1].as_f64(),
            r_arr[2].as_f64(),
            r_arr[3].as_f64(),
        ];
        let smoothing = v.get("smoothing").as_f64();
        let expected_corners = v.get("corners").as_arr();
        let got_corners = fit_corners(w, h, radii, smoothing);
        for i in 0..4 {
            let ec = expected_corners[i].as_arr();
            assert!(
                near(got_corners[i].radius, ec[0].as_f64())
                    && near(got_corners[i].smoothing, ec[1].as_f64())
                    && near(got_corners[i].extent, ec[2].as_f64()),
                "vector {idx} corner {i} mismatch: got {:?}, expected [{}, {}, {}]",
                got_corners[i],
                ec[0].as_f64(),
                ec[1].as_f64(),
                ec[2].as_f64()
            );
        }
        let expected_cmds = v.get("commands").as_arr();
        let got_cmds = box_commands(w, h, radii, smoothing);
        assert_eq!(
            got_cmds.len(),
            expected_cmds.len(),
            "vector {idx} command count mismatch"
        );
        for (ci, (gc, ec)) in got_cmds.iter().zip(expected_cmds.iter()).enumerate() {
            let ea = ec.as_arr();
            let op = ea[0].as_str();
            match (*gc, op) {
                (BoxCommand::Move(x, y), "M") | (BoxCommand::Line(x, y), "L") => {
                    assert!(
                        near(x, ea[1].as_f64()) && near(y, ea[2].as_f64()),
                        "vector {idx} cmd {ci} ({op}) mismatch"
                    );
                }
                (BoxCommand::Cubic(x1, y1, x2, y2, x3, y3), "C") => {
                    assert!(
                        near(x1, ea[1].as_f64())
                            && near(y1, ea[2].as_f64())
                            && near(x2, ea[3].as_f64())
                            && near(y2, ea[4].as_f64())
                            && near(x3, ea[5].as_f64())
                            && near(y3, ea[6].as_f64()),
                        "vector {idx} cmd {ci} (C) mismatch"
                    );
                }
                (BoxCommand::Close, "Z") => {}
                (g, e) => panic!("vector {idx} cmd {ci} op mismatch: {g:?} vs {e}"),
            }
        }
    }
}

#[test]
fn diamond_gradient_renders_in_fill_stroke_and_opacity_group() {
    let mut e = Engine::new(Limits::default());
    // 1. Opaque fill centred at (50, 50), radius 40 in unit gradient space.
    let mut fill_rec = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [100.0, 100.0]);
    fill_rec.paths = vec![Entry::Rect {
        w: 100.0,
        h: 100.0,
        radii: [0.0; 4],
    }];
    fill_rec.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Gradient {
            kind: 5,
            m: [40.0, 0.0, 0.0, 40.0, 50.0, 50.0],
            stops: vec![(0.0, [1.0, 0.0, 0.0, 1.0]), (1.0, [0.0, 0.0, 1.0, 1.0])],
        },
    }];
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &fill_rec);
    e.apply(&w.finish()).unwrap();
    let cam = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let (px, _) = e.render_cpu(100, 100, cam, [1.0, 1.0, 1.0, 1.0], false).unwrap();
    let at = |buf: &[u8], x: usize, y: usize| {
        let i = (y * 100 + x) * 4;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    };
    let c = at(px, 50, 50);
    assert!(c[0] > 245 && c[2] < 10, "centre {c:?}");
    let diag = at(px, 70, 70);
    assert!(diag[0] < 5 && diag[2] > 250, "diagonal {diag:?}");
    let axis = at(px, 70, 50);
    assert!(
        (110..=140).contains(&axis[0]) && (115..=145).contains(&axis[2]),
        "axis {axis:?}"
    );

    // 2. Translucent isolated opacity group (opacity 0.5) containing a diamond stroke over a dark
    // green backdrop: interior stays backdrop green, while the stroke blends 50% red/blue over green.
    let mut stroke_rec = Rec::new([1.0, 0.0, 0.0, 1.0, 10.0, 10.0], [80.0, 80.0]);
    stroke_rec.flags = 2; // FLAG_ISOLATE
    stroke_rec.opacity = 0.5;
    stroke_rec.paths = vec![Entry::Rect {
        w: 80.0,
        h: 80.0,
        radii: [0.0; 4],
    }];
    // Diamond centred on the top stroke midpoint (40, 0) with radius 40 -> red at top midpoint,
    // blue at corners (0, 0) and (80, 0).
    stroke_rec.ops = vec![Op::Stroke {
        path: 0,
        width: 12.0,
        join: 0,
        cap: 0,
        dashes: vec![],
        offset: 0.0,
        paint: Paint::Gradient {
            kind: 5,
            m: [40.0, 0.0, 0.0, 40.0, 40.0, 0.0],
            stops: vec![(0.0, [1.0, 0.0, 0.0, 1.0]), (1.0, [0.0, 0.0, 1.0, 1.0])],
        },
    }];
    let mut w2 = W::new(ANY, 2);
    w2.reset();
    w2.set(2, 0, &stroke_rec);
    e.apply(&w2.finish()).unwrap();
    let (px2, _) = e.render_cpu(100, 100, cam, [0.0, 0.8, 0.0, 1.0], false).unwrap();
    // Interior of stroked rect at (50, 50) is untouched backdrop green (0, 204, 0, 255).
    let interior = at(px2, 50, 50);
    assert!(
        interior[0] < 5 && (200..=208).contains(&interior[1]) && interior[2] < 5,
        "interior should stay backdrop green: {interior:?}"
    );
    // Top stroke midpoint (50, 10): 50% opaque red over green -> R ~ 128, G ~ 102, B ~ 0.
    let top_mid = at(px2, 50, 10);
    assert!(
        (115..=140).contains(&top_mid[0]) && (90..=115).contains(&top_mid[1]) && top_mid[2] < 15,
        "top stroke midpoint should blend 50% red over green: {top_mid:?}"
    );
    // Top-right stroke corner (90, 10): 50% opaque blue over green -> R ~ 0, G ~ 102, B ~ 128.
    let corner = at(px2, 90, 10);
    assert!(
        corner[0] < 15 && (90..=115).contains(&corner[1]) && (115..=140).contains(&corner[2]),
        "stroke corner should blend 50% blue over green: {corner:?}"
    );
}

#[test]
fn wire_version_and_layer_scope_validation() {
    let mut record = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [50.0, 50.0]);
    record.paths.push(Entry::Rect {
        w: 50.0,
        h: 50.0,
        radii: [0.0; 4],
    });
    let msg = |minor: u16, rec: &Rec| {
        let mut writer = W::new(ANY, 1);
        writer.reset();
        writer.set(1, 0, rec);
        let mut bytes = writer.finish();
        bytes[6..8].copy_from_slice(&minor.to_le_bytes());
        bytes
    };

    // Valid 1.0 and 1.1 messages without layer ops succeed.
    assert!(Engine::new(Limits::default()).apply(&msg(0, &record)).is_ok());
    assert!(Engine::new(Limits::default()).apply(&msg(1, &record)).is_ok());

    // 1.0 and 1.1 headers carrying 1.2-only layer/unlayer ops must be rejected with Version.
    record.ops = vec![Op::Layer { compose: 0 }, Op::Unlayer];
    for old_minor in [0u16, 1u16] {
        let old_header = Engine::new(Limits::default()).apply(&msg(old_minor, &record));
        assert!(
            matches!(old_header, Err(ref e) if e.code == drawpane_engine::error::ErrorCode::Version),
            "1.{old_minor} must reject 1.2-only ops: {old_header:?}"
        );
    }

    // Both the original 1.2 and current headers accept balanced layer ops.
    let current = drawpane_engine::wire::MINOR;
    for supported_minor in [2, current] {
        assert!(
            Engine::new(Limits::default())
                .apply(&msg(supported_minor, &record))
                .is_ok()
        );
    }
    let newer_header = Engine::new(Limits::default()).apply(&msg(current + 1, &record));
    assert!(matches!(newer_header, Err(e) if e.code == drawpane_engine::error::ErrorCode::Version));

    // Crossed clip/layer, unclosed layer, and excess scope depth are rejected.
    let tight = Limits {
        depth: 3,
        open_scopes: 3,
        ..Limits::default()
    };
    record.ops = vec![
        Op::Clip {
            path: 0,
            even_odd: false,
        },
        Op::Layer { compose: 0 },
        Op::Unclip,
        Op::Unlayer,
    ];
    assert!(Engine::new(tight).apply(&msg(2, &record)).is_err());

    record.ops = vec![Op::Layer { compose: 0 }];
    assert!(Engine::new(tight).apply(&msg(2, &record)).is_err());

    record.ops = vec![
        Op::Layer { compose: 0 },
        Op::Layer { compose: 0 },
        Op::Layer { compose: 0 },
        Op::Layer { compose: 0 },
        Op::Unlayer,
        Op::Unlayer,
        Op::Unlayer,
        Op::Unlayer,
    ];
    assert!(Engine::new(tight).apply(&msg(2, &record)).is_err());
}

#[test]
fn diamond_export_and_cpu_render_track_temporary_paint_memory() {
    let mut engine = Engine::new(Limits {
        memory_bytes: 8 * 1024 * 1024,
        ..Limits::default()
    });
    let mut record = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [1024.0, 256.0]);
    record.paths.push(Entry::Rect {
        w: 1024.0,
        h: 256.0,
        radii: [0.0; 4],
    });
    for i in 0..10 {
        record.ops.push(Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Gradient {
                kind: 5,
                m: [512.0, 0.0, 0.0, 128.0, 512.0, 128.0],
                stops: vec![(0.0, [i as f32 / 10.0, 0.0, 0.0, 0.5]), (1.0, [0.0, 0.0, 1.0, 0.5])],
            },
        });
    }
    let mut writer = W::new(ANY, 1);
    writer.reset();
    writer.set(1, 0, &record);
    engine.apply(&writer.finish()).unwrap();
    let camera = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let admission = engine.admit_export(1024, 256, camera);
    assert!(
        matches!(admission, Err(ref e) if e.code == drawpane_engine::error::ErrorCode::Limit),
        "expected Limit for 10x 1 MiB diamond rasters under 8 MiB budget: {admission:?}"
    );
    let err = engine
        .render_band(1024, 256, camera, [1.0; 4], 0, 256)
        .expect_err("one 256-row band must refuse ten full-sized diamond rasters within 8 MiB");
    assert_eq!(err.code, drawpane_engine::error::ErrorCode::Limit);
}

#[test]
fn corner_wire_path_handles_f32_quantization_and_subpixel_transform() {
    // The 455-vector f64 harness checks fit_corners/box_commands to 1e-6 before wire f32 encoding.
    // On the wire path, f32 coordinates widen to f64 (e.g. 1000.00004 -> 1000.0000610351563),
    // staying well within sub-pixel bounds (< 1e-3 px) and rendering cleanly under fractional transforms.
    let width = 1000.00004f64;
    let height = 1000.0f64;
    let radii = [100.0f64; 4];
    let smoothing = 0.6f64;
    let reference = box_commands(width, height, radii, smoothing);
    let production =
        drawpane_engine::geometry::rounded_rect(width as f32, height as f32, radii.map(|r| r as f32), smoothing as f32);
    let expected = reference
        .iter()
        .filter_map(|c| match c {
            BoxCommand::Line(x, _) => Some(*x),
            _ => None,
        })
        .fold(0.0, f64::max);
    let actual = production
        .elements()
        .iter()
        .filter_map(|c| match c {
            vello_common::kurbo::PathEl::LineTo(p) => Some(p.x),
            _ => None,
        })
        .fold(0.0, f64::max);
    assert!(
        (actual - expected).abs() < 1e-3,
        "wire f32 quantization drifted too far: expected {expected}, wire path {actual}"
    );

    // Exercise the actual wire path with fractional dimensions, per-corner radii, smoothing, and rotation.
    let mut e = Engine::new(Limits::default());
    let mut rec = Rec::new([0.9659, 0.2588, -0.2588, 0.9659, 20.35, 10.75], [60.5, 44.25]);
    rec.smoothing = 0.6;
    rec.paths.push(Entry::Rect {
        w: 60.5,
        h: 44.25,
        radii: [12.5, 4.25, 18.75, 0.0],
    });
    rec.ops.push(Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.1, 0.3, 0.9, 1.0]),
    });
    let mut w = W::new(ANY, 1);
    w.reset();
    w.set(1, 0, &rec);
    e.apply(&w.finish()).unwrap();
    let cam = Camera {
        zoom: 1.5,
        x: 0.25,
        y: 0.5,
        dpr: 1.0,
    };
    let (px, stats) = e.render_cpu(128, 128, cam, [1.0, 1.0, 1.0, 1.0], false).unwrap();
    assert_eq!(stats.draw.records, 1);
    assert!(
        px.as_chunks::<4>().0.iter().any(|p| p[2] > 200 && p[0] < 60),
        "transformed subpixel smoothed rect should render blue pixels"
    );
}

#[test]
fn outside_text_stroke_leaves_background_and_interior_clean() {
    let mut e = Engine::new(Limits::default());
    // A 1000x1000 font-unit square glyph (scaled 0.04 -> 40x40 px at (20, 60) baseline -> y in [20, 60]).
    // Build a self-overlapping glyph (two overlapping squares) to verify nonzero fill cutout!
    let glyph_path = vec![
        (0u8, vec![0.0, 0.0]),
        (1, vec![700.0, 0.0]),
        (1, vec![700.0, 1000.0]),
        (1, vec![0.0, 1000.0]),
        (4, vec![]),
        (0, vec![300.0, 0.0]),
        (1, vec![1000.0, 0.0]),
        (1, vec![1000.0, 1000.0]),
        (1, vec![300.0, 1000.0]),
        (4, vec![]),
    ];

    // Background green rect covering the whole 100x100 frame.
    let mut bg = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [100.0, 100.0]);
    bg.paths = vec![Entry::Rect {
        w: 100.0,
        h: 100.0,
        radii: [0.0; 4],
    }];
    bg.ops = vec![Op::Fill {
        path: 0,
        even_odd: false,
        paint: Paint::Solid([0.0, 1.0, 0.0, 1.0]),
    }];

    // Hollow text (no fill, only 6 px red outside stroke -> double-width 12 px stroke cut out by nonzero glyph fill).
    let mut text = Rec::new([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [100.0, 100.0]);
    text.paths = vec![Entry::Glyphs {
        scale: 0.04,
        glyphs: vec![(1, 30.0, 70.0)],
    }];
    text.ops = vec![
        Op::Layer { compose: 0 }, // SrcOver isolated
        Op::Stroke {
            path: 0,
            width: 12.0,
            join: 0,
            cap: 0,
            dashes: vec![],
            offset: 0.0,
            paint: Paint::Solid([1.0, 0.0, 0.0, 1.0]),
        },
        Op::Layer { compose: 1 }, // DestOut
        Op::Fill {
            path: 0,
            even_odd: false,
            paint: Paint::Solid([0.0, 0.0, 0.0, 1.0]),
        },
        Op::Unlayer,
        Op::Unlayer,
    ];

    let mut w = W::new(ANY, 1);
    w.reset();
    w.glyph(1, &glyph_path);
    w.set(1, 0, &bg);
    w.set(2, 0, &text);
    e.apply(&w.finish()).unwrap();

    let cam = Camera {
        zoom: 1.0,
        x: 0.0,
        y: 0.0,
        dpr: 1.0,
    };
    let (px, _) = e.render_cpu(100, 100, cam, [1.0, 1.0, 1.0, 1.0], false).unwrap();
    let at = |x: usize, y: usize| {
        let i = (y * 100 + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    };
    // Far outside glyph (5, 5): background green untouched!
    assert_eq!(at(5, 5), [0, 255, 0, 255]);
    // 3 px outside the left edge (x = 27, y = 50): red outside stroke!
    assert_eq!(at(27, 50), [255, 0, 0, 255]);
    // 2 px INSIDE the left edge (x = 32, y = 50): stroke cleanly cut out -> green background shows through!
    assert_eq!(at(32, 50), [0, 255, 0, 255]);
    // Inside the self-overlapping region (x = 50, y = 50): nonzero fill cut out -> green background, NOT red!
    assert_eq!(at(50, 50), [0, 255, 0, 255]);
    // Also check at 50% opacity: outside stroke blends 50% red over green, interior stays 100% green!
    text.opacity = 0.5;
    let mut w2 = W::new(1, 2);
    w2.set(2, 0, &text);
    e.apply(&w2.finish()).unwrap();
    let (px2, _) = e.render_cpu(100, 100, cam, [1.0, 1.0, 1.0, 1.0], false).unwrap();
    let at2 = |x: usize, y: usize| {
        let i = (y * 100 + x) * 4;
        [px2[i], px2[i + 1], px2[i + 2], px2[i + 3]]
    };
    let edge = at2(27, 50);
    assert!(
        (124..=132).contains(&edge[0]) && (124..=132).contains(&edge[1]),
        "half-opacity stroke {edge:?}"
    );
    assert_eq!(
        at2(32, 50),
        [0, 255, 0, 255],
        "interior must stay completely cut out at 50% opacity"
    );
}
