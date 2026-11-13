import { getProp, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  clampBox,
  cropFromPlacement,
  cropOfBox,
  imageRect,
  pannedCrop,
  presetBox,
} from "../src/crop";
import { Editor } from "../src/editor";
import { imagePlacement } from "../src/images";
import { Interaction, type PointerInput } from "../src/interaction";

const REF = "a".repeat(64);

describe("crop geometry", () => {
  it("places a cropped image so the crop fills the box", () => {
    // Showing the middle half of the image across a 100-wide box: the image is 200 wide.
    expect(
      imagePlacement(
        "crop",
        { width: 100, height: 50 },
        { width: 2000, height: 1000 },
        { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      ),
    ).toEqual({
      x: -50,
      y: -25,
      width: 200,
      height: 100,
      tile: false,
    });
  });

  it("starts from what a fill shows now", () => {
    // A 2:1 image filling a square box shows its middle half.
    const fill = { type: "image" as const, ref: REF, scaleMode: "fill" as const };
    const image = imageRect(fill, { width: 100, height: 100 }, { width: 2000, height: 1000 });
    expect(image).toEqual({ x: -50, y: 0, width: 200, height: 100 });
    expect(cropFromPlacement(image, { width: 100, height: 100 })).toEqual({
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      box: { x: 0, y: 0, width: 100, height: 100 },
    });
    // A fit image is smaller than its box: the box shrinks to it.
    const fit = imageRect(
      { ...fill, scaleMode: "fit" },
      { width: 100, height: 100 },
      { width: 2000, height: 1000 },
    );
    expect(cropFromPlacement(fit, { width: 100, height: 100 }).box).toEqual({
      x: 0,
      y: 25,
      width: 100,
      height: 50,
    });
  });

  it("slides the image under the box, never past its edges", () => {
    const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
    expect(pannedCrop(crop, { width: 100, height: 100 }, 20, 0).x).toBeCloseTo(0.15, 6);
    expect(pannedCrop(crop, { width: 100, height: 100 }, 500, 500)).toEqual({
      ...crop,
      x: 0,
      y: 0,
    });
    expect(pannedCrop(crop, { width: 100, height: 100 }, -500, 0).x).toBeCloseTo(0.5, 6);
  });

  it("keeps a box inside the image, at least a minimum size, and right side up", () => {
    const image = { x: -50, y: 0, width: 200, height: 100 };
    expect(clampBox({ x: -80, y: -10, width: 300, height: 50 }, image)).toEqual({
      x: -50,
      y: 0,
      width: 200,
      height: 40,
    });
    expect(clampBox({ x: 60, y: 40, width: -30, height: 0 }, image, 4)).toEqual({
      x: 30,
      y: 40,
      width: 30,
      height: 4,
    });
    expect(cropOfBox(image, { x: 0, y: 0, width: 100, height: 100 })).toEqual({
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
    });
  });

  it("makes the largest box of a preset shape, centred on the crop", () => {
    const image = { x: 0, y: 0, width: 400, height: 200 };
    expect(presetBox(image, { x: 150, y: 50, width: 100, height: 100 }, 1)).toEqual({
      x: 100,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(presetBox(image, { x: 0, y: 0, width: 10, height: 10 }, 16 / 9).x).toBe(0);
  });
});

describe("cropping a layer", () => {
  function setup() {
    const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
    editor.state.set({ role: "editor", viewport: { width: 1000, height: 800 } });
    editor.imageSize = () => ({ width: 2000, height: 1000 });
    const ops: Op[] = [
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        op: "create",
        id: "photo",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          x: 100,
          y: 100,
          width: 200,
          height: 200,
          fills: [{ type: "image", ref: REF, scaleMode: "fill" }],
        },
      },
    ];
    editor.doc.apply(ops);
    editor.setPage("p");
    return { editor, interaction: new Interaction(editor) };
  }
  const props = (editor: Editor) => editor.doc.get("photo")?.props ?? {};
  const at = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
    screen: { x, y },
    button: 0,
    shift: false,
    alt: false,
    mod: false,
    clicks: 1,
    ...extra,
  });
  /** Where the whole image is on the page, for checking it never moves while cropping. */
  const imageOnPage = (editor: Editor) => {
    const node = editor.doc.get("photo") as NodeRecord;
    const fill = getProp(node.props, "fills")[0];
    if (fill?.type !== "image") throw new Error("no image");
    const r = imageRect(
      fill,
      { width: getProp(node.props, "width"), height: getProp(node.props, "height") },
      { width: 2000, height: 1000 },
    );
    return {
      x: getProp(node.props, "x") + r.x,
      y: getProp(node.props, "y") + r.y,
      width: r.width,
      height: r.height,
    };
  };

  it("double-click enters cropping, showing what the fill showed", () => {
    const { editor, interaction } = setup();
    interaction.down(at(200, 200, { clicks: 1 }));
    interaction.up(at(200, 200));
    interaction.down(at(200, 200, { clicks: 2 }));
    interaction.up(at(200, 200));
    expect(editor.s.cropping).toEqual({ id: "photo", index: 0 });
    expect(getProp(props(editor), "fills")[0]).toMatchObject({
      scaleMode: "crop",
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    });
    // Enter or Escape finishes.
    interaction.key({ key: "Escape", shift: false, alt: false, mod: false });
    expect(editor.s.cropping).toBeNull();
  });

  it("crops with a handle and slides the image, while the image stays put", () => {
    const { editor, interaction } = setup();
    editor.select(["photo"]);
    editor.enterCrop("photo");
    const before = imageOnPage(editor);
    // Drag the right edge 50px in.
    interaction.down(at(300, 200));
    interaction.move(at(270, 200));
    interaction.move(at(250, 200));
    interaction.up(at(250, 200));
    expect([getProp(props(editor), "x"), getProp(props(editor), "width")]).toEqual([100, 150]);
    expect(imageOnPage(editor)).toEqual(before);
    // Slide the image 20px left under the box.
    interaction.down(at(150, 200));
    interaction.move(at(130, 200));
    interaction.up(at(130, 200));
    expect((getProp(props(editor), "fills")[0] as { crop: { x: number } }).crop.x).toBeCloseTo(
      0.3,
      6,
    );
    // Each drag is its own undo step.
    editor.undo();
    expect(imageOnPage(editor)).toEqual(before);
    editor.undo();
    expect(getProp(props(editor), "width")).toBe(200);
  });

  it("never crops past the image", () => {
    const { editor, interaction } = setup();
    editor.select(["photo"]);
    editor.enterCrop("photo");
    // The image extends 100px right of the box: drag the edge 400px.
    interaction.down(at(300, 200));
    interaction.move(at(700, 200));
    interaction.up(at(700, 200));
    expect(getProp(props(editor), "width")).toBe(300);
  });

  it("reshapes to a preset and leaves when the selection moves on", () => {
    const { editor } = setup();
    editor.select(["photo"]);
    editor.enterCrop("photo");
    editor.setCropAspect(16 / 9);
    expect(getProp(props(editor), "width") / getProp(props(editor), "height")).toBeCloseTo(
      16 / 9,
      2,
    );
    editor.select([]);
    expect(editor.s.cropping).toBeNull();
  });

  it("waits for the image before converting a fill", () => {
    const { editor } = setup();
    editor.imageSize = () => null;
    expect(editor.enterCrop("photo")).toBe(false);
    expect(editor.s.notice?.text).toMatch(/still loading/);
  });
});
