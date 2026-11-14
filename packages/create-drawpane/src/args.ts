/**
 * The command line: options, and plain words when they're mistyped. Node's
 * parser says what went wrong in its own terms (and suggests `--`, which
 * means something else to npm); a typo here gets "did you mean".
 */
import { parseArgs } from "node:util";
import { Problem } from "./flows.js";

export const OPTIONS = {
  account: { type: "string" },
  name: { type: "string" },
  domain: { type: "string" },
  yes: { type: "boolean", short: "y", default: false },
  force: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

/** What an example value looks like, for "needs a value" messages. */
const EXAMPLES: Record<string, string> = {
  account: "--account 'My company'",
  name: "--name design",
  domain: "--domain design.example.com",
};

export function parseCli(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (error) {
    throw explainArgsError(error);
  }
}

/** A parser error as something to fix; anything else is passed through. */
export function explainArgsError(error: unknown): unknown {
  if (!(error instanceof Error) || !("code" in error)) return error;
  const code = (error as { code: unknown }).code;
  // Node quotes the option ("'--domian'", "'-y, --yes'"): the long form is the one people type.
  const flag =
    /(--[A-Za-z][\w-]*)/.exec(error.message)?.[1] ?? /'(-\w)/.exec(error.message)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const guess = closest(flag.replace(/^-+/, ""));
    return new Problem(
      `There's no option ${flag}.${guess ? ` Did you mean --${guess}?` : ""} See --help.`,
    );
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const name = flag.replace(/^-+/, "");
    const example = EXAMPLES[name];
    return new Problem(
      example
        ? `${flag} needs a value, like ${example}.`
        : `${flag} doesn't take a value: it's on when given. See --help.`,
    );
  }
  return error;
}

/** The known option nearest to a mistyped one, if it's a plausible typo. */
function closest(typed: string): string | null {
  let best: { name: string; d: number } | null = null;
  for (const name of Object.keys(OPTIONS)) {
    const d = distance(typed.toLowerCase(), name);
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= Math.max(1, Math.floor(best.name.length / 3)) ? best.name : null;
}

/** Edit distance, counting a swap of neighbours as one edit ("domian" is one from "domain"). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, at(i - 2, j - 2) + 1);
      (d[i] as number[])[j] = v;
    }
  return at(a.length, b.length);
}
