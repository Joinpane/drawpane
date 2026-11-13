// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generate, readCurrent } from "../scripts/build-tokens.ts";
import { fontStack } from "../scripts/render-tokens.ts";
import { iconNames } from "../src/icons";
import { colors, cssVar, presenceColor, presenceSlot } from "../src/tokens";

describe("generated files", () => {
  it.each(generate().map((file) => [file.path, file] as const))(
    "%s is up to date with the design system (run `pnpm --filter @drawpane/ui tokens`)",
    (path, file) => {
      expect(readCurrent(path)).toBe(file.contents);
    },
  );

  it("has an icon for every SVG in design-system/assets/Icons", () => {
    const dir = new URL("../../../design-system/assets/Icons/", import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.replace(/\.svg$/, ""));
    expect(files).toHaveLength(86);
    expect([...iconNames].sort()).toEqual(files.sort());
  });
});

describe("tokens", () => {
  it("keeps tokens.json values", () => {
    expect(colors.signal).toEqual({ light: "#e04f1a", dark: "#ff7a45" });
  });

  it("puts the self-hosted families in front of the stack", () => {
    expect(fontStack('"Instrument Sans", ui-sans-serif')).toBe(
      '"Instrument Sans Variable", "Instrument Sans", ui-sans-serif',
    );
    expect(fontStack('"Instrument Serif", Georgia, serif')).toBe(
      '"Instrument Serif", Georgia, serif',
    );
  });

  it("references tokens as CSS variables", () => {
    expect(cssVar("surface-raised")).toBe("var(--surface-raised)");
    expect(cssVar("type-ui-body")).toBe("var(--type-ui-body)");
  });

  it("maps collaborators to presence slots, wrapping after 8", () => {
    expect(presenceColor(1)).toBe("var(--presence-1)");
    expect(presenceColor(8)).toBe("var(--presence-8)");
    expect(presenceColor(9)).toBe("var(--presence-1)");
    expect(presenceSlot(0)).toBe(8);
    expect(presenceSlot(-1)).toBe(7);
  });
});

describe("styles", () => {
  const stylesDir = new URL("../src/styles/", import.meta.url);
  const cssFiles = readdirSync(stylesDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".css") && f !== "tokens.css")
    .map((f) => [f, readFileSync(new URL(f, stylesDir), "utf8")] as const);

  it.each(cssFiles)("%s uses tokens, not raw colors", (_, css) => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  it("never requests Google Fonts", () => {
    for (const [, css] of cssFiles) expect(css).not.toContain("googleapis");
  });
});
