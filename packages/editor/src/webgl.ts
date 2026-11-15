/**
 * What the effects drawn by a shader share (glass, texture): scratch
 * canvases, and a WebGL2 program that runs a fragment shader over a whole
 * canvas. Each effect keeps its own context, made on first use, so files
 * without them pay nothing.
 */

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

/** A canvas made and kept for scratch work, sized to the region (resizing only when it changes). */
export function scratch(existing: AnyCanvas | null, w: number, h: number): AnyCanvas | null {
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

/**
 * A device-pixel box: [x0, x1) × [y0, y1). `fill`: what lies past it (a
 * clipping frame's own fill, as Figma's glass sees it), else its edge repeats.
 */
export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly fill?: string;
}

/**
 * Copies `src`'s pixels in the rect (x, y, w, h), which may reach past its
 * edges, to the top left of `out`. Past them the edge pixels repeat, as a
 * texture clamped to its edge does: a blur or a bent ray there sees the
 * backdrop go on, not fade to nothing, so glass and background blur look the
 * same at the edge of the screen as away from it. Leaves `out` unfiltered
 * and unsmoothed.
 */
export function copyExtended(
  src: AnyCanvas,
  out: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  /** What of `src` may be read (a clipping frame's box); the rest of the canvas is as if past its edge. */
  within: Bounds = { x0: 0, y0: 0, x1: src.width, y1: src.height },
) {
  const lo = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
  const bx0 = Math.max(0, Math.floor(within.x0));
  const by0 = Math.max(0, Math.floor(within.y0));
  const bx1 = Math.min(src.width, Math.ceil(within.x1));
  const by1 = Math.min(src.height, Math.ceil(within.y1));
  const ix0 = lo(x, bx0, bx1);
  const iy0 = lo(y, by0, by1);
  const ix1 = lo(x + w, bx0, bx1);
  const iy1 = lo(y + h, by0, by1);
  out.save();
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalCompositeOperation = "copy";
  out.filter = "none";
  out.imageSmoothingEnabled = false;
  if (ix1 <= ix0 || iy1 <= iy0) {
    out.clearRect(0, 0, w, h);
    out.restore();
    return;
  }
  const dx = ix0 - x;
  const dy = iy0 - y;
  const iw = ix1 - ix0;
  const ih = iy1 - iy0;
  out.drawImage(src, ix0, iy0, iw, ih, dx, dy, iw, ih);
  out.globalCompositeOperation = "source-over";
  const right = w - dx - iw;
  const bottom = h - dy - ih;
  // The edge columns stretched sideways, then the edge rows (corners included) up and down.
  if (dx > 0) out.drawImage(out.canvas, dx, dy, 1, ih, 0, dy, dx, ih);
  if (right > 0) out.drawImage(out.canvas, dx + iw - 1, dy, 1, ih, dx + iw, dy, right, ih);
  if (dy > 0) out.drawImage(out.canvas, 0, dy, w, 1, 0, 0, w, dy);
  if (bottom > 0) out.drawImage(out.canvas, 0, dy + ih - 1, w, 1, 0, dy + ih, w, bottom);
  // Past the bounds (not merely past the canvas): what lies there, when it's known.
  if (within.fill) {
    const fx0 = Math.max(0, Math.round(within.x0) - x);
    const fy0 = Math.max(0, Math.round(within.y0) - y);
    const fx1 = Math.min(w, Math.round(within.x1) - x);
    const fy1 = Math.min(h, Math.round(within.y1) - y);
    out.fillStyle = within.fill;
    if (fy0 > 0) out.fillRect(0, 0, w, fy0);
    if (fy1 < h) out.fillRect(0, fy1, w, h - fy1);
    if (fx0 > 0) out.fillRect(0, fy0, fx0, fy1 - fy0);
    if (fx1 < w) out.fillRect(fx1, fy0, w - fx1, fy1 - fy0);
  }
  out.restore();
}

/** The vertex shader: one quad over the canvas, `uv` 0–1 from its bottom left. */
const VERTEX = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() {
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(`${label} shader:`, gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

/**
 * Links a fragment shader with the full-quad vertex shader, its corner
 * attribute at location 0, so programs on one context share one quad.
 */
export function linkQuad(
  gl: WebGL2RenderingContext,
  fragment: string,
  label: string,
): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX, label);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment, label);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "corner");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`${label} program:`, gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

