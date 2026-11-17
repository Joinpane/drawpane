/**
 * Instances whose nested instance is swapped for another component (an
 * icon swapped in a button, as UI kits do everywhere): they stay
 * instances through the whole import, `convertFile`, `pinInstances` and
 * the compact form (`compactByInstance`, run before upload).
 *
 * Figma names a layer inside a copy by its path of instances, the last
 * element the layer in the innermost one's component: under a swapped
 * instance, that's the swapped-in component's layer, so that's what it
 * copies; under an instance put in a slot (copying nothing), its own
 * component's. Content a main put in its nested instance's slot is named
 * under the slot in the main and without it in the main's copies.
 */
import { pinInstances } from "@drawpane/editor";
import { convertFile, drawpaneId, type Figma } from "@drawpane/figma";
import { compactByInstance, expand, getProp, type NodeRecord } from "@drawpane/model";
import { describe, expect, it } from "vitest";

const node = (n: Partial<Figma.Node> & { id: string; type: string }): Figma.Node =>
  ({
    name: n.type.toLowerCase(),
    size: { x: 16, y: 16 },
    relativeTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    ...n,
  }) as Figma.Node;
const rect = (id: string, name: string) =>
  node({
    id,
    type: "RECTANGLE",
    name,
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
  });
const instance = (id: string, componentId: string, children: Figma.Node[], name = "Icon") =>
  node({ id, type: "INSTANCE", name, componentId, children });
const component = (id: string, name: string, children: Figma.Node[]) =>
  node({ id, type: "COMPONENT", name, children });
const file = (...children: Figma.Node[]): Figma.File => ({
  name: "Swaps",
  document: node({
    id: "0:0",
    type: "DOCUMENT",
    children: [node({ id: "0:1", type: "CANVAS", name: "Page", children })],
  }),
});

/**
 * Two icons of different shapes; a placeholder showing the first; a button
 * whose placeholder shows the second (swapped in the main); a button copy
 * as its main has it; one swapped back to the first; and a placeholder
 * copy swapped in a screen.
 */
const kit = () =>
  file(
    component("1:1", "Icon A", [rect("1:2", "A")]),
    component("1:3", "Icon B", [rect("1:4", "B top"), rect("1:5", "B bottom")]),
    component("2:1", "Placeholder", [instance("2:2", "1:1", [rect("I2:2;1:2", "A")])]),
    component("3:1", "Button", [
      instance(
        "3:2",
        "2:1",
        [
          // Resized too, so it differs from its own component, not only from the layer it copies.
          {
            ...instance("I3:2;2:2", "1:3", [
              rect("I3:2;2:2;1:4", "B top"),
              rect("I3:2;2:2;1:5", "B bottom"),
            ]),
            size: { x: 24, y: 24 },
          },
        ],
        "Placeholder",
      ),
    ]),
    instance(
      "4:1",
      "3:1",
      [
        instance(
          "I4:1;3:2",
          "2:1",
          [
            {
              ...instance("I4:1;3:2;2:2", "1:3", [
                rect("I4:1;3:2;2:2;1:4", "B top"),
                rect("I4:1;3:2;2:2;1:5", "B bottom"),
              ]),
              size: { x: 24, y: 24 },
            },
          ],
          "Placeholder",
        ),
      ],
      "Button",
    ),
    instance(
      "4:2",
      "3:1",
      [
        instance(
          "I4:2;3:2",
          "2:1",
          [instance("I4:2;3:2;2:2", "1:1", [rect("I4:2;3:2;2:2;1:2", "A")])],
          "Placeholder",
        ),
      ],
      "Button",
    ),
    instance(
      "4:3",
      "2:1",
      [
        instance("I4:3;2:2", "1:3", [
          rect("I4:3;2:2;1:4", "B top"),
          rect("I4:3;2:2;1:5", "B bottom"),
        ]),
      ],
      "Placeholder",
    ),
  );

const get = (nodes: readonly NodeRecord[], figmaId: string) =>
  nodes.find((n) => n.id === drawpaneId(figmaId)) as NodeRecord;

