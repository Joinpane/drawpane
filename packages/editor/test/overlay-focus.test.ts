import type { Peer } from "@drawpane/model";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { Interaction } from "../src/interaction";
import { drawOverlay, type OverlayTheme } from "../src/overlay";

const THEME: OverlayTheme = {
  signal: "#e0531f",
  componentInk: "#7a3fd1",
  onSignal: "#ffffff",
  guide: "#ff3366",
  component: "#7a3fd1",
  inkMuted: "#6b6a66",
  surfaceRaised: "#ffffff",
  xrayPadding: "#ffd36b",
  xrayGap: "#ff8ac2",
  presence: [
    "#2b4fd6",
    "#0f8a7e",
    "#c2410c",
    "#7c3aed",
    "#be185d",
    "#4d7c0f",
    "#0369a1",
    "#b45309",
  ],
  onPresence: "#ffffff",
  agent: "#7c3aed",
  onAgent: "#ffffff",
  fontUi: "Instrument Sans",
};

/**
 * A 2D context that records what's drawn: the text of every fillText, and
 * the colour every outline was stroked in. Everything else is a no-op.
 */
function recordingContext() {
  const texts: string[] = [];
  const strokes: string[] = [];
  const state: Record<string | symbol, unknown> = {
    canvas: { width: 1000, height: 600 },
    strokeStyle: "#000",
    fillStyle: "#000",
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "fillText") return (text: string) => texts.push(text);
      if (key === "measureText") return (text: string) => ({ width: text.length * 6 });
      if (key === "strokeRect" || key === "stroke")
        return () => strokes.push(String(target.strokeStyle));
      if (key === "createLinearGradient" || key === "createPattern")
        return () => ({ addColorStop() {} });
      if (key === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, strokes };
}

function setup() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
  editor.state.set({ role: "editor", viewport: { width: 1000, height: 600 } });
  editor.doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    {
      op: "create",
      id: "card",
      type: "rect",
      parent: "p1",
      key: "a0",
      props: { x: 100, y: 100, width: 200, height: 120 },
    },
  ]);
  editor.setPage("p1");
  const lena: Peer = {
    sessionId: "lena",
    userId: "u-lena",
    name: "Lena Park",
    color: 1,
    kind: "person",
    presence: { cursor: { x: 400, y: 300 }, pageId: "p1", selection: ["card"] },
  };
  editor.state.set({ peers: new Map([["lena", lena]]) });
  return { editor, interaction: new Interaction(editor) };
}

describe("focus mode", () => {
  it("draws collaborators' cursors, names and selections, and hides them all in focus mode", () => {
    const { editor, interaction } = setup();
    const lenaColor = THEME.presence[0] as string;

    const normal = recordingContext();
    drawOverlay(normal.ctx, editor, interaction, THEME, 1);
    expect(normal.texts).toContain("Lena Park");
    expect(normal.strokes).toContain(lenaColor);

    editor.state.set({ focusMode: true });
    const focused = recordingContext();
    drawOverlay(focused.ctx, editor, interaction, THEME, 1);
    expect(focused.texts).not.toContain("Lena Park");
    expect(focused.strokes).not.toContain(lenaColor);
  });
});