/** The quad every `linkQuad` program draws, bound at attribute 0. */
export function bindQuad(gl: WebGL2RenderingContext): void {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

/** A WebGL2 context on a canvas of its own: what drawing a picture with it takes. */
export interface GlCanvas {
  readonly canvas: AnyCanvas;
  readonly gl: WebGL2RenderingContext;
  /** The largest texture side this GPU takes. */
  readonly maxTexture: number;
}

/** A fragment shader ready to run over its canvas, with its textures and uniforms. */
export interface QuadProgram<T extends string, U extends string> extends GlCanvas {
  readonly textures: Readonly<Record<T, { readonly unit: number; readonly texture: WebGLTexture }>>;
  readonly uniforms: Readonly<Record<U, WebGLUniformLocation | null>>;
}

export interface QuadProgramOptions<T extends string, U extends string> {
  /** For messages: "glass". */
  readonly label: string;
  /** GLSL ES 3.00 with `in vec2 uv` and `out vec4 color`. */
  readonly fragment: string;
  /** Its samplers, by name, in texture-unit order. */
  readonly textures: readonly T[];
  readonly uniforms: readonly U[];
  /** How its textures are sampled. Default linear. */
  readonly filter?: "linear" | "nearest";
  /** Upload canvases premultiplied, as they draw. Default false (straight colour). */
  readonly premultiply?: boolean;
}

/**
 * A WebGL2 context on a canvas of its own, running `fragment` over the
 * whole canvas; null where there's no WebGL2 or the shader doesn't build.
 */
export function quadProgram<T extends string, U extends string>(
  options: QuadProgramOptions<T, U>,
): QuadProgram<T, U> | null {
  const canvas = scratch(null, 1, 1);
  const gl = canvas?.getContext("webgl2", { premultipliedAlpha: true, antialias: false }) as
    | WebGL2RenderingContext
    | null
    | undefined;
  if (!canvas || !gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX, options.label);
  const fs = compile(gl, gl.FRAGMENT_SHADER, options.fragment, options.label);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`${options.label} program:`, gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  if (options.premultiply) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const filter = options.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
  const textures = {} as Record<T, { unit: number; texture: WebGLTexture }>;
  options.textures.forEach((name, unit) => {
    const texture = gl.createTexture() as WebGLTexture;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    textures[name] = { unit, texture };
  });
  const uniforms = {} as Record<U, WebGLUniformLocation | null>;
  for (const name of options.uniforms) uniforms[name] = gl.getUniformLocation(program, name);
  const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
  return { canvas, gl, maxTexture, textures, uniforms };
}

/**
 * Whether the program can draw a w × h picture now: its context isn't lost,
 * and the picture fits the GPU's textures. When it can't, the caller keeps
 * what it has rather than draw a blank.
 */
export function fits(p: GlCanvas, w: number, h: number): boolean {
  return !p.gl.isContextLost() && w <= p.maxTexture && h <= p.maxTexture;
}

/**
 * Readies the program to draw a w × h picture at its canvas's top left
 * (read it back from (0, 0, w, h)), cleared. The canvas only grows, so a
 * zoom doesn't reallocate it every frame, unless it's far bigger than needed.
 * False when the drawing buffer came out smaller than asked (the browser
 * caps it): don't use what it draws.
 */
export function begin(p: GlCanvas, w: number, h: number): boolean {
  const { canvas, gl } = p;
  const oversized = canvas.width * canvas.height > 4 * w * h;
  if (canvas.width < w || oversized) canvas.width = w;
  if (canvas.height < h || oversized) canvas.height = h;
  if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) return false;
  // The viewport's origin is the bottom left: the top rows are the canvas's top.
  gl.viewport(0, gl.drawingBufferHeight - h, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return true;
}

/** Puts a canvas's pixels in one of the program's textures. */
export function upload<T extends string>(
  p: QuadProgram<T, string>,
  name: T,
  source: AnyCanvas,
): void {
  const { gl } = p;
  const { unit, texture } = p.textures[name];
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/** Runs the shader over the canvas. */
export function draw(p: GlCanvas): void {
  p.gl.drawArrays(p.gl.TRIANGLE_STRIP, 0, 4);
}
