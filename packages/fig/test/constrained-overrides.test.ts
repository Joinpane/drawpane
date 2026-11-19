/**
 * A constrained child of a copy frame its instance resized (review 8 of #187,
 * B1): its place and size are laid out only where they're what its
 * constraints derive from its main layer's (`constrainedValues`). Anything
 * else is a person's change, kept as an override: imports mark it, and sync
 * keeps it. Each constraint, for place and size, through the REST
 * importer's `markOverrides` and through `pinInstances`, which every import
 * runs.
 */
import { Doc, pinInstances, syncInstanceOps } from "@drawpane/editor";
import { convertFile, type Figma } from "@drawpane/figma";
import { getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

type Constraint = "start" | "end" | "center" | "stretch" | "scale";

/**
 * The main is 100 wide, its child 20 wide at x 10; the instance is 200 wide.
 * What each constraint gives the child there: its place and size.
 */
const DERIVED: Record<Constraint, { x: number; width: number }> = {
  start: { x: 10, width: 20 },
  end: { x: 110, width: 20 },
  center: { x: 60, width: 20 },
  stretch: { x: 10, width: 120 },
  scale: { x: 20, width: 40 },
};
const FIGMA: Record<Constraint, string> = {
  start: "LEFT",
  end: "RIGHT",
  center: "CENTER",
  stretch: "LEFT_RIGHT",
  scale: "SCALE",
};
const CONSTRAINTS = Object.keys(DERIVED) as Constraint[];

/** What the copied child holds: as derived, moved by 30, or resized by 30. */
type Shape = "derived" | "moved" | "resized";
const childOf = (c: Constraint, shape: Shape) => ({
  x: DERIVED[c].x + (shape === "moved" ? 30 : 0),
  width: DERIVED[c].width + (shape === "resized" ? 30 : 0),
});

/** The file as Drawpane holds it, before `pinInstances`. */
function nodes(c: Constraint, shape: Shape): NodeRecord[] {
  const child = childOf(c, shape);
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("main", "frame", "p", "a0", { isComponent: true, width: 100, height: 100 }),
    node("r", "rect", "main", "a0", { x: 10, y: 10, width: 20, height: 20, constraintH: c }),
    node("i", "frame", "p", "a1", { instanceOf: "main", width: 200, height: 100 }),
    node("ir", "rect", "i", "a0", {
      mirrors: "r",
      x: child.x,
      y: 10,
      width: child.width,
      height: 20,
      constraintH: c,
    }),
  ];
}

const figmaNode = (n: Partial<Figma.Node> & { id: string; type: string }) =>
  ({ name: n.type.toLowerCase(), ...n }) as Figma.Node;
const at = (x: number, y: number): Figma.Transform => [
  [1, 0, x],
  [0, 1, y],
];

/** The same file as Figma's REST API gives it. */
function restFile(c: Constraint, shape: Shape): Figma.File {
  const child = childOf(c, shape);
  const constraints = { horizontal: FIGMA[c], vertical: "TOP" };
  return {
    name: "Constrained",
    document: figmaNode({
      id: "0:0",
      type: "DOCUMENT",
      children: [
        figmaNode({
          id: "0:1",
          type: "CANVAS",
          children: [
            figmaNode({
              id: "1:1",
              type: "COMPONENT",
              size: { x: 100, y: 100 },
              relativeTransform: at(0, 0),
              children: [
                figmaNode({
                  id: "1:2",
                  type: "RECTANGLE",
                  size: { x: 20, y: 20 },
                  relativeTransform: at(10, 10),
                  constraints,
                }),
              ],
            }),
            figmaNode({
              id: "2:1",
              type: "INSTANCE",
              componentId: "1:1",
              size: { x: 200, y: 100 },
              relativeTransform: at(200, 0),
              children: [
                figmaNode({
                  id: "I2:1;1:2",
                  type: "RECTANGLE",
                  size: { x: child.width, y: 20 },
                  relativeTransform: at(child.x, 10),
                  constraints,
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  };
}

/** What the child is marked for, and holds after the instance syncs. */
function afterSync(stored: readonly NodeRecord[], instance: string, child: string) {
  const doc = new Doc({ compactCopies: false });
  doc.resetStored(structuredClone([...stored]), "materialized");
  const marked = [...getProp(doc.get(child)?.props ?? {}, "overrides")].sort();
  doc.apply(syncInstanceOps(doc, instance));
  const props = doc.get(child)?.props ?? {};
  return { marked, x: getProp(props, "x"), width: getProp(props, "width") };
}

/** What a shape is marked for: the place or size that isn't what the constraint derives. */
const expectedMarks = (shape: Shape): string[] => {
  if (shape === "moved") return ["x"];
  if (shape === "resized") return ["width"];
  return [];
};

describe("a constrained child of a resized copy (review 8 of #187, B1)", () => {
  for (const c of CONSTRAINTS)
    for (const shape of ["derived", "moved", "resized"] as const) {
      const child = childOf(c, shape);
      const label = `${c}, ${shape === "derived" ? "as derived" : shape}`;

      it(`pinInstances keeps it: ${label}`, () => {
        const pinned = pinInstances(nodes(c, shape));
        expect(pinned.detached).toBe(0);
        expect(afterSync(pinned.nodes, "i", "ir")).toEqual({
          marked: expectedMarks(shape),
          ...child,
        });
      });

      it(`the REST importer marks it, and sync keeps it: ${label}`, () => {
        const converted = convertFile(restFile(c, shape)).nodes;
        expect(afterSync(converted, "f2-1", "fI2-1_1-2")).toEqual({
          marked: expectedMarks(shape),
          ...child,
        });
        // And through pinInstances after it, as every import runs.
        const pinned = pinInstances(converted);
        expect(afterSync(pinned.nodes, "f2-1", "fI2-1_1-2")).toEqual({
          marked: expectedMarks(shape),
          ...child,
        });
      });
    }
});
