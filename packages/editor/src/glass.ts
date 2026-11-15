/**
 * The glass effect (decision 0007): what's behind a layer, seen through it
 * as through a lens with a curved rim, lit along its edge.
 *
 * Drawn in device pixels, where the canvas has the backdrop:
 * 1. the backdrop under the layer (and a margin the bent rays reach into),
 *    blurred by the frost; and the layer's shape, as an anti-aliased mask;
 * 2. on the GPU, the rim's height: the shape blurred by a Gaussian as wide
 *    as the rim is deep, at a resolution the blur can spare, with its slope
 *    taken by derivative-of-Gaussian kernels in the same passes. The slope
 *    is smooth everywhere and for any shape: inner contours round off, rims
 *    from opposite sides fade into each other, and nothing creases;
 * 3. a fragment shader that bends the backdrop down the slope (colour by
 *    colour for dispersion, fanned out for splay), reading it through
 *    mipmaps so compressed content doesn't shimmer, and lights the edge
 *    facing the light, and more softly the one opposite: a fine line,
 *    placed by the distance in that the rim's height gives (for a blurred
 *    edge, the height is a Gaussian's cumulative distribution of it).
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
  /** The rim's height is the shape blurred by a Gaussian this share of the depth wide. */
  readonly rimSigma: number;
  /** How the bend follows the rim's slope: slope^profile, the slope 1 at a straight edge. */
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

/**
 * Fitted to Figma's glass (tools/glass-calibration): mean difference 3.0 of
 * 255 over 22 cells, all but the deepest rim within 4.5.
 */
export const DEFAULT_GLASS_TUNING: GlassTuning = {
  bend: 0.86,
  rimSigma: 0.275,
  profile: 1.6,
  dispersion: 0.2,
  frost: 0.45,
  angleOffset: -4.9,
  angleTurn: 1,
  lineWidth: 0.005,
  lineMin: 0.8,
  line: 2.02,
  glowWidth: 0.25,
  glowMin: 2.55,
  glow: 0,
  facing: 1.58,
  backLine: 1.23,
  backGlow: 0.2,
  backFacing: 1.12,
  sheen: 0,
  shade: 0,
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
  /** The Gaussian that makes the rim's height from the shape, in px. */
  readonly sigma: number;
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
  // Full refraction bends a ray a share of the rim's depth at its edge (never over less
  // than a few pixels). A rim deeper than the shape is wide fades into the one opposite.
  const refraction = (glass.refraction / 100) * tune.bend * Math.max(depth, 4 * scale);
  // Colours part by a share of the bend: real glass fringes subtly.
  const dispersion = (glass.dispersion / 100) * tune.dispersion;
  const frost = Math.max(0, glass.frost) * scale * tune.frost;
  const splay = glass.splay / 100;
  const radians = ((glass.angle * tune.angleTurn + tune.angleOffset) * Math.PI) / 180;
  return {
    refraction,
    depth,
    sigma: Math.max(0.5, Math.max(depth, 4 * scale) * tune.rimSigma),
    dispersion,
    frost,
    splay,
    light: { x: Math.sin(radians), y: -Math.cos(radians) },
    intensity: glass.intensity / 100,
    margin: Math.ceil(refraction * (1 + dispersion) * (1 + splay) + frost * 3 + 2),
  };
}

/**
 * The mask averaged over `k` × `k` pixels: what the rim's blur starts from,
 * at a resolution it can spare. With `k` even, each tap sits between four
 * pixels, so the texture's filtering averages them: a quarter of the reads.
 */
