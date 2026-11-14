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

/** A fragment shader ready to run over its canvas, with its textures and uniforms. */
export interface QuadProgram<T extends string, U extends string> {
  readonly canvas: AnyCanvas;
  readonly gl: WebGL2RenderingContext;
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
  return { canvas, gl, textures, uniforms };
}

/** Sizes the program's canvas to w × h and clears it, ready to draw. */
export function begin(p: QuadProgram<string, string>, w: number, h: number): void {
  if (p.canvas.width !== w) p.canvas.width = w;
  if (p.canvas.height !== h) p.canvas.height = h;
  p.gl.viewport(0, 0, w, h);
  p.gl.clearColor(0, 0, 0, 0);
  p.gl.clear(p.gl.COLOR_BUFFER_BIT);
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
export function draw(p: QuadProgram<string, string>): void {
  p.gl.drawArrays(p.gl.TRIANGLE_STRIP, 0, 4);
}
