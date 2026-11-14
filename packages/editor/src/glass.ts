/**
 * The glass effect (decision 0007): what's behind a layer, seen through it
 * as through a lens with a curved rim.
 *
 * Drawn in device pixels, where the canvas has the backdrop:
 * 1. the backdrop under the layer (and a margin the bent rays reach into),
 *    blurred by the frost;
 * 2. the layer's shape as a mask, and that mask blurred over the rim's
 *    depth: a height that rises across the rim, whose slope bends the rays;
 * 3. a WebGL2 fragment shader that samples the backdrop along the slope
 *    (refraction, colour by colour for dispersion, fanned out from the
 *    centre for splay), lights the rim facing the light and shades the
 *    side facing away, and cuts the result to the shape.
 * Without WebGL2 it falls back to the frost and a rim highlight in 2D.
 */
import type { Glass } from "@drawpane/model";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/** A glass effect in device pixels, as the shader takes it. */
export interface GlassParams {
  /** How far the rim's slope moves a sample at most, in px. */
  readonly refraction: number;
  /** The rim's width, in px (the blur of the mask is half of it: a Gaussian is ~flat by 2σ). */
  readonly depth: number;
  /** Red moves this much further than green, blue this much less (0–0.5). */
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
export function glassParams(glass: Glass, scale: number): GlassParams {
  const depth = Math.max(0, glass.depth) * scale;
  // Full refraction bends a ray across most of the rim, and never less than a few pixels.
  const refraction = (glass.refraction / 100) * Math.max(depth, 4 * scale) * 1.25;
  const dispersion = (glass.dispersion / 100) * 0.5;
  const frost = Math.max(0, glass.frost) * scale;
  const splay = glass.splay / 100;
  const radians = (glass.angle * Math.PI) / 180;
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

/** A canvas made and kept for scratch work, sized to the region (resizing only when it changes). */
function scratch(existing: AnyCanvas | null, w: number, h: number): AnyCanvas | null {
  let canvas = existing;
  if (!canvas) {
    if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(w, h);
    else if (typeof document !== "undefined") canvas = document.createElement("canvas");
    else return null;
  }
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return canvas;
}

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() {
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D backdrop;
uniform sampler2D shape;
uniform sampler2D height;
uniform vec2 size;
uniform vec2 center;
uniform float refraction;
uniform float depth;
uniform float dispersion;
uniform float splay;
uniform vec2 light;
uniform float intensity;

void main() {
  // Canvases are uploaded top row first: flip so y runs down, as on screen.
  vec2 at = vec2(uv.x, 1.0 - uv.y);
  float alpha = texture(shape, at).a;
  if (alpha <= 0.0) { color = vec4(0.0); return; }
  vec2 texel = 1.0 / size;
  // The rim's slope: the blurred mask rises inward across it.
  float hx = texture(height, at + vec2(texel.x, 0.0)).a - texture(height, at - vec2(texel.x, 0.0)).a;
  float hy = texture(height, at + vec2(0.0, texel.y)).a - texture(height, at - vec2(0.0, texel.y)).a;
  vec2 slope = vec2(hx, hy) * 0.5;
  // 0 in the flat middle, 1 at the steepest part of the rim (a Gaussian's slope peaks at 1/(σ√2π)).
  float sigma = max(depth * 0.5, 0.5);
  float rim = clamp(length(slope) * sigma * 2.5066, 0.0, 1.0);
  vec2 inward = length(slope) > 1e-6 ? normalize(slope) : vec2(0.0);
  vec2 outward = -inward;
  vec2 fromCenter = at * size - center;
  vec2 fan = length(fromCenter) > 1e-3 ? normalize(fromCenter) : vec2(0.0);
  // A convex rim magnifies: each pixel there sees the backdrop from further in.
  vec2 bend = (inward + fan * splay) * rim * rim * refraction;
  vec2 g = at + bend * texel;
  vec2 r = at + bend * (1.0 + dispersion) * texel;
  vec2 b = at + bend * (1.0 - dispersion) * texel;
  vec3 seen = vec3(texture(backdrop, r).r, texture(backdrop, g).g, texture(backdrop, b).b);
  // The rim catches the light where it faces it, and dims a little where it faces away.
  float facing = dot(outward, light);
  float lit = intensity * rim * pow(max(facing, 0.0), 1.5);
  float shade = intensity * rim * 0.22 * max(-facing, 0.0);
  seen = mix(seen, vec3(1.0), clamp(lit * 0.85, 0.0, 1.0)) * (1.0 - shade);
  color = vec4(seen * alpha, alpha);
}`;

interface Gl {
  readonly canvas: AnyCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly textures: readonly [WebGLTexture, WebGLTexture, WebGLTexture];
  readonly uniforms: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("glass shader:", gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

/** Draws glass effects; keeps its canvases and WebGL context between frames. */
export class GlassPainter {
  #gl: Gl | null | undefined;
  #backdrop: AnyCanvas | null = null;
  #shape: AnyCanvas | null = null;
  #height: AnyCanvas | null = null;

  /** WebGL2, made on first use; null where there's none (then 2D's fallback draws). */
  #webgl(): Gl | null {
    if (this.#gl !== undefined) return this.#gl;
    this.#gl = null;
    const canvas = scratch(null, 1, 1);
    const gl = canvas?.getContext("webgl2", { premultipliedAlpha: true, antialias: false }) as
      | WebGL2RenderingContext
      | null
      | undefined;
    if (!canvas || !gl) return null;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    const texture = (unit: number, name: string) => {
      const t = gl.createTexture() as WebGLTexture;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
      return t;
    };
    const textures = [texture(0, "backdrop"), texture(1, "shape"), texture(2, "height")] as const;
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of [
      "size",
      "center",
      "refraction",
      "depth",
      "dispersion",
      "splay",
      "light",
      "intensity",
    ])
      uniforms[name] = gl.getUniformLocation(program, name);
    this.#gl = { canvas, gl, program, textures, uniforms };
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
    const centre = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2 - x0,
      y: (Math.min(...ys) + Math.max(...ys)) / 2 - y0,
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
    if (!gl) {
      this.#fallback(ctx, shape, p, x0, y0, rw, rh);
      return;
    }

    // The shape, and the shape blurred over the rim: its height.
    this.#shape = scratch(this.#shape, rw, rh);
    this.#height = scratch(this.#height, rw, rh);
    const mask = this.#shape?.getContext("2d") as Ctx | null | undefined;
    const height = this.#height?.getContext("2d") as Ctx | null | undefined;
    if (!this.#shape || !this.#height || !mask || !height) return;
    mask.setTransform(1, 0, 0, 1, 0, 0);
    mask.clearRect(0, 0, rw, rh);
    mask.setTransform(t.a, t.b, t.c, t.d, t.e - x0, t.f - y0);
    mask.fillStyle = "#fff";
    mask.fill(shape);
    height.setTransform(1, 0, 0, 1, 0, 0);
    height.clearRect(0, 0, rw, rh);
    height.filter = `blur(${Math.max(0.5, p.depth / 2)}px)`;
    height.drawImage(this.#shape, 0, 0);
    height.filter = "none";

    const { gl: g, textures, uniforms } = gl;
    if (gl.canvas.width !== rw || gl.canvas.height !== rh) {
      gl.canvas.width = rw;
      gl.canvas.height = rh;
    }
    g.viewport(0, 0, rw, rh);
    const upload = (unit: number, texture: WebGLTexture, source: AnyCanvas) => {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, texture);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source);
    };
    upload(0, textures[0], this.#backdrop);
    upload(1, textures[1], this.#shape);
    upload(2, textures[2], this.#height);
    g.uniform2f(uniforms.size ?? null, rw, rh);
    g.uniform2f(uniforms.center ?? null, centre.x, centre.y);
    g.uniform1f(uniforms.refraction ?? null, p.refraction);
    g.uniform1f(uniforms.depth ?? null, p.depth);
    g.uniform1f(uniforms.dispersion ?? null, p.dispersion);
    g.uniform1f(uniforms.splay ?? null, p.splay);
    g.uniform2f(uniforms.light ?? null, p.light.x, p.light.y);
    g.uniform1f(uniforms.intensity ?? null, p.intensity);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.drawImage(gl.canvas, 0, 0, rw, rh, x0, y0, rw, rh);
    ctx.restore();
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
