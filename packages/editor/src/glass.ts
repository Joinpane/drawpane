/**
 * The glass effect (decision 0007): what's behind a layer, seen through it
 * as through a lens with a curved rim, lit along its edge.
 *
 * Drawn in device pixels, where the canvas has the backdrop:
 * 1. the backdrop under the layer (and a margin the bent rays reach into),
 *    and the layer's shape, as an anti-aliased mask; the backdrop frosted on
 *    the GPU, read from its mipmaps at a level where what's left of the blur
 *    is a few texels wide, so frost costs the same at any strength.
 *    Both reach past the canvas's edges, the backdrop's edge pixels
 *    repeated there, so a layer the screen cuts has no rim along the cut;
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
import { fitCorners } from "./corner-geometry";
import {
  type AnyCanvas,
  type Bounds,
  begin,
  bindQuad,
  type Ctx,
  copyExtended,
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
  /** Boxes: at full refraction, how far the edge looks in, as a share of the rim's depth. */
  readonly bend: number;
  /**
   * Boxes: the bend falls off as (1 − distance in / depth)^n, n = falloff +
   * falloffPerDepth × the depth in units (Figma's grows with depth: about 2.7
   * at 20, 3.3 at 100).
   */
  readonly falloff: number;
  readonly falloffPerDepth: number;
  /** Other shapes (no exact distance to their edge): the bend's share of the depth, and slope^profile. */
  readonly slopeBend: number;
  /**
   * Ellipses: the bend's share of the depth is 1 − ellipseLoss / (depth +
   * ellipseDepth), depth in units (Figma's, measured: 0.38 at depth 10, 0.59
   * at 20, 0.78 at 40, 0.87 at 70, whatever the size), along the slope's profile.
   */
  readonly ellipseLoss: number;
  readonly ellipseDepth: number;
  readonly profile: number;
  /** The rim's height is the shape blurred by a Gaussian this share of the depth wide. */
  readonly rimSigma: number;
  /** At full dispersion, how far red and blue part from green, as a share of the bend. */
  readonly dispersion: number;
  /** At full splay, the pull along an edge toward its middle at its ends, as a share of the bend. */
  readonly splay: number;
  /** Blur per unit of frost. */
  readonly frost: number;
  /** The light's hairline: how far in from the edge it fades, in the layer's units. */
  readonly hairline: number;
  /** Its strength on an edge facing the light: front × (facing − frontStart), at least 0. */
  readonly front: number;
  readonly frontStart: number;
  /** And on an edge facing away: back × (−facing − backStart). */
  readonly back: number;
  readonly backStart: number;
  /** Shading across the rim, shade × facing (darker toward the light, lighter away), gone at shadeReach of the depth. */
  readonly shade: number;
  readonly shadeReach: number;
}

/**
 * Figma's glass, measured setting by setting (decision 0007's revision of
 * 2026-11-15; `tools/figma-parity/scenes/glass-probe-2.json`): the bend at
 * its edge is the depth times the refraction, falling off as the cube of
 * the way in; red and blue part by a tenth of it at full dispersion; the
 * light is a hairline on edges that face toward or away from it, and a faint
 * shade across the rim.
 */
export const DEFAULT_GLASS_TUNING: GlassTuning = {
  bend: 1.02,
  falloff: 2.55,
  falloffPerDepth: 0.0075,
  slopeBend: 0.86,
  ellipseLoss: 12.1,
  ellipseDepth: 9.5,
  profile: 1.6,
  rimSigma: 0.275,
  dispersion: 0.1,
  splay: 0.58,
  frost: 0.45,
  hairline: 0.35,
  front: 3.7,
  frontStart: 0.45,
  back: 2.4,
  backStart: 0.42,
  shade: 0.09,
  shadeReach: 0.55,
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
  /** Device pixels per layer unit. */
  readonly unitPx: number;
  /** A box's bend falls off as (1 − distance in / depth)^falloff. */
  readonly falloff: number;
}

/**
 * A glass effect's values in device pixels at `scale` (device pixels per
 * unit). 0° is light from the top, turning clockwise: −45° is the top left.
 */
/** How a glass layer's shape bends (see `glassParams`). */
export type GlassKind = "box" | "ellipse" | "other";

