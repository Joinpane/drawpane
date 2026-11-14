import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Block, type Inline, parseComment, plainText } from "./format";

const text = (t: string): Inline => ({ kind: "text", text: t });

/** The first line of a comment that's one paragraph. */
function firstLine(body: string, names: readonly string[] = []): readonly Inline[] {
  const block = parseComment(body, names)[0];
  if (block?.kind !== "paragraph") throw new Error(`not a paragraph: ${body}`);
  return block.lines[0] ?? [];
}

describe("parseComment", () => {
  it("reads the comment people actually type: a list, then bold", () => {
    expect(parseComment("- hello?\n* yes!\n**hello**")).toEqual<Block[]>([
      { kind: "list", ordered: false, start: 1, items: [[text("hello?")], [text("yes!")]] },
      { kind: "paragraph", lines: [[{ kind: "strong", children: [text("hello")] }]] },
    ]);
  });

  it("formats bold, italic and code inline, but nothing inside code", () => {
    const [block] = parseComment("Use **brand/primary**, not _blue_; see `**raw**`.");
    expect(block).toEqual({
      kind: "paragraph",
      lines: [
        [
          text("Use "),
          { kind: "strong", children: [text("brand/primary")] },
          text(", not "),
          { kind: "em", children: [text("blue")] },
          text("; see "),
          { kind: "code", text: "**raw**" },
          text("."),
        ],
      ],
    });
  });

  it("leaves snake_case, 2 * 3 * 4 and lone stars alone", () => {
    for (const body of ["a_token_name", "2 * 3 * 4", "a * b", "**", "*"]) {
      expect(plainText(firstLine(body))).toBe(body);
      expect(
        JSON.stringify(parseComment(body)).includes('"strong"') ||
          JSON.stringify(parseComment(body)).includes('"em"'),
      ).toBe(false);
    }
  });

  it("links https URLs, leaving trailing punctuation outside", () => {
    expect(firstLine("Spec: https://example.com/a?b=1 (see https://x.dev/y).")).toEqual([
      text("Spec: "),
      { kind: "link", href: "https://example.com/a?b=1", text: "https://example.com/a?b=1" },
      text(" (see "),
      { kind: "link", href: "https://x.dev/y", text: "https://x.dev/y" },
      text(")."),
    ]);
    // Only http(s): nothing else becomes a link.
    expect(JSON.stringify(parseComment("javascript:alert(1)"))).not.toContain('"link"');
  });

  it("finds mentions, inside bold too", () => {
    expect(firstLine("@Ana Lima will **ask @Bo**", ["Ana Lima", "Bo"])).toEqual([
      { kind: "mention", name: "Ana Lima", text: "@Ana Lima" },
      text(" will "),
      {
        kind: "strong",
        children: [text("ask "), { kind: "mention", name: "Bo", text: "@Bo" }],
      },
    ]);
  });

  it("numbers lists from where they start, splits paragraphs on blank lines, keeps line breaks", () => {
    expect(parseComment("3. three\n4) four\n\nOne\ntwo")).toEqual<Block[]>([
      { kind: "list", ordered: true, start: 3, items: [[text("three")], [text("four")]] },
      { kind: "paragraph", lines: [[text("One")], [text("two")]] },
    ]);
  });

  it("never loses or adds words: the plain text is the input, less the markers", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (body) => {
        const blocks = parseComment(body);
        const words = blocks
          .flatMap((b) => (b.kind === "paragraph" ? b.lines : b.items))
          .map(plainText)
          .join("");
        // Removing markup characters and whitespace from both, nothing else differs.
        const strip = (s: string) => s.replace(/[\s*_`\-•.)\d]/g, "");
        expect(strip(words)).toBe(strip(body));
      }),
    );
  });
});
