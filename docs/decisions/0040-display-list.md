# The display list (decision 0040)

The wire format between TypeScript and the render engine, version 1.4. TypeScript writes it (`packages/engine/src/wire.ts`, built by `packages/editor/src/engine/display-list.ts`); the engine reads it (`packages/engine/rust/src/wire.rs`, `record.rs`, `store.rs`). The two must agree number for number.

## Messages

A message is one `ArrayBuffer` of little-endian words: integers `u32`, coordinates and colours `f32`, transforms `f64`. Every float must be finite, or the message is refused.

| Field | Type | |
| --- | --- | --- |
| magic | u32 | `"DPDL"` |
| major, minor | u16, u16 | 1, 4. The engine refuses another major, or a minor above its own. (1.1 added provisional; 1.2 added `layer` and `unlayer` ops 7 and 8; 1.3 reserved 3B reader ops 9..12; 1.4 added 3A effect ops 13+.) |
| base | u32 | The revision the message applies to, or `0xFFFFFFFF` for a fresh list (which must start with a reset). |
| revision | u32 | The revision it makes: `base + 1` for a patch; for a fresh list, any revision later than the one the engine holds. Never `0xFFFFFFFF`. |
| count | u32 | Commands that follow. |
| commands | | Each: opcode `u32`, body length in bytes `u32`, body. Each body is read from its own reader of exactly that length, so a command can't read (or allocate for) the bytes after it; a body of another length than it says is refused. A count inside a body is refused when its items couldn't fit in what's left (each item has a minimum size). |

**Revisions.** A patch must name the revision the engine holds and make the next one; anything else is refused (`ErrorCode.Revision`) and changes nothing: an old or replayed patch, one that skips a revision, one that makes its own base. A fresh list must move the revision forward, so a stale fresh list can't roll the page back. After a refusal the builder is told (`DisplayListBuilder.acknowledge`) and its next message is a fresh list for a revision past the engine's. An engine made afresh (after a lost device or a trap) holds revision 0.

**A message is one revision, applied whole.** The engine applies a patch's commands as it reads them, with an undo log: if any command fails (malformed, an unknown record, a cycle, a limit), everything the message changed is put back and the engine keeps its revision. A fresh list is built into a graph of its own beside the one it replaces, read once, and swapped in when it's all read and valid: a refused fresh list leaves the old graph, its pixels and its revision exactly as they were. While it's built both graphs count against the graph's budget (`graph_bytes`), so a Worker, whose engine starts empty for each render, never holds two. A frame is drawn between messages, never during one, so it never shows half a revision; an export pins its revision (see "Exports").

## Commands

