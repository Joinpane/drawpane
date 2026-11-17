/**
 * `export_image` with no editor open (decisions 0021 and 0023): a layer
 * drawn by resvg in the room, sent back to the model as an MCP image with
 * what it couldn't draw exactly; sized for a model by default, at a scale
 * when asked; with any token, since it only looks.
 */
import { env } from "cloudflare:test";
import { DEFAULT_GLASS } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { signedInUser } from "./helpers";
import { call, makeToken } from "./mcp-helpers";

type Result = Awaited<ReturnType<typeof call>>;

/** The picture an answer carries, and its size from the PNG's header. */
function picture(result: Result) {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
  const image = (result.content as Array<Record<string, string>>).find((c) => c.type === "image");
  if (!image?.data) throw new Error("No image in the answer.");
  expect(image.mimeType).toBe("image/png");
  const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
  expect([...bytes.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  const view = new DataView(bytes.buffer);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    data: result.structuredContent as {
      width: number;
      height: number;
      scale: number;
      approximate?: string[];
    },
  };
}

/** Ana's new file, a live session on it, and a write and a read token. */
async function setup() {
  const ana = await signedInUser("Ana Lima");
  const { file } = await ana.browser.json<{ file: { id: string } }>(
    `/api/projects/${ana.projectId}/files`,
    { method: "POST", json: { name: "Pictures" } },
  );
  const { token } = await makeToken(ana.browser, "Claude Code", 90, "write");
  const { token: reader } = await makeToken(ana.browser, "Viewer", 90, "read");
  const started = await call(token, "start_session", { fileId: file.id, mode: "live" });
  const sessionId = (started.structuredContent as { sessionId: string }).sessionId;
  const render = async (jsx: string) => {
    const out = await call(token, "render", { sessionId, jsx });
    expect(out.isError, JSON.stringify(out.structuredContent)).toBe(false);
    return (out.structuredContent as { ids: string[] }).ids[0] as string;
  };
  return { browser: ana.browser, fileId: file.id, token, reader, render };
}

describe("export_image, headless", () => {
  it("draws a layer at the scale asked, for any token", async () => {
    const { fileId, reader, render } = await setup();
    const id = await render(`<Frame name="Card" w={120} h={80} fill="#2563eb" radius={12} />`);

    const at1 = picture(await call(reader, "export_image", { fileId, id, scale: 1 }));
    expect([at1.width, at1.height]).toEqual([120, 80]);
    expect(at1.data).toMatchObject({ width: 120, height: 80, scale: 1 });
    expect(at1.data.approximate).toBeUndefined();

    const at2 = picture(await call(reader, "export_image", { fileId, id, scale: 2 }));
    expect([at2.width, at2.height]).toEqual([240, 160]);
  });

  it("sizes a picture for a model when no scale is given", async () => {
    const { fileId, token, render } = await setup();
    const small = await render(`<Frame w={300} h={200} fill="#f97316" />`);
    const big = await render(`<Frame y={400} w={3000} h={1000} fill="#16a34a" />`);

    // Small layers are drawn at 2×, large ones brought down to about 1536 px.
    const two = picture(await call(token, "export_image", { fileId, id: small }));
    expect(two.data.scale).toBe(2);
    expect([two.width, two.height]).toEqual([600, 400]);
    const fitted = picture(await call(token, "export_image", { fileId, id: big }));
    expect(fitted.data.scale).toBe(0.51);
    expect(fitted.width).toBeLessThanOrEqual(1536);
    expect(fitted.width).toBeGreaterThan(1500);
  });

  it("says what it drew only approximately, and what it couldn't load", async () => {
    const { fileId, token, render } = await setup();
    const glass = await render(
      `<Rect w={100} h={100} fill="#ffffff" effects={${JSON.stringify([{ ...DEFAULT_GLASS, type: "glass" }])}} />`,
    );
    const out = picture(await call(token, "export_image", { fileId, id: glass, scale: 1 }));
    expect(out.data.approximate).toEqual([expect.stringContaining("glass")]);

    const missing = "a".repeat(64);
    const photo = await render(
      `<Rect w={100} h={100} fill={${JSON.stringify([{ type: "image", ref: missing, scaleMode: "fill" }])}} />`,
    );
    const left = picture(await call(token, "export_image", { fileId, id: photo, scale: 1 }));
    expect(left.data.approximate).toEqual([expect.stringContaining("couldn't be loaded")]);
  });

  it("draws the file's own images, from where they were uploaded", async () => {
    const { browser, fileId, token, render } = await setup();
    // A 2×1 PNG, uploaded as a person would.
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const uploaded = await browser.fetch(`/api/files/${fileId}/media`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    expect(uploaded.ok).toBe(true);
    const { sha } = (await uploaded.json()) as { sha: string };
    const photo = await render(
      `<Rect w={100} h={50} fill={${JSON.stringify([{ type: "image", ref: sha, scaleMode: "fill" }])}} />`,
    );
    const out = picture(await call(token, "export_image", { fileId, id: photo, scale: 1 }));
    expect([out.width, out.height]).toEqual([100, 50]);
    expect(out.data.approximate).toBeUndefined();
  });

  it("refuses images more than a render may hold, known before their files are read", async () => {
    const { browser, fileId, token, render } = await setup();
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const uploaded = await browser.fetch(`/api/files/${fileId}/media`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    const { sha } = (await uploaded.json()) as { sha: string };
    // As a 12-megapixel photo's record says: 48 MB decoded, past the 32 MB a render may hold.
    await env.DB.prepare("UPDATE media SET width = 4000, height = 3000 WHERE sha = ?")
      .bind(sha)
      .run();
    const photo = await render(
      `<Rect w={100} h={50} fill={${JSON.stringify([{ type: "image", ref: sha, scaleMode: "fill" }])}} />`,
    );
    const refused = await call(token, "export_image", { fileId, id: photo, scale: 1 });
    expect(refused.isError).toBe(true);
    expect(String(refused.structuredContent.error)).toMatch(
      /images in that render take more memory than drawing here may \(up to 32 MB/,
    );
  });

  it("explains what it can't draw", async () => {
    const { fileId, token, render } = await setup();
    const unknown = await call(token, "export_image", { fileId, id: "nope", scale: 1 });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.structuredContent)).toContain("no layer nope");

    const hidden = await render(`<Frame w={100} h={100} fill="#000000" hidden />`);
    const nothing = await call(token, "export_image", { fileId, id: hidden });
    expect(JSON.stringify(nothing.structuredContent)).toContain("Nothing visible");

    const huge = await render(`<Frame w={4000} h={4000} fill="#000000" />`);
    const tooBig = await call(token, "export_image", { fileId, id: huge, scale: 2 });
    expect(JSON.stringify(tooBig.structuredContent)).toContain("too large");
  });
});
