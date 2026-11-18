# 0036. Font aliases: drawing a family the team doesn't have in one it does

- Status: accepted
- Date: 2026-11-17
- Deciders: Ziyang (lead maintainer)

## Context

iOS kits name Apple's "SF Pro", which ships as one variable family with an optical size axis, and also as static "SF Pro Text" (small type) and "SF Pro Display" (large type). Teams upload the static files as team fonts, but text still names "SF Pro", so it all drew in the fallback, SF Symbols included. Those are glyphs at private-use code points, so a fallback font draws whatever it has there, or nothing.

Rewriting the file is the wrong fix. It changes the file, has to be done again after every re-import, and loses the name the kit uses.

## Decision

1. **One rule, as data.** An alias maps a family to targets, each with an optional size range: `{ family, minSize?, maxSize? }`, where min is inclusive and max exclusive, in px (`packages/model/src/font-aliases.ts`).
   - Built-in aliases are a table, not code paths:
     - "SF Pro" → "SF Pro Text" below 20 px, "SF Pro Display" from 20 px. Apple's guidance is Text for 19 pt or smaller and Display for 20 pt or larger, so in-between sizes such as 19.5 go to Text.
     - The same split for "SF Compact".
     - Each cut falls back to the variable family when that's what a team has.
     - The pre-2017 "SF UI Text" and "SF UI Display" go to today's names.
   - "SF Pro Rounded", "SF Compact Rounded", "SF Mono" and "New York" ship under those names as single families, so they need none.
   - Adding a family with the same pattern is one row.
2. **Precedence.** `resolveFont(family, size, available, teamAliases)` tries, in order:
   - the family itself when it's here, so a team that uploads the variable "SF Pro" gets exactly that;
   - then the team's alias;
   - then the built-in one;
   - else the family, which then shows as missing.
   Within an alias, the first target that's here and holds the size wins, else the nearest by size of those that are here. Aliases don't chain. Weight and italic are never aliased: only the family changes, and its faces are matched to the text's weight and style as for any font.
3. **Where it's applied.** The text measurer answers `family(name, size)` (`TextMeasurer.family`, from a `FontResolver`). `fontString`, `shapingRun`, SVG export, PDF export and the headless renderer's `facesUsed` all ask it, so the canvas, HarfBuzz shaping, exports and server renders agree by construction. The file never changes.
4. **Team aliases live in D1**: `team_font_aliases (team_id, family, targets JSON, updated_by, updated_at)`, primary key `(team_id, family)`, at most 200 per team. `GET /api/teams/:team/fonts` lists them beside the faces, so the editor gets both in one request. `PUT /api/teams/:team/font-aliases` and `DELETE …/font-aliases/:family` need an editor on the team. Input is checked by `parseFontAlias`.
5. **The browser.** The font registry (`apps/web/src/fonts/fonts.ts`) is the editor's `FontResolver`.
   - It treats a family as here when it's a team font, built in, a system font, in the Google catalog or local.
   - Until the catalog has loaded, it aliases nothing, so text never jumps to a stand-in and back.
   - `watchDocumentFonts` loads every stand-in a family may use, since which one depends on size.
   - Layouts are invalidated through the measurer's generation when the registry changes.
6. **The Worker.** `apps/agent-runner/src/font-aliases.ts` (the agent runner, decision 0033) answers the same question from D1 (the team's families and aliases), the bundled and system lists (shared constants in the model), and the Google catalog.
   - It is prepared before measuring, like font files.
   - The team's part is looked up again after a minute, so a long-lived room picks up a new alias.
   - Only fonts installed on someone's own computer are beyond it.
7. **Missing glyphs.** "Drawpane Missing Glyph" is a 1 KB font of one box glyph mapped to every private-use code point (cmap format 13, as Apple's Last Resort font does).
   - Every font string lists it right after the text's own family. A symbol the font lacks draws as the box, never as a fallback's guess.
   - Its unicode-range (no space) keeps it from being CSS's first available font, so line heights don't change. The HarfBuzz measurer skips it for metrics for the same reason.
   - The same bytes go to the canvas (as a `FontFace`), HarfBuzz and resvg.
8. **The missing fonts panel** (File → Missing fonts…, or the page inspector's Fonts section):
   - It lists each family that isn't here, each style a family here lacks, and each family shown through an alias, with layer counts.
   - "This file" writes the replacements into layers, runs and text styles as one undoable change (`replaceFontOps`).
   - "Every file in the team" saves a team alias instead.

## Consequences

- "SF Pro" kits open drawn in the team's SF Pro Text and SF Pro Display, and keep working after re-imports, with no file changed.
- What text is drawn in can now change without an edit, when a team uploads a font or sets an alias. Layout sizes stored in the file are kept, as for any font that arrives late, and text measured in this session refits.
- Static SF Pro Text and Display, if they lack the symbols, show boxes for them. `tools/font-symbols/check.mjs` counts the private-use glyphs in font files before they're uploaded, so a team can see which of its files carries the symbols.
- A local font a person has installed only counts in their browser. The Worker can't see it, so the agent runner may resolve that family differently. This is the same limit local fonts already have.
