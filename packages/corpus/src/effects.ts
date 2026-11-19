/**
 * A file shaped like a large phone UI kit's screens, at the effects that
 * cost the most to draw: what the interaction benchmark measures when no
 * licensed kit is at hand.
 *
 * Each screen is a phone-sized board over a gradient wallpaper with soft
 * blobs (one a little blurred), and on it:
 *
 * - **glass controls**: a tab bar and round buttons, each glass with three
 *   inner shadows blended by linear burn and linear dodge, as the kit's are;
 * - **cards** with background blur, a soft drop shadow and an inner shadow,
 *   holding rows of text;
 * - **text drawn from saved glyph outlines** (decision 0037) in a font that
 *   isn't here (`SF Pro`), with white labels added by linear dodge;
 * - **a masked group**: a rounded mask over stripes.
 *
 * Glyph outlines are made up (a box per character, a little different for
 * each), stored once in a `glyphSet`, and each text layer's layout is
 * fingerprinted as the importer does, so it's drawn from them. The same
 * options make the same file, ids included.
 */
import {
  GLYPH_UNITS,
  glyphKey,
  keysBetween,
  type NodeRecord,
  type Props,
  ROOT_ID,
} from "@drawpane/model";

export interface EffectKitOptions {
  /** Screens on the heavy page (default 48). */
  readonly screens?: number;
  /** Screens per row. */
  readonly columns?: number;
}

export interface EffectKit {
  readonly nodes: NodeRecord[];
  /** Page ids: the heavy page of screens first, then a page of components. */
  readonly pages: readonly string[];
  readonly stats: {
    readonly layers: number;
    readonly readers: number;
    readonly shadows: number;
    readonly texts: number;
  };
}

const W = 402;
const H = 874;
const FONT = "SF Pro";

const solid = (color: string, blendMode?: string) => [
  blendMode ? { type: "solid", color, blendMode } : { type: "solid", color },
];

/** The kit's glass: refraction and frost, lit by inner shadows that burn and dodge. */
const GLASS = [
  {
    type: "glass",
    angle: 0,
    intensity: 25,
    refraction: 70,
    depth: 30,
    dispersion: 20,
    frost: 6,
    splay: 20,
  },
  {
    type: "inner-shadow",
    color: "#e6e6e6",
    x: 0,
    y: 40,
    blur: 30,
    spread: -40,
    blendMode: "linear-burn",
  },
  {
    type: "inner-shadow",
    color: "#282828",
    x: 0,
    y: -40,
    blur: 10,
    spread: -40,
    blendMode: "linear-dodge",
  },
  {
    type: "inner-shadow",
    color: "#282828",
    x: 0,
    y: 40,
    blur: 10,
    spread: -40,
    blendMode: "linear-dodge",
  },
];

const WORDS =
  "Messages Photos Camera Settings Weather Music Podcasts Wallet Health Fitness Maps Notes Reminders Calendar Clock Files Mail Safari Contacts Phone Today Library Browse Search Recently Added Favorites Shared".split(
    " ",
  );

/** A made-up outline for a character: a box with a notch, its width and notch from the code. */
function outline(code: number): string {
  const w = 380 + (code % 7) * 40;
  const h = 520 + (code % 5) * 40;
  const n = 60 + (code % 11) * 20;
  return `M60 0 L${w} 0 L${w} ${h} L${60 + n} ${h} L${60 + n} ${h - n} L60 ${h - n} Z`;
}

const hex16 = (n: number) => n.toString(16).padStart(16, "0");

