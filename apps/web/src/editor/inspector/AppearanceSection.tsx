/**
 * Appearance: opacity and blend mode, corner radius (one value, or each
 * corner on its own), and whether a frame clips its content.
 */
import type { Editor } from "@drawpane/editor";
import {
  BLEND_MODES,
  type BlendMode,
  getProp,
  type NodeRecord,
  propAllowed,
} from "@drawpane/model";
import { IconButton, NumberField, PropertyRow, PropertySection, Switch } from "@drawpane/ui";
import { useState } from "react";
import { common, Num, Select } from "./fields";

const BLEND_LABEL: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "Color dodge",
  "color-burn": "Color burn",
  "hard-light": "Hard light",
  "soft-light": "Soft light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};
const BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABEL[m] }));

export function AppearanceSection({
  editor,
  nodes,
  corners,
  frames,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  corners: NodeRecord[];
  frames: NodeRecord[];
}) {
  const ids = nodes.map((n) => n.id);
  const clip = common(frames, "clipContent");
  // Masks are shapes inside a group or frame (on the page they'd clip everything above).
  const maskable = nodes.filter(
    (n) => propAllowed(n.type, "isMask") && editor.doc.get(n.parent)?.type !== "page",
  );
  const rounded = nodes.filter(
    (n) => n.type === "polygon" || n.type === "star" || n.type === "frame" || n.type === "rect",
  );
  return (
    <PropertySection title="Appearance">
      <PropertyRow>
        <Num
          editor={editor}
          nodes={nodes}
          prop="opacity"
          icon="opacity"
          ariaLabel="Opacity"
          unit="%"
          min={0}
          max={100}
          scale={100}
        />
        <Select
          label="Blend mode"
          value={common(nodes, "blendMode")}
          options={BLEND_OPTIONS}
          onChange={(v) =>
            editor.setProp(ids, "blendMode", v === "normal" ? null : v, "Blend mode")
          }
        />
      </PropertyRow>
      {corners.length === nodes.length ? (
        // A new selection starts from its own corners, not the last one's mode.
        <Corners key={corners.map((n) => n.id).join()} editor={editor} nodes={corners} />
      ) : rounded.length === nodes.length ? (
        // Polygons and stars round every corner alike.
        <Num
          editor={editor}
          nodes={rounded}
          prop="cornerRadius"
          icon="radius"
          ariaLabel="Corner radius"
          min={0}
        />
      ) : null}
      {maskable.length === nodes.length ? (
        <PropertyRow columns="label">
          <span className="inspector__label">Mask</span>
          <Switch
            label="Clips the layers above"
            checked={common(maskable, "isMask") ?? false}
            onChange={(checked) =>
              editor.setProp(
                ids,
                "isMask",
                checked ? true : null,
                checked ? "Use as mask" : "Remove mask",
              )
            }
          />
        </PropertyRow>
      ) : null}
      {frames.length === nodes.length ? (
        <PropertyRow columns="label">
          <span className="inspector__label">Clip</span>
          <Switch
            label="Clip content"
            checked={clip ?? false}
            onChange={(checked) =>
              editor.setProp(
                frames.map((f) => f.id),
                "clipContent",
                checked ? null : false,
                "Clip content",
              )
            }
          />
        </PropertyRow>
      ) : null}
    </PropertySection>
  );
}

const CORNERS = [
  { label: "↖", name: "Top left", index: 0 },
  { label: "↗", name: "Top right", index: 1 },
  { label: "↙", name: "Bottom left", index: 3 },
  { label: "↘", name: "Bottom right", index: 2 },
] as const;

/** Corner radius: one value, or (with the corners toggle) each corner. */
function Corners({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  // Each corner's value across the selection, uniform radii included.
  const cornerOf = (n: NodeRecord, i: number) =>
    getProp(n.props, "cornerRadii")?.[i] ?? getProp(n.props, "cornerRadius");
  const cornerValue = (i: number) => {
    const first = nodes[0] ? cornerOf(nodes[0], i) : null;
    return nodes.every((n) => cornerOf(n, i) === first) ? first : null;
  };
  const independentNow = nodes.some((n) => getProp(n.props, "cornerRadii") !== null);
  const [wanted, setWanted] = useState(independentNow);
  const independent = independentNow || wanted;

  const toggle = () => {
    if (independent) {
      // Back to one radius: the largest corner, so nothing gets sharper than it was.
      editor.beginGesture("Uniform corners");
      for (const n of nodes) {
        const r = getProp(n.props, "cornerRadii");
        if (r) editor.setProp([n.id], "cornerRadius", Math.max(...r));
      }
      editor.setProp(ids, "cornerRadii", null);
      editor.endGesture();
      setWanted(false);
    } else {
      editor.beginGesture("Independent corners");
      for (const n of nodes) {
        const r = getProp(n.props, "cornerRadius");
        editor.setProp([n.id], "cornerRadii", [r, r, r, r]);
      }
      editor.endGesture();
      setWanted(true);
    }
  };

  const setCorner = (index: number, value: number) => {
    editor.beginGesture("Corner radius");
    for (const n of nodes) {
      const r = getProp(n.props, "cornerRadius");
      const current = getProp(n.props, "cornerRadii") ?? [r, r, r, r];
      const next = current.map((v, i) => (i === index ? Math.max(0, value) : v)) as [
        number,
        number,
        number,
        number,
      ];
      editor.setProp([n.id], "cornerRadii", next);
    }
    editor.endGesture();
  };

  return (
    <>
      <div className="inspector__corners-head">
        {independent ? (
          <span className="inspector__label">Corners</span>
        ) : (
          <Num
            editor={editor}
            nodes={nodes}
            prop="cornerRadius"
            icon="radius"
            ariaLabel="Corner radius"
            min={0}
          />
        )}
        <IconButton
          icon="corners"
          label={independent ? "One radius for every corner" : "Independent corners"}
          pressed={independent}
          onClick={toggle}
        />
      </div>
      {independent ? (
        <div className="inspector__corners">
          {CORNERS.map((c) => (
            <NumberField
              key={c.index}
              label={c.label}
              ariaLabel={`${c.name} radius`}
              min={0}
              placeholder="Mixed"
              value={cornerValue(c.index)}
              onChange={(v) => setCorner(c.index, v)}
              onScrubStart={() => editor.beginGesture("Corner radius")}
              onScrubEnd={() => editor.endGesture()}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
