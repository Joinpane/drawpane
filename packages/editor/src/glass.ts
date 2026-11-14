/**
 * The glass effect (decision 0007): what's behind a layer, seen through it
 * as through a lens with a curved rim, lit along its edge.
 *
 * Drawn in device pixels, where the canvas has the backdrop:
 * 1. the backdrop under the layer (and a margin the bent rays reach into),
 *    blurred by the frost; and the layer's shape, as an anti-aliased mask;
 * 2. on the GPU, every pixel's nearest point on the shape's edge, by jump
 *    flooding from sub-pixel edge points the mask gives (half-float, so
 *    exact to a fraction of a pixel): its distance in, and the direction
 *    out;
 * 3. a fragment shader that turns the distance into a smooth rim (steep at
 *    the edge, flat a depth in), bends the backdrop along the rim's normal
 *    (colour by colour for dispersion, fanned out for splay), and lights
 *    it: a fine specular line on the edge facing the light, a softer one
 *    opposite, and a sheen across the lit side of the rim.
 * Without WebGL2 (or rendering to half floats) it falls back to the frost
 * and a rim highlight in 2D.
 */
import type { Glass } from "@drawpane/model";
import {
  type AnyCanvas,
  begin,
  bindQuad,
  type Ctx,
  draw,
  fits,
  type GlCanvas,
  linkQuad,
  scratch,
} from "./webgl";

/**
 * The constants that shape glass's look: what calibration against Figma's
 * renders fits (tools/glass-calibration). The defaults are the fitted
 * values; nothing in the editor changes them.
 */
export interface GlassTuning {
  /** At full refraction, how far the edge looks in, as a share of the rim's depth. */
  readonly bend: number;
  /** How fast the bend eases toward the flat middle: (1 − t)^profile. */
  readonly profile: number;
  /** At full dispersion, how far colours part, as a share of the bend. */
  readonly dispersion: number;
  /** Blur per unit of frost. */
  readonly frost: number;
  /** Degrees added to the light's angle, and whether it turns the other way (−1). */
  readonly angleOffset: number;
  readonly angleTurn: 1 | -1;
  /** The specular line on the lit edge: width (share of depth, at least `lineMin` px) and strength. */
  readonly lineWidth: number;
  readonly lineMin: number;
  readonly line: number;
  /** A broader glow inside the lit edge: width (share of depth, at least `glowMin` px) and strength. */
  readonly glowWidth: number;
  readonly glowMin: number;
  readonly glow: number;
  /** How tightly the light falls on edges facing it: cos^facing. */
  readonly facing: number;
  /** The edge opposite the light: its line and glow strength, and falloff power. */
  readonly backLine: number;
  readonly backGlow: number;
  readonly backFacing: number;
  /** A sheen across the whole rim, and shade on the side away from the light. */
  readonly sheen: number;
  readonly shade: number;
}

export const DEFAULT_GLASS_TUNING: GlassTuning = {
  bend: 0.45,
  profile: 3,
  dispersion: 0.25,
  frost: 1,
  angleOffset: 0,
  angleTurn: 1,
  lineWidth: 0.05,
  lineMin: 1.2,
  line: 1.1,
  glowWidth: 0.35,
  glowMin: 3,
  glow: 0.3,
  facing: 1.4,
  backLine: 0.55,
  backGlow: 0.1,
  backFacing: 2,
  sheen: 0.05,
  shade: 0.1,
};

let tuning: GlassTuning = DEFAULT_GLASS_TUNING;

/** The tuning glass draws with. */
export function glassTuning(): GlassTuning {
  return tuning;
}

/** Calibration only: draws glass with other constants (`null` restores the defaults). */
export function setGlassTuning(next: Partial<GlassTuning> | null): void {
  tuning = next ? { ...DEFAULT_GLASS_TUNING, ...next } : DEFAULT_GLASS_TUNING;
}

