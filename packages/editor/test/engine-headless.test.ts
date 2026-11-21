import { ErrorCode, RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { createHeadlessRenderer } from "../src/headless-render";

describe.skipIf(!built() || !built("browser"))("Headless PNG pixels", () => {
  it("matches the browser engine byte for byte with a contextual reader and a clipped ancestor", async () => {
    const doc = new Doc();
    doc.apply([
      { op: "create", id: "p", parent: ROOT_ID, type: "page", key: "a0", props: {} },
      {
        op: "create",
        id: "board",
        parent: "p",
        type: "frame",
        key: "a0",
        props: {
          width: 420,
          height: 360,
          clipContent: true,
          fills: [{ type: "solid", color: "#0066aa" }],
        },
      },
      {
        op: "create",
        id: "bar",
        parent: "board",
        type: "rect",
        key: "a0",
        props: {
          width: 120,
          height: 340,
          fills: [{ type: "solid", color: "#ff8800" }],
        },
      },
      {
        op: "create",
        id: "blur",
        parent: "board",
        type: "rect",
        key: "a1",
        props: {
          x: 60,
          y: 20,
          width: 310,
          height: 280,
          cornerRadius: 16,
          fills: [],
          effects: [{ type: "background-blur", radius: 12 }],
        },
      },
    ]);
    const renderer = (build: "worker" | "browser") =>
      createHeadlessRenderer({
        measurer: { width: () => 0 },
        images: async () => null,
        decodeImage: () => null,
        async acquireEngine() {
          return { engine: new RenderEngine(await loadNodeEngine(build)), release() {} };
        },
      });
    const worker = await renderer("worker").renderPng(doc, "blur", { scale: 1.5 });
    const browser = await renderer("browser").renderPng(doc, "blur", { scale: 1.5 });
    expect(worker).toEqual(browser);
    expect(worker.approximate).toEqual([]);
    const isolated = await renderer("worker").renderPng(doc, "blur", {
      scale: 1.5,
      background: "#00f",
    });
    expect(isolated.png).not.toEqual(worker.png);

    const over = renderer("worker").renderPng(doc, "blur", { scale: 40 });
    await expect(over).rejects.toThrow("8,192");
    doc.apply([
      {
        op: "set",
        id: "blur",
        prop: "effects",
        value: [
          {
            type: "layer-blur",
            blurType: "progressive",
            startRadius: 1,
            radius: 12,
            startOffset: { x: 0, y: 0 },
            endOffset: { x: 1, y: 1 },
          },
        ],
      },
    ]);
    await expect(renderer("worker").renderPng(doc, "blur")).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
    });
  });
});
