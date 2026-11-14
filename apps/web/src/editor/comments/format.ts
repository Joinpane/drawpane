/**
 * Comment formatting: the little Markdown people type out of habit, read
 * into a tree (never HTML), so nothing in a comment can inject markup.
 *
 * - `**bold**`, `*italic*` or `_italic_` (not inside words: snake_case stays),
 *   and `` `code` `` (nothing formats inside it);
 * - `https://` links (trailing punctuation stays outside);
 * - `@Name` mentions of the people in the comment;
 * - lines starting `- `, `* ` or `• ` make a list, `1. ` or `1) ` a numbered
 *   one; blank lines separate paragraphs, single line breaks stay.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong" | "em"; readonly children: readonly Inline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly text: string }
  | { readonly kind: "mention"; readonly name: string; readonly text: string };

/** A paragraph's lines, or a list's items. */
export type Block =
  | { readonly kind: "paragraph"; readonly lines: readonly (readonly Inline[])[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      /** The first item's number, for an ordered list. */
      readonly start: number;
      readonly items: readonly (readonly Inline[])[];
    };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One pattern for every inline form, earliest first; at the same place, the first listed wins. */
function inlinePattern(names: readonly string[]): RegExp {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const parts = [
    "`(?<code>[^`\\n]+)`",
    // A URL ends before trailing punctuation and closing brackets.
    "(?<link>https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?'\")\\]])",
    ...(sorted.length > 0
      ? [`@(?<mention>${sorted.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`]
      : []),
    "\\*\\*(?<strong>(?=\\S)[^\\n]*?\\S)\\*\\*",
    "(?<![\\p{L}\\p{N}*_])(?<mark>[*_])(?<em>(?=[^\\s*_])[^\\n]*?[^\\s*_]|[^\\s*_])\\k<mark>(?![\\p{L}\\p{N}*_])",
  ];
  return new RegExp(parts.join("|"), "gu");
}

function inline(text: string, names: readonly string[]): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out.at(-1);
    if (prev?.kind === "text") out[out.length - 1] = { kind: "text", text: prev.text + t };
    else out.push({ kind: "text", text: t });
  };
  for (const match of text.matchAll(inlinePattern(names))) {
    const index = match.index ?? 0;
    push(text.slice(last, index));
    const g = match.groups ?? {};
    if (g.code !== undefined) out.push({ kind: "code", text: g.code });
    else if (g.link !== undefined) out.push({ kind: "link", href: g.link, text: g.link });
    else if (g.mention !== undefined)
      out.push({ kind: "mention", name: g.mention, text: match[0] });
    else if (g.strong !== undefined)
      out.push({ kind: "strong", children: inline(g.strong, names) });
    else if (g.em !== undefined) out.push({ kind: "em", children: inline(g.em, names) });
    last = index + match[0].length;
  }
  push(text.slice(last));
  return out;
}

/** Reads a comment's text into paragraphs and lists of formatted runs. */
export function parseComment(body: string, mentionNames: readonly string[] = []): Block[] {
  const blocks: Block[] = [];
  let paragraph: Inline[][] | null = null;
  let list: { ordered: boolean; start: number; items: Inline[][] } | null = null;
  const flush = () => {
    if (paragraph) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list) blocks.push({ kind: "list", ...list });
    paragraph = null;
    list = null;
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      if (paragraph || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(inline((bullet?.[1] ?? numbered?.[2] ?? "").trimEnd(), mentionNames));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (list) flush();
    paragraph ??= [];
    paragraph.push(inline(line, mentionNames));
  }
  flush();
  return blocks;
}

/** The plain words of some runs: for a one-line preview or an accessible name. */
export function plainText(runs: readonly Inline[]): string {
  return runs.map((r) => ("children" in r ? plainText(r.children) : r.text)).join("");
}