describe("nested instances swapped, or put in a slot", () => {
  it("copies the swapped-in component's layers, and says it's swapped", () => {
    const { nodes } = convertFile(kit());
    // In the main: the placeholder's icon is the second icon, its layers that icon's.
    expect(get(nodes, "I3:2;2:2").props).toMatchObject({
      instanceOf: drawpaneId("1:3"),
      mirrors: drawpaneId("2:2"),
      overrides: ["instanceOf", "width", "height"],
    });
    expect(getProp(get(nodes, "I3:2;2:2;1:4").props, "mirrors")).toBe(drawpaneId("1:4"));
    // A copy as its main has it copies the main's copies.
    expect(getProp(get(nodes, "I4:1;3:2;2:2").props, "overrides")).toEqual([]);
    expect(getProp(get(nodes, "I4:1;3:2;2:2;1:4").props, "mirrors")).toBe(
      drawpaneId("I3:2;2:2;1:4"),
    );
    // Swapped back in a copy: the first icon's layer.
    expect(getProp(get(nodes, "I4:2;3:2;2:2").props, "overrides")).toContain("instanceOf");
    expect(getProp(get(nodes, "I4:2;3:2;2:2;1:2").props, "mirrors")).toBe(drawpaneId("1:2"));
    expect(getProp(get(nodes, "I4:3;2:2;1:5").props, "mirrors")).toBe(drawpaneId("1:5"));
  });

  it("in slot content, copies its own component's layers", () => {
    // A card with an empty slot, and a copy whose slot holds an icon: the icon is the copy's own
    // layer (it copies nothing), named under the slot, and its layers are the icon's.
    const { nodes } = convertFile(
      file(
        component("1:3", "Icon B", [rect("1:4", "B top"), rect("1:5", "B bottom")]),
        component("5:0", "Card", [node({ id: "5:2", type: "FRAME", name: "Slot", children: [] })]),
        instance(
          "5:1",
          "5:0",
          [
            node({
              id: "I5:1;5:2",
              type: "FRAME",
              name: "Slot",
              children: [
                instance("I5:1;5:2;6:1", "1:3", [
                  rect("I5:1;5:2;6:1;1:4", "B top"),
                  rect("I5:1;5:2;6:1;1:5", "B bottom"),
                ]),
              ],
            }),
          ],
          "Card",
        ),
      ),
    );
    expect(getProp(get(nodes, "I5:1;5:2").props, "mirrors")).toBe(drawpaneId("5:2"));
    expect(get(nodes, "I5:1;5:2;6:1").props).toMatchObject({ instanceOf: drawpaneId("1:3") });
    expect(getProp(get(nodes, "I5:1;5:2;6:1").props, "mirrors")).toBeNull();
    expect(getProp(get(nodes, "I5:1;5:2;6:1;1:4").props, "mirrors")).toBe(drawpaneId("1:4"));
    expect(getProp(get(nodes, "I5:1;5:2;6:1;1:5").props, "mirrors")).toBe(drawpaneId("1:5"));
  });

  it("copies what a main put in its nested instance's slot, named without the slot in copies", () => {
    // A group whose slot shows a key by default, a button whose group's slot shows another key,
    // and a copy of the button: Figma names the key under the slot in the button, and without
    // the slot in the copy.
    const keyLayers = (prefix: string) => [rect(`${prefix}7:2`, "Cap")];
    const nodes = convertFile(
      file(
        component("7:1", "Key", keyLayers("")),
        component("8:0", "Group", [
          node({
            id: "8:1",
            type: "FRAME",
            name: "Items",
            children: [instance("8:2", "7:1", keyLayers("I8:2;"), "Key")],
          }),
        ]),
        component("9:0", "Button", [
          instance(
            "9:1",
            "8:0",
            [
              node({
                id: "I9:1;8:1",
                type: "FRAME",
                name: "Items",
                children: [instance("I9:1;8:1;9:5", "7:1", keyLayers("I9:1;8:1;9:5;"), "Key")],
              }),
            ],
            "Group",
          ),
        ]),
        instance(
          "10:0",
          "9:0",
          [
            instance(
              "I10:0;9:1",
              "8:0",
              [
                node({
                  id: "I10:0;9:1;8:1",
                  type: "FRAME",
                  name: "Items",
                  children: [instance("I10:0;9:1;9:5", "7:1", keyLayers("I10:0;9:1;9:5;"), "Key")],
                }),
              ],
              "Group",
            ),
          ],
          "Button",
        ),
      ),
    ).nodes;
    // In the button, the key copies nothing (its group's main has another): its layer is the key's.
    expect(getProp(get(nodes, "I9:1;8:1;9:5").props, "mirrors")).toBeNull();
    expect(getProp(get(nodes, "I9:1;8:1;9:5;7:2").props, "mirrors")).toBe(drawpaneId("7:2"));
    // In the copy, it copies the button's key, and its layer the button's key's layer.
    expect(getProp(get(nodes, "I10:0;9:1;9:5").props, "mirrors")).toBe(drawpaneId("I9:1;8:1;9:5"));
    expect(getProp(get(nodes, "I10:0;9:1;9:5;7:2").props, "mirrors")).toBe(
      drawpaneId("I9:1;8:1;9:5;7:2"),
    );
    // The button's group isn't its main as it is (another key in its slot), so it's unlinked, and
    // its copies with it; the copy of the button, and the keys, stay instances.
    const pinned = pinInstances(nodes);
    expect(pinned.detached).toBe(1);
    const linked = (figmaId: string) =>
      getProp(get(pinned.nodes, figmaId).props, "instanceOf") !== null;
    expect(["10:0", "I9:1;8:1;9:5", "I10:0;9:1;9:5"].map(linked)).toEqual([true, true, true]);
    expect(["9:1", "I10:0;9:1"].map(linked)).toEqual([false, false]);
    expect([...compactByInstance(pinned.nodes).detached]).toEqual([]);
  });

  it("stays an instance through the import, and compacts with nothing detached", () => {
    const pinned = pinInstances(convertFile(kit()).nodes);
    expect(pinned.detached).toBe(0);
    const compact = compactByInstance(pinned.nodes);
    expect([...compact.detached]).toEqual([]);
    // Every copy is presented from its main: no stored layer is left under an instance.
    const instances = new Set(
      compact.nodes.filter((n) => n.type === "frame" && n.props.instanceOf).map((n) => n.id),
    );
    expect(compact.nodes.filter((n) => n.type !== "override" && instances.has(n.parent))).toEqual(
      [],
    );
    // And it shows what it showed: expanded again, the same layers, ids renamed.
    const back = expand(compact.nodes);
    expect(back.length).toBe(pinned.nodes.length);
  });
});
