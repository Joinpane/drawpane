/**
 * `export_image` with no editor open (decisions 0021 and 0040): a layer
 * drawn by the runner's CPU engine, sent back to the model as an MCP image with
 * what it couldn't draw exactly; sized for a model by default, at a scale
 * when asked; with any token, since it only looks.
 */
import { env } from "cloudflare:test";
import { inflateSync } from "node:zlib";
import { DEFAULT_GLASS, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import notoUrl from "../../../packages/editor/test/fixtures/NotoSansSC-Subset.ttf?inline";
import { enginePngPixel, solidPng } from "../../../packages/editor/test/fixtures/png";
import { agentDeps } from "../src/agent/call";
import { AGENT_RUNNER_V } from "../src/agent/runner-api";
import { mediaKey } from "../src/api/media";
import { teamFontKey } from "../src/api/team-fonts";
import type { NodeRow } from "../src/rooms/node-tables";
import { snapshotStream } from "../src/rooms/snapshots";
import ttfUrl from "./fixtures/InstrumentSans-Regular.ttf?inline";
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
    bytes,
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
  it.skipIf(!env.TEST_FALLBACK_FONTS)(
    "exports Han fallback outlines from the requested R2 slice",
    async () => {
      const { fileId, reader, render } = await setup();
      const file = await env.DB.prepare("SELECT team_id FROM files WHERE id = ?")
        .bind(fileId)
        .first<{ team_id: string }>();
      if (!file) throw new Error("missing test file");
      const fontBytes = (url: string) =>
        Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
      const latin = fontBytes(ttfUrl);
      const sha = "d".repeat(64);
      await env.FILES.put(teamFontKey(sha), latin);
      await env.DB.prepare(
        `INSERT INTO team_fonts (id, team_id, family, style, weight, weight_max, italic, format, sha, bytes, created_at)
       VALUES ('runner_latin_font', ?, 'Instrument Sans', 'Regular', 400, NULL, 0, 'ttf', ?, ?, ?)`,
      )
        .bind(file.team_id, sha, latin.byteLength, Date.now())
        .run();
      await env.FILES.put("fonts/fallback/v1/Noto-Sans-SC/4e00.ttf", fontBytes(notoUrl));
      // The JP control slice lacks Han coverage. It must draw the last-resort outline.
      await env.FILES.put("fonts/fallback/v1/Noto-Sans-JP/4e00.ttf", latin);
      const id = await render(
        '<Frame w={80} h={80} fill="#ffffff"><Text font="Instrument Sans" size={44} fill="#101010">中</Text></Frame>',
      );
      const input = { fileId, id, scale: 1 };
      const simplified = picture(await call(reader, "export_image", input));
      const japanese = picture(
        await call(reader, "export_image", input, { "accept-language": "ja-JP" }),
      );
      expect([simplified.width, simplified.height]).toEqual([80, 80]);
      expect([japanese.width, japanese.height]).toEqual([80, 80]);
      // 中 has a vertical stroke through its centre. The last-resort box is empty there.
      const middle = (bytes: Uint8Array) =>
        [16, 24, 32].map((y) => enginePngPixel(bytes, 22, y)[0] ?? 255);
      expect(middle(simplified.bytes).some((value) => value < 128)).toBe(true);
      expect(middle(japanese.bytes)).toEqual([255, 255, 255]);
      expect(picture(await call(reader, "export_image", input)).bytes).toEqual(simplified.bytes);
    },
    30_000,
  );

  it.skipIf(!env.TEST_LIVE_FONTS)(
    "exports CJK text and an image with the runner near its editor admission limit",
    async () => {
      const { fileId } = await setup();
      const runner = agentDeps(env, fileId).runner();
      const file = await env.DB.prepare("SELECT team_id FROM files WHERE id = ?")
        .bind(fileId)
        .first<{ team_id: string }>();
      if (!file) throw new Error("missing test file");
      const faces = [
        [
          "Noto Sans SC",
          400,
          "界面设计",
          "notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYxNbPzS5HE.ttf",
        ],
        [
          "Noto Sans SC",
          700,
          "中文排版",
          "notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYxNbPzS5HE.ttf",
        ],
        [
          "Noto Sans JP",
          400,
          "日本語のテキスト",
          "notosansjp/v57/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75vY0rw-oME.ttf",
        ],
      ] as const;
      for (const [i, [family, weight, , path]] of faces.entries()) {
        const response = await fetch(`https://fonts.gstatic.com/s/${path}`);
        expect(response.ok, family).toBe(true);
        const bytes = await response.arrayBuffer();
        const sha = (i + 5).toString(16).repeat(64);
        await env.FILES.put(teamFontKey(sha), bytes);
        await env.DB.prepare(
          `INSERT INTO team_fonts (id, team_id, family, style, weight, weight_max, italic, format, sha, bytes, created_at)
           VALUES (?, ?, ?, 'Regular', ?, NULL, 0, 'ttf', ?, ?, ?)`,
        )
          .bind(`cjk_${i}`, file.team_id, family, weight, sha, bytes.byteLength, Date.now())
          .run();
      }
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      const image = "2".repeat(64);
      await env.FILES.put(mediaKey(image), png);
      await env.DB.prepare(
        `INSERT INTO media (sha, team_id, mime, width, height, bytes, created_at)
         VALUES (?, ?, 'image/png', 2, 1, ?, ?)`,
      )
        .bind(image, file.team_id, png.byteLength, Date.now())
        .run();

      const row = (
        id: string,
        parent: string,
        key: string,
        type: string,
        props: object,
      ): NodeRow => ({ id, parent, key, type, props: JSON.stringify(props) });
      const filler = 244;
      const scene = [
        row("P", ROOT_ID, "a0", "page", {}),
        row("F", "P", "a0", "frame", {
          width: 1360,
          height: 320,
          clipContent: true,
          opacity: 0.85,
          fills: [{ type: "solid", color: "#dddddd" }],
        }),
        row("Photo", "F", "a0", "rect", {
          width: 1360,
          height: 320,
          fills: [{ type: "image", ref: image, scaleMode: "fill" }],
        }),
        row("Reader", "F", "a1", "rect", {
          width: 680,
          height: 320,
          effects: [{ type: "background-blur", radius: 48 }],
          fills: [],
        }),
        ...faces.map(([fontFamily, fontWeight, characters], i) =>
          row(`T${i}`, "F", `a${i + 2}`, "text", {
            width: 600,
            height: 52,
            x: 16,
            y: 20 + i * 84,
            fontSize: 42,
            fontFamily,
            fontWeight,
            characters,
          }),
        ),
      ];
      // About 46.5 MiB of text payload. Hidden layers exercise the editor's snapshot and
      // admission budget without inflating the export's display list.
      const props = JSON.stringify({
        visible: false,
        fontFamily: "Noto Sans JP",
        characters: "x".repeat(200_000),
      });
      function* pages(): Generator<NodeRow[]> {
        yield scene;
        for (let i = 0; i < filler; i += 16) {
          yield Array.from({ length: Math.min(16, filler - i) }, (_, j) => ({
            id: `hidden${i + j}`,
            parent: "P",
            key: "a1",
            type: "text",
            props,
          }));
        }
      }
      const answer = await runner.run({
        v: AGENT_RUNNER_V,
        fileId,
        tool: "export_image",
        input: { id: "F", scale: 1 },
        source: {
          kind: "snapshot",
          revn: 10,
          at: 10,
          count: scene.length + filler,
          copies: "materialized",
          body: snapshotStream({ fileId, revn: 10, at: Date.now() }, pages()),
          txns: [],
        },
      });
      if (!answer.ok)
        throw new Error("message" in answer ? answer.message : "The runner requested a retry.");
      expect(answer.result).toMatchObject({ width: 1360, height: 320, scale: 1 });
      expect(answer.result).not.toHaveProperty("approximate");
      expect(answer.image?.mimeType).toBe("image/png");
    },
    180_000,
  );

  it.skipIf(!env.TEST_LIVE_FONTS)(
    "draws live text from the runner's capped HarfBuzz module",
    async () => {
      const { fileId, token, render } = await setup();
      const file = await env.DB.prepare("SELECT team_id FROM files WHERE id = ?")
        .bind(fileId)
        .first<{ team_id: string }>();
      if (!file) throw new Error("missing test file");
      const font = Uint8Array.from(atob(ttfUrl.slice(ttfUrl.indexOf(",") + 1)), (c) =>
        c.charCodeAt(0),
      );
      const sha = "d".repeat(64);
      await env.DB.prepare(
        `INSERT INTO team_fonts (id, team_id, family, style, weight, weight_max, italic, format, sha, bytes, created_at)
       VALUES ('runner_outline_font', ?, 'Bridge Sans', 'Regular', 400, NULL, 0, 'ttf', ?, ?, ?)`,
      )
        .bind(file.team_id, sha, font.byteLength, Date.now())
        .run();
      await env.FILES.put(teamFontKey(sha), font);
      const id = await render(
        '<Text font="Bridge Sans" size={28} fill="#101010">Live outlines</Text>',
      );
      const { bytes, width, height, data } = picture(
        await call(token, "export_image", { fileId, id, scale: 1 }),
      );
      expect(data.approximate).toBeUndefined();
      const view = new DataView(bytes.buffer);
      const chunks: Uint8Array[] = [];
      for (let offset = 8; offset < bytes.length; ) {
        const length = view.getUint32(offset);
        if (view.getUint32(offset + 4) === 0x49444154)
          chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      const packed = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        packed.set(chunk, offset);
        offset += chunk.length;
      }
      const rows = inflateSync(packed);
      expect(rows.length).toBe((width * 4 + 1) * height);
      let inked = 0;
      for (let start = 0; start < rows.length; start += width * 4 + 1) {
        let alpha = 0;
        for (let x = 0; x < width; x++) {
          alpha = (alpha + (rows[start + 4 + x * 4] ?? 0)) & 255;
          if (alpha > 0) inked++;
        }
      }
      expect(inked).toBeGreaterThan(100);
    },
  );

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

  it("draws glass and reports unavailable assets", async () => {
    const { fileId, token, render } = await setup();
    const glass = await render(
      `<Rect w={100} h={100} fill="#ffffff" effects={${JSON.stringify([{ ...DEFAULT_GLASS, type: "glass" }])}} />`,
    );
    const out = picture(await call(token, "export_image", { fileId, id: glass, scale: 1 }));
    expect(out.data.approximate).toBeUndefined();

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

  it("draws an image more than a render may hold as a placeholder, and says so", async () => {
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
    // Exercise the encoded input cap before fetching the object.
    await env.DB.prepare("UPDATE media SET bytes = 16777216 WHERE sha = ?").bind(sha).run();
    const photo = await render(
      `<Rect w={100} h={50} fill={${JSON.stringify([{ type: "image", ref: sha, scaleMode: "fill" }])}} />`,
    );
    // Known from its record before its file is read; the rest of the picture is drawn.
    const out = picture(await call(token, "export_image", { fileId, id: photo, scale: 0.05 }));
    expect([out.width, out.height]).toEqual([5, 3]);
    expect(out.data.approximate).toEqual([
      expect.stringMatching(new RegExp(`too large to draw here.*placeholders \\(${sha}\\)`)),
    ]);
  });

  it("draws a 720p source at full size and a 2,000-square source at its drawn size", async () => {
    const { browser, fileId, token, render } = await setup();
    const color = [36, 108, 203, 255];
    for (const [width, height, drawWidth, drawHeight] of [
      [1280, 720, 1280, 720],
      [2000, 2000, 500, 500],
    ] as const) {
      const png = solidPng(width, height, color);
      const uploaded = await browser.fetch(`/api/files/${fileId}/media`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(png),
      });
      expect(uploaded.ok).toBe(true);
      const { sha } = (await uploaded.json()) as { sha: string };
      const fills = JSON.stringify([{ type: "image", ref: sha, scaleMode: "stretch" }]);
      const id = await render(`<Rect w={${drawWidth}} h={${drawHeight}} fill={${fills}} />`);
      const out = picture(await call(token, "export_image", { fileId, id, scale: 1 }));
      expect(out.data).toMatchObject({ width: drawWidth, height: drawHeight, scale: 1 });
      expect(out.data.approximate).toBeUndefined();
      expect(enginePngPixel(out.bytes, drawWidth >> 1, drawHeight >> 1)).toEqual(color);
    }
  }, 120_000);

  it("explains what it can't draw", async () => {
    const { fileId, token, render } = await setup();
    const unknown = await call(token, "export_image", { fileId, id: "nope", scale: 1 });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.structuredContent)).toContain("no layer nope");

    const hidden = await render(`<Frame w={100} h={100} fill="#000000" hidden />`);
    const nothing = await call(token, "export_image", { fileId, id: hidden });
    expect(JSON.stringify(nothing.structuredContent)).toContain("Nothing visible");

    const huge = await render(`<Frame w={8193} h={30} fill="#000000" />`);
    const tooBig = await call(token, "export_image", { fileId, id: huge, scale: 1 });
    expect(JSON.stringify(tooBig.structuredContent)).toContain("too large");
  });

  it("streams exports at the longest side limit in either orientation", async () => {
    const { fileId, token, render } = await setup();
    for (const [width, height] of [
      [8192, 48],
      [48, 8192],
    ]) {
      const id = await render(`<Rect w={${width}} h={${height}} fill="#446688" />`);
      const result = picture(await call(token, "export_image", { fileId, id, scale: 1 }));
      expect([result.width, result.height]).toEqual([width, height]);
    }
  });

  it("reduces a large reader inside clipped opacity and mask scopes", async () => {
    const { fileId, token, render } = await setup();
    const scopes = "<Frame w={1024} h={180} opacity={0.94} clip>";
    const id = await render(
      `<Frame w={1024} h={180} clip fill="#4076a8">
        ${scopes.repeat(4)}
          <Rect w={900} h={180} isMask maskType="alpha" fill="#ffffff" />
          <Rect w={400} h={180} fill="#bde591" />
          <Rect x={80} w={680} h={180} fill="#ffffff22" effects={[{ "type": "background-blur", "radius": 160 }]} />
        ${"</Frame>".repeat(4)}
      </Frame>`,
    );
    const out = picture(await call(token, "export_image", { fileId, id, scale: 1 }));
    expect(out.data.scale).toBeLessThan(1);
    expect(out.data).toHaveProperty("reduced", expect.stringContaining("Drawn smaller than asked"));
    expect(out.width).toBeGreaterThanOrEqual(256);
  }, 120_000);

  it("finishes exports from several files after a real Wasm trap", async () => {
    const first = await setup();
    const second = await setup();
    const firstId = await first.render('<Rect w={64} h={40} fill="#336699" />');
    const secondId = await second.render('<Rect w={40} h={64} fill="#663399" />');
    const runners = env.AGENT_RUNNER;
    if (!runners) throw new Error("missing test runner binding");
    await runners.get(runners.idFromName(first.fileId)).arm("render-trap");
    const failed = await call(first.token, "export_image", { fileId: first.fileId, id: firstId });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.structuredContent)).toContain("the engine trapped");
    const [one, two] = await Promise.all([
      call(first.token, "export_image", { fileId: first.fileId, id: firstId, scale: 1 }),
      call(second.token, "export_image", { fileId: second.fileId, id: secondId, scale: 1 }),
    ]);
    expect(picture(one).data).toMatchObject({ width: 64, height: 40 });
    expect(picture(two).data).toMatchObject({ width: 40, height: 64 });
  });
});