/** A glass effect in device pixels, as the shader takes it. */
export interface GlassParams {
  /**
   * How far the rim moves a sample at most (at the very edge), in px. At
   * most about a third of the depth, so the lens folds content back on
   * itself only in a sliver at the edge, as thick glass does.
   */
  readonly refraction: number;
  /** The rim's width, in px: where the glass curves before it's flat. */
  readonly depth: number;
  /** Red moves this much further than green, blue this much less (0–0.25). */
  readonly dispersion: number;
  /** The backdrop's blur, in px. */
  readonly frost: number;
  /** How much the bend also fans out from the centre (0–1). */
  readonly splay: number;
  /** Where the light comes from, as a unit vector on screen (y down). */
  readonly light: { readonly x: number; readonly y: number };
  /** The rim's highlight at most (0–1). */
  readonly intensity: number;
  /** Around the layer, how far the backdrop is read: as far as a ray bends, and the frost's reach. */
  readonly margin: number;
}

/**
 * A glass effect's values in device pixels at `scale` (device pixels per
 * unit). 0° is light from the top, turning clockwise: −45° is the top left.
 */
export function glassParams(
  glass: Glass,
  scale: number,
  tune: GlassTuning = glassTuning(),
): GlassParams {
  const depth = Math.max(0, glass.depth) * scale;
  // Full refraction bends a ray a share of the rim's width at its edge (never over less than a few pixels).
  const refraction = (glass.refraction / 100) * tune.bend * Math.max(depth, 4 * scale);
  // Colours part by a share of the bend: real glass fringes subtly.
  const dispersion = (glass.dispersion / 100) * tune.dispersion;
  const frost = Math.max(0, glass.frost) * scale * tune.frost;
  const splay = glass.splay / 100;
  const radians = ((glass.angle * tune.angleTurn + tune.angleOffset) * Math.PI) / 180;
  return {
    refraction,
    depth,
    dispersion,
    frost,
    splay,
    light: { x: Math.sin(radians), y: -Math.cos(radians) },
    intensity: glass.intensity / 100,
    margin: Math.ceil(refraction * (1 + dispersion) * (1 + splay) + frost * 3 + 2),
  };
}

/** The farthest step jump flooding starts from: past twice the rim, nothing changes. */
export function floodSteps(depth: number): number[] {
  let step = 1;
  while (step < Math.ceil(depth) + 2) step *= 2;
  step = Math.min(step, 2048);
  const steps: number[] = [];
  for (; step >= 1; step /= 2) steps.push(step);
  // One more at 1 settles the last pixels jump flooding can miss.
  steps.push(1);
  return steps;
}

// Every pass works in the framebuffer's pixels: `p` is gl_FragCoord.xy, y up.
// Canvases are uploaded top row first, so they're read with y flipped.

/** Seeds: each pixel on or outside the edge, the offset to the edge from it (in px, y up). */
const SEED = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D mask;
uniform vec2 size;
float alphaAt(vec2 p) { return texture(mask, vec2(p.x, size.y - p.y) / size).a; }
void main() {
  vec2 p = gl_FragCoord.xy;
  float a = alphaAt(p);
  // Wholly inside: no edge here (yet).
  if (a >= 0.999) { color = vec4(1e4, 1e4, 0.0, 0.0); return; }
  // Coverage rises inward: its gradient points in, and 0.5 coverage is the edge.
  vec2 g = vec2(alphaAt(p + vec2(1.0, 0.0)) - alphaAt(p - vec2(1.0, 0.0)),
                alphaAt(p + vec2(0.0, 1.0)) - alphaAt(p - vec2(0.0, 1.0)));
  vec2 inward = length(g) > 1e-4 ? normalize(g) : vec2(0.0);
  color = vec4(inward * (0.5 - a), 0.0, 0.0);
}`;

/** One jump-flooding step: the nearest edge point any neighbour `step` away knows of. */
const FLOOD = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D seeds;
uniform vec2 size;
uniform vec2 texSize;
uniform float step;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 best = vec2(1e4);
  float bestD = 1e12;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 q = p + vec2(float(i), float(j)) * step;
      if (q.x < 0.0 || q.y < 0.0 || q.x >= size.x || q.y >= size.y) continue;
      vec2 v = texture(seeds, q / texSize).xy;
      if (v.x > 9e3) continue;
      vec2 edge = q + v - p;
      float d = dot(edge, edge);
      if (d < bestD) { bestD = d; best = edge; }
    }
  color = vec4(best, 0.0, 0.0);
}`;