export function generateEffectKit(options: EffectKitOptions = {}): EffectKit {
  const screens = options.screens ?? 48;
  const columns = options.columns ?? 8;
  const nodes: NodeRecord[] = [];
  let next = 0;
  const KEYS = keysBetween(null, null, 400);
  const keyAt = new Map<string, number>();
  const key = (parent: string) => {
    const i = keyAt.get(parent) ?? 0;
    keyAt.set(parent, i + 1);
    return KEYS[i] as string;
  };
  const stats = { layers: 0, readers: 0, shadows: 0, texts: 0 };
  const add = (type: string, parent: string, props: Props, id = `g${(next++).toString(36)}`) => {
    nodes.push({ id, type, parent, key: key(parent), props } as NodeRecord);
    if (type !== "page" && type !== "glyphSet") stats.layers++;
    for (const e of (props.effects as Array<{ type: string }> | undefined) ?? []) {
      if (e.type === "glass" || e.type === "background-blur") stats.readers++;
      if (e.type === "drop-shadow" || e.type === "inner-shadow") stats.shadows++;
    }
    return id;
  };

  // The glyphs, one per character used, stored once.
  const outlines: Record<string, string> = {};
  const glyphOf = (ch: string) => {
    const id = hex16(0xa000 + (ch.codePointAt(0) ?? 0));
    outlines[id] ??= outline(ch.codePointAt(0) ?? 0);
    return id;
  };

  /** A line of text drawn from saved glyphs: auto width, its advance from the outline. */
  const text = (
    parent: string,
    characters: string,
    x: number,
    y: number,
    size: number,
    fills: unknown[],
    weight = 400,
  ) => {
    const advance = (ch: string) =>
      ((440 + ((ch.codePointAt(0) ?? 0) % 7) * 40) / GLYPH_UNITS) * size;
    const width = Math.ceil([...characters].reduce((a, ch) => a + advance(ch), 0));
    const height = Math.round(size * 1.3);
    const props: Props = {
      name: characters,
      x,
      y,
      width,
      height,
      characters,
      fontFamily: FONT,
      fontWeight: weight,
      fontStyle: "normal",
      fontSize: size,
      textAutoResize: "width",
      fills,
    } as Props;
    const refs: string[] = [];
    const g: number[] = [];
    let at = 0;
    const baseline = Math.round(size * 1.02);
    for (const ch of characters) {
      if (ch !== " ") {
        const id = glyphOf(ch);
        let i = refs.indexOf(id);
        if (i < 0) i = refs.push(id) - 1;
        g.push(i, Math.round(at * 100) / 100, baseline);
      }
      at += advance(ch);
    }
    const c: number[] = [];
    let index = 0;
    let glyph = 0;
    for (const ch of characters) {
      if (ch !== " ") {
        if (index !== glyph) c[glyph] = index;
        glyph++;
      }
      index++;
    }
    const layout: Record<string, unknown> = {
      key: glyphKey(props),
      w: width,
      h: height,
      refs,
      g,
      size,
    };
    if (c.length > 0) layout.c = Array.from({ length: glyph }, (_, i) => c[i] ?? i);
    stats.texts++;
    return add("text", parent, { ...props, glyphLayout: layout } as Props);
  };

  const words = (i: number, n: number) =>
    Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(" ");

  const screen = (parent: string, i: number, x: number, y: number) => {
    const board = add("frame", parent, {
      name: `Screen ${i + 1}`,
      x,
      y,
      width: W,
      height: H,
      cornerRadius: 48,
      clipContent: true,
      fills: [
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          stops: [
            { position: 0, color: ["#3a7bd5", "#ff7e5f", "#43cea2", "#8e2de2"][i % 4] as string },
            { position: 1, color: ["#00d2ff", "#feb47b", "#185a9d", "#4a00e0"][i % 4] as string },
          ],
        },
      ],
    } as Props);
    // Soft blobs on the wallpaper (the kit blurs few layers, and those small: one here).
    for (let b = 0; b < 3; b++)
      add("ellipse", board, {
        name: "Blob",
        x: 40 + ((i * 53 + b * 131) % 260),
        y: 120 + b * 220,
        width: 180,
        height: 180,
        opacity: 0.6,
        fills: solid(["#ffd200", "#f7971e", "#ff00cc"][b] as string),
        ...(b === 0 ? { effects: [{ type: "layer-blur", radius: 6 }] } : {}),
      } as Props);
    // Status bar and title.
    text(board, "9:41", 32, 18, 17, solid("#ffffff"), 600);
    text(board, WORDS[i % WORDS.length] as string, 24, 64, 34, solid("#ffffff"), 700);
    // A grid of app icons with labels.
    for (let k = 0; k < 16; k++) {
      const cx = 24 + (k % 4) * 92;
      const cy = 130 + Math.floor(k / 4) * 96;
      add("rect", board, {
        name: "Icon",
        x: cx + 8,
        y: cy,
        width: 62,
        height: 62,
        cornerRadius: 14,
        fills: solid(["#34c759", "#007aff", "#ff9500", "#af52de", "#ff2d55"][k % 5] as string),
        effects: [{ type: "drop-shadow", color: "#00000026", x: 0, y: 2, blur: 6, spread: 0 }],
      } as Props);
      text(
        board,
        WORDS[(i + k) % WORDS.length] as string,
        cx + 4,
        cy + 66,
        11,
        solid("#ededed", "linear-dodge"),
      );
    }
    // A card of rows on background blur.
    const card = add("frame", board, {
      name: "Card",
      x: 16,
      y: 520,
      width: W - 32,
      height: 180,
      cornerRadius: 26,
      clipContent: true,
      fills: solid("#ffffff59"),
      effects: [
        { type: "background-blur", radius: 40 },
        { type: "drop-shadow", color: "#00000014", x: 0, y: 8, blur: 24, spread: 0 },
        { type: "inner-shadow", color: "#ffffff80", x: 0, y: 1, blur: 0, spread: 0 },
      ],
    } as Props);
    for (let r = 0; r < 4; r++) {
      text(card, words(i + r, 2), 20, 16 + r * 40, 17, solid("#1a1a1a"));
      text(card, words(i + r + 5, 1), 260, 16 + r * 40, 15, solid("#3c3c4399"));
      add("rect", card, {
        name: "Separator",
        x: 20,
        y: 50 + r * 40,
        width: W - 72,
        height: 1,
        fills: solid("#3c3c4349"),
      } as Props);
    }
    // A masked group of stripes.
    const masked = add("group", board, { name: "Masked" } as Props);
    add("rect", masked, {
      name: "Mask",
      isMask: true,
      x: 280,
      y: 60,
      width: 96,
      height: 40,
      cornerRadius: 20,
      fills: solid("#000000"),
    } as Props);
    for (let s = 0; s < 6; s++)
      add("rect", masked, {
        name: "Stripe",
        x: 270 + s * 20,
        y: 50,
        width: 10,
        height: 60,
        fills: solid(s % 2 ? "#ffffff" : "#ff3b30"),
      } as Props);
    // Round glass buttons.
    for (let k = 0; k < 4; k++) {
      const button = add("frame", board, {
        name: "Glass button",
        x: 24 + k * 96,
        y: 718,
        width: 44,
        height: 44,
        cornerRadius: 1000,
        clipContent: true,
        fills: [],
        effects: GLASS,
      } as Props);
      text(button, "+", 15, 10, 20, solid("#1a1a1a"), 500);
    }
    // The glass tab bar, its labels added by linear dodge.
    const bar = add("frame", board, {
      name: "Tab bar",
      x: 16,
      y: 786,
      width: W - 32,
      height: 62,
      cornerRadius: 1000,
      clipContent: true,
      fills: [],
      effects: GLASS,
    } as Props);
    for (let k = 0; k < 4; k++) {
      text(bar, "*", 28 + k * 90, 6, 24, solid("#ededed", "linear-dodge"), 500);
      text(
        bar,
        WORDS[(i + k * 2) % WORDS.length] as string,
        12 + k * 90,
        36,
        10,
        solid("#ededed", "linear-dodge"),
        600,
      );
    }
  };

  const heavy = add(
    "page",
    ROOT_ID,
    { name: "Screens", backgroundColor: "#808080" } as Props,
    "gpage1",
  );
  for (let i = 0; i < screens; i++)
    screen(heavy, i, (i % columns) * (W + 80), Math.floor(i / columns) * (H + 120));
  const light = add("page", ROOT_ID, { name: "Components" } as Props, "gpage2");
  for (let i = 0; i < 4; i++) screen(light, i, i * (W + 80), 0);
  add("glyphSet", ROOT_ID, { name: "Glyphs", glyphOutlines: outlines } as Props, "gglyphs");
  return { nodes, pages: [heavy, light], stats };
}
