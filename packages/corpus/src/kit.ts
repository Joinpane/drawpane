/**
 * A file shaped like a real UI kit, at any size: what Drawpane has to open,
 * draw, edit and store when someone brings in a design system.
 *
 * - **Icons** (small vector mains), used everywhere.
 * - **Atoms** (buttons, inputs, badges, avatars, checkboxes): auto layout
 *   frames with text and copies of icons.
 * - **Molecules** (cards, table rows, nav items, dialogs, lists): auto layout
 *   built of copies of atoms and icons.
 * - **Blocks**: pages of screens (a sidebar of nav items, a header, a grid of
 *   cards, a table) made of copies, until the file has the layers asked for.
 *
 * Copies are made with the editor's `instantiateOps` and laid out with its
 * layout engine, so they're exactly what Drawpane stores: materialized,
 * `mirrors`-linked layers. The same seed makes the same file (ids aside).
 * Measured against the shadcn/ui Pro kit: its converted layers come to 410
 * to 510 bytes of JSON each; these come to about the same.
 */
import { Doc, instantiateOps, layoutOps } from "@drawpane/editor";
import { keysBetween, type NodeRecord, newId, type Op, ROOT_ID } from "@drawpane/model";

export interface KitOptions {
  /** Layers to make, about (pages not counted); the last screen may go a little over. */
  readonly layers: number;
  readonly seed?: number;
  /** Most layers on one page of blocks before the next page starts. */
  readonly pageLayers?: number;
}

export interface Kit {
  readonly nodes: NodeRecord[];
  readonly stats: {
    readonly layers: number;
    readonly pages: number;
    readonly mains: number;
    readonly instances: number;
    /** JSON bytes of the nodes, as an import sends them. */
    readonly bytes: number;
  };
  /** The main components most used, most first: what an edit to a main is measured on. */
  readonly busiestMains: readonly { readonly id: string; readonly copies: number }[];
}

