/** Polygons and stars: how many points, and how deep a star's points go. */
import type { Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { PropertyRow, PropertySection } from "@drawpane/ui";
import { Num } from "./fields";

export function ShapeSection({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const shapes = nodes.filter((n) => n.type === "polygon" || n.type === "star");
  if (shapes.length === 0 || shapes.length !== nodes.length) return null;
  const stars = shapes.filter((n) => n.type === "star");
  const allStars = stars.length === shapes.length;
  return (
    <PropertySection
      title={allStars ? "Star" : shapes.some((n) => n.type === "star") ? "Shape" : "Polygon"}
    >
      <PropertyRow>
        <Num
          editor={editor}
          nodes={shapes}
          prop="pointCount"
          label="#"
          ariaLabel={allStars ? "Points" : "Sides"}
          min={3}
          max={60}
          commit={(v) =>
            editor.setProp(
              shapes.map((n) => n.id),
              "pointCount",
              Math.min(60, Math.max(3, Math.round(v))),
              allStars ? "Points" : "Sides",
            )
          }
        />
        {allStars ? (
          <Num
            editor={editor}
            nodes={stars}
            prop="innerRadius"
            label="%"
            ariaLabel="Inner radius ratio"
            unit="%"
            min={1}
            max={100}
            scale={100}
            commit={(v) =>
              editor.setProp(
                stars.map((n) => n.id),
                "innerRadius",
                Math.min(1, Math.max(0.01, Math.round(v * 1000) / 1000)),
                "Star ratio",
              )
            }
          />
        ) : (
          <span />
        )}
      </PropertyRow>
    </PropertySection>
  );
}
