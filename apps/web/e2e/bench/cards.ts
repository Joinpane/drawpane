/**
 * A realistic simple file: cards of 25 layers (boards, text, shapes, icons),
 * no effects beyond a soft shadow per card. The canvas benchmark pans 400
 * of them (10,000 layers); the interaction benchmark measures on them what
 * it measures on effect-heavy files, as the reference for those.
 */
import type { Page } from "@playwright/test";

/** Fills the current page with `cards` cards of 25 layers, straight into the local document. */
export async function buildFile(page: Page, cards: number): Promise<number> {
  return page.evaluate((cards) => {
    type Op = {
      op: "create";
      id: string;
      type: string;
      parent: string;
      key: string;
      props: object;
    };
    const e = (
      window as unknown as {
        drawpane: { s: { pageId: string }; doc: { apply(ops: Op[]): void } };
      }
    ).drawpane;
    const ops: Op[] = [];
    let n = 0;
    const id = () => `bench${(n++).toString(36)}`;
    // Order keys: "a" + one base-62 digit, then "b" + two (see the model's order keys).
    const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const key = (i: number) =>
      i < 62 ? `a${DIGITS[i]}` : `b${DIGITS[Math.floor(i / 62)]}${DIGITS[i % 62]}`;
    const columns = Math.ceil(Math.sqrt(cards));
    for (let c = 0; c < cards; c++) {
      const card = id();
      const x = (c % columns) * 360;
      const y = Math.floor(c / columns) * 260;
      ops.push({
        op: "create",
        id: card,
        type: "frame",
        parent: e.s.pageId,
        key: key(c),
        props: {
          name: `Card ${c + 1}`,
          x,
          y,
          width: 320,
          height: 220,
          cornerRadius: 12,
          fills: [{ type: "solid", color: "#ffffff" }],
          strokes: [{ type: "solid", color: "#e3e1dc" }],
          effects: [{ type: "drop-shadow", color: "#0000001f", x: 0, y: 4, blur: 12, spread: 0 }],
        },
      });
      let k = 0;
      const child = (type: string, props: object) =>
        ops.push({ op: "create", id: id(), type, parent: card, key: key(k++), props });
      child("rect", {
        x: 16,
        y: 16,
        width: 288,
        height: 96,
        cornerRadius: 8,
        fills: [{ type: "solid", color: "#f1efe9" }],
      });
      child("ellipse", {
        x: 16,
        y: 124,
        width: 32,
        height: 32,
        fills: [{ type: "solid", color: "#e8590c" }],
      });
      child("text", {
        x: 56,
        y: 124,
        width: 10,
        height: 10,
        characters: `Project ${c + 1}`,
        fontSize: 15,
        fontWeight: 600,
      });
      child("text", {
        x: 56,
        y: 144,
        width: 10,
        height: 10,
        characters: "Updated just now",
        fontSize: 11,
        fills: [{ type: "solid", color: "#77746d" }],
      });
      child("text", {
        x: 16,
        y: 166,
        width: 288,
        height: 10,
        textAutoResize: "height",
        characters: "Three things on today, nothing more. Pick the one that matters.",
        fontSize: 12,
      });
      for (let i = 0; i < 4; i++) {
        child("rect", {
          x: 16 + i * 52,
          y: 196,
          width: 44,
          height: 16,
          cornerRadius: 8,
          fills: [{ type: "solid", color: i === 0 ? "#007ca5" : "#e9e7e2" }],
        });
        child("text", {
          x: 22 + i * 52,
          y: 198,
          width: 10,
          height: 10,
          characters: ["Focus", "Today", "Later", "Done"][i] as string,
          fontSize: 9,
        });
      }
      for (let i = 0; i < 6; i++)
        child("path", {
          x: 220 + (i % 3) * 28,
          y: 28 + Math.floor(i / 3) * 28,
          width: 20,
          height: 20,
          pathData: "M0 10 L10 0 L20 10 L10 20 Z",
          fills: [{ type: "solid", color: "#1c1b1a" }],
        });
      for (let i = 0; i < 5; i++)
        child("rect", {
          x: 24 + i * 36,
          y: 32 + (i % 2) * 24,
          width: 28,
          height: 20,
          cornerRadius: 4,
          fills: [{ type: "solid", color: "#d9d9d6" }],
        });
    }
    e.doc.apply(ops);
    return ops.length;
  }, cards);
}
