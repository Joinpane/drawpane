import { describe, expect, it } from "vitest";
import { parseCli, parseCommand } from "../src/args";
import { Problem } from "../src/problem";

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

  it("reads install, upgrade and email, with their folders", () => {
    expect(parseCommand([])).toEqual({ kind: "install", dir: undefined });
    expect(parseCommand(["my-design"])).toEqual({ kind: "install", dir: "my-design" });
    expect(parseCommand(["upgrade"])).toEqual({ kind: "upgrade", dir: undefined });
    expect(parseCommand(["upgrade", "my-design"])).toEqual({ kind: "upgrade", dir: "my-design" });
    expect(parseCommand(["email"])).toEqual({ kind: "email", dir: undefined });
    expect(parseCommand(["email", "my-design"])).toEqual({ kind: "email", dir: "my-design" });
  });

  it("lists every extra word, and asks about a mistyped command", () => {
    const message = (words: string[]) => {
      try {
        parseCommand(words);
      } catch (e) {
        expect(e).toBeInstanceOf(Problem);
        return (e as Error).message;
      }
      throw new Error("parsed");
    };
    expect(message(["a", "b", "c"])).toBe("Unexpected: b c. Give one folder. See --help.");
    expect(message(["upgrade", "a", "b", "c"])).toBe(
      "Unexpected: b c. Upgrade takes one folder. See --help.",
    );
    for (const typo of ["upgarde", "upgrde", "Upgrade", "update"])
      expect(message([typo])).toBe(
        `Did you mean upgrade? To install into a folder named ${typo}, say ./${typo}.`,
      );
    expect(message(["email", "a", "b"])).toBe("Unexpected: b. Email takes one folder. See --help.");
    for (const typo of ["emial", "mail", "emails", "Email"])
      expect(message([typo])).toBe(
        `Did you mean email? To install into a folder named ${typo}, say ./${typo}.`,
      );
    // Words near a short command are folders.
    expect(parseCommand(["detail"])).toEqual({ kind: "install", dir: "detail" });
    // Said plainly, it's a folder.
    expect(parseCommand(["./upgarde"])).toEqual({ kind: "install", dir: "./upgarde" });
    expect(parseCommand(["design-team"])).toEqual({ kind: "install", dir: "design-team" });
  });
});
