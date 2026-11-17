# 0021. Agent tools: one tool layer, run in an open editor or headless, handed over mid-session

- Status: accepted
- Date: 2026-11-15
- Deciders: Ziyang (lead maintainer)

## Context

Decision 0011 gave agents a read-only MCP server. The PRD makes agents collaborators that design in the file. Two things shape how they write:

- **Where the work runs.** An edit isn't finished when its operations are written. The editor fixes things up after every commit: it measures and wraps text, lays out auto layout, updates instances and resolves variables. Then the result has to be drawn, so the agent can check its own work. In the browser all of that runs on canvas. A Worker has no canvas.
- **What other tools do.** Open Pencil runs about 125 tools inside the open editor, with the MCP server only relaying. The core of its set:
  - `render` builds a whole tree from JSX in one call, and `get_jsx` reads it back the same way;
  - typed setters, an all-or-nothing batch, and a patch with a dry run;
  - `export_image` and `diff_pixels`, so the agent checks visually;
  - one undo step per call, and an undo that won't revert the person's edits.

  Figma writes through one tool that runs Plugin API code, guided by skills files. Both need the app open. We want agents to work whether or not anyone has the file open.

## Decision

1. **One tool layer, defined once.** Tools live in `@drawpane/editor` (`src/agent/`). Each has:
   - a name;
   - a description written for models;
   - a zod schema for its input;
   - a level: `read`; `view`, which changes only what's shown; or `write`, which changes the document;
   - a `run(editor, input)` that works on an `Editor` and returns JSON, plus an image where it renders one.

   MCP, the built-in agent (PRD v0.3) and any later surface generate their tool lists from it. MCP's `readOnlyHint` and `destructiveHint` come from the level. No tool runs code the agent wrote.

2. **JSX is the main write path.** `render` takes a small JSX dialect and `get_jsx` returns the same dialect, so an agent can read a layer, edit it and render it back over itself (`replace`). The dialect is parsed, never evaluated:
   - elements are layer types (`Frame`, `Text`, `Rect`, `Ellipse`, `Line`, `Instance`, …);
   - attributes are model properties, with a few short forms (`w`, `h`, `p`, `gap`, `fill`, `radius`, `flex`);
   - text children become text.

   Typed tools cover precise changes:
   - `set_props`, a batch that applies all or nothing;
   - `delete`, `move`, `duplicate`;
   - `bind_token`, `set_variable_mode`, `insert_component`.

3. **Every write call is one transaction.** A call runs against the editor, collects its operations and commits them as one undo step attributed to the agent, labelled with the tool. If the call throws or its result fails validation, nothing is committed. `undo` and `redo` for agents only step back over the agent's own calls, and refuse when the latest step on that path is a person's.

4. **Two engines run the same tools.**
   - **Open editor (preferred when there is one).** The FileRoom knows which editors are connected. A call goes to one of them: the requesting person's own tab first, then any editor tab with edit rights. That editor runs the tool with its live `Editor` and commits through the normal transaction path, so the change appears as the person watches. Rendering is the canvas renderer, the same as on screen.
   - **Headless (when no editor is open).** The Worker builds an `Editor` from the room's snapshot. A `TextMeasurer` built on HarfBuzz reads the same font files the browser uses: the font proxy for Google and built-in families, R2 for team fonts. The editor runs the tool and the room commits the resulting operations. Images come from the editor's SVG export, rasterised in the Worker.

5. **Calls hand over cleanly between engines.**
   - Every call carries an id. The room records the ids of calls whose transaction it committed, with their result, for an hour.
   - If an editor running a call disconnects or doesn't answer within its timeout, the server asks the room. If the call committed, it returns the recorded result. If not, it runs the call headlessly.
   - So a call is done exactly once, whichever engine finishes it. An editor that went away halfway leaves nothing behind, because commits are whole transactions.
   - The engine is chosen per call: a session that started in someone's tab carries on headless after they close it, and moves back when they open the file again.

