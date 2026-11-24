import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPreviewUploadsForTest } from "../editor/image-preview";
import { figmaFileKey, importFigma } from "./figma-import";

afterEach(() => {
  resetPreviewUploadsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Figma links", () => {
  it("finds the file key in any kind of link, or takes a bare key", () => {
    expect(
      figmaFileKey("https://www.figma.com/design/rvjaU14YWKozfSHkYXKCp2/Untitled?node-id=0-1"),
    ).toBe("rvjaU14YWKozfSHkYXKCp2");
    expect(figmaFileKey("figma.com/file/AbCdEfGhIjKl/Old")).toBe("AbCdEfGhIjKl");
    expect(figmaFileKey("https://www.figma.com/proto/AbCdEfGhIjKl/Flow")).toBe("AbCdEfGhIjKl");
    expect(figmaFileKey("  AbCdEfGhIjKl  ")).toBe("AbCdEfGhIjKl");
    // A branch is read by its own key.
    expect(
      figmaFileKey("https://www.figma.com/design/AbCdEfGhIjKl/branch/ZyXwVuTsRqPo/Kit?node-id=1-2"),
    ).toBe("ZyXwVuTsRqPo");
  });

  it("turns away what isn't one", () => {
    expect(figmaFileKey("https://example.com/design/AbCdEfGhIjKl")).toBeNull();
    expect(figmaFileKey("hello")).toBeNull();
    expect(figmaFileKey("")).toBeNull();
  });

  it("does not block import when a background preview PUT stalls", async () => {
    const sha = "a".repeat(64);
    const previewPuts: string[] = [];
    let releaseStalledPut: (() => void) | undefined;

    // Fake preview Worker so background preview generation completes immediately and hits the stalled PUT.
    class InstantPreviewWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(req: { id: number }) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              id: req.id,
              naturalWidth: 2000,
              naturalHeight: 1500,
              encodeMs: 1,
              previews: [
                {
                  size: 256,
                  width: 256,
                  height: 192,
                  blob: new Blob([new Uint8Array(128)], { type: "image/jpeg" }),
                },
              ],
            },
          } as MessageEvent);
        });
      }
      terminate() {}
    }

    vi.stubGlobal("Worker", InstantPreviewWorker);
    vi.stubGlobal("OffscreenCanvas", class {});

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.figma.com/v1/files/AbCdEfGhIjKl/images")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ meta: { images: { "img-ref-1": "https://cdn.figma.test/1.png" } } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      if (url.startsWith("https://api.figma.com/v1/files/AbCdEfGhIjKl")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: "Kit",
              document: {
                id: "0:0",
                name: "Document",
                type: "DOCUMENT",
                children: [
                  {
                    id: "1:1",
                    name: "Page 1",
                    type: "CANVAS",
                    children: [
                      {
                        id: "2:1",
                        name: "Hero",
                        type: "RECTANGLE",
                        absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
                        fills: [{ type: "IMAGE", imageRef: "img-ref-1", scaleMode: "FILL" }],
                      },
                    ],
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url === "https://cdn.figma.test/1.png") {
        return Promise.resolve(
          new Response(new Uint8Array(256), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        );
      }
      if (url === "/api/projects/proj-1/files" && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ file: { id: "file-1", name: "Kit" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url === "/api/files/file-1/media" && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ sha }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith(`/api/media/${sha}/previews/`) && init?.method === "PUT") {
        previewPuts.push(url);
        // Stall until released in finally: importFigma must finish without waiting on this PUT.
        return new Promise<Response>((resolve) => {
          releaseStalledPut = () => resolve(new Response("ok", { status: 200 }));
        });
      }
      if (url === "/api/files/file-1/imports" && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ importId: "imp-1", copies: "materialized" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.startsWith("/api/files/file-1/imports/imp-1/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const results = await importFigma("AbCdEfGhIjKl", "figd_token", "proj-1", () => {});
      expect(results).toHaveLength(1);
      expect(results[0]?.stage).toBe("done");
      expect(results[0]?.error).toBeNull();
      expect(results[0]?.images).toEqual({ done: 1, total: 1 });
      // Preview PUT was queued and fired in the background while the import finished immediately.
      await new Promise((r) => setTimeout(r, 10));
      expect(previewPuts).toEqual([`/api/media/${sha}/previews/256`]);
    } finally {
      releaseStalledPut?.();
    }
  });
});
