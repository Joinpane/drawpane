import { describe, expect, it } from "vitest";
import { parseCli } from "../src/args";
import { Problem } from "../src/flows";

const error = (argv: string[]) => {
  try {
    parseCli(argv);
  } catch (e) {
    return e;
  }
  throw new Error("parsed");
};

describe("the command line", () => {
  it("parses the options and the folder", () => {
    const { values, positionals } = parseCli(["my-design", "--domain", "d.example.com", "-y"]);
    expect(positionals).toEqual(["my-design"]);
    expect(values).toMatchObject({ domain: "d.example.com", yes: true, force: false });
  });

  it("suggests the option a typo meant", () => {
    const e = error(["--domian", "x.com"]);
    expect(e).toBeInstanceOf(Problem);
    expect((e as Error).message).toBe(
      "There's no option --domian. Did you mean --domain? See --help.",
    );
    expect((error(["--acount", "x"]) as Error).message).toContain("Did you mean --account?");
    // Nothing near: no guess.
    expect((error(["--zzzzzz"]) as Error).message).toBe("There's no option --zzzzzz. See --help.");
  });

  it("says what a value looks like when one is missing, or that a switch takes none", () => {
    expect((error(["--domain"]) as Error).message).toBe(
      "--domain needs a value, like --domain design.example.com.",
    );
    expect((error(["--yes=1"]) as Error).message).toBe(
      "--yes doesn't take a value: it's on when given. See --help.",
    );
  });
});
