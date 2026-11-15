/**
 * The credit a kit carries into the team: a small "About this kit" frame on
 * the file's first page, above its content, saying what the kit is, who made
 * it, where it's from, its licence as given, and that it was converted. It
 * travels with the file (copies, exports, libraries), which a note in the
 * store alone wouldn't, so a licence that asks for credit is honoured.
 *
 * Built on a scratch editor like the built-in templates, so text is measured
 * and laid out as the editor would, then placed into the converted nodes.
 */
import { keyBetween, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { kit as kitOf, solid } from "../new-file/kit";
import { nodesOf, type Scratch, scratchEditor } from "../new-file/scratch";

const WIDTH = 560;
const PADDING = 32;
/**
 * Text wraps at a set width, the frame's inside. (Not "fill": a wrapping text
 * that fills a frame being built has no width yet, and wrapping at none
 * never ends.)
 */
const wrap = { width: WIDTH - PADDING * 2, textAutoResize: "height" } as const;
/** Room between the credit and the content under it. */
const GAP = 120;

type Box = { x: number; y: number; width: number; height: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function boxOf(node: NodeRecord): Box | null {
  const x = num(node.props.x);
  const y = num(node.props.y);
  const width = num(node.props.width);
  const height = num(node.props.height);
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height };
}

/** The first page of converted nodes (pages hang from the root, in key order). */
export function firstPage(nodes: readonly NodeRecord[]): NodeRecord | null {
  const pages = nodes
    .filter((n) => n.type === "page" && n.parent === ROOT_ID)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return pages[0] ?? null;
}

/** Where the credit goes: above the page's content, at its left edge. */
export function placeCredit(children: readonly NodeRecord[], size: { height: number }) {
  const boxes = children.map(boxOf).filter((b): b is Box => b !== null);
  if (boxes.length === 0) return { x: 0, y: 0 };
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  return { x: left, y: top - size.height - GAP };
}

/**
 * The converted nodes with the credit added to their first page, in front of
 * everything else on it. Unchanged when there's no page.
 */
export async function withCredit(
  nodes: NodeRecord[],
  title: string,
  lines: readonly string[],
  scratch: () => Promise<Scratch> = scratchEditor,
): Promise<NodeRecord[]> {
  const page = firstPage(nodes);
  if (!page) return nodes;
  const { editor, pageId } = await scratch();
  const k = kitOf(editor);
  const frame = k.stack(pageId, "column", {
    name: "About this kit",
    width: WIDTH,
    sizingH: "fixed",
    sizingV: "hug",
    gap: 10,
    paddingTop: 28,
    paddingRight: PADDING,
    paddingBottom: 28,
    paddingLeft: PADDING,
    cornerRadius: 16,
    fills: solid("#ffffff"),
    strokes: solid("#e6e3dd"),
    strokeWeight: 1,
  });
  k.text(frame, "About this kit", {
    name: "Label",
    fontSize: 13,
    fontWeight: 600,
    fills: solid("#6f6b63"),
  });
  k.text(frame, title, {
    name: "Title",
    fontSize: 24,
    fontWeight: 600,
    fills: solid("#1c1b1a"),
    ...wrap,
  });
  for (const [i, line] of lines.entries())
    k.text(frame, line, {
      name: `Credit ${i + 1}`,
      fontSize: 14,
      lineHeight: { unit: "percent", value: 145 },
      fills: solid("#1c1b1a"),
      ...wrap,
    });

  const made = nodesOf(editor).filter((n) => n.type !== "page" && n.id !== pageId);
  const top = made.find((n) => n.id === frame);
  if (!top) return nodes;
  const children = nodes.filter((n) => n.parent === page.id);
  const lastKey = children.reduce<string | null>(
    (max, n) => (max === null || n.key > max ? n.key : max),
    null,
  );
  const at = placeCredit(children, { height: num(top.props.height) ?? 200 });
  const placed = made.map((n) =>
    n.id === frame
      ? {
          ...n,
          parent: page.id,
          key: keyBetween(lastKey, null),
          props: { ...n.props, x: at.x, y: at.y },
        }
      : n,
  );
  return [...nodes, ...placed];
}
