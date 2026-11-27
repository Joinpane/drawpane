import { z } from "zod";

export const rendererPolicySchema = z.object({
  defaultRenderer: z.enum(["canvas", "engine"]).nullable(),
  forceCanvas: z.boolean(),
});

type RendererPolicy = z.infer<typeof rendererPolicySchema>;

export async function readRendererPolicy(db: D1Database): Promise<RendererPolicy> {
  const row = await db
    .prepare("SELECT default_renderer, force_canvas FROM renderer_policy WHERE id = 1")
    .first<{ default_renderer: RendererPolicy["defaultRenderer"]; force_canvas: number }>();
  return { defaultRenderer: row?.default_renderer ?? null, forceCanvas: row?.force_canvas === 1 };
}

export async function writeRendererPolicy(db: D1Database, policy: RendererPolicy): Promise<void> {
  await db
    .prepare(
      `INSERT INTO renderer_policy (id, default_renderer, force_canvas) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET default_renderer = excluded.default_renderer,
                                     force_canvas = excluded.force_canvas`,
    )
    .bind(policy.defaultRenderer, Number(policy.forceCanvas))
    .run();
}
