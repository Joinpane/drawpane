// @vitest-environment jsdom
import { CanvasRenderer, Editor } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (typeof globalThis.matchMedia !== "function") {
    globalThis.matchMedia = (() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
  }
});

import { ComponentPreview } from "./ComponentPreview";
import { EditorContext } from "./hooks";

function makeDoc(idPrefix: string) {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: idPrefix });
  editor.doc.apply([
    {
      op: "create",
      id: `${idPrefix}-p`,
      type: "page",
      parent: ROOT_ID,
      key: "a0",
      props: { name: "Page 1" },
    },
    {
      op: "create",
      id: `${idPrefix}-c`,
      type: "frame",
      parent: `${idPrefix}-p`,
      key: "a0",
      props: {
        name: "Button",
        x: 0,
        y: 0,
        width: 120,
        height: 48,
        fills: [{ type: "solid", color: "#2b4fd6" }],
      },
    },
  ]);
  editor.setPage(`${idPrefix}-p`);
  return editor;
}

describe("ComponentPreview canvas mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("redraws a team-library component preview when the open file changes", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as unknown as CanvasRenderingContext2D,
    );
    const renderSpy = vi.spyOn(CanvasRenderer.prototype, "render").mockImplementation(() => true);

    const live = makeDoc("live");
    const library = makeDoc("lib");
    const libNode = library.doc.get("lib-c");
    if (!libNode) throw new Error("missing library component");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          createElement(
            EditorContext.Provider,
            { value: live },
            createElement(ComponentPreview, { node: libNode, source: library }),
          ),
        );
      });
      const initialCalls = renderSpy.mock.calls.length;
      const beforeVersion = live.doc.version;
      expect(initialCalls).toBeGreaterThan(0);

      act(() => {
        live.doc.apply([{ op: "set", id: "live-c", prop: "name", value: "Updated open file" }]);
      });
      expect(live.doc.version).toBeGreaterThan(beforeVersion);
      expect(renderSpy.mock.calls.length).toBeGreaterThan(initialCalls);
    } finally {
      act(() => root.unmount());
    }
  });
});
