/**
 * The texture effect (decision 0008): a layer's edges roughened, as if
 * printed on rough paper.
 *
 * A WebGL2 shader runs over the layer's picture, drawn alone. Each cell of
 * `size` units, anchored to the layer, moves its pixels by a random offset
 * of up to `radius`: edges break up into grain, and so does any detail
 * inside, while flat colour stays flat. With "clip to shape" the result is
 * cut to the layer's own coverage, so nothing reaches past its edge but the
 * edge still roughens inward. Without WebGL2 the picture stays as it is.
 */
import type { Texture } from "@drawpane/model";
import { invert, type Matrix } from "./geometry";
import {
  type AnyCanvas,
  begin,
  type Ctx,
  draw,
  type QuadProgram,
  quadProgram,
  upload,
} from "./webgl";

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D source;
// The source canvas, and the part of it the picture covers (from its top left), in pixels.
uniform vec2 size;
uniform vec2 extent;
// The canvas's pixels (y down) to the layer's units.
uniform mat3 toLayer;
// A cell, in the layer's units; the farthest a pixel moves, in pixels.
uniform float cell;
uniform float radius;
uniform bool clip;

// pcg2d (Jarzynski and Olano, 2020): a well-mixed hash of a cell.
uvec2 hash(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return v;
}

vec4 at(vec2 px) {
  if (px.x < 0.0 || px.y < 0.0 || px.x > extent.x || px.y > extent.y) return vec4(0.0);
  vec2 t = px / size;
  return texture(source, t);
}

void main() {
  // Canvases are uploaded top row first: flip so y runs down, as on screen.
  vec2 px = vec2(uv.x, 1.0 - uv.y) * extent;
  vec2 local = (toLayer * vec3(px, 1.0)).xy;
  vec2 r = vec2(hash(uvec2(ivec2(floor(local / cell))))) / 4294967295.0;
  // A point spread evenly over the disc of the radius.
  float turn = r.x * 6.2831853;
  vec2 moved = px + vec2(cos(turn), sin(turn)) * sqrt(r.y) * radius;
  color = at(moved);
  if (clip) color *= at(px).a;
}`;

type Program = QuadProgram<"source", "size" | "extent" | "toLayer" | "cell" | "radius" | "clip">;

/** How far an unclipped texture reaches past its layer's edge, in the layer's units. */
export function textureReach(texture: Texture): number {
  return texture.clipToShape ? 0 : texture.radius;
}

/** Roughens layers' pictures; keeps its WebGL context between frames. */
export class TexturePainter {
  #program: Program | null | undefined;

  #webgl(): Program | null {
    if (this.#program === undefined)
      this.#program = quadProgram({
        label: "texture",
        fragment: FRAGMENT,
        textures: ["source"],
        uniforms: ["size", "extent", "toLayer", "cell", "radius", "clip"],
        // Whole pixels move: grain stays crisp, as on paper.
        filter: "nearest",
        premultiply: true,
      });
    return this.#program;
  }

  /**
   * Roughens the w × h pixels at `canvas`'s top left, in place. `layer`
   * takes the layer's units to the canvas's pixels; `scale` is pixels per
   * unit. False where there's no WebGL2 (the picture is left as it was).
   */
  paint(
    canvas: AnyCanvas,
    w: number,
    h: number,
    texture: Texture,
    layer: Matrix,
    scale: number,
  ): boolean {
    const radius = texture.radius * scale;
    if (radius <= 0 || w <= 0 || h <= 0) return true;
    const program = this.#webgl();
    const ctx = canvas.getContext("2d") as Ctx | null;
    if (!program || !ctx) return false;
    const { gl, uniforms } = program;
    begin(program, w, h);
    upload(program, "source", canvas);
    const [a, b, c, d, e, f] = invert(layer);
    gl.uniform2f(uniforms.size, canvas.width, canvas.height);
    gl.uniform2f(uniforms.extent, w, h);
    gl.uniformMatrix3fv(uniforms.toLayer, false, [a, b, 0, c, d, 0, e, f, 1]);
    gl.uniform1f(uniforms.cell, texture.size);
    gl.uniform1f(uniforms.radius, radius);
    gl.uniform1i(uniforms.clip, texture.clipToShape ? 1 : 0);
    draw(program);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(program.canvas, 0, 0, w, h, 0, 0, w, h);
    ctx.restore();
    return true;
  }
}
