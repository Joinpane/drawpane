/// <reference path="./pathkit-wasm.d.ts" />
/**
 * The boolean engine on Skia's PathOps, through PathKit (WASM, ~324 KB, plus
 * a 33 KB loader). It keeps curves as curves and is the same code Chrome and
 * Android use, so it is robust with coincident edges and tangent curves.
 *
 * `loadPathKitEngine` imports the module dynamically, so bundlers split it
 * into its own chunk and the editor only downloads it when a boolean runs.
 */
import type { BooleanEngine, BooleanOp, BooleanOperand, FillRule } from "./boolean";

/** The slice of PathKit's API the adapter uses. */
export interface PathKitPath {
  op(other: PathKitPath, op: number): PathKitPath | null;
  setFillType(type: number): void;
  getFillTypeString(): string;
  toSVGString(): string;
  delete(): void;
}

export interface PathKitApi {
  FromSVGString(d: string): PathKitPath | null;
  NewPath(): PathKitPath;
  readonly PathOp: {
    readonly UNION: number;
    readonly DIFFERENCE: number;
    readonly INTERSECT: number;
    readonly XOR: number;
  };
  readonly FillType: { readonly WINDING: number; readonly EVENODD: number };
}

function isPathKit(value: unknown): value is PathKitApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "FromSVGString" in value &&
    "PathOp" in value &&
    "FillType" in value
  );
}

export function createPathKitEngine(pk: PathKitApi): BooleanEngine {
  const opCode: Record<BooleanOp, number> = {
    union: pk.PathOp.UNION,
    subtract: pk.PathOp.DIFFERENCE,
    intersect: pk.PathOp.INTERSECT,
    exclude: pk.PathOp.XOR,
  };
  const load = (operand: BooleanOperand): PathKitPath => {
    const path = pk.FromSVGString(operand.d) ?? pk.NewPath();
    path.setFillType(operand.fillRule === "evenodd" ? pk.FillType.EVENODD : pk.FillType.WINDING);
    return path;
  };
  return {
    combine(operands, op) {
      const [first, ...rest] = operands;
      if (!first) return { d: "", fillRule: "nonzero" };
      const result = load(first);
      try {
        for (const operand of rest) {
          const next = load(operand);
          try {
            if (!result.op(next, opCode[op]))
              throw new Error("PathOps couldn't combine these shapes.");
          } finally {
            next.delete();
          }
        }
        const fillRule: FillRule = result.getFillTypeString() === "evenodd" ? "evenodd" : "nonzero";
        return { d: result.toSVGString(), fillRule };
      } finally {
        result.delete();
      }
    },
  };
}

export interface PathKitOptions {
  /** Where the browser fetches `pathkit.wasm` from (a bundler asset URL). */
  readonly wasmUrl?: string;
  /** The WASM bytes, for Node and Workers. */
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
}

export async function loadPathKitEngine(options: PathKitOptions = {}): Promise<BooleanEngine> {
  const mod = await import("pathkit-wasm");
  const init = mod.default;
  const { wasmUrl, wasmBinary } = options;
  const pk = await init(
    wasmBinary
      ? { wasmBinary }
      : wasmUrl
        ? { locateFile: (file) => (file.endsWith(".wasm") ? wasmUrl : file) }
        : {},
  );
  if (!isPathKit(pk)) throw new Error("PathKit didn't load.");
  return createPathKitEngine(pk);
}
