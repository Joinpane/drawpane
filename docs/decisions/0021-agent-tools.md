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
- **The room's engine.** `FileRoom.runAgentTool` loads fonts first (all the async work), then runs the tool on a warm `Editor` and commits the operations its sync engine queued (`SyncEngine.takeUnsent`, fix-ups included) as one transaction, with no await between taking the editor and the commit. The warm editor follows every commit and is rebuilt when it falls out of step. Something the editor refuses along the way (a notice) fails the whole call.
- **The call ledger** (`agent_calls` in the room's SQLite) is written in the commit's storage transaction. Calls are kept for a day rather than an hour, because the session's undo reaches back as far as the ledger does. A call's label is its tool's title, kept in the ledger beside the revision it committed.
- **Agent undo** applies a call's recorded inverse as a new transaction. It refuses when anyone else's logged operations since then changed one of the call's layers, or put a layer inside one.
- **Measurer.** The agent tools are listed only once a real `TextMeasurer` is configured (`provideMeasurer`, for the HarfBuzz measurer of step 3). `AGENT_MEASURER=standin` turns on a fixed-advance stand-in for tests and local development.
