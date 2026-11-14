/**
 * Post effects (decision 0008): the effects that work on a layer's finished
 * picture (its fills, strokes, shadows and children together) rather than
 * on its shape. Layer blur, noise and texture. They apply in the order
 * they're listed, as in Figma.
 */
import type { Effect, Noise, Texture } from "@drawpane/model";
import { textureReach } from "./texture";

type Blur = Extract<Effect, { type: "layer-blur" | "background-blur" }>;
export type LayerBlur = Blur & { readonly type: "layer-blur" };
export type PostEffect = LayerBlur | Noise | Texture;

const NONE: readonly PostEffect[] = [];

/**
 * A layer's visible post effects, in the order they apply. Layer blurs next
 * to each other count as one, the strongest, as they always have.
 */
export function postEffects(effects: readonly Effect[]): readonly PostEffect[] {
  if (effects.length === 0) return NONE;
  let post: PostEffect[] | null = null;
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "layer-blur") {
      const blur = e as LayerBlur;
      post ??= [];
      const last = post[post.length - 1];
      if (last?.type !== "layer-blur") post.push(blur);
      else if (blur.radius > last.radius) post[post.length - 1] = blur;
    } else if (e.type === "noise" || e.type === "texture") {
      post ??= [];
      post.push(e);
    }
  }
  return post ?? NONE;
}

/** How far a layer blur shows past what it blurs: a Gaussian is all but gone by 3σ. */
const BLUR_REACH = 3;

/**
 * How far post effects reach past what the layer paints, in its units: the
 * room the canvas they work on needs around it. Each works on what the one
 * before left, so their reaches add up.
 */
export function postMargin(post: readonly PostEffect[]): number {
  let margin = 0;
  for (const e of post) {
    if (e.type === "layer-blur") margin += e.radius * BLUR_REACH;
    else if (e.type === "texture") margin += textureReach(e);
  }
  return margin;
}
