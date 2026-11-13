/**
 * Boolean operations on paths go through a small engine interface, so the
 * geometry library stays swappable and tests can use a fake. The default
 * engine is Skia's PathOps (PathKit, WASM), loaded only when a boolean runs.
 * See docs/decisions/0002-vector-booleans.md.
 */

export const BOOLEAN_OPS = ["union", "subtract", "intersect", "exclude"] as const;
export type BooleanOp = (typeof BOOLEAN_OPS)[number];

export const BOOLEAN_LABELS: Readonly<Record<BooleanOp, string>> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  exclude: "Exclude",
};

export type FillRule = "nonzero" | "evenodd";

export interface BooleanOperand {
  /** SVG path data, all operands in the same coordinate space. */
  readonly d: string;
  readonly fillRule: FillRule;
}

export interface BooleanResult {
  readonly d: string;
  readonly fillRule: FillRule;
}

export interface BooleanEngine {
  /**
   * Combines operands bottom to top: union, intersect and exclude fold over
   * all of them; subtract removes every upper operand from the bottom one.
   */
  combine(operands: readonly BooleanOperand[], op: BooleanOp): BooleanResult;
}

export type BooleanEngineLoader = () => Promise<BooleanEngine>;