export function glassParams(
  glass: Glass,
  scale: number,
  tune: GlassTuning = glassTuning(),
  /** The shape's largest inscribed radius, in its units: no rim is deeper (see inradius.ts). */
  inradius = Number.POSITIVE_INFINITY,
  /**
   * What the shape is, for how it bends (each measured against Figma): a box
   * (its exact distance in known), an ellipse, or anything else.
   */
  kind: GlassKind = "other",
): GlassParams {
  // Figma's ranges: depth and frost at most 100.
  const units = Math.max(0, Math.min(glass.depth, 100, inradius));
  const depth = units * scale;
  // Full refraction bends a ray at the edge as far as the rim is deep (a box); an ellipse, a
  // share that grows with the depth; other shapes, the slope's share, never over less than a
  // few pixels. A rim deeper than the shape is wide fades into the one opposite.
  const share =
    kind === "box"
      ? tune.bend
      : kind === "ellipse"
        ? Math.max(0, 1 - tune.ellipseLoss / (units + tune.ellipseDepth))
        : tune.slopeBend;
  const refraction =
    (glass.refraction / 100) * share * (kind === "box" ? depth : Math.max(depth, 4 * scale));
  // Red and blue part from green by a share of the bend.
  const dispersion = (glass.dispersion / 100) * tune.dispersion;
  const frost = Math.max(0, Math.min(glass.frost, 100)) * scale * tune.frost;
  const splay = (glass.splay / 100) * tune.splay;
  const radians = (glass.angle * Math.PI) / 180;
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
    unitPx: scale,
    falloff: tune.falloff + tune.falloffPerDepth * Math.min(glass.depth, 100, inradius),
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
// What this draw wrote (the textures only grow): past it is outside the shape, never what an
// earlier, larger glass left there.
uniform vec2 valid;
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
    vec2 q = p + vec2(x, 0.0);
    float m = q.x < 0.0 || q.x > valid.x ? 0.0 : texture(src, q / texSize).r;
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
uniform vec2 valid;
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
    vec2 q = p + vec2(0.0, y);
    vec2 v = q.y < 0.0 || q.y > valid.y ? vec2(0.0) : texture(src, q / texSize).rg;
    h += w * v.r;
    dx += w * v.g;
    dy += w * v.r * y / (sigma * sigma);
    total += w;
  }
  color = vec4(h / total, dx / total, dy / total, 0.0);
}`;

/**
 * Frost: a Gaussian across or down, read from the backdrop's mipmaps at a
 * level where what's left of the blur is a few texels wide, so frost costs
 * about the same at any strength (decision 0007's revision of 2026-11-15).
 */
const FROST = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D src;
uniform vec2 size;
uniform float lod;
uniform vec2 dir;
uniform float sigma;
uniform int radius;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -64; i <= 64; i++) {
    if (i < -radius || i > radius) continue;
    float w = exp(-0.5 * float(i * i) / (sigma * sigma));
    sum += textureLod(src, (p + dir * float(i)) / size, lod) * w;
    total += w;
  }
  color = sum / total;
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
// The layer's half width and height on the device: how far along an edge its middle is.
uniform vec2 halfSize;
uniform float depth;
uniform float refraction;
uniform float dispersion;
uniform float splay;
uniform vec2 light;
uniform float intensity;
// A box (rect or frame): its exact distance in from the edge, region pixels to box units, its size
// and corner radii (top-left, top-right, bottom-right, bottom-left) in units as drawn, their
// smoothing as drawn (corners.ts), and pixels per unit.
uniform int box;
uniform mat3 toBox;
uniform vec2 boxSize;
uniform vec4 boxRadii;
uniform vec4 boxSmoothing;
uniform float unitPx;
// GlassTuning: (profile, falloff, hairline px, -), (front, frontStart, back, backStart),
// (shade, shadeReach, -, -), (-, -, -, -).
uniform vec4 tuneA;
uniform vec4 tuneB;
uniform vec4 tuneC;

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
// The backdrop where a bent ray lands (premultiplied), filtered over the footprint of this
// pixel's ray: where the lens compresses what's behind, mipmaps average it.
vec4 seenAt(vec2 p) {
  vec2 uv = flipped(p);
  return textureGrad(backdrop, uv, dFdx(uv), dFdy(uv));
}

// How far in from a corner's outline a point is, in box units (negative outside), for a corner of
// radius R and smoothing s as corners.ts draws it, folded about the corner's diagonal: "along" is
// the larger of the point's distances in from the corner's two edges, "off" the smaller. At s = 0
// it's the distance from a circle.
float cornerDistance(float along, float off, float R, float s) {
  float p = (1.0 + s) * R;
  if (along >= p) return off;
  float arcAngle = 1.5707963 * (1.0 - s);
  float arcChord = sin(arcAngle * 0.5) * R * 1.4142136;
  float alpha = (1.5707963 - arcAngle) * 0.5;
  float c = R * tan(alpha * 0.5) * cos(0.7853982 * s);
  float d = c * tan(0.7853982 * s);
  float b = (p - arcChord - c - d) / 3.0;
  float a = 2.0 * b;
  float x3 = p - a - b - c;
  // On the arc's side of the line from its centre through where it starts: the circle.
  vec2 v = vec2(along, off) - R;
  vec2 toStart = vec2(x3, d) - R;
  if (toStart.x * v.y - toStart.y * v.x <= 0.0) return R - length(v);
  // On the easing curve's side: off = d t^3 as along runs from p (t = 0) to x3 (t = 1).
  float lo = 0.0;
  float hi = 1.0;
  for (int i = 0; i < 12; i++) {
    float t = 0.5 * (lo + hi);
    float u = 1.0 - t;
    float x = u * u * u * p + 3.0 * u * u * t * (p - a) + 3.0 * u * t * t * (p - a - b) + t * t * t * x3;
    if (x > along) lo = t; else hi = t;
  }
  float t = 0.5 * (lo + hi);
  float u = 1.0 - t;
  float dx = -3.0 * u * u * a - 6.0 * u * t * b + 3.0 * t * t * (x3 - p + a + b);
  float slope = 3.0 * d * t * t / min(dx, -1e-6);
  return (off - d * t * t * t) / sqrt(1.0 + slope * slope);
}

// How far in from a box's edge a region pixel is, in pixels (negative outside): exact, square
// corners and all, where the blurred height reads low at convex corners.
float boxDistance(vec2 p) {
  vec2 q = (toBox * vec3(p, 1.0)).xy - boxSize * 0.5;
  // The radius and smoothing of q's corner (y runs down in the box).
  float r = q.x < 0.0 ? (q.y < 0.0 ? boxRadii.x : boxRadii.w) : (q.y < 0.0 ? boxRadii.y : boxRadii.z);
  float s = q.x < 0.0 ? (q.y < 0.0 ? boxSmoothing.x : boxSmoothing.w) : (q.y < 0.0 ? boxSmoothing.y : boxSmoothing.z);
  if (r <= 0.0 || s <= 0.0) {
    vec2 e = abs(q) - boxSize * 0.5 + r;
    return -(min(max(e.x, e.y), 0.0) + length(max(e, 0.0)) - r) * unitPx;
  }
  vec2 e = boxSize * 0.5 - abs(q);
  return cornerDistance(max(e.x, e.y), min(e.x, e.y), r, s) * unitPx;
}

void main() {
  vec2 p = gl_FragCoord.xy - origin;
  float a = canvasAt(mask, p).a;
  float boxEdge = box == 1 ? boxDistance(p) : 0.0;
  // The destination clips reduced boxes using the original path. Keep a texel
  // past its edge for interpolation so upsampling retains the bright rim.
  if (box == 1 && tuneA.w < 1.0) a = boxEdge >= -1.5 ? 1.0 : 0.0;
  if (a <= 0.0) { color = vec4(0.0); return; }
  // The rim: its slope, in full pixels, from the smooth height field.
  vec3 hs = texture(height, (p / k) / heightTexSize).rgb;
  vec2 grad = hs.gb / k;
  float g = length(grad);
  // The distance in from the edge. A box knows it exactly. Otherwise, near a straight edge the
  // rim's height is the Gaussian's cumulative distribution of it, so its inverse gives it back
  // (to a fraction of a pixel), though it reads short at a convex corner.
  float d = box == 1
    ? max(0.0, boxEdge)
    : max(0.0, 1.4142136 * sigma * erfinv(clamp(2.0 * hs.r - 1.0, -0.99999, 0.99999)));
  // 1 at a straight edge, falling smoothly to 0 in the flat middle: for a box, the blurred
  // edge's slope at that distance (the same along a side, and square at a square corner).
  float slope = box == 1 ? exp(-0.5 * (d / sigma) * (d / sigma)) : clamp(g * sigma * 2.5066283, 0.0, 1.0);
  // Which way is in: the height's slope, smooth everywhere (no crease along a corner's diagonal).
  vec2 inward = g > 1e-6 ? grad / g : vec2(0.0);
  float rim = pow(slope, tuneA.x);
  // How much of the bend this pixel gets: a box's measured falloff from its exact edge (as
  // Figma's: the cube of the way in), else its slope's share.
  float fall = box == 1 ? pow(clamp(1.0 - d / max(depth, tuneA.w), 0.0, 1.0), tuneA.y) : rim;

  // Splay pulls each ray along its edge toward the edge's middle, as far as it is from it.
  vec2 along = vec2(-inward.y, inward.x);
  float extent = abs(along.x) * halfSize.x + abs(along.y) * halfSize.y;
  float off = extent > 0.0 ? dot(p - center, along) / extent : 0.0;
  // A convex rim looks in: each pixel there sees the backdrop from further inside.
  vec2 bend = (inward - along * off * splay) * fall * refraction;
  vec4 red = seenAt(p + bend * (1.0 + dispersion));
  vec4 green = seenAt(p + bend);
  vec4 blue = seenAt(p + bend * (1.0 - dispersion));
  // Premultiplied, so what's behind keeps its alpha: over nothing, glass shows nothing (as
  // Figma's does), and its light and shade are only as opaque as what they fall on.
  float seenAlpha = max(red.a, max(green.a, blue.a));
  vec3 seen = vec3(red.r, green.g, blue.b);
  // Light (given y down) as y up, as Figma lights its glass: a hairline along each edge facing
  // toward the light or away from it (more the more squarely), and a faint shade across the
  // rim, darker facing the light and lighter away, fading in toward the middle.
  vec2 l = vec2(light.x, -light.y);
  float facing = dot(-inward, l);
  float hair = exp(-max(0.0, d - 0.5 * tuneA.w) / max(tuneA.z, 1e-3));
  float edge = max(tuneB.x * (facing - tuneB.y), 0.0) + max(tuneB.z * (-facing - tuneB.w), 0.0);
  float shading = intensity * tuneC.x * facing * max(0.0, 1.0 - d / max(tuneC.y * depth, tuneA.w));
  seen = shading > 0.0 ? mix(seen, vec3(0.0), shading) : mix(seen, vec3(seenAlpha), -shading);
  seen = mix(seen, vec3(seenAlpha), clamp(intensity * edge * hair, 0.0, 1.0));
  color = vec4(seen, seenAlpha) * a;
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
  readonly frost: Program;
  /** The backdrop, mipmapped. */
  readonly backdrop: WebGLTexture;
  /** Frost across, then down: the second mipmapped, for the glass to read. */
  readonly frosted: [WebGLTexture, WebGLTexture];
  frostSize: { w: number; h: number };
  readonly mask: WebGLTexture;
  /** Ping-pong for the rim's height and slope, at reduced resolution (RGBA16F), and the framebuffer that draws into them. */
  readonly low: [WebGLTexture, WebGLTexture];
  readonly framebuffer: WebGLFramebuffer;
  lowSize: { w: number; h: number };
  /**
   * Textures the framebuffer was found complete with, since they were last
   * allocated. Asking costs a round trip to the GPU, a stall every glass
   * drawn would pay; the answer only changes when a texture is allocated.
   */
  readonly complete: WeakSet<WebGLTexture>;
}

/** Whether the framebuffer, drawing into `tex`, is complete: asked once per allocation of it. */
function attachable(g: Gl, tex: WebGLTexture): boolean {
  if (g.complete.has(tex)) return true;
  const { gl } = g;
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
  g.complete.add(tex);
  return true;
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
/**
 * What a layer's glass looked like the last time it was drawn whole on
 * screen, and everything it depended on: on a pan, with nothing else
 * changed, the same glass lands a whole number of pixels away and is copied
 * rather than drawn again.
 */
interface Drawn {
  /** The renderer's content generation: the backdrop and the layer as they were. */
  readonly generation: number;
  readonly look: Glass;
  readonly tuning: GlassTuning;
  /** The layer's device transform, less the whole-pixel offset of its region. */
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly w: number;
  readonly h: number;
  readonly picture: AnyCanvas;
}

/** Pixels of glass kept for pans, at most (about 64 MB). */
const KEPT_PIXELS = 16_000_000;

/** A glass layer's shape: its outline, or what draws it in white into a mask (text's glyphs). */
export type GlassShape = Path2D | ((mask: Ctx) => void);

/** A box's exact outline, for the shader (see `boxDistance`). */
interface BoxUniforms {
  readonly toBox: readonly number[];
  readonly size: readonly [number, number];
  readonly radii: readonly [number, number, number, number];
  readonly smoothing: readonly [number, number, number, number];
  readonly unitPx: number;
}

/** What else `GlassPainter.paint` can know about the layer. */
export interface GlassPaintOptions {
  /** Where and against what it's drawn: what it draws whole on screen is kept for pans. */
  readonly key?: GlassKey | null;
  /** The shape's largest inscribed radius, in its units (see `glassParams`). */
  readonly inradius?: number;
  /**
   * The shape is its box, (0, 0, w, h), with these corner radii (top-left,
   * top-right, bottom-right, bottom-left, in its units): its rim is measured
   * from the exact edge, square corners staying square.
   */
  readonly corners?: readonly [number, number, number, number] | null;
  /** How smooth those corners are, 0 to 1 (corners.ts); missing is 0. */
  readonly smoothing?: number;
  /**
   * What of the canvas the backdrop may come from (the frames that clip the
   * layer, on the device): past it, the edge repeats, as past the canvas's.
   */
  readonly within?: Bounds;
  /** What the shape is, when it isn't a box with `corners` (an ellipse bends as Figma's do). */
  readonly kind?: GlassKind;
  /**
   * The canvas is known to be opaque (the screen over a page's background): the glass, opaque
   * too, simply goes over what's there. Elsewhere (an export with no background, a layer's own
   * canvas) what's behind may be see-through: the glass replaces it under the shape, as Figma's
   * does, rather than going over it (a half-clear backdrop would come out twice as opaque).
   */
  readonly opaque?: boolean;
  /**
   * Where to read the backdrop instead of the canvas drawn on: a canvas whose top left is
   * (x, y) on the device (an export's view of what's under it on the page).
   */
  readonly source?: { readonly canvas: AnyCanvas; readonly x: number; readonly y: number };
}

/** Where, and against what, a glass is drawn: for reusing what it drew (see `Drawn`). */
export interface GlassKey {
  readonly id: string;
  readonly generation: number;
}

// The backdrop, mask, mip chain and drawing buffer all use this raster.
const MAX_GLASS_SIDE = 4096;
const MAX_GLASS_PIXELS = 4 * 1024 * 1024;
const MAX_RIM_SIGMA = (64 * 8) / 3;

export class GlassPainter {
  #gl: Gl | null | undefined;
  /** By layer, most recently drawn last. */
  readonly #drawn = new Map<string, Drawn>();
  /** The content generation each layer's glass was last drawn against. */
  readonly #drawnAt = new Map<string, number>();
  #keptPixels = 0;
  #backdrop: AnyCanvas | null = null;
  #shape: AnyCanvas | null = null;
  #softwareFrost: AnyCanvas | null = null;

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
    const frost = program(gl, FROST, "glass frost");
    const framebuffer = gl.createFramebuffer();
    if (!down || !blurX || !blurY || !glass || !frost || !framebuffer) return null;
    const backdrop = texture(gl, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const across = texture(gl, gl.LINEAR);
    const frosted = texture(gl, gl.LINEAR);
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
      frost,
      backdrop,
      frosted: [across, frosted],
      frostSize: { w: 0, h: 0 },
      mask: texture(gl, gl.LINEAR),
      low: [texture(gl, gl.LINEAR), texture(gl, gl.LINEAR)],
      framebuffer,
      lowSize: { w: 0, h: 0 },
      complete: new WeakSet(),
    };
    return this.#gl;
  }

  /**
   * Draws `glass` for a layer whose `shape` is in the context's current
   * transform, over the box (0, 0, w, h): a path, or what draws it in white
   * (a text's glyphs, each a lens of its own, as in Figma). The context's opacity and
   * blending apply to the result. With a `key`, what it draws whole on
   * screen is kept, and drawn again by copying while nothing it depends on
   * has changed.
   */
  paint(
    ctx: Ctx,
    shape: GlassShape,
    w: number,
    h: number,
    glass: Glass,
    scale: number,
    options: GlassPaintOptions = {},
  ): void {
    const {
      key = null,
      inradius = Number.POSITIVE_INFINITY,
      corners = null,
      smoothing = 0,
      within,
      kind = "other",
      opaque = true,
      source,
    } = options;
    const t = ctx.getTransform();
    const tune = glassTuning();
    const shapeKind = corners ? "box" : kind;
    const full = glassParams(glass, scale, tune, inradius, shapeKind);
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
    // Past the canvas's edges too, as far as the rim's shape and a ray's reach count for what's
    // on it: cut at the edge, the shape would grow a rim along it, and the backdrop fade there.
    const pad = full.margin + Math.ceil(3 * full.sigma);
    const x0 = Math.max(-pad, Math.floor(Math.min(...xs)) - full.margin);
    const y0 = Math.max(-pad, Math.floor(Math.min(...ys)) - full.margin);
    const x1 = Math.min(ctx.canvas.width + pad, Math.ceil(Math.max(...xs)) + full.margin);
    const y1 = Math.min(ctx.canvas.height + pad, Math.ceil(Math.max(...ys)) + full.margin);
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) return;
    if (x1 <= 0 || y1 <= 0 || x0 >= ctx.canvas.width || y0 >= ctx.canvas.height) return;
    // Keep the halo in device space. When it or the viewport is too large to raster
    // at device resolution, scale the whole sampling region and the lens together.
    const gl = this.#webgl();
    const side = Math.min(gl?.maxTexture ?? MAX_GLASS_SIDE, MAX_GLASS_SIDE);
    const raster = Math.min(
      1,
      side / Math.max(width, height),
      Math.sqrt(MAX_GLASS_PIXELS / (width * height)),
      MAX_RIM_SIGMA / full.sigma,
    );
    const rw = Math.ceil(width * raster);
    const rh = Math.ceil(height * raster);
    const p = raster === 1 ? full : glassParams(glass, scale * raster, tune, inradius, shapeKind);
    // The layer's centre, in the region's pixels with y up (as the shader works).
    const centre = {
      x: ((Math.min(...xs) + Math.max(...xs)) / 2 - x0) * raster,
      y: rh - ((Math.min(...ys) + Math.max(...ys)) / 2 - y0) * raster,
    };
    // Its half width and height on the device: how far along an edge its middle is (for splay).
    const halfSize = {
      x: ((Math.max(...xs) - Math.min(...xs)) / 2) * raster,
      y: ((Math.max(...ys) - Math.min(...ys)) / 2) * raster,
    };

    // All it reads is on the canvas: what it draws can be kept, or what was kept is good.
    const whole =
      raster === 1 && x0 >= 0 && y0 >= 0 && x1 <= ctx.canvas.width && y1 <= ctx.canvas.height;
    const kept = key ? this.#drawn.get(key.id) : undefined;
    if (
      opaque &&
      key &&
      kept &&
      whole &&
      kept.generation === key.generation &&
      kept.look === glass &&
      kept.tuning === tune &&
      kept.a === t.a &&
      kept.b === t.b &&
      kept.c === t.c &&
      kept.d === t.d &&
      // The same within rounding: a pan moves it by whole pixels.
      Math.abs(kept.e - (t.e - x0)) < 1e-6 &&
      Math.abs(kept.f - (t.f - y0)) < 1e-6 &&
      kept.w === w &&
      kept.h === h &&
      kept.picture.width === rw &&
      kept.picture.height === rh
    ) {
      // Most recently used last.
      this.#drawn.delete(key.id);
      this.#drawn.set(key.id, kept);
      this.#place(ctx, kept.picture, x0, y0, rw, rh);
      return;
    }

    // The backdrop, its edge pixels repeated past the canvas's (and the frames that clip it).
    this.#backdrop = scratch(this.#backdrop, rw, rh);
    const backdrop = this.#backdrop?.getContext("2d") as Ctx | null | undefined;
    if (!this.#backdrop || !backdrop) return;
    if (source)
      copyExtended(
        source.canvas,
        backdrop,
        x0 - source.x,
        y0 - source.y,
        width,
        height,
        within && {
          ...within,
          x0: within.x0 - source.x,
          y0: within.y0 - source.y,
          x1: within.x1 - source.x,
          y1: within.y1 - source.y,
        },
        raster,
      );
    else copyExtended(ctx.canvas, backdrop, x0, y0, width, height, within, raster);
    // The shape, anti-aliased.
    this.#shape = scratch(this.#shape, rw, rh);
    const mask = this.#shape?.getContext("2d") as Ctx | null | undefined;
    if (!this.#shape || !mask) return;
    mask.setTransform(1, 0, 0, 1, 0, 0);
    mask.globalCompositeOperation = "source-over";
    mask.clearRect(0, 0, rw, rh);
    mask.setTransform(
      t.a * raster,
      t.b * raster,
      t.c * raster,
      t.d * raster,
      (t.e - x0) * raster,
      (t.f - y0) * raster,
    );
    mask.fillStyle = "#fff";
    if (typeof shape === "function") shape(mask);
    else mask.fill(shape);

    // A box: the map from the region's pixels (y up, as the shader works) to the box's units.
    let box: BoxUniforms | null = null;
    const det = t.a * t.d - t.b * t.c;
    if (corners && w > 0 && h > 0 && Math.abs(det) > 1e-12) {
      const [ia, ib, ic, id] = [t.d / det, -t.b / det, -t.c / det, t.a / det];
      const ie = (t.c * t.f - t.d * t.e) / det;
      const jf = (t.b * t.e - t.a * t.f) / det;
      const top = y0 + rh / raster;
      // The corners as drawn: radii and smoothing cut to the space each has.
      const fitted = fitCorners(w, h, corners, smoothing);
      box = {
        // Column-major: device (x0 + px, y0 + rh − py) taken back through the layer's transform.
        toBox: [
          ia / raster,
          ib / raster,
          0,
          -ic / raster,
          -id / raster,
          0,
          ia * x0 + ic * top + ie,
          ib * x0 + id * top + jf,
          1,
        ],
        size: [w, h],
        radii: fitted.map((c) => c.radius) as unknown as readonly [number, number, number, number],
        smoothing: fitted.map((c) => c.smoothing) as unknown as readonly [
          number,
          number,
          number,
          number,
        ],
        unitPx: Math.sqrt(Math.abs(det)) * raster,
      };
    }
    if (!gl || !fits(gl, rw, rh) || !this.#draw(gl, p, rw, rh, centre, halfSize, box, raster)) {
      this.#fallback(ctx, shape, p, x0, y0, rw, rh, raster, opaque);
      return;
    }
    // Upsampling must not spread the effect beyond the original outline.
    const clip = raster < 1 && typeof shape !== "function";
    if (clip) {
      ctx.save();
      ctx.clip(shape);
      ctx.imageSmoothingEnabled = true;
    }
    if (!opaque && ctx.globalCompositeOperation === "source-over") {
      this.#replace(ctx, gl.canvas, x0, y0, rw, rh, raster, clip && box !== null);
      if (clip) ctx.restore();
      if (key) this.#forget(key.id);
      return;
    }
    this.#place(ctx, gl.canvas, x0, y0, rw, rh, raster);
    if (clip) ctx.restore();
    // Kept only once it's been drawn twice against the same content (a pan, not a drag, whose
    // every frame is new): copying it would cost every frame of a drag for nothing.
    const steady = key !== null && this.#drawnAt.get(key.id) === key.generation;
    if (key) this.#drawnAt.set(key.id, key.generation);
    if (key && whole && steady) this.#keep(key, glass, tune, t, x0, y0, w, h, gl.canvas, rw, rh);
    else if (key) this.#forget(key.id);
  }

  /**
   * The backdrop frosted by a Gaussian `sigma` pixels wide, in two passes
   * (across, then down) read from its mipmap at a level where what's left of
   * the blur is a few texels wide: a strong frost costs no more than a light
   * one. The result is mipmapped, as the backdrop is, for compressed reads.
   */
  #frost(g: Gl, sigma: number, rw: number, rh: number): WebGLTexture | null {
    const { gl } = g;
    const level = Math.max(0, Math.min(6, Math.floor(Math.log2(Math.max(1, sigma / 3)))));
    const f = 2 ** level;
    const fw = Math.max(1, Math.ceil(rw / f));
    const fh = Math.max(1, Math.ceil(rh / f));
    if (g.frostSize.w !== fw || g.frostSize.h !== fh) {
      for (const tex of g.frosted) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        g.complete.delete(tex);
      }
      g.frostSize = { w: fw, h: fh };
    }
    // What's left of the blur once the mip level has averaged f × f pixels (a box: variance
    // f²/12 an axis), in its texels.
    const left = Math.sqrt(Math.max(sigma * sigma - (f * f) / 12, 0.25)) / f;
    const radius = Math.min(64, Math.ceil(left * 3));
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.framebuffer);
    gl.viewport(0, 0, fw, fh);
    const u = g.frost.u;
    gl.useProgram(g.frost.program);
    for (const [src, lod, dir, into] of [
      [g.backdrop, level, [1, 0], g.frosted[0]],
      [g.frosted[0], 0, [0, 1], g.frosted[1]],
    ] as const) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, into, 0);
      if (!attachable(g, into)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return null;
      }
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(u("src"), 4);
      gl.uniform2f(u("size"), fw, fh);
      gl.uniform1f(u("lod"), lod);
      gl.uniform2f(u("dir"), dir[0], dir[1]);
      gl.uniform1f(u("sigma"), left);
      gl.uniform1i(u("radius"), radius);
      draw(g);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, g.frosted[1]);
    gl.generateMipmap(gl.TEXTURE_2D);
    return g.frosted[1];
  }

  /** Draws the top left rw × rh of `picture` at (x0, y0) on the device. */
  #place(ctx: Ctx, picture: AnyCanvas, x0: number, y0: number, rw: number, rh: number, raster = 1) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.drawImage(picture, 0, 0, rw, rh, x0, y0, rw / raster, rh / raster);
    ctx.restore();
  }

  /**
   * Puts the glass where the shape is in place of what was there: what's under the shape cut
   * out by the mask, then the glass (premultiplied, already cut by the mask) added in. The
   * context's opacity applies to both, so a faded glass mixes with what was there.
   */
  #replace(
    ctx: Ctx,
    picture: AnyCanvas,
    x0: number,
    y0: number,
    rw: number,
    rh: number,
    raster: number,
    boxClip: boolean,
  ) {
    if (!this.#shape) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "destination-out";
    if (boxClip) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x0, y0, rw / raster, rh / raster);
    } else {
      ctx.drawImage(this.#shape, 0, 0, rw, rh, x0, y0, rw / raster, rh / raster);
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(picture, 0, 0, rw, rh, x0, y0, rw / raster, rh / raster);
    ctx.restore();
  }

  /** Keeps what a layer's glass drew, within the budget, dropping the least recently drawn. */
  #keep(
    key: GlassKey,
    look: Glass,
    tuning: GlassTuning,
    t: DOMMatrix,
    x0: number,
    y0: number,
    w: number,
    h: number,
    from: AnyCanvas,
    rw: number,
    rh: number,
  ) {
    if (rw * rh > KEPT_PIXELS / 4) {
      this.#forget(key.id);
      return;
    }
    const old = this.#drawn.get(key.id);
    this.#forget(key.id);
    const picture = scratch(old?.picture ?? null, rw, rh);
    const pctx = picture?.getContext("2d") as Ctx | null | undefined;
    if (!picture || !pctx) return;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.globalCompositeOperation = "copy";
    pctx.drawImage(from, 0, 0, rw, rh, 0, 0, rw, rh);
    pctx.globalCompositeOperation = "source-over";
    this.#drawn.set(key.id, {
      generation: key.generation,
      look,
      tuning,
      a: t.a,
      b: t.b,
      c: t.c,
      d: t.d,
      e: t.e - x0,
      f: t.f - y0,
      w,
      h,
      picture,
    });
    this.#keptPixels += rw * rh;
    for (const id of this.#drawn.keys()) {
      if (this.#keptPixels <= KEPT_PIXELS) break;
      this.#forget(id);
    }
  }

  #forget(id: string) {
    const drawn = this.#drawn.get(id);
    if (!drawn) return;
    this.#keptPixels -= drawn.picture.width * drawn.picture.height;
    this.#drawn.delete(id);
  }

  /**
   * The GPU passes: the rim's height and slope (downsample, blur across,
   * blur down), then the glass into the canvas. False if it couldn't.
   */
  #draw(
    g: Gl,
    p: GlassParams,
    rw: number,
    rh: number,
    centre: { x: number; y: number },
    halfSize: { x: number; y: number },
    box: BoxUniforms | null,
    raster: number,
  ): boolean {
    const { gl } = g;
    // The rim's height, at a resolution its blur can spare.
    const k = heightScale(p.sigma);
    const lw = Math.ceil(rw / k);
    const lh = Math.ceil(rh / k);
    const oversized = Math.max(g.lowSize.w, lw) * Math.max(g.lowSize.h, lh) > 4 * lw * lh;
    if (oversized || g.lowSize.w < lw || g.lowSize.h < lh) {
      const w = oversized ? lw : Math.max(lw, g.lowSize.w);
      const h = oversized ? lh : Math.max(lh, g.lowSize.h);
      for (const tex of g.low) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        g.complete.delete(tex);
      }
      g.lowSize = { w, h };
    }
    const lowTexSize = [g.lowSize.w, g.lowSize.h] as const;
    const bind = (unit: number, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    // Premultiplied: what's see-through behind stays so through the frost, the mipmaps and
    // the shader, and averages without dark fringes.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
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
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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
    if (!attachable(g, g.low[0])) {
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
      gl.uniform2f(pass.u("valid"), lw, lh);
      gl.uniform1f(pass.u("sigma"), sigmaLow);
      gl.uniform1i(pass.u("radius"), radius);
      draw(g);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Frost, on the GPU at a resolution its blur can spare; the glass reads the result.
    const frosted = p.frost > 0.4 ? this.#frost(g, p.frost, rw, rh) : null;
    bind(0, frosted ?? g.backdrop);

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
    gl.uniform1i(u("box"), box ? 1 : 0);
    if (box) {
      gl.uniformMatrix3fv(u("toBox"), false, box.toBox);
      gl.uniform2f(u("boxSize"), box.size[0], box.size[1]);
      gl.uniform4f(u("boxRadii"), ...box.radii);
      gl.uniform4f(u("boxSmoothing"), ...box.smoothing);
      gl.uniform1f(u("unitPx"), box.unitPx);
    }
    const tune = glassTuning();
    gl.uniform4f(u("tuneA"), tune.profile, p.falloff, tune.hairline * p.unitPx, raster);
    gl.uniform4f(u("tuneB"), tune.front, tune.frontStart, tune.back, tune.backStart);
    gl.uniform4f(u("tuneC"), tune.shade, tune.shadeReach, 0, 0);
    gl.uniform2f(u("halfSize"), halfSize.x, halfSize.y);
    draw(g);
    // A large upload can fail even when its dimensions fit the reported limits.
    // An incomplete sampler reads black. Keep it out of the destination.
    return !gl.isContextLost() && (rw * rh < 1_000_000 || gl.getError() === gl.NO_ERROR);
  }

  /** No WebGL2: the frosted backdrop inside the shape, and a highlight along the lit rim. */
  #fallback(
    ctx: Ctx,
    shape: GlassShape,
    p: GlassParams,
    x0: number,
    y0: number,
    rw: number,
    rh: number,
    raster: number,
    opaque: boolean,
  ) {
    let backdrop = this.#backdrop;
    if (!backdrop) return;
    const t = ctx.getTransform();
    ctx.save();
    if (typeof shape === "function") {
      // The frosted backdrop where the mask is: the mask with the backdrop drawn into it.
      const mask = this.#shape?.getContext("2d") as Ctx | null | undefined;
      if (!this.#shape || !mask) {
        ctx.restore();
        return;
      }
      mask.setTransform(1, 0, 0, 1, 0, 0);
      mask.globalCompositeOperation = "source-in";
      // Frost in 2D here: there's no GPU to do it.
      mask.filter = p.frost > 0 ? `blur(${p.frost}px)` : "none";
      mask.drawImage(backdrop, 0, 0, rw, rh, 0, 0, rw, rh);
      mask.filter = "none";
      mask.globalCompositeOperation = "source-over";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.#shape, 0, 0, rw, rh, x0, y0, rw / raster, rh / raster);
      ctx.restore();
      return;
    }
    ctx.clip(shape);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // What may be see-through behind is replaced, not drawn over (see `GlassPaintOptions.opaque`).
    if (!opaque && ctx.globalCompositeOperation === "source-over" && ctx.globalAlpha >= 1)
      ctx.globalCompositeOperation = "copy";
    if (p.frost > 0 && raster < 1) {
      this.#softwareFrost = scratch(this.#softwareFrost, rw, rh);
      const frost = this.#softwareFrost?.getContext("2d") as Ctx | null | undefined;
      if (this.#softwareFrost && frost) {
        frost.globalCompositeOperation = "copy";
        frost.filter = `blur(${p.frost}px)`;
        frost.drawImage(backdrop, 0, 0);
        backdrop = this.#softwareFrost;
      }
    }
    ctx.filter = p.frost > 0 && raster === 1 ? `blur(${p.frost}px)` : "none";
    ctx.drawImage(backdrop, 0, 0, rw, rh, x0, y0, rw / raster, rh / raster);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(t);
    if (p.intensity > 0 && p.depth > 0) {
      ctx.globalAlpha *= p.intensity * 0.6;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1, p.depth / Math.max(1e-6, Math.hypot(t.a, t.b) * raster) / 2);
      ctx.stroke(shape);
    }
    ctx.restore();
  }
}