/** The glass itself, from the backdrop, the mask and each pixel's offset to the edge. */
const GLASS = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D backdrop;
uniform sampler2D mask;
uniform sampler2D seeds;
uniform vec2 size;
uniform vec2 texSize;
uniform vec2 origin;
uniform vec2 center;
uniform float depth;
uniform float refraction;
uniform float dispersion;
uniform float splay;
uniform vec2 light;
uniform float intensity;
// GlassTuning: (profile, lineWidth, lineMin, line), (glowWidth, glowMin, glow, facing),
// (backLine, backGlow, backFacing, sheen), (shade, -, -, -).
uniform vec4 tuneA;
uniform vec4 tuneB;
uniform vec4 tuneC;
uniform vec4 tuneD;

vec4 canvasAt(sampler2D t, vec2 p) { return texture(t, vec2(p.x, size.y - p.y) / size); }

void main() {
  vec2 p = gl_FragCoord.xy - origin;
  float a = canvasAt(mask, p).a;
  if (a <= 0.0) { color = vec4(0.0); return; }
  vec2 toEdge = texture(seeds, p / texSize).xy;
  bool far = toEdge.x > 9e3;
  float d = far ? 1e4 : length(toEdge);
  // Out, toward the nearest edge. Right at the edge that direction rests on
  // one pixel's estimate; the anti-aliased mask's own slope is smoother there.
  vec2 outward = d > 1e-3 ? toEdge / d : vec2(0.0);
  if (d < 2.0) {
    vec2 g = vec2(canvasAt(mask, p - vec2(1.0, 0.0)).a - canvasAt(mask, p + vec2(1.0, 0.0)).a,
                  canvasAt(mask, p - vec2(0.0, 1.0)).a - canvasAt(mask, p + vec2(0.0, 1.0)).a);
    if (length(g) > 1e-3) outward = normalize(mix(normalize(g), outward, d / 2.0));
  }
  float rimDepth = max(depth, 1.0);
  float t = clamp(d / rimDepth, 0.0, 1.0);
  // How far in the rim looks: most at the edge, easing (with its slope) to
  // nothing a depth in, so the lens meets the flat middle without a crease.
  float slope = pow(1.0 - t, tuneA.x);

  vec2 fromCenter = p - center;
  vec2 fan = length(fromCenter) > 1e-3 ? normalize(fromCenter) : vec2(0.0);
  // A convex rim looks in: each pixel there sees the backdrop from further inside.
  vec2 bend = (-outward + fan * splay) * slope * refraction;
  vec3 seen = vec3(
    canvasAt(backdrop, p + bend * (1.0 + dispersion)).r,
    canvasAt(backdrop, p + bend).g,
    canvasAt(backdrop, p + bend * (1.0 - dispersion)).b);
  // Light (given y down) as y up. A fine specular line along the edge facing
  // it, a softer one along the edge opposite (light inside the glass), and a
  // sheen across the lit side of the rim.
  vec2 l = vec2(light.x, -light.y);
  float facing = dot(outward, l);
  float line = exp(-d / max(tuneA.z, depth * tuneA.y));
  float glow = exp(-d / max(tuneB.y, depth * tuneB.x));
  float lit = pow(max(facing, 0.0), tuneB.w) * (tuneA.w * line + tuneB.z * glow)
            + pow(max(-facing, 0.0), tuneC.z) * (tuneC.x * line + tuneC.y * glow)
            + tuneC.w * slope;
  float shade = max(-facing, 0.0) * slope * tuneD.x;
  seen = mix(seen, vec3(1.0), clamp(intensity * lit, 0.0, 1.0)) * (1.0 - intensity * shade);
  color = vec4(seen * a, a);
}`;

type Program = {
  readonly program: WebGLProgram;
  readonly u: (name: string) => WebGLUniformLocation | null;
};

interface Gl extends GlCanvas {
  readonly seed: Program;
  readonly flood: Program;
  readonly glass: Program;
  readonly backdrop: WebGLTexture;
  readonly mask: WebGLTexture;
  /** Ping-pong offsets to the edge (RGBA16F), and the framebuffer that draws into them. */
  readonly offsets: [WebGLTexture, WebGLTexture];
  readonly framebuffer: WebGLFramebuffer;
  offsetSize: { w: number; h: number };
}

function texture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const t = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function program(gl: WebGL2RenderingContext, fragment: string, label: string): Program | null {
  const p = linkQuad(gl, fragment, label);
  if (!p) return null;
  const locations = new Map<string, WebGLUniformLocation | null>();
  return {
    program: p,
    u: (name) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(p, name));
      return locations.get(name) ?? null;
    },
  };
}

/** Draws glass effects; keeps its canvases and WebGL context between frames. */
export class GlassPainter {
  #gl: Gl | null | undefined;
  #backdrop: AnyCanvas | null = null;
  #shape: AnyCanvas | null = null;

  /** WebGL2 with half-float render targets, made on first use; null where there's none. */
  #webgl(): Gl | null {
    if (this.#gl !== undefined) return this.#gl;
    this.#gl = null;
    const canvas = scratch(null, 1, 1);
    const gl = canvas?.getContext("webgl2", { premultipliedAlpha: true, antialias: false }) as
      | WebGL2RenderingContext
      | null
      | undefined;
    if (!canvas || !gl) return null;
    // Rendering to half floats: the offsets need fractions of a pixel.
    if (
      !gl.getExtension("EXT_color_buffer_float") &&
      !gl.getExtension("EXT_color_buffer_half_float")
    )
      return null;
    const seed = program(gl, SEED, "glass seeds");
    const flood = program(gl, FLOOD, "glass flood");
    const glass = program(gl, GLASS, "glass");
    const framebuffer = gl.createFramebuffer();
    if (!seed || !flood || !glass || !framebuffer) return null;
    bindQuad(gl);
    this.#gl = {
      canvas,
      gl,
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
      seed,
      flood,
      glass,
      backdrop: texture(gl, gl.LINEAR),
      mask: texture(gl, gl.LINEAR),
      offsets: [texture(gl, gl.NEAREST), texture(gl, gl.NEAREST)],
      framebuffer,
      offsetSize: { w: 0, h: 0 },
    };
    return this.#gl;
  }

  /**
   * Draws `glass` for a layer whose `shape` is in the context's current
   * transform, over the box (0, 0, w, h). The context's opacity and
   * blending apply to the result.
   */
  paint(ctx: Ctx, shape: Path2D, w: number, h: number, glass: Glass, scale: number): void {
    const p = glassParams(glass, scale);
    const t = ctx.getTransform();
    // The layer's reach on the device, with the margin rays bend into, within the canvas.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [px, py] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      xs.push(t.a * px + t.c * py + t.e);
      ys.push(t.b * px + t.d * py + t.f);
    }
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - p.margin);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - p.margin);
    const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...xs)) + p.margin);
    const y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...ys)) + p.margin);
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 0 || rh <= 0 || rw * rh > 24_000_000) return;
    // The layer's centre, in the region's pixels with y up (as the shader works).
    const centre = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2 - x0,
      y: rh - ((Math.min(...ys) + Math.max(...ys)) / 2 - y0),
    };

    // The backdrop, frosted.
    this.#backdrop = scratch(this.#backdrop, rw, rh);
    const backdrop = this.#backdrop?.getContext("2d") as Ctx | null | undefined;
    if (!this.#backdrop || !backdrop) return;
    backdrop.setTransform(1, 0, 0, 1, 0, 0);
    backdrop.clearRect(0, 0, rw, rh);
    backdrop.filter = p.frost > 0 ? `blur(${p.frost}px)` : "none";
    backdrop.drawImage(ctx.canvas, x0, y0, rw, rh, 0, 0, rw, rh);
    backdrop.filter = "none";

    const gl = this.#webgl();
    if (!gl || !fits(gl, rw, rh)) {
      this.#fallback(ctx, shape, p, x0, y0, rw, rh);
      return;
    }

    // The shape, anti-aliased.
    this.#shape = scratch(this.#shape, rw, rh);
    const mask = this.#shape?.getContext("2d") as Ctx | null | undefined;
    if (!this.#shape || !mask) return;
    mask.setTransform(1, 0, 0, 1, 0, 0);
    mask.clearRect(0, 0, rw, rh);
    mask.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
    mask.fillStyle = "#fff";
    mask.fill(shape);

    if (!this.#draw(gl, p, rw, rh, centre)) {
      this.#fallback(ctx, shape, p, x0, y0, rw, rh);
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.drawImage(gl.canvas, 0, 0, rw, rh, x0, y0, rw, rh);
    ctx.restore();
  }

  /** The GPU passes: seeds, flooding, then the glass into the canvas. False if it couldn't. */
  #draw(g: Gl, p: GlassParams, rw: number, rh: number, centre: { x: number; y: number }): boolean {
    const { gl } = g;
    // Offsets: half floats, grown to fit.
    if (g.offsetSize.w < rw || g.offsetSize.h < rh) {
      const w = Math.max(rw, g.offsetSize.w);
      const h = Math.max(rh, g.offsetSize.h);
      for (const tex of g.offsets) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      }
      g.offsetSize = { w, h };
    }
    const texSize = [g.offsetSize.w, g.offsetSize.h] as const;
    const bind = (unit: number, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    bind(0, g.backdrop);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.#backdrop as AnyCanvas,
    );
    bind(1, g.mask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.#shape as AnyCanvas);

    // Seeds, then flooding, ping-ponging between the two offset textures.
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.framebuffer);
    gl.viewport(0, 0, rw, rh);
    let into = 0;
    const target = (i: number) => {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        g.offsets[i] as WebGLTexture,
        0,
      );
    };
    target(into);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
    gl.useProgram(g.seed.program);
    gl.uniform1i(g.seed.u("mask"), 1);
    gl.uniform2f(g.seed.u("size"), rw, rh);
    draw(g);
    gl.useProgram(g.flood.program);
    gl.uniform2f(g.flood.u("size"), rw, rh);
    gl.uniform2f(g.flood.u("texSize"), texSize[0], texSize[1]);
    gl.uniform1i(g.flood.u("seeds"), 2);
    for (const step of floodSteps(p.depth)) {
      bind(2, g.offsets[into] as WebGLTexture);
      into = 1 - into;
      target(into);
      gl.uniform1f(g.flood.u("step"), step);
      draw(g);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The glass, into the canvas's top left.
    if (!begin(g, rw, rh)) return false;
    const origin = gl.drawingBufferHeight - rh;
    const u = g.glass.u;
    gl.useProgram(g.glass.program);
    bind(2, g.offsets[into] as WebGLTexture);
    gl.uniform1i(u("backdrop"), 0);
    gl.uniform1i(u("mask"), 1);
    gl.uniform1i(u("seeds"), 2);
    gl.uniform2f(u("size"), rw, rh);
    gl.uniform2f(u("texSize"), texSize[0], texSize[1]);
    gl.uniform2f(u("origin"), 0, origin);
    gl.uniform2f(u("center"), centre.x, centre.y);
    gl.uniform1f(u("depth"), p.depth);
    gl.uniform1f(u("refraction"), p.refraction);
    gl.uniform1f(u("dispersion"), p.dispersion);
    gl.uniform1f(u("splay"), p.splay);
    gl.uniform2f(u("light"), p.light.x, p.light.y);
    gl.uniform1f(u("intensity"), p.intensity);
    const k = glassTuning();
    gl.uniform4f(u("tuneA"), k.profile, k.lineWidth, k.lineMin, k.line);
    gl.uniform4f(u("tuneB"), k.glowWidth, k.glowMin, k.glow, k.facing);
    gl.uniform4f(u("tuneC"), k.backLine, k.backGlow, k.backFacing, k.sheen);
    gl.uniform4f(u("tuneD"), k.shade, 0, 0, 0);
    draw(g);
    return true;
  }

  /** No WebGL2: the frosted backdrop inside the shape, and a highlight along the lit rim. */
  #fallback(
    ctx: Ctx,
    shape: Path2D,
    p: GlassParams,
    x0: number,
    y0: number,
    rw: number,
    rh: number,
  ) {
    const backdrop = this.#backdrop;
    if (!backdrop) return;
    ctx.save();
    ctx.clip(shape);
    const t = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backdrop, 0, 0, rw, rh, x0, y0, rw, rh);
    ctx.setTransform(t);
    if (p.intensity > 0 && p.depth > 0) {
      ctx.globalAlpha *= p.intensity * 0.6;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1, p.depth / Math.max(1e-6, Math.hypot(t.a, t.b)) / 2);
      ctx.stroke(shape);
    }
    ctx.restore();
  }
}
