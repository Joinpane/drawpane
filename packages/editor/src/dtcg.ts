/**
 * Reading W3C Design Tokens (DTCG) JSON, and alias cycle checks.
 *
 * Supported: nested groups (joined with "/"), `$type` inherited from groups,
 * colors (hex), dimensions and numbers (px and unitless; rem as 16px), strings,
 * fontFamily (first family), aliases `{group.token}`, `$description`, and
 * Drawpane's own modes in `$extensions["drawpane.modes"]`.
 */
import { getProp } from "@drawpane/model";
import type { Doc } from "./doc";
import type { VariableType } from "./variables";

export interface ParsedToken {
  readonly name: string;
  readonly type: VariableType;
  /** Mode name → literal or alias by token name ("brand/500"). */
  readonly values: Readonly<Record<string, string | number | { alias: string }>>;
  readonly description?: string;
}

const DEFAULT_MODE = "Default";

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let c = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(c)) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (/^#[0-9a-f]{4}$/.test(c)) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}${c[4]}${c[4]}`;
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(c) ? c : null;
}

function parseDimension(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    const v = value as { value: unknown; unit?: unknown };
    if (typeof v.value === "number") return v.unit === "rem" ? v.value * 16 : v.value;
  }
  if (typeof value !== "string") return null;
  const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "rem" ? n * 16 : n;
}

function typeOf(dtcgType: string | undefined): VariableType | null {
  switch (dtcgType) {
    case "color":
      return "color";
    case "dimension":
    case "number":
    case "fontWeight":
    case "duration":
      return "number";
    case "fontFamily":
    case "string":
      return "string";
    default:
      return null;
  }
}

/** Parses DTCG JSON into flat tokens and the modes they use. Unknown types are skipped. */
export function parseDtcg(json: unknown): { tokens: ParsedToken[]; modes: string[] } {
  const tokens: ParsedToken[] = [];
  const modes = new Set<string>([DEFAULT_MODE]);
  const visit = (node: unknown, path: string[], inheritedType: string | undefined) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const groupType = typeof record.$type === "string" ? record.$type : inheritedType;
    if ("$value" in record) {
      const type = typeOf(groupType);
      if (!type) return;
      const convert = (raw: unknown): string | number | { alias: string } | null => {
        if (typeof raw === "string") {
          const alias = /^\{([^}]+)\}$/.exec(raw.trim());
          if (alias?.[1]) return { alias: alias[1].split(".").join("/") };
        }
        if (type === "color") return normalizeColor(raw);
        if (type === "number") return parseDimension(raw);
        if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : null;
        return typeof raw === "string" ? raw : null;
      };
      const values: Record<string, string | number | { alias: string }> = {};
      const base = convert(record.$value);
      if (base !== null) values[DEFAULT_MODE] = base;
      const extensions = record.$extensions as Record<string, unknown> | undefined;
      const extra = extensions?.["drawpane.modes"];
      if (extra && typeof extra === "object") {
        for (const [mode, raw] of Object.entries(extra as Record<string, unknown>)) {
          const value = convert(raw);
          if (value === null) continue;
          modes.add(mode);
          values[mode] = value;
        }
      }
      if (Object.keys(values).length === 0) return;
      const description = typeof record.$description === "string" ? record.$description : undefined;
      tokens.push({ name: path.join("/"), type, values, ...(description ? { description } : {}) });
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key.startsWith("$")) continue;
      visit(child, [...path, key], groupType);
    }
  };
  visit(json, [], undefined);
  // When every token defines the first extra mode, "Default" is just the base value; keep it named so.
  return { tokens, modes: [...modes] };
}

/** True when variable `from` resolves through `target` (or is it): binding `target` to `from` would cycle. */
export function dependsOn(doc: Doc, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.get(id);
    if (node?.type !== "variable") continue;
    for (const value of Object.values(getProp(node.props, "values"))) {
      if (typeof value === "object") stack.push(value.alias);
    }
  }
  return false;
}
