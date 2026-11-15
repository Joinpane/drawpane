// Builds parity scenes in Figma: one page per suite ("Parity: shadows"),
// one frame per cell named "<suite>/<id>", from the same scene JSON
// Drawpane builds from. Runs where Figma's plugin API is `figma`: in a
// plugin, or in Figma's page once any plugin has run (build-in-figma.mjs).
//
// Scene layers use Drawpane's properties (docs: packages/model/src/schema.ts);
// this file is the one place they become Figma's.

// biome-ignore lint/correctness/noUnusedVariables: evaluated by build-in-figma.mjs as `(source)(figma, suites)`.
async function buildParity(figma, suites) {
  const rgb = (hex) => ({
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  });
  const alpha = (hex) => (hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1);
  const rgba = (hex) => ({ ...rgb(hex), a: alpha(hex) });

  // Figma's gradient transform maps the layer's unit square into gradient space, where a
  // linear gradient runs along x from 0 to 1 at y = 0.5, and radial and angular ones sit
  // at (0.5, 0.5) with radius 0.5. Drawpane gives handles in the unit square instead.
  const invert = ([[a, c, e], [b, d, f]]) => {
    const det = a * d - b * c;
    return [
      [d / det, -c / det, (c * f - d * e) / det],
      [-b / det, a / det, (b * e - a * f) / det],
    ];
  };
  const gradientTransform = (paint) => {
    const { from, to } = paint;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (paint.type === "linear") {
      // Gradient space → unit square: x along the handles, y across them.
      return invert([
        [dx, -dy, from.x + 0.5 * dy],
        [dy, dx, from.y - 0.5 * dx],
      ]);
    }
    // Radial and angular: centred on `from`, radius (and start) toward `to`.
    return invert([
      [2 * dx, -2 * dy, from.x - dx + dy],
      [2 * dy, 2 * dx, from.y - dy - dx],
    ]);
  };
  const BLEND = (mode) => (mode ?? "normal").toUpperCase().replace(/-/g, "_");
  const paint = (p) => {
    const common = {
      visible: p.visible !== false,
      opacity: p.opacity ?? 1,
      blendMode: BLEND(p.blendMode),
    };
    if (p.type === "solid")
      return {
        type: "SOLID",
        color: rgb(p.color),
        ...common,
        opacity: (p.opacity ?? 1) * alpha(p.color),
      };
    const type = {
      linear: "GRADIENT_LINEAR",
      radial: "GRADIENT_RADIAL",
      angular: "GRADIENT_ANGULAR",
    }[p.type];
    return {
      type,
      gradientTransform: gradientTransform(p),
      gradientStops: p.stops.map((s) => ({ position: s.position, color: rgba(s.color) })),
      ...common,
    };
  };
  const effect = (e) => {
    const visible = e.visible !== false;
    switch (e.type) {
      case "drop-shadow":
      case "inner-shadow":
        return {
          type: e.type === "drop-shadow" ? "DROP_SHADOW" : "INNER_SHADOW",
          color: rgba(e.color),
          offset: { x: e.x, y: e.y },
          radius: e.blur,
          spread: e.spread,
          visible,
          blendMode: "NORMAL",
          ...(e.type === "drop-shadow" ? { showShadowBehindNode: false } : {}),
        };
      case "layer-blur":
      case "background-blur":
        return {
          type: e.type === "layer-blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR",
          blurType: "NORMAL",
          radius: e.radius,
          visible,
        };
      case "glass":
        return {
          type: "GLASS",
          visible,
          lightIntensity: e.intensity / 100,
          lightAngle: e.angle,
          refraction: e.refraction / 100,
          depth: Math.max(1, e.depth),
          dispersion: e.dispersion / 100,
          radius: e.frost,
        };
      default:
        throw new Error(`No Figma effect for ${e.type} yet.`);
    }
  };

  // Figma's style names for a weight, in the spellings fonts use for them.
  const STYLES = {
    100: ["Thin"],
    200: ["Extra Light", "ExtraLight"],
    300: ["Light"],
    400: ["Regular"],
    500: ["Medium"],
    600: ["Semi Bold", "SemiBold"],
    700: ["Bold"],
    800: ["Extra Bold", "ExtraBold"],
    900: ["Black"],
  };
  const fontFor = async (family, weight = 400, italic = false) => {
    for (const name of STYLES[weight] ?? ["Regular"]) {
      const style = italic ? (name === "Regular" ? "Italic" : `${name} Italic`) : name;
      try {
        await figma.loadFontAsync({ family, style });
        return { family, style };
      } catch {
        // Try the next spelling.
      }
    }
    throw new Error(`Figma has no ${family} ${weight}${italic ? " italic" : ""}.`);
  };
  const lineHeight = (lh) =>
    !lh || lh.unit === "auto"
      ? { unit: "AUTO" }
      : { unit: lh.unit === "px" ? "PIXELS" : "PERCENT", value: lh.value };

  const text = async (spec, parent) => {
    const node = figma.createText();
    parent.appendChild(node);
    const family = spec.fontFamily ?? "Inter";
    node.fontName = await fontFor(family, spec.fontWeight, spec.fontStyle === "italic");
    node.characters = spec.characters ?? "";
    node.fontSize = spec.fontSize ?? 16;
    node.lineHeight = lineHeight(spec.lineHeight);
    if (spec.letterSpacing)
      node.letterSpacing = {
        unit: spec.letterSpacing.unit === "px" ? "PIXELS" : "PERCENT",
        value: spec.letterSpacing.value,
      };
    node.textAlignHorizontal = {
      left: "LEFT",
      center: "CENTER",
      right: "RIGHT",
      justify: "JUSTIFIED",
    }[spec.textAlign ?? "left"];
    node.textAlignVertical = { top: "TOP", middle: "CENTER", bottom: "BOTTOM" }[
      spec.textAlignVertical ?? "top"
    ];
    node.textCase = { none: "ORIGINAL", upper: "UPPER", lower: "LOWER", title: "TITLE" }[
      spec.textCase ?? "none"
    ];
    node.textDecoration = { none: "NONE", underline: "UNDERLINE", strikethrough: "STRIKETHROUGH" }[
      spec.textDecoration ?? "none"
    ];
    if (spec.paragraphSpacing) node.paragraphSpacing = spec.paragraphSpacing;
    node.fills = (spec.fills ?? [{ type: "solid", color: "#1c1b1a" }]).map(paint);
    for (const run of spec.textRuns ?? []) {
      if (run.fontWeight || run.fontStyle)
        node.setRangeFontName(
          run.start,
          run.end,
          await fontFor(
            family,
            run.fontWeight ?? spec.fontWeight ?? 400,
            (run.fontStyle ?? spec.fontStyle) === "italic",
          ),
        );
      if (run.fontSize) node.setRangeFontSize(run.start, run.end, run.fontSize);
      if (run.fills) node.setRangeFills(run.start, run.end, run.fills.map(paint));
      if (run.textDecoration)
        node.setRangeTextDecoration(run.start, run.end, run.textDecoration.toUpperCase());
    }
    // Drawpane's "width" is Figma's width-and-height: the box follows the text.
    const resize = spec.textAutoResize ?? "width";
    node.textAutoResize = { width: "WIDTH_AND_HEIGHT", height: "HEIGHT", none: "NONE" }[resize];
    if (resize === "height") node.resize(spec.width, node.height);
    if (resize === "none") node.resize(spec.width, spec.height);
    node.x = spec.x;
    node.y = spec.y;
    return node;
  };

  const layer = async (spec, parent, origin) => {
    if (spec.type === "text") return text(spec, parent);
    const node =
      spec.type === "ellipse"
        ? figma.createEllipse()
        : spec.type === "frame"
          ? figma.createFrame()
          : figma.createRectangle();
    parent.appendChild(node);
    node.resize(Math.max(0.01, spec.width), Math.max(0.01, spec.height));
    node.x = spec.x;
    node.y = spec.y;
    if (spec.name) node.name = spec.name;
    if (spec.cornerRadii) {
      [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] =
        spec.cornerRadii;
    } else if (spec.cornerRadius !== undefined && spec.type !== "ellipse")
      node.cornerRadius = spec.cornerRadius;
    node.fills = (spec.fills ?? []).map(paint);
    node.strokes = (spec.strokes ?? []).map(paint);
    if (spec.strokes?.length) {
      node.strokeWeight = spec.strokeWeight ?? 1;
      node.strokeAlign = (spec.strokeAlign ?? "inside").toUpperCase();
      if (spec.strokeDashes) node.dashPattern = spec.strokeDashes;
      if (spec.strokeJoin) node.strokeJoin = spec.strokeJoin.toUpperCase();
    }
    node.effects = (spec.effects ?? []).map(effect);
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    if (spec.blendMode) node.blendMode = BLEND(spec.blendMode);
    for (const child of spec.children ?? []) await layer(child, node, origin);
    return node;
  };

  const backdrops = {
    // Bars both ways over a warm-to-cool gradient: what blurs and lenses show best.
    stripes: async (frame, cell) => {
      frame.fills = [
        paint({
          type: "linear",
          from: { x: 0, y: 0.5 },
          to: { x: 1, y: 0.5 },
          stops: [
            { position: 0, color: "#ff7a45" },
            { position: 0.5, color: "#ffd166" },
            { position: 1, color: "#3d7bf0" },
          ],
        }),
      ];
      for (let y = 0, k = 0; y < cell.height; y += 24, k++)
        await layer(
          {
            type: "rect",
            x: 0,
            y,
            width: cell.width,
            height: 6,
            fills: [{ type: "solid", color: k % 2 ? "#ffffffa6" : "#1c1b1aa6" }],
          },
          frame,
        );
      for (let x = 0; x < cell.width; x += 30)
        await layer(
          {
            type: "rect",
            x,
            y: 0,
            width: 4,
            height: cell.height,
            fills: [{ type: "solid", color: "#0b3d918c" }],
          },
          frame,
        );
    },
  };

  const made = [];
  for (const suite of suites) {
    const name = `Parity: ${suite.suite}`;
    for (const old of figma.root.children.filter((p) => p.name === name)) old.remove();
    const page = figma.createPage();
    page.name = name;
    await figma.setCurrentPageAsync(page);
    const { cell } = suite;
    for (const [i, spec] of suite.cells.entries()) {
      const frame = figma.createFrame();
      page.appendChild(frame);
      frame.name = `${suite.suite}/${spec.id}`;
      frame.resize(cell.width, cell.height);
      frame.x = (i % cell.columns) * (cell.width + cell.gap);
      frame.y = Math.floor(i / cell.columns) * (cell.height + cell.gap);
      frame.clipsContent = true;
      frame.fills = [paint({ type: "solid", color: suite.background ?? "#ffffff" })];
      if (suite.backdrop) await backdrops[suite.backdrop](frame, cell);
      for (const spec2 of spec.layers) await layer(spec2, frame);
      made.push(frame.name);
    }
  }
  return made;
}