6. **The engines are kept as close as possible.** Only two things differ: the text measurer and the rasteriser.
   - **Text.** Since text is drawn at the font's exact advances (decision 0013), canvas and HarfBuzz measure the same thing. A test measures a corpus of strings with both, in the browser, and holds them to a fraction of a pixel.
   - **Rendering.** A parity suite renders scenes both ways and keeps a per-scene threshold, as the Figma suites do.
   - **Code.** Everything else runs the same code.

7. **Sessions are live or on a branch, chosen when they start.** `start_session` takes `mode: "live" | "branch"`.
   - **live** edits the file directly. The agent has a cursor and name tag in the room, and its undo can't revert people's edits.
   - **branch** makes a branch (decision 0012) that a person reviews and merges.
   - Tokens are scoped: read, or read and write. A read token can't start a session.

8. **Agents see their work.**
   - `export_image` returns a PNG of a layer or page as MCP image content.
   - `diff_image` compares two renders and says where they differ.
   - `lint` reports detached values, contrast and overlaps.

## Consequences

- Agents work without anyone having the file open. When someone does, the agent works in their tab, visibly, with exact rendering.
- The Worker gains HarfBuzz and a rasteriser (WebAssembly), which costs bundle size. If the bundle outgrows Cloudflare's free-plan limit, rendering moves to its own Worker.
- Headless images can differ slightly from the canvas, for example for glass, noise and shaders. The parity suite says by how much, and tools mark images as headless.
- Build order, each step shipped and tested on its own:
  1. the tool layer and JSX, tested in Node;
  2. room commits for agents with call ids, the MCP write tools on the headless engine with a stand-in measurer, sessions and scoped tokens;
  3. the HarfBuzz measurer and the text parity test;
  4. headless rendering and the render parity suite;
  5. running calls in open editors, with handover;
  6. agent presence.

## Notes from step 2 (MCP write tools on the headless engine)

