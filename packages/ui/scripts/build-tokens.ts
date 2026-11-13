// Generates src/styles/tokens.css, src/tokens.ts and src/icons.ts from design-system/tokens.json
// and design-system/assets/Icons (in the order design-system.json lists them).
// Run with `pnpm --filter @drawpane/ui tokens` (plain Node: type stripping, no build step).
// Pass --check to fail instead of writing when a generated file is out of date.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderIconsTs } from "./render-icons.ts";
import { renderTokensCss, renderTokensTs } from "./render-tokens.ts";
import { parseTokens } from "./tokens-source.ts";

const designSystem = new URL("../../../design-system/", import.meta.url);
const pkg = new URL("../", import.meta.url);

export interface GeneratedFile {
  /** Path relative to packages/ui. */
  path: string;
  contents: string;
}

export function generate(): GeneratedFile[] {
  const tokens = parseTokens(
    JSON.parse(readFileSync(new URL("tokens.json", designSystem), "utf8")),
  );
  const iconDir = new URL("assets/Icons/", designSystem);
  const icons = readdirSync(iconDir)
    .filter((file) => file.endsWith(".svg"))
    .map((file) => ({
      name: file.slice(0, -".svg".length),
      source: readFileSync(new URL(file, iconDir), "utf8"),
    }));
  const index: unknown = JSON.parse(
    readFileSync(new URL("design-system.json", designSystem), "utf8"),
  );
  return [
    { path: "src/styles/tokens.css", contents: renderTokensCss(tokens) },
    { path: "src/tokens.ts", contents: renderTokensTs(tokens) },
    { path: "src/icons.ts", contents: renderIconsTs(icons, iconOrder(index)) },
  ];
}

/** The icon order recorded in design-system.json (assetGroups.Icons.order), without ".svg". */
function iconOrder(index: unknown): string[] {
  if (typeof index !== "object" || index === null || !("assetGroups" in index)) return [];
  const groups = index.assetGroups;
  if (typeof groups !== "object" || groups === null || !("Icons" in groups)) return [];
  const icons = groups.Icons;
  if (typeof icons !== "object" || icons === null || !("order" in icons)) return [];
  const order = icons.order;
  if (!Array.isArray(order)) return [];
  return order
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.replace(/\.svg$/, ""));
}

export function readCurrent(path: string): string | null {
  try {
    return readFileSync(new URL(path, pkg), "utf8");
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = generate().filter((file) => readCurrent(file.path) !== file.contents);
  for (const file of stale) {
    if (check) console.error(`Out of date: ${file.path}`);
    else writeFileSync(new URL(file.path, pkg), file.contents);
  }
  if (check && stale.length > 0) {
    console.error("Run `pnpm --filter @drawpane/ui tokens` to regenerate.");
    process.exitCode = 1;
  } else if (!check) {
    console.log(stale.length ? `Wrote ${stale.map((f) => f.path).join(", ")}` : "Up to date.");
  }
}