| Opcode | Command | Body |
| --- | --- | --- |
| 1 | reset | none: every record and glyph goes (images stay; they're resources, not records) |
| 2 | glyph | `u32` glyph handle, path (in font units, y up). Refused for a handle a record uses: a glyph is immutable while referenced. |
| 3 | glyph free | `u32` glyph handle (refused while a record uses it). The builder frees a glyph at the end of the message that lets go of its last record. |
| 4 | set | `u32` record handle, `u32` parent handle, record. Inserts, or replaces in place. A new record goes last among its parent's children; a record set under another parent moves there, last. |
| 5 | remove | `u32` record handle: it and everything under it |
| 6 | order | `u32` parent, `u32` count, handles: the parent's children in paint order, exactly its current children |
| 7 | transform | `u32` record handle, `f64` × 6: only its transform changes (a drag) |

Handle 0 is the page, the root every top-level record hangs from. It can't be set or removed. Record handles are stable layer ids interned by the builder for the session and never reused, so a stale handle can't name another layer. A record can't be its own ancestor, and nesting is capped, counting the subtree a moved record brings with it.

Each glyph definition gets a serial no other definition has, in any engine, across resets and fresh lists (which start handles over), and the glyph caches key masks by it: a mask made for one outline is never found for another.

## A record

| Field | Type | |
| --- | --- | --- |
| flags | u32 | 1 hidden, 2 isolate (fades as one: an opacity group), 4 group (no paint of its own; its ops are only `children`), 8 provisional (sent ahead of its real drawing, as text not yet shaped while a page opens or while its face loads: drawn as its coarse ops at every scale, never exact, and sent again whole soon after; it counts its box, grown by its reach, wherever its coarse ops paint or don't, and an export is refused while any shown record is provisional), 16 reserved for 3B context, 32 post (minor 1.4: ordered `postEffects` list follows `coarse`), 64 blend (minor 1.4: layer blend mode `u32` `1..=17` follows `postEffects` or `coarse`), 128 mask (minor 1.4: mask kind `u32` `1..=5` follows `blend`), 256 ends mask (minor 1.4: visible clipping frame that closes a sibling mask scope) |
| opacity | f32 | Its own; inherited opacity multiplies down unless it isolates. |
| transform | f64 × 6 | Its units to its parent record's (`a b c d e f`), not to the page: moving a board is one command. |
| width, height | f32 × 2 | Its box, for the speck rule (layers under half a device pixel both ways are skipped on screen). |
| coarse below | f32 | Below this many device pixels per unit, its coarse ops are drawn instead (text too small to read, as bars). 0: never. Screen only; exports always draw the ops. |
| reach | f32 | How far it may paint past its box, in its units (strokes, effects, overhanging type). A record the engine refuses counts its box grown by this, so it's refused wherever it could show, never culled away. |
| unsupported | u32 | Features the builder found it needs that the engine doesn't draw yet (`UNSUPPORTED` in wire.ts). The engine derives additional flags while decoding, such as for backdrop readers outside the tests. A page holding a shown record with any unsupported features is refused whole, wherever the record is. |
| paths | u32 count, entries | Its shapes, referred to by index |
| ops | u32 count, ops | What it draws, in order |
| coarse | u32 count, ops | Drawn instead of `ops` below `coarse below` (no `children`) |
| post effects | u32 count, entries | Present only when `flags & 32` is set (minor 1.4). Applied in order to the record's finished picture: kind `1` = layer blur (`radius` `f32`, `sigma = 0.45 * radius * view_scale`, decision 0013 revision); kind `2` = noise (`noiseType` `u32` 0 mono / 1 duo / 2 multi, `size` `f32`, `density` `f32`, `color` RGBA `f32` × 4, `secondaryColor` RGBA `f32` × 4, `opacity` `f32` in `[0, 1]`); kind `3` = texture (`size` `f32` in [0.5, 50], `radius` `f32` in [0, 100], `clipToShape` `u32` 0 or 1). |
| blend | u32 | Present only when `flags & 64` is set (minor 1.4). Non-normal layer blend mode (`1..=17`, matching `BLEND` in `wire.ts`). |
| mask | u32 | Present only when `flags & 128` is set (minor 1.4). Mask kind (`1` outline shape NonZero, `2` outline shape EvenOdd, `3` outline picture, `4` alpha picture, `5` luminance picture, matching `MASK` in `wire.ts`). Kinds `1` and `2` clip siblings above them to `paths[0]`; kinds `3..=5` composite siblings above them against the mask's rendered picture (`mask.rs` / `mask.wgsl`). |

**Path entries:**

| Kind | | Body |
| --- | --- | --- |
| 1 | path | verb count `u32`, coordinate count `u32`, verbs a byte each padded to four (0 move, 1 line, 2 quad, 3 cubic, 4 close), coordinates `f32`. A segment before the first move is refused. |
| 2 | rect | w, h, radii (top left, top right, bottom right, bottom left), smoothing: generated by the engine via its port of `corner-geometry.ts` (`fit_corners`, `box_commands`), verified against all 455 Figma test vectors. |
| 3 | ellipse | w, h. Arcs are generated at the canvas's tolerance (a thousandth of a unit) up to a radius of 100,000 units, then at a hundred-millionth of the radius, so a curve is a few dozen cubics however large. |
| 4 | glyphs | scale `f32` (font units to its units; the engine flips y), count, then per glyph: handle `u32`, x `f32`, y `f32` (its origin on the baseline). Each glyph keeps its identity, for the glyph cache. |
| 5 | outside | `u32` an earlier entry: a box with that shape cut out (even-odd), what an outside stroke or a cut-out drop shadow (decision 0031) is clipped to. The engine makes the box where it draws: the viewport mapped into the record's units, and round the shape, so it's right at any size or position (not a fixed "huge" box). |
| 6 | box | x, y, w, h, radii (top left, top right, bottom right, bottom left), smoothing (minor 1.4): a positioned rounded box at `(x, y)` of size `w` x `h` (used for spread shadow shapes, preserving uniform corner radius metadata for analytic blurred rounded rectangles). |
| 7 | oval | x, y, w, h (minor 1.4): a positioned ellipse inscribed in `(x, y, w, h)` (used for spread ellipse shadows). |

**Ops:**

| Op | | Body |
| --- | --- | --- |
| 1 | fill | path, `u32` even-odd, paint |
| 2 | stroke | path, width, join (0 miter, 1 round, 2 bevel), cap (0 butt, 1 round, 2 square), miter limit (above 1,000 it is taken as 1,000), dash count and dashes, dash offset, paint. A dash pattern that would cut its path into more pieces than a frame may generate is refused (`Limit`): at decode for shapes whose length is known, when drawn for glyph runs. |
| 3 | clip | path, `u32` even-odd. A clip path, which doesn't isolate. |
| 4 | unclip | Clips and unclips balance within a list. |
| 5 | children | Its children are drawn here, inside the clips open at this point. At most once. |
| 6 | read | kernel `u32`, halo `f32` (its units): a backdrop reader over its box, reading its box grown by the halo. Refused outside the tests in phase 1 (glass and background blur arrive in phase 3); the render graph already orders and invalidates by it. |
| 7 | layer | compose `u32` (0 SrcOver isolated, 1 DestOut, 2 DestIn). Opens a compositing layer (balanced LIFO with `unlayer` and `clip`/`unclip`). Requires wire version 1.2 (`minor >= 2`); rejected with `ErrorCode.Version` in 1.0 and 1.1 messages. |
| 8 | unlayer | Closes the matching `layer`. Requires wire version 1.2 (`minor >= 2`). |
| 13 | drop shadow | path count `u32`, path indices `u32[]`, `u32` flags (bit 0: even-odd, bit 1: stroke cast), `dx` `f32`, `dy` `f32`, `blur` `f32` (Figma radius), RGBA `f32` × 4, blend `u32` (0..17; minor 1.4; 9..=12 reserved for 3B), plus stroke style (same fields as op 2) when bit 1 is set. Casts from all listed entries combined (stroked when bit 1 is set, for open stroke-only layers), offset in page space by `(dx, dy)` and blurred with Figma's calibrated Gaussian (`0.45 * blur`). Cut-out shadows (decision 0031) wrap the op in `clip(outside(shape), evenOdd: true)`. |
| 14 | inner shadow | `shape` `u32`, `hole` `u32` (`0xFFFFFFFF` when spread shrinks the hole to empty), `u32` even-odd, `dx` `f32`, `dy` `f32`, `blur` `f32`, RGBA `f32` × 4, blend `u32` (0..17; minor 1.4). Clips to `shape`, blurs the shifted `hole` with Figma's calibrated Gaussian (`0.45 * blur`), and tints the complement (`1 - alpha`). |

**Paints:** a kind `u32` and a blend mode `u32` (`0` normal, `1..=17` per `BLEND` in `wire.ts`: 11 W3C separable modes, 4 W3C non-separable HSL modes, `16` Figma linear-dodge, `17` Figma linear-burn).

| Kind | | Body |
| --- | --- | --- |
| 1 | solid | RGBA `f32`, straight, paint opacity folded in |
| 2, 3, 4 | linear, radial, angular | `f64` × 6 mapping the unit gradient into its units (linear along x from 0 to 1; radial and angular about the origin, radius 1; angular from 3 o'clock, clockwise, y down), stop count, then position and RGBA per stop. Stops are ordered by position as a `CanvasGradient` orders them (stably: stops at one position keep their order), whatever order they arrive in. Colours interpolate unpremultiplied, as the canvas does. |
| 5 | diamond | `f64` × 6 and stops as above; `t = clamp(|u| + |v|, 0, 1)` in unit gradient space, evaluated unpremultiplied on CPU and GPU (WebGPU & WebGL2). |
| 6 | image | image handle `u32`, `f64` × 6 mapping the image's unit square into its units (one tile, when tiled), `u32` flags (1 tile), opacity `f32` |
| 7 | placeholder | opacity `f32`: the loading checkerboard, fixed to device pixels, at the image paint's opacity (as the canvas draws it) |

Strokes' align, per-side widths, fitted dashes and end markers are resolved by the builder into these (inside: a clip to the shape around a double-width stroke; outside: a clip to `outside`; per side: an even-odd region filled), as the canvas renderer draws them.

## Images

Images aren't in messages. `putImage(handle, width, height, rgba)` uploads one (straight or premultiplied RGBA8); the engine keeps a chain of halved levels, the same pixels on both backends, and a draw samples the smallest level at least as wide as it shows. The builder writes an image paint only once the engine holds the image, and a placeholder until then.

## The render graph

The records are a tree in paint order: a record's ops, with its children drawn where its `children` op is. The engine derives what retained drawing needs:

- **Bounds,** per record in its own units: what its ops paint (each stroke grown by how far its outline can reach: half its width times its miter limit for mitered joins, √2 for square caps, plus a unit; glyph outlines' own bounds), its children's bounds kept to the clip they're drawn in, its box for a reader and, for a refused record, its box grown by its reach. Cached and dropped up the parent chain on change. Culling uses them.
- **Paint order:** a preorder index and subtree end per record, rebuilt only when the structure changes and only while readers exist.
- **Invalidation.** Applying a message answers where each touched record's subtree painted before and paints now (page units, with its place in paint order). `dirtyFor(camera)` turns that into device rectangles, grown by a pixel and a half for anti-aliasing, and adds, in paint order, every reader whose read region takes in a change beneath it (an earlier subtree, or an ancestor), with that reader's own box joining the dirty set for the readers above it. Places from before a structural change in the same message count as beneath every reader. The property tests hold every changed pixel to lie inside the answer.

## Limits

A message past a limit is refused whole, with the limit named (`ErrorCode.Limit`): records 4,000,000; path verbs 1,000,000; paths and ops per record 65,536; glyphs per run 65,536; dashes 64; gradient stops 64; message 512 MiB; glyph outlines 64 MiB; the graph 1 GiB (its records and outlines, roughly); nesting 512 records and 512 clips; a frame's or image's longest side 8,192 px; images 256 MiB; a reader's reach 512 px (summed through readers, for bands); bands of at most 256 rows and 2 MiB of output, in export tiles of 1,024 columns.

What the engine generates while drawing is held to limits too, so a legal document can't make a frame take unbounded time or memory before anything can fall back: a frame (or export tile) may generate 4,000,000 path elements (dashes, glyph runs expanded to outlines, shapes; glyphs off the viewport aren't expanded), and open 512 clips and layers at once. A transform that overflows on the device is refused. A refused frame is `Limit`; the editor draws that page with the canvas renderer.

Numbers that aren't finite are refused wherever they are, including a value that overflows an f32 when the builder writes it: TypeScript writes them as they are, never as zero.

The Worker build has smaller budgets (`WORKER_LIMITS` in `src/index.ts`), inside its module's 25 MiB memory maximum: messages 8 MiB, the graph 10 MiB, images 6 MiB, glyph outlines 4 MiB, and an export is admitted against the 25 MiB before it starts (see "Exports").

## Exports

An export renders in bands and tiles (`renderPng`, `renderPngStream`). Before its first byte it's refused, with a typed failure, when:
- the page holds a shown record the engine doesn't draw, anywhere on it (not only in the export's crop);
- the frame is larger than 8,192 px on a side;
- another export is streaming on the engine;
- its working set (a band, a tile with the readers' reach round it, the scene's rows, the compressor) wouldn't fit beside what the engine holds under its memory budget.

While it streams the engine is pinned: messages and image changes are refused (`ErrorCode.State`), so every band draws one revision. It ends when it's read to the end, fails (the stream errors with the engine's code) or is cancelled; each lets the engine take changes again.

## Versioning

The TypeScript and WebAssembly builds ship together; the version check catches a stale cache. A change that old readers would misread bumps the major. A new command or kind bumps the minor; an engine refuses lists newer than itself.