- **Tokens** carry a scope, `read` or `write`; tokens made before scopes stay `read`. The MCP server lists the write tools to every token and refuses them for read tokens with a message saying how to make a write token.
- **Sessions** live in D1 (`agent_sessions`): the person, the token (only it may use the session), the file, the target file and the name ("Claude, for Ana"). Branch sessions are the default. Each call checks the person can still edit the target, as the API does.
- **The room's engine.** `FileRoom.runAgentTool` loads fonts first (all the async work), then runs the tool on a warm `Editor` and commits the operations its sync engine queued (`SyncEngine.takeUnsent`, fix-ups included) as one transaction, with no await between taking the editor and the commit. The warm editor follows every commit and is rebuilt when it falls out of step. It holds the whole file in memory, so what it keeps is counted as it's kept (decision 0026 item 8): it's built from pages of the room's rows, each node counted in a meter as it's parsed and each copy layer as it's built, and the build stops with a refusal (`AgentTooLarge`, the tool's failure) before it holds more than 48 MB (`AGENT_MAX_HELD`) or presents more than 50,000 layers (`AGENT_MAX_NODES`). A SQL pre-check refuses what surely won't fit before a row is read. The warm editor counts what it follows as it applies it, and lets itself go once past the limit, or before a change whose copies alone would take it there; a tool whose edit builds copies past it is refused, and its editor let go of. `get_jsx` returns at most 2,000,000 characters. A call's undo (its inverse) is kept whole in its ledger row, as before #173: deleting a frame of 2,000 styled children (1.26 MB to put back) commits, undoes and redoes. Building that inverse isn't bounded yet; undo kept in pages of SQL rows and replayed in bounded parts as one step comes with moving tool execution out of the room (below). The MCP read tools answer from SQLite at any size (decision 0026). Something the editor refuses along the way (a notice) fails the whole call.
- **The call ledger** (`agent_calls` in the room's SQLite) is written in the commit's storage transaction. Calls are kept for a day rather than an hour, because the session's undo reaches back as far as the ledger does. A call's label is its tool's title, kept in the ledger beside the revision it committed.
- **Agent undo** applies a call's recorded inverse as a new transaction. It refuses when anyone else's logged operations since then changed one of the call's layers, or put a layer inside one.
- **Measurer.** The agent tools are listed only once a real `TextMeasurer` is configured. The Worker registers the HarfBuzz measurer as it starts (`apps/worker/src/agent/harfbuzz.ts`): one per room, reading the room's team fonts first. `AGENT_MEASURER=standin` asks for a fixed-advance stand-in instead, for tests and local development.
- **`export_image` headless** (step 4). The tool is defined once in the editor and asks its engine for the picture (`ToolServices.renderPng`), as decision 0023 draws it: in the room, resvg with the file's font files (the shaper's, as the render parity suite measured) and its team's images from R2. The text is laid out in its own fonts first, as for a write. The answer is MCP image content beside the JSON, which lists what's approximate (glass, noise, texture, background blur) and any font or image that couldn't be had. Images are bounded, as the editor is: only those the render draws are loaded (the SVG is written once without them to see which), one at a time, each charged before its file is read (its file twice and its pixels decoded at full size, `imageCost`, from the media record), and an image that would take them past 32 MB (`HEADLESS_IMAGE_BYTES`) isn't drawn: its fills are a grey, crossed placeholder, and the answer lists it by hash, so the agent knows the picture is incomplete and can still check the rest. A 2,000 × 2,000 image fits; a 12-megapixel photo doesn't, and is drawn when the file is open in an editor (reduced copies made at upload, or an image service, would let it be drawn here). resvg is handed each file's bytes beside the SVG (`resolveImage`, by a URL never fetched), so no base64 copy is made, except for a tiled fill: resvg resolves only images outside patterns, so a tile's pattern carries its image as a data: URL, charged for it. Nothing in the room can decode an image smaller than it is. Without a scale it's sized for a model: about 1536 px on the longest side, at most 2×.
- **Tool execution isn't bounded yet** (#173's second review). What's bounded is building the document: the meter counts the editor as it's built and as it follows changes. What a tool does with the built editor (layout, fonts, SVG, rasterising) isn't counted, and each of these can still take a room past its memory on a file the meter admits. They were on main before #173. They'll be bounded by moving agent tool execution out of the file room into an isolate of its own, a separate design:
  1. Text layout and its caches. A `set_props` changing the font size of four texts of 199,998 characters (801,907 bytes metered) ran a 128 MB heap out laying them out (`text-fixup.log`).
  2. SVG expansion. 10,000 rectangles with an angular gradient each (8.2 MB metered) ran the heap out writing the SVG, each gradient drawn as 180 wedges (`svg-expansion.log`).
  3. resvg's compositing surfaces. 20 nested 2,048 × 2,048 frames at 0.9 opacity (10 KB metered) grew resvg's WebAssembly memory to 375 MiB at the default size and 667 MiB at scale 1, which it never gives back (`resvg-nested-default-values.log`, `resvg-nested-values.log`).
  4. HarfBuzz font faces. 800 texts at weights 100 to 899 of one variable font (265 KB metered) grew HarfBuzz's memory to 172 MiB before a tool ran: a blob, face and font per weight (`font-faces-values.log`).
  7. Held replay of the copy cache. A valid transaction whose graph is cyclic part way through, followed held, leaves the engine's copies out of step with a fresh editor's, so font discovery misses faces (`held-fonts.log`). The per-operation code before had cases like it.

  Numbering follows the review; its findings 5 (the undo refusal, removed) and 6 (a photo failing the whole export, now a placeholder) are fixed. The reproductions are the review's (`reproductions.test.ts`, run by `run-repro.sh`), kept with it outside the repository.
- **HarfBuzz in a Worker.** The `harfbuzzjs` package fetches its WebAssembly from beside its script and, as it starts, compiles a small module at run time (Emscripten's `addFunction`, for a blob's destroy callback). A Worker can do neither. `patches/harfbuzzjs@1.6.4.patch` lets the package take Emscripten options set beforehand (the Worker passes the bundled module through `instantiateWasm`). Where `addFunction` isn't allowed, it leaves blobs without a destroy callback: their font data stays for the isolate's life. Fonts are loaded once per isolate and cached anyway. Freeing it when the JavaScript object goes would risk freeing it under a face. A test in workerd (`agent-harfbuzz.test.ts`) measures text with it there.
