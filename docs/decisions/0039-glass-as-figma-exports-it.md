# 0039. Glass and background blur as Figma exports them

- Status: accepted
- Date: 2026-11-18
- Deciders: Ziyang (lead maintainer)

## Context

On a large iOS UI kit (kit parity, decision 0030), glass was the largest cause of difference from Figma after missing fonts: 401 of 1,409 over 400 frames at af07ef0, per the triage's per-pixel attribution. The symptoms: glass drew darker than Figma's (a switch's knob 74 where Figma has 184; a Control Centre button 21 where Figma has 121), and a dark popover drew grey where Figma's export is black.

The glass shader was fitted to Figma setting by setting (decision 0007) over opaque grey and stripes. Rather than refit its constants against the kit, three new parity suites take apart what the kit's glass does differently, each built in Figma and exported as the goldens are:

- `glass-dark`: glass over black, near black, white and a black and white split, one setting at a time (light at several angles and strengths, refraction, dispersion, frost), and the settings Apple's round buttons use.
- `glass-alpha`: cells exported with no background, so the render's alpha shows what glass and background blur let through of an empty or half-empty backdrop: glass with and without a fill, over nothing, over half an opaque backdrop, over a faint one; Apple's switch knob and round button stacks and their parts; materials (background blur under a translucent fill) over nothing.
- `glass-context`: each cell exports a frame with nothing of its own over a grey cell with a white bar, holding blended fills and layers, background blur, glass and the same stacks: what an exported layer's drawing sees of what's under it.

And a few one-off probes in the parity file: a page with a grey background, a section, the button stack nested as the kit nests it (in a 10% black frame in a 10% black section), as a component, an instance and an instance in a component, and an exact rebuild of the kit's button with each of its parts left out in turn.

## What Figma does

1. **Over opaque backdrops Drawpane already matched**, black included (`glass-dark` 0.68 of 255 before any change). Glass doesn't brighten or tint anything by itself: the darkness wasn't in the shader's constants.
2. **Glass keeps its backdrop's alpha.** Over nothing it draws nothing at all, light included; over a half-clear backdrop the clear half stays clear and the light lies only on what's there; frost blurs the alpha's edge as it does colour. It replaces what's under its shape: over a faint backdrop (30%) without light, the glass is as faint as the backdrop beside it, not twice as opaque. A white layer multiplied over it then shows white through what's clear, which is why Apple's knob comes out light grey: its glass is over a translucent track.
3. **Background blur and blended paints and layers over nothing were already right**: a dark material (black 60% over a blur) over nothing stays 60% black, linear dodge and burn give the source (decision 0038).
4. **An exported layer's glass and background blur see what's under it on the page**: the frames and sections it sits in and what's drawn beneath it, but not the page's background (a glass on a frame straight on a grey page sees nothing there; one in a 10% black section sees 10% black). What's inside the layer under the glass is seen as it is on the page: a linear dodge fill inside the exported layer blends with what's under the layer for the glass's view, though the same fill, exported, draws over nothing. Everything else in the export draws over nothing. That's why the kit's dark popover is black: it sits on an opaque black "Dark examples" section, and its material's blur sees it. And why Apple's Control Centre buttons (a `#101010` linear dodge fill under a glass frame) are mid grey, 121, in Figma's export where a rebuild of the same layers on their own comes out 25: the boards they sit on lie over a grey rectangle (`#737373`), so for the glass the fill adds to grey (115, dimmed by the board's 10% black, plus 16 is 120).
5. **Settings.** The kit's glass isn't Figma's default glass: Apple's knob has no frost or light and a 7 px rim, its buttons frost 6, depth 30, light 40% from the top, splay 20%. A `.fig` record keeps them under its own names, checked against the plugin API on the kit's layers: frost is `radius`, depth `refractionRadius`, refraction `refractionIntensity`, the light `specularAngle` and `specularIntensity`, dispersion `chromaticAberration`, splay `reflectionDistance`. Glass from before Figma had refraction has none set and a rim under a pixel; the plugin API reports it the same way.

## Decision

1. **Glass is premultiplied end to end.** The backdrop goes to the GPU premultiplied; frost, mipmaps and the bend read colour and alpha together; the light and shade mix toward white and black only as far as the backdrop is opaque; the result keeps the backdrop's alpha.
2. **On a canvas that may be see-through, glass replaces what's under its shape**: the shape's coverage cut out of the canvas, then the glass added in (the canvas's `destination-out`, then `lighter`), both at the layer's opacity. The screen, filled with an opaque page background, draws as before, keeping pictures for pans; so does any canvas the renderer knows is opaque (decision 0038's list).
3. **Exports see what's under them.** `renderNodes` takes `context`: when the exported layers hold glass or background blur, the page is first drawn, without its background, up to and including them into a second canvas, keeping what each of their glass and background blur layers reads there; drawing the export itself, those layers read what was kept instead of the export's canvas. PNG and JPEG export, the export panel's preview and the kit parity harness use it. Exports without glass or background blur draw once, as before.
4. **The `.fig` importer brings glass's settings** by the record's names above; the REST importer still can't (its API leaves them out) and keeps the defaults and the note.
5. **SVG export** draws glass as a lit rim masked by the alpha of what's under the layer in its group. Over nothing there's no light, as on the canvas and in Figma. Headless PNG uses rule 3 through the CPU engine (decision 0040, phase 4).
6. **Background blur under text shows under its glyphs**, as in Figma, not across the text's box. It used to cover the box, unseen while an export's backdrop was empty; seeing what's under the layer made it a grey box behind the kit's lock screen widgets' text. Figma's layer is its fills over the blur, cut to the glyphs once, so under a fill that comes out the same whatever is under it (opaque and normal, or white added by linear dodge as Apple's vibrant text is, or black multiplied) none of the blur shows, not even at the glyphs' anti-aliased edges: there it's skipped (`glass-context`'s `blur-text`, `blur-text-dodge` and `blur-text-faint`).
7. **Parity suites** can export a cell with no background (`"background": "none"`, compared over white and over black so alpha counts) or a named layer of each cell (`"export"`), drawn as an export draws it.

## Consequences

- Numbers in the pull request (both kits, before and after on the same base).
- Documents drawn on screen look the same; exports of layers with glass or background blur over transparency or on dark boards change, toward Figma.
- An export holding glass or background blur draws what's beneath it on the page once more, bounded by the export's rect, and keeps a copy of each such layer's backdrop region. Panning is untouched.
- SVG export shows the glass rim within the exported layers.

## Revision: the export preview's cost (2026-11-19)

The inspector's export preview drew the selection with what's under it (point 3) a beat after every selection and every edit, on the main thread, with a renderer made afresh each time (a new WebGL context and shaders for glass). On a glass board of a large iOS UI kit that was a task of four to five seconds after each nudge or undo, and after selecting a component, during which the editor took no input.

- **One renderer for an editor's previews**, kept: glass's WebGL context, shaders and measured shapes serve every preview after the first.
- **What's under the export is drawn only where its glass and background blur read it**: around each of them, as far as it reads (what `#backdropFor` keeps), not the whole export rect. A layer touching none of that can't change what they see, so the export comes out the same.
- **The preview is drawn only while it's on screen** (the inspector often has it scrolled out of view), and when it comes into view.

A large selection full of glass still costs its export's drawing once it's in view (a couple of seconds on a machine without a GPU). Numbers in the pull request.

### Glass at high zoom in the editor

The canvas renderer sizes glass scratch to the visible lens and its optical reach.
When that crop exceeds its raster budget, it samples the same region at a lower
resolution. The lens center, edge distance and refraction stay tied to the
original geometry. The full-resolution outline clips the enlarged result.

The WebGL glass pass computes ray gradients before discarding transparent
pixels. A pixel at the lens edge can share a derivative quad with pixels
outside the outline. Their rays keep mip selection defined at the edge.
