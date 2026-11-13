// Evaluates what people type into numeric fields and the command bar: plain numbers, arithmetic
// (`24*2`, `(100 - 8) / 2`) and units (`1.5rem`, `12px`). A small recursive-descent parser, so
// nothing is ever passed to eval.

export interface NumericInputOptions {
  /** The field's own unit (`%`, `°`). Numbers typed with it are taken as they are. */
  unit?: string;
  /**
   * Extra units, as the number of base units in one of them: `{ "%": parentWidth / 100 }`.
   * Fields without their own unit are in px and also accept `px`, `rem` and `em` (16px).
   */
  units?: Readonly<Record<string, number>>;
}

const PX_UNITS: Readonly<Record<string, number>> = { px: 1, rem: 16, em: 16 };

type Token =
  | { kind: "number"; value: number; unit: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" | "(" | ")" };

const OPERATORS: Readonly<Record<string, "+" | "-" | "*" | "/" | "(" | ")">> = {
  "+": "+",
  "-": "-",
  "−": "-",
  "*": "*",
  "×": "*",
  "/": "/",
  "÷": "/",
  "(": "(",
  ")": ")",
};

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)\s*([a-z%°]*)|(.))/giy;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    const [, digits, unit, symbol] = match;
    if (digits !== undefined) {
      tokens.push({ kind: "number", value: Number(digits), unit: (unit ?? "").toLowerCase() });
    } else if (symbol !== undefined) {
      const op = OPERATORS[symbol];
      if (!op) return null;
      tokens.push({ kind: "op", op });
    }
    if (pattern.lastIndex >= input.length) break;
  }
  return tokens;
}

/** Parses `expression := term (("+" | "-") term)*`, `term := factor (("*" | "/") factor)*`. */
function parse(tokens: Token[], toBase: (unit: string) => number | null): number | null {
  let index = 0;
  const peekOp = (): string | null => {
    const token = tokens[index];
    return token?.kind === "op" ? token.op : null;
  };

  function binary(
    operand: () => number | null,
    ops: readonly string[],
    apply: (op: string | null, left: number, right: number) => number,
  ): number | null {
    let left = operand();
    let op = peekOp();
    while (left !== null && op !== null && ops.includes(op)) {
      index++;
      const right = operand();
      if (right === null) return null;
      left = apply(op, left, right);
      op = peekOp();
    }
    return left;
  }

  const expression = (): number | null =>
    binary(term, ["+", "-"], (op, a, b) => (op === "+" ? a + b : a - b));
  const term = (): number | null =>
    binary(factor, ["*", "/"], (op, a, b) => (op === "*" ? a * b : a / b));

  function factor(): number | null {
    const op = peekOp();
    if (op === "-" || op === "+") {
      index++;
      const value = factor();
      return value === null ? null : op === "-" ? -value : value;
    }
    if (op === "(") {
      index++;
      const value = expression();
      if (peekOp() !== ")") return null;
      index++;
      return value;
    }
    const token = tokens[index];
    if (token?.kind !== "number") return null;
    index++;
    const scale = toBase(token.unit);
    return scale === null ? null : token.value * scale;
  }

  const value = expression();
  return value !== null && index === tokens.length ? value : null;
}

/** Returns the value of `input` in the field's base unit, or null when it isn't a valid number. */
export function evaluateNumericInput(
  input: string,
  options: NumericInputOptions = {},
): number | null {
  const tokens = tokenize(input.trim());
  if (!tokens || tokens.length === 0) return null;
  const own = options.unit?.toLowerCase();
  const units = { ...(own === undefined ? PX_UNITS : {}), ...options.units };
  const toBase = (unit: string): number | null => {
    if (unit === "" || unit === own) return 1;
    return units[unit] ?? null;
  };
  const value = parse(tokens, toBase);
  return value !== null && Number.isFinite(value) ? value : null;
}

/** Rounds to `precision` decimals, without ever returning -0. */
export function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Formats a field value: at most `precision` decimals, trailing zeros dropped. */
export function formatNumber(value: number, precision: number): string {
  return String(roundTo(value, precision));
}