const DOWN = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D mask;
uniform vec2 size;
uniform int k;
float alphaAt(vec2 p) { return texture(mask, vec2(p.x, size.y - p.y) / size).a; }
void main() {
  vec2 base = floor(gl_FragCoord.xy) * float(k);
  float sum = 0.0;
  float n = 0.0;
  if (k % 2 == 0) {
    // Even: taps between pixels, each one the average of four.
    for (int j = 0; j < 4; j++) {
      if (j >= k / 2) break;
      for (int i = 0; i < 4; i++) {
        if (i >= k / 2) break;
        sum += alphaAt(base + vec2(float(i), float(j)) * 2.0 + 1.0);
        n += 1.0;
      }
    }
  } else {
    // Odd: pixel by pixel, so nothing is read from the next cell.
    for (int j = 0; j < 7; j++) {
      if (j >= k) break;
      for (int i = 0; i < 7; i++) {
        if (i >= k) break;
        sum += alphaAt(base + vec2(float(i), float(j)) + 0.5);
        n += 1.0;
      }
    }
  }
  color = vec4(sum / n, 0.0, 0.0, 0.0);
}`;

/**
 * The rim's blur across: the Gaussian of the (downsampled) mask, and its
 * derivative across, as red and green.
 */
const BLUR_X = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D src;
uniform vec2 texSize;
uniform float sigma;
uniform int radius;
void main() {
  vec2 p = gl_FragCoord.xy;
  float h = 0.0, dx = 0.0, total = 0.0;
  float inv = 1.0 / (2.0 * sigma * sigma);
  for (int i = -64; i <= 64; i++) {
    if (i < -radius || i > radius) continue;
    float x = float(i);
    float w = exp(-x * x * inv);
    float m = texture(src, (p + vec2(x, 0.0)) / texSize).r;
    h += w * m;
    dx += w * m * x / (sigma * sigma);
    total += w;
  }
  color = vec4(h / total, dx / total, 0.0, 0.0);
}`;

/**
 * Then down: the rim's height (red), and its slope across (green) and up
 * (blue), each per low-resolution pixel.
 */
const BLUR_Y = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D src;
uniform vec2 texSize;
uniform float sigma;
uniform int radius;
void main() {
  vec2 p = gl_FragCoord.xy;
  float h = 0.0, dx = 0.0, dy = 0.0, total = 0.0;
  float inv = 1.0 / (2.0 * sigma * sigma);
  for (int i = -64; i <= 64; i++) {
    if (i < -radius || i > radius) continue;
    float y = float(i);
    float w = exp(-y * y * inv);
    vec2 v = texture(src, (p + vec2(0.0, y)) / texSize).rg;
    h += w * v.r;
    dx += w * v.g;
    dy += w * v.r * y / (sigma * sigma);
    total += w;
  }
  color = vec4(h / total, dx / total, dy / total, 0.0);
}`;

/** The glass itself, from the backdrop, the mask, the rim's height and the distance to the edge. */
const GLASS = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D backdrop;
uniform sampler2D mask;
uniform sampler2D height;
uniform vec2 size;
uniform vec2 heightTexSize;
uniform float k;
uniform float sigma;
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

// The inverse error function (Giles' single-precision approximation).
float erfinv(float x) {
  float w = -log((1.0 - x) * (1.0 + x));
  float q;
  if (w < 5.0) {
    w -= 2.5;
    q = 2.81022636e-08;
    q = 3.43273939e-07 + q * w;
    q = -3.5233877e-06 + q * w;
    q = -4.39150654e-06 + q * w;
    q = 0.00021858087 + q * w;
    q = -0.00125372503 + q * w;
    q = -0.00417768164 + q * w;
    q = 0.246640727 + q * w;
    q = 1.50140941 + q * w;
  } else {
    w = sqrt(w) - 3.0;
    q = -0.000200214257;
    q = 0.000100950558 + q * w;
    q = 0.00134934322 + q * w;
    q = -0.00367342844 + q * w;
    q = 0.00573950773 + q * w;
    q = -0.0076224613 + q * w;
    q = 0.00943887047 + q * w;
    q = 1.00167406 + q * w;
    q = 2.83297682 + q * w;
  }
  return q * x;
}
vec2 flipped(vec2 p) { return vec2(p.x, size.y - p.y) / size; }
vec4 canvasAt(sampler2D t, vec2 p) { return texture(t, flipped(p)); }
// The backdrop where a bent ray lands, filtered over the footprint of this
// pixel's ray: where the lens compresses what's behind, mipmaps average it.
float seenAt(vec2 p, int channel) {
  vec2 uv = flipped(p);
  return textureGrad(backdrop, uv, dFdx(uv), dFdy(uv))[channel];
}

void main() {
  vec2 p = gl_FragCoord.xy - origin;
  float a = canvasAt(mask, p).a;
  if (a <= 0.0) { color = vec4(0.0); return; }
  // The rim: its slope, in full pixels, from the smooth height field.
  vec3 hs = texture(height, (p / k) / heightTexSize).rgb;
  vec2 grad = hs.gb / k;
  float g = length(grad);
  // 1 at a straight edge, falling smoothly to 0 in the flat middle.
  float slope = clamp(g * sigma * 2.5066283, 0.0, 1.0);
  vec2 inward = g > 1e-6 ? grad / g : vec2(0.0);
  float rim = pow(slope, tuneA.x);

  vec2 fromCenter = p - center;
  vec2 fan = length(fromCenter) > 1e-3 ? normalize(fromCenter) : vec2(0.0);
  // A convex rim looks in: each pixel there sees the backdrop from further inside.
  vec2 bend = (inward + fan * splay) * rim * refraction;
  vec3 seen = vec3(
    seenAt(p + bend * (1.0 + dispersion), 0),
    seenAt(p + bend, 1),
    seenAt(p + bend * (1.0 - dispersion), 2));
  // The distance in from the edge: near a straight edge the rim's height is the Gaussian's
  // cumulative distribution of it, so its inverse gives it back (to a fraction of a pixel).
  float d = max(0.0, 1.4142136 * sigma * erfinv(clamp(2.0 * hs.r - 1.0, -0.99999, 0.99999)));
  // Light (given y down) as y up. A fine specular line along the edge facing
  // it, a softer one along the edge opposite (light inside the glass), and a
  // sheen across the lit side of the rim.
  vec2 l = vec2(light.x, -light.y);
  float facing = dot(-inward, l);
  float line = exp(-d / max(tuneA.z, depth * tuneA.y));
  float glow = exp(-d / max(tuneB.y, depth * tuneB.x));
  float lit = pow(max(facing, 0.0), tuneB.w) * (tuneA.w * line + tuneB.z * glow)
            + pow(max(-facing, 0.0), tuneC.z) * (tuneC.x * line + tuneC.y * glow)
            + tuneC.w * rim;
  float shade = max(-facing, 0.0) * rim * tuneD.x;
  seen = mix(seen, vec3(1.0), clamp(intensity * lit, 0.0, 1.0)) * (1.0 - intensity * shade);
  color = vec4(seen * a, a);
}`;

