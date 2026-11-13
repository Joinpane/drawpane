/**
 * The bar under an image being cropped, after the design sheet: aspect
 * presets (Free, 1:1, 4:3, 16:9) and Done. Free leaves the crop as it is;
 * a preset reshapes it to the largest box of that shape inside the image.
 */
import {
  apply,
  boundsOfPoints,
  croppableImage,
  type Editor,
  imageRect,
  type Rect,
  unionRects,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { Button, SegmentedControl } from "@drawpane/ui";
import { useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";

const PRESETS = [
  { value: "free", label: "Free", ratio: null },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
] as const;
type Preset = (typeof PRESETS)[number]["value"];

export function CropBar() {
  const editor = useEditor();
  useDocVersion();
  const cropping = useEditorState((s) => s.cropping);
  const camera = useEditorState((s) => s.camera);
  const viewport = useEditorState((s) => s.viewport);
  const gesture = useEditorState((s) => s.gesture);
  const [preset, setPreset] = useState<Preset>("free");
  const [croppingId, setCroppingId] = useState<string | null>(null);
  // A new crop session starts free.
  if ((cropping?.id ?? null) !== croppingId) {
    setCroppingId(cropping?.id ?? null);
    setPreset("free");
  }
  if (!cropping || gesture) return null;
  const bounds = cropArea(editor, cropping.id);
  if (!bounds) return null;
  const bottom = camera.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });
  const top = camera.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y });
  // Under the size pill, or above the image when there's no room below.
  const below = bottom.y + 40 + 44 < viewport.height;
  const y = below ? bottom.y + 36 : top.y - 52;
  return (
    <div
      className="crop-bar pane"
      role="toolbar"
      aria-label="Crop"
      style={{ left: bottom.x, top: Math.max(64, y) }}
    >
      <SegmentedControl
        label="Crop shape"
        options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
        value={preset}
        onChange={(value) => {
          setPreset(value);
          const ratio = PRESETS.find((p) => p.value === value)?.ratio ?? null;
          editor.setCropAspect(ratio);
        }}
      />
      <Button variant="primary" size="sm" onClick={() => editor.exitCrop()}>
        Done
      </Button>
    </div>
  );
}

/** The page area a crop covers: the layer and the whole image around it, so the bar clears both. */
function cropArea(editor: Editor, id: string): Rect | null {
  const node = editor.doc.get(id);
  const bounds = editor.scene.bounds(id);
  const image = croppableImage(node);
  if (!node || !bounds || !image) return bounds;
  const box = { width: getProp(node.props, "width"), height: getProp(node.props, "height") };
  const r = imageRect(image.paint, box, { width: 1, height: 1 });
  const m = editor.scene.worldMatrix(id);
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ].map((p) => apply(m, p));
  return unionRects([bounds, boundsOfPoints(corners) ?? bounds]);
}