/** mulberry32: small, fast and the same everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
  };
}

const solid = (color: string) => [{ type: "solid", color }];
const INK = "#1c1b1a";
const MUTED = "#77746d";
const LINE = "#e3e1dc";
const SURFACE = "#ffffff";
const WORDS =
  "account billing project team settings invite member review export import share archive draft publish schedule message inbox search filter status overview revenue orders customers report analytics weekly monthly pending active paused".split(
    " ",
  );

export function generateKit(options: KitOptions): Kit {
  const r = random(options.seed ?? 1);
  const pageLayers = options.pageLayers ?? 40_000;
  const doc = new Doc();
  const pageKeys = keysBetween(null, null, 200);
  let pageCount = 0;
  let layers = 0;
  const mains: string[] = [];

  const words = (n: number) => Array.from({ length: n }, () => r.pick(WORDS)).join(" ");
  const textWidth = (text: string, size: number) => Math.ceil(text.length * size * 0.55);

  const page = (name: string): string => {
    const id = newId();
    doc.apply([
      {
        op: "create",
        id,
        type: "page",
        parent: ROOT_ID,
        key: pageKeys[pageCount++] as string,
        props: { name },
      } as Op,
    ]);
    return id;
  };

  /** Children's keys, handed out in order under each parent. */
  const nextKey = new Map<string, number>();
  const KEYS = keysBetween(null, null, 4000);
  const key = (parent: string) => {
    const i = nextKey.get(parent) ?? 0;
    nextKey.set(parent, i + 1);
    return KEYS[i] as string;
  };

  const create = (type: string, parent: string, props: Record<string, unknown>): string => {
    const id = newId();
    doc.apply([{ op: "create", id, type, parent, key: key(parent), props } as Op]);
    layers++;
    return id;
  };
  const text = (parent: string, characters: string, size = 14, color = INK, weight = 400) =>
    create("text", parent, {
      name: characters.slice(0, 40),
      characters,
      fontSize: size,
      fontWeight: weight,
      width: textWidth(characters, size),
      height: Math.round(size * 1.4),
      sizingH: "hug",
      sizingV: "hug",
      fills: solid(color),
    });
  const copy = (main: string, parent: string, x = 0, y = 0): string => {
    const made = instantiateOps(doc, main, parent, key(parent), { x, y });
    if (!made) throw new Error(`Not a component: ${main}`);
    doc.apply(made.ops);
    layers += made.ops.length;
    return made.rootId;
  };
  const laidOut = (id: string) => {
    const ops = layoutOps(doc, [id]);
    if (ops.length > 0) doc.apply(ops);
  };
  const frame = (parent: string, props: Record<string, unknown>) =>
    create("frame", parent, { fills: [], clipContent: false, ...props });
  const main = (parent: string, props: Record<string, unknown>, build: (id: string) => void) => {
    const id = frame(parent, { ...props, isComponent: true });
    build(id);
    laidOut(id);
    mains.push(id);
    return id;
  };
  const row = (gap: number, padding: number) => ({
    layoutMode: "row",
    gap,
    paddingTop: padding,
    paddingBottom: padding,
    paddingLeft: padding * 2,
    paddingRight: padding * 2,
    alignItems: "center",
    sizingH: "hug",
    sizingV: "hug",
  });
  const column = (gap: number, padding: number) => ({
    layoutMode: "column",
    gap,
    paddingTop: padding,
    paddingBottom: padding,
    paddingLeft: padding,
    paddingRight: padding,
    sizingH: "hug",
    sizingV: "hug",
  });

  // Icons: a 24 px frame of one to three stroked paths, about 200 characters of path data each.
  const iconsPage = page("Icons");
  const icons: string[] = [];
  for (let i = 0; i < 160; i++)
    icons.push(
      main(
        iconsPage,
        {
          name: `Icon / ${r.pick(WORDS)}-${i}`,
          x: (i % 20) * 48,
          y: Math.floor(i / 20) * 48,
          width: 24,
          height: 24,
        },
        (icon) => {
          for (let p = r.int(1, 3); p > 0; p--) {
            let d = `M${r.int(2, 22)} ${r.int(2, 22)}`;
            for (let c = r.int(4, 9); c > 0; c--)
              d += ` C${r.int(0, 24)} ${r.int(0, 24)} ${r.int(0, 24)} ${r.int(0, 24)} ${r.int(0, 24)} ${r.int(0, 24)}`;
            create("path", icon, {
              name: "Vector",
              x: 0,
              y: 0,
              width: 24,
              height: 24,
              pathData: d,
              strokes: solid(INK),
              strokeWeight: 1.5,
            });
          }
        },
      ),
    );

  // Atoms.
  const atomsPage = page("Atoms");
  const atoms: {
    buttons: string[];
    inputs: string[];
    badges: string[];
    avatars: string[];
    checks: string[];
  } = { buttons: [], inputs: [], badges: [], avatars: [], checks: [] };
  let at = 0;
  const place = () => ({ x: (at % 8) * 220, y: Math.floor(at++ / 8) * 80 });
  for (const variant of ["Primary", "Secondary", "Ghost", "Outline", "Danger", "Link"])
    for (const size of ["Small", "Medium", "Large"])
      atoms.buttons.push(
        main(
          atomsPage,
          {
            name: `Button / ${variant} / ${size}`,
            ...place(),
            ...row(8, 8),
            cornerRadius: 8,
            fills: solid(variant === "Primary" ? INK : SURFACE),
            strokes: variant === "Outline" ? solid(LINE) : [],
          },
          (b) => {
            copy(r.pick(icons), b);
            text(
              b,
              words(r.int(1, 2)),
              size === "Small" ? 12 : 14,
              variant === "Primary" ? SURFACE : INK,
              600,
            );
          },
        ),
      );
  for (const state of ["Default", "Focus", "Error", "Disabled"])
    atoms.inputs.push(
      main(
        atomsPage,
        {
          name: `Input / ${state}`,
          ...place(),
          ...row(8, 10),
          width: 280,
          sizingH: "fixed",
          cornerRadius: 8,
          fills: solid(SURFACE),
          strokes: solid(LINE),
        },
        (f) => {
          copy(r.pick(icons), f);
          text(f, words(2), 14, MUTED);
        },
      ),
    );
  for (const tone of ["Neutral", "Success", "Warning", "Danger", "Info"])
    atoms.badges.push(
      main(
        atomsPage,
        {
          name: `Badge / ${tone}`,
          ...place(),
          ...row(4, 2),
          cornerRadius: 999,
          fills: solid("#f1efe9"),
        },
        (f) => {
          text(f, r.pick(WORDS), 11, INK, 600);
        },
      ),
    );
  for (let i = 0; i < 4; i++)
    atoms.avatars.push(
      main(
        atomsPage,
        {
          name: `Avatar / ${i}`,
          ...place(),
          width: 32,
          height: 32,
          cornerRadius: 16,
          fills: solid("#d9d9d6"),
        },
        (f) => {
          create("ellipse", f, {
            name: "Photo",
            x: 0,
            y: 0,
            width: 32,
            height: 32,
            fills: solid("#c7c4bd"),
          });
          text(f, "AB", 12, INK, 600);
        },
      ),
    );
  for (const state of ["Off", "On"])
    atoms.checks.push(
      main(
        atomsPage,
        { name: `Checkbox / ${state}`, ...place(), ...row(8, 0), paddingLeft: 0, paddingRight: 0 },
        (f) => {
          const box = frame(f, {
            name: "Box",
            width: 16,
            height: 16,
            cornerRadius: 4,
            strokes: solid(INK),
          });
          if (state === "On") copy(icons[0] as string, box);
          text(f, words(2), 14);
        },
      ),
    );

  // Molecules.
  const moleculesPage = page("Molecules");
  at = 0;
  const molecules: { cards: string[]; rows: string[]; navs: string[]; dialogs: string[] } = {
    cards: [],
    rows: [],
    navs: [],
    dialogs: [],
  };
  const molPlace = () => ({ x: (at % 6) * 420, y: Math.floor(at++ / 6) * 420 });
  for (let i = 0; i < 16; i++)
    molecules.navs.push(
      main(
        moleculesPage,
        { name: `Nav item / ${i}`, ...molPlace(), ...row(10, 6), cornerRadius: 6 },
        (f) => {
          copy(r.pick(icons), f);
          text(f, words(r.int(1, 2)), 14);
          if (i % 3 === 0) copy(r.pick(atoms.badges), f);
        },
      ),
    );
  for (let i = 0; i < 20; i++)
    molecules.cards.push(
      main(
        moleculesPage,
        {
          name: `Card / ${i}`,
          ...molPlace(),
          ...column(16, 24),
          width: 340,
          sizingH: "fixed",
          cornerRadius: 12,
          fills: solid(SURFACE),
          strokes: solid(LINE),
        },
        (f) => {
          const head = frame(f, { name: "Header", ...row(12, 0), paddingLeft: 0, paddingRight: 0 });
          copy(r.pick(atoms.avatars), head);
          const names = frame(head, { name: "Title", ...column(2, 0) });
          text(names, words(2), 15, INK, 600);
          text(names, words(3), 12, MUTED);
          laidOut(names);
          laidOut(head);
          text(f, words(r.int(10, 22)), 13, MUTED);
          if (i % 2 === 0) for (let k = 0; k < r.int(2, 4); k++) copy(r.pick(atoms.checks), f);
          const actions = frame(f, {
            name: "Actions",
            ...row(8, 0),
            paddingLeft: 0,
            paddingRight: 0,
          });
          for (let k = 0; k < r.int(1, 3); k++) copy(r.pick(atoms.buttons), actions);
          laidOut(actions);
        },
      ),
    );
  for (let i = 0; i < 10; i++)
    molecules.rows.push(
      main(
        moleculesPage,
        { name: `Table row / ${i}`, ...molPlace(), ...row(16, 10), strokes: solid(LINE) },
        (f) => {
          copy(r.pick(atoms.checks), f);
          for (let k = 0; k < 4; k++) text(f, words(r.int(1, 3)), 13);
          copy(r.pick(atoms.badges), f);
          copy(r.pick(atoms.buttons), f);
        },
      ),
    );
  for (let i = 0; i < 6; i++)
    molecules.dialogs.push(
      main(
        moleculesPage,
        {
          name: `Dialog / ${i}`,
          ...molPlace(),
          ...column(16, 24),
          width: 420,
          sizingH: "fixed",
          cornerRadius: 16,
          fills: solid(SURFACE),
          effects: [{ type: "drop-shadow", color: "#0000001f", x: 0, y: 8, blur: 24, spread: 0 }],
        },
        (f) => {
          text(f, words(3), 18, INK, 600);
          text(f, words(r.int(12, 24)), 13, MUTED);
          for (let k = 0; k < 2; k++) copy(r.pick(atoms.inputs), f);
          const actions = frame(f, {
            name: "Actions",
            ...row(8, 0),
            paddingLeft: 0,
            paddingRight: 0,
          });
          copy(atoms.buttons[3] as string, actions);
          copy(atoms.buttons[1] as string, actions);
          laidOut(actions);
        },
      ),
    );

  // Blocks: screens of copies until the file is big enough.
  let blocks = 0;
  let blockPage = "";
  let onPage = 0;
  let screen = 0;
  while (layers < options.layers) {
    if (!blockPage || onPage >= pageLayers) {
      blockPage = page(`Blocks ${++blocks}`);
      onPage = 0;
      screen = 0;
    }
    const before = layers;
    const s = frame(blockPage, {
      name: `Screen ${screen + 1}`,
      x: (screen % 6) * 1600,
      y: Math.floor(screen / 6) * 1100,
      width: 1440,
      height: 960,
      layoutMode: "row",
      fills: solid("#faf9f7"),
      clipContent: true,
    });
    screen++;
    const side = frame(s, {
      name: "Sidebar",
      ...column(4, 16),
      sizingV: "fill",
      width: 240,
      sizingH: "fixed",
      fills: solid(SURFACE),
    });
    for (let k = 0; k < r.int(8, 14); k++) copy(r.pick(molecules.navs), side);
    const main_ = frame(s, {
      name: "Content",
      ...column(24, 32),
      sizingH: "fill",
      sizingV: "fill",
    });
    const header = frame(main_, { name: "Header", ...row(12, 0), paddingLeft: 0, paddingRight: 0 });
    text(header, words(3), 24, INK, 700);
    for (let k = 0; k < 2; k++) copy(r.pick(atoms.buttons), header);
    const grid = frame(main_, {
      name: "Cards",
      layoutMode: "row",
      gap: 16,
      sizingH: "fill",
      sizingV: "hug",
    });
    for (let k = 0; k < r.int(3, 8); k++) copy(r.pick(molecules.cards), grid);
    const table = frame(main_, {
      name: "Table",
      ...column(0, 0),
      sizingH: "fill",
      fills: solid(SURFACE),
      cornerRadius: 12,
      strokes: solid(LINE),
    });
    for (let k = 0; k < r.int(6, 16); k++) copy(r.pick(molecules.rows), table);
    if (screen % 4 === 0) copy(r.pick(molecules.dialogs), s, 520, 200);
    laidOut(s);
    onPage += layers - before;
  }

  const nodes = [...doc.nodes()];
  let bytes = 0;
  for (const n of nodes) bytes += JSON.stringify(n).length + 1;
  // Every copy, nested ones included (an icon in a button in a card on a screen).
  const used = new Map<string, number>();
  for (const n of nodes)
    if (typeof n.props.instanceOf === "string")
      used.set(n.props.instanceOf, (used.get(n.props.instanceOf) ?? 0) + 1);
  const busiestMains = [...used]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, n]) => ({ id, copies: n }));
  return {
    nodes,
    stats: {
      layers,
      pages: pageCount,
      mains: mains.length,
      instances: [...used.values()].reduce((a, b) => a + b, 0),
      bytes,
    },
    busiestMains,
  };
}