type Program = {
  readonly program: WebGLProgram;
  readonly u: (name: string) => WebGLUniformLocation | null;
};

interface Gl extends GlCanvas {
  readonly down: Program;
  readonly blurX: Program;
  readonly blurY: Program;
  readonly glass: Program;
  /** The frosted backdrop, mipmapped. */
  readonly backdrop: WebGLTexture;
  readonly mask: WebGLTexture;
  /** Ping-pong for the rim's height and slope, at reduced resolution (RGBA16F), and the framebuffer that draws into them. */
  readonly low: [WebGLTexture, WebGLTexture];
  readonly framebuffer: WebGLFramebuffer;
  lowSize: { w: number; h: number };
}

/** How much the rim's blur can be downsampled: its Gaussian stays at least 3 pixels wide there. */
export function heightScale(sigma: number): number {
  const k = Math.max(1, Math.min(8, Math.floor(sigma / 3)));
  // Even, past 1: the downsample reads four pixels at a time.
  return k > 1 ? k - (k % 2) : 1;
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
    // Rendering to half floats: the rim's height needs more than 8 bits.
    if (
      !gl.getExtension("EXT_color_buffer_float") &&
      !gl.getExtension("EXT_color_buffer_half_float")
    )
      return null;
    const down = program(gl, DOWN, "glass rim downsample");
    const blurX = program(gl, BLUR_X, "glass rim blur across");
    const blurY = program(gl, BLUR_Y, "glass rim blur down");
    const glass = program(gl, GLASS, "glass");
    const framebuffer = gl.createFramebuffer();
    if (!down || !blurX || !blurY || !glass || !framebuffer) return null;
    const backdrop = texture(gl, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    bindQuad(gl);
    this.#gl = {
      canvas,
      gl,
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
      down,
      blurX,
      blurY,
      glass,
      backdrop,
      mask: texture(gl, gl.LINEAR),
      low: [texture(gl, gl.LINEAR), texture(gl, gl.LINEAR)],
      framebuffer,
      lowSize: { w: 0, h: 0 },
    };
    return this.#gl;
  }

  /**
   * Draws `glass` for a layer whose `shape` is in the context's current
   * transform, over the box (0, 0, w, h). The context's opacity and
   * blending apply to the result.
   */
  paint(ctx: Ctx, shape: Path2D, w: number, h: number, glass: Glass, scale: number): void {
    const t = ctx.getTransform();
    const p = glassParams(glass, scale, glassTuning());
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

  /**
   * The GPU passes: the rim's height and slope (downsample, blur across,
   * blur down), then the glass into the canvas. False if it couldn't.
   */
  #draw(g: Gl, p: GlassParams, rw: number, rh: number, centre: { x: number; y: number }): boolean {
    const { gl } = g;
    // The rim's height, at a resolution its blur can spare.
    const k = heightScale(p.sigma);
    const lw = Math.ceil(rw / k);
    const lh = Math.ceil(rh / k);
    if (g.lowSize.w < lw || g.lowSize.h < lh) {
      const w = Math.max(lw, g.lowSize.w);
      const h = Math.max(lh, g.lowSize.h);
      for (const tex of g.low) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      }
      g.lowSize = { w, h };
    }
    const lowTexSize = [g.lowSize.w, g.lowSize.h] as const;
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
    // Bent rays can land where the lens compresses what's behind: read it through mipmaps.
    gl.generateMipmap(gl.TEXTURE_2D);
    bind(1, g.mask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.#shape as AnyCanvas);

    // The rim: the mask averaged down, then blurred across and down with its slope.
    const lowTarget = (i: number) => {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        g.low[i] as WebGLTexture,
        0,
      );
    };
    const sigmaLow = p.sigma / k;
    const radius = Math.min(64, Math.ceil(sigmaLow * 3));
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.framebuffer);
    gl.viewport(0, 0, lw, lh);
    lowTarget(0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
    gl.useProgram(g.down.program);
    gl.uniform1i(g.down.u("mask"), 1);
    gl.uniform2f(g.down.u("size"), rw, rh);
    gl.uniform1i(g.down.u("k"), k);
    draw(g);
    for (const [pass, from, into] of [
      [g.blurX, 0, 1],
      [g.blurY, 1, 0],
    ] as const) {
      bind(3, g.low[from] as WebGLTexture);
      lowTarget(into);
      gl.useProgram(pass.program);
      gl.uniform1i(pass.u("src"), 3);
      gl.uniform2f(pass.u("texSize"), lowTexSize[0], lowTexSize[1]);
      gl.uniform1f(pass.u("sigma"), sigmaLow);
      gl.uniform1i(pass.u("radius"), radius);
      draw(g);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The glass, into the canvas's top left.
    if (!begin(g, rw, rh)) return false;
    const origin = gl.drawingBufferHeight - rh;
    const u = g.glass.u;
    gl.useProgram(g.glass.program);
    bind(3, g.low[0] as WebGLTexture);
    gl.uniform1i(u("backdrop"), 0);
    gl.uniform1i(u("mask"), 1);
    gl.uniform1i(u("height"), 3);
    gl.uniform2f(u("size"), rw, rh);
    gl.uniform2f(u("heightTexSize"), lowTexSize[0], lowTexSize[1]);
    gl.uniform1f(u("k"), k);
    gl.uniform1f(u("sigma"), p.sigma);
    gl.uniform2f(u("origin"), 0, origin);
    gl.uniform2f(u("center"), centre.x, centre.y);
    gl.uniform1f(u("depth"), p.depth);
    gl.uniform1f(u("refraction"), p.refraction);
    gl.uniform1f(u("dispersion"), p.dispersion);
    gl.uniform1f(u("splay"), p.splay);
    gl.uniform2f(u("light"), p.light.x, p.light.y);
    gl.uniform1f(u("intensity"), p.intensity);
    const tune = glassTuning();
    gl.uniform4f(u("tuneA"), tune.profile, tune.lineWidth, tune.lineMin, tune.line);
    gl.uniform4f(u("tuneB"), tune.glowWidth, tune.glowMin, tune.glow, tune.facing);
    gl.uniform4f(u("tuneC"), tune.backLine, tune.backGlow, tune.backFacing, tune.sheen);
    gl.uniform4f(u("tuneD"), tune.shade, 0, 0, 0);
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
