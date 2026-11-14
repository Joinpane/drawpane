/**
 * Position and size: a frame's preset size and orientation, X and Y, W and H
 * with an aspect-ratio lock, rotation and flips. Constraints sit below for
 * layers their frame doesn't place by auto layout.
 */
import type { Editor } from "@drawpane/editor";
import { FRAME_PRESETS, framePreset, matchFramePreset } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { IconButton, PropertyRow, PropertySection, SegmentedControl } from "@drawpane/ui";
import { shortcutFor } from "../actions";
import { common, Num } from "./fields";

export function GeometrySection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ids = nodes.map((n) => n.id);
  const lock = common(nodes, "lockAspect");
  const only = nodes.length === 1 ? nodes[0] : undefined;
  return (
    <PropertySection title="Position and size">
      {only?.type === "frame" && getProp(only.props, "instanceOf") === null ? (
        <FrameSize editor={editor} frame={only} />
      ) : null}
      <PropertyRow>
        <Num editor={editor} nodes={nodes} prop="x" label="X" ariaLabel="X position" />
        <Num editor={editor} nodes={nodes} prop="y" label="Y" ariaLabel="Y position" />
      </PropertyRow>
      <div className="inspector__size">
        <Num
          editor={editor}
          nodes={nodes}
          prop="width"
          label="W"
          ariaLabel="Width"
          min={0}
          commit={(v) => editor.resize(ids, "width", v, "Width")}
        />
        <Num
          editor={editor}
          nodes={nodes}
          prop="height"
          label="H"
          ariaLabel="Height"
          min={0}
          commit={(v) => editor.resize(ids, "height", v, "Height")}
        />
        <IconButton
          icon="link"
          label={lock ? "Unlock aspect ratio" : "Lock aspect ratio"}
          pressed={lock === true}
          onClick={() =>
            editor.setProp(
              ids,
              "lockAspect",
              lock ? null : true,
              lock ? "Unlock aspect ratio" : "Lock aspect ratio",
            )
          }
        />
      </div>
      <div className="inspector__rotation">
        <Num
          editor={editor}
          nodes={nodes}
          prop="rotation"
          icon="rotate"
          ariaLabel="Rotation"
          unit="°"
        />
        <span className="inspector__buttons">
          <IconButton
            icon="rotate"
            label="Rotate 90°"
            onClick={() => {
              editor.beginGesture("Rotate 90°");
              for (const n of nodes) {
                const r = getProp(n.props, "rotation") + 90;
                editor.setProp([n.id], "rotation", ((((r + 180) % 360) + 360) % 360) - 180);
              }
              editor.endGesture();
            }}
          />
          <IconButton
            icon="flip-horizontal"
            label="Flip horizontal"
            shortcut={shortcutFor("arrange.flipHorizontal")}
            onClick={() => editor.flip("horizontal")}
          />
          <IconButton
            icon="flip-vertical"
            label="Flip vertical"
            shortcut={shortcutFor("arrange.flipVertical")}
            onClick={() => editor.flip("vertical")}
          />
        </span>
      </div>
    </PropertySection>
  );
}

/** A frame's preset size (or Custom), its orientation, and resize to fit. */
function FrameSize({ editor, frame }: { editor: Editor; frame: NodeRecord }) {
  const width = getProp(frame.props, "width");
  const height = getProp(frame.props, "height");
  const match = matchFramePreset(width, height);
  const portrait = height >= width;
  const auto = getProp(frame.props, "layoutMode") !== "none";
  const setSize = (w: number, h: number, label: string) => {
    editor.beginGesture(label);
    editor.setProp([frame.id], "width", w);
    editor.setProp([frame.id], "height", h);
    if (getProp(frame.props, "sizingH") !== "fixed") editor.setProp([frame.id], "sizingH", "fixed");
    if (getProp(frame.props, "sizingV") !== "fixed") editor.setProp([frame.id], "sizingV", "fixed");
    editor.endGesture();
  };
  return (
    <div className="inspector__frame-size">
      <select
        className="inspector__select"
        aria-label="Frame size"
        value={match?.id ?? ""}
        onChange={(e) => {
          const preset = framePreset(e.target.value);
          if (!preset) return;
          // Keep the frame's orientation when picking a preset.
          const flip = !portrait && preset.height > preset.width;
          setSize(
            flip ? preset.height : preset.width,
            flip ? preset.width : preset.height,
            preset.name,
          );
        }}
      >
        <option value="">Custom</option>
        {FRAME_PRESETS.map((group) => (
          <optgroup key={group.name} label={group.name}>
            {group.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="inspector__buttons">
        <SegmentedControl
          label="Orientation"
          options={[
            { value: "portrait", icon: "portrait", title: "Portrait" },
            { value: "landscape", icon: "landscape", title: "Landscape" },
          ]}
          value={portrait ? "portrait" : "landscape"}
          onChange={(next) => {
            if ((next === "portrait") !== portrait && width !== height)
              setSize(height, width, next === "portrait" ? "Portrait" : "Landscape");
          }}
        />
        <IconButton
          icon="fit"
          label={auto ? "Auto layout frames hug their content" : "Resize to fit content"}
          disabled={auto || editor.doc.childIds(frame.id).length === 0}
          onClick={() => editor.fitToContent([frame.id])}
        />
      </span>
    </div>
  );
}
