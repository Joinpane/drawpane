/** The workerd test's scene: a dashboard of cards (scripts/workerd.mjs). */
import { keyBetween, type Op, ROOT_ID } from "@drawpane/model";

/** Cards of a dashboard: a board with a gradient and an outline, text in two weights, shapes. */
export function scene(cards: number, seed: number): Op[] {
  const ops: Op[] = [
    { op: "create", id: "P", type: "page", parent: ROOT_ID, key: "a0", props: {} } as Op,
  ];
  let key: string | null = null;
  let n = 0;
  const cols = Math.ceil(Math.sqrt(cards));
  for (let i = 0; i < cards; i++) {
    key = keyBetween(key, null);
    const x = (i % cols) * 260;
    const y = Math.floor(i / cols) * 200;
    const card = `c${i}`;
    const hue = (i * 37 + seed * 11) % 360;
    ops.push({
      op: "create",
      id: card,
      type: "frame",
      parent: "P",
      key,
      props: {
        x,
        y,
        width: 240,
        height: 180,
        cornerRadius: 14,
        clipContent: true,
        fills: [
          {
            type: "linear",
            from: { x: 0, y: 0 },
            to: { x: 1, y: 1 },
            stops: [
              { position: 0, color: "#ffffff" },
              {
                position: 1,
                color: `#${((hue * 7919) & 0xffffff).toString(16).padStart(6, "0")}33`,
              },
            ],
          },
        ],
        strokes: [{ type: "solid", color: "#d6d3cc" }],
        strokeWeight: 1,
      },
    } as Op);
    let k: string | null = null;
    const child = (type: string, props: object) => {
      k = keyBetween(k, null);
      ops.push({ op: "create", id: `n${n++}`, type, parent: card, key: k, props } as Op);
    };
    child("ellipse", {
      x: x + 16,
      y: y + 16,
      width: 36,
      height: 36,
      fills: [
        {
          type: "radial",
          from: { x: 0.5, y: 0.5 },
          to: { x: 1, y: 0.5 },
          stops: [
            { position: 0, color: "#4dabf7" },
            { position: 1, color: "#1864ab" },
          ],
        },
      ],
    });
    child("text", {
      x: x + 64,
      y: y + 18,
      width: 160,
      height: 20,
      characters: `Project ${i + seed}`,
      fontFamily: "Inter",
      fontSize: 15,
      fontWeight: 600,
      textAutoResize: "none",
      fills: [{ type: "solid", color: "#212529" }],
    });
    child("text", {
      x: x + 64,
      y: y + 38,
      width: 160,
      height: 18,
      characters: "Updated 3 days ago",
      fontFamily: "Inter",
      fontSize: 12,
      fontWeight: 400,
      textAutoResize: "none",
      fills: [{ type: "solid", color: "#868e96" }],
    });
    child("rect", {
      x: x + 16,
      y: y + 72,
      width: 208,
      height: 8,
      cornerRadius: 4,
      fills: [{ type: "solid", color: "#e9ecef" }],
    });
    child("rect", {
      x: x + 16,
      y: y + 72,
      width: 40 + ((i * 53) % 160),
      height: 8,
      cornerRadius: 4,
      fills: [{ type: "solid", color: "#40c057" }],
    });
    child("text", {
      x: x + 16,
      y: y + 96,
      width: 208,
      height: 60,
      characters: "Review the onboarding flow and the billing settings before Friday's release.",
      fontFamily: "Inter",
      fontSize: 13,
      fontWeight: 400,
      textAutoResize: "height",
      fills: [{ type: "solid", color: "#495057" }],
    });
    child("path", {
      x: x + 196,
      y: y + 148,
      width: 24,
      height: 24,
      pathData: "M2 12 L9 19 L22 4",
      strokes: [{ type: "solid", color: "#2f9e44" }],
      strokeWeight: 3,
      strokeCap: "round",
      strokeJoin: "round",
      fills: [],
    });
  }
  return ops;
}
