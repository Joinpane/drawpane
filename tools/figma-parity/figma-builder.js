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
          blendMode: BLEND(e.blendMode),
          // Drawpane's shadows show behind see-through fills unless they say not to. The goldens
          // so far were built with it off, on opaque fills, where it makes no difference.
          ...(e.type === "drop-shadow" ? { showShadowBehindNode: e.showBehind !== false } : {}),
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
          splay: e.splay / 100,
        };
      case "noise":
        return {
          type: "NOISE",
          noiseType: { mono: "MONOTONE", duo: "DUOTONE", multi: "MULTITONE" }[e.noiseType],
          noiseSize: e.size,
          density: e.density / 100,
          color: rgba(e.color),
          ...(e.noiseType === "duo" ? { secondaryColor: rgba(e.secondaryColor) } : {}),
          ...(e.noiseType === "multi" ? { opacity: e.opacity / 100 } : {}),
          visible,
        };
      case "texture":
        return {
          type: "TEXTURE",
          noiseSize: e.size,
          radius: e.radius,
          clipToShape: e.clipToShape,
          visible,
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
    if (spec.leadingTrim === "cap-height") node.leadingTrim = "CAP_HEIGHT";
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
      if (run.lineHeight) node.setRangeLineHeight(run.start, run.end, lineHeight(run.lineHeight));
      if (run.fills) node.setRangeFills(run.start, run.end, run.fills.map(paint));
      if (run.textDecoration)
        node.setRangeTextDecoration(run.start, run.end, run.textDecoration.toUpperCase());
    }
    // Lists: Drawpane keeps a paragraph's list on its characters, Figma per paragraph.
    for (const run of spec.textRuns ?? []) {
      if (run.listType)
        node.setRangeListOptions(run.start, run.end, {
          type: { none: "NONE", bullet: "UNORDERED", number: "ORDERED" }[run.listType],
        });
      // Figma counts a list's first level as indentation 1.
      if (run.listType && run.listType !== "none")
        node.setRangeIndentation(run.start, run.end, (run.listLevel ?? 0) + 1);
    }
    // Drawpane's "width" is Figma's width-and-height: the box follows the text.
    const resize = spec.textAutoResize ?? "width";
    node.textAutoResize = { width: "WIDTH_AND_HEIGHT", height: "HEIGHT", none: "NONE" }[resize];
    if (resize === "height") node.resize(spec.width, node.height);
    if (resize === "none") node.resize(spec.width, spec.height);
    node.x = spec.x;
    node.y = spec.y;
    node.effects = (spec.effects ?? []).map(effect);
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    place(node, spec);
    return node;
  };

  // Drawpane turns a layer clockwise about its box's centre; Figma's own rotation turns the
  // other way about its top left, so the transform is set outright.
  const place = (node, spec) => {
    if (!spec.rotation) return;
    const r = (spec.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const cx = node.width / 2;
    const cy = node.height / 2;
    node.relativeTransform = [
      [cos, -sin, spec.x + cx - (cos * cx - sin * cy)],
      [sin, cos, spec.y + cy - (sin * cx + cos * cy)],
    ];
  };

  const layer = async (spec, parent, origin) => {
    if (spec.type === "text") return text(spec, parent);
    const make = {
      ellipse: () => figma.createEllipse(),
      frame: () => figma.createFrame(),
      star: () => figma.createStar(),
      polygon: () => figma.createPolygon(),
      path: () => figma.createVector(),
      rect: () => figma.createRectangle(),
    }[spec.type];
    if (!make) throw new Error(`No Figma layer for ${spec.type} yet.`);
    const node = make();
    parent.appendChild(node);
    if (spec.type === "path")
      // Its box is the path's: scenes keep paths of straight lines filling their box.
      node.vectorPaths = [{ windingRule: "NONZERO", data: spec.pathData }];
    else node.resize(Math.max(0.01, spec.width), Math.max(0.01, spec.height));
    if (spec.pointCount !== undefined) node.pointCount = spec.pointCount;
    if (spec.innerRadius !== undefined) node.innerRadius = spec.innerRadius;
    node.x = spec.x;
    node.y = spec.y;
    if (spec.name) node.name = spec.name;
    if (spec.cornerRadii) {
      [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] =
        spec.cornerRadii;
    } else if (spec.cornerRadius !== undefined && ["rect", "frame"].includes(spec.type))
      node.cornerRadius = spec.cornerRadius;
    node.fills = (spec.fills ?? []).map(paint);
    node.strokes = (spec.strokes ?? []).map(paint);
    if (spec.strokes?.length) {
      node.strokeWeight = spec.strokeWeight ?? 1;
      node.strokeAlign = (spec.strokeAlign ?? "inside").toUpperCase();
      if (spec.strokeDashes) node.dashPattern = spec.strokeDashes;
      if (spec.strokeJoin) node.strokeJoin = spec.strokeJoin.toUpperCase();
      if (spec.strokeWeights)
        [
          node.strokeTopWeight,
          node.strokeRightWeight,
          node.strokeBottomWeight,
          node.strokeLeftWeight,
        ] = spec.strokeWeights;
    }
    node.effects = (spec.effects ?? []).map(effect);
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    if (spec.blendMode) node.blendMode = BLEND(spec.blendMode);
    // Figma's frames clip by default, Drawpane's don't: only when the scene says.
    if (spec.type === "frame" && spec.clipContent !== undefined)
      node.clipsContent = spec.clipContent;
    if (spec.isMask) {
      node.isMask = true;
      node.maskType = { outline: "VECTOR", alpha: "ALPHA", luminance: "LUMINANCE" }[
        spec.maskType ?? "outline"
      ];
    }
    for (const child of spec.children ?? []) await layer(child, node, origin);
    place(node, spec);
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
      // "none": no background, so the render's alpha shows what the cell lets through.
      frame.fills =
        suite.background === "none"
          ? []
          : [paint({ type: "solid", color: suite.background ?? "#ffffff" })];
      if (suite.backdrop) await backdrops[suite.backdrop](frame, cell);
      for (const spec2 of spec.layers) await layer(spec2, frame);
      made.push(frame.name);
    }
  }
  return made;
}
