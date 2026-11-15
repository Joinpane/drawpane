# Connecting AI clients

Every Drawpane instance serves an [MCP](https://modelcontextprotocol.io) server. Any MCP client (Claude Code, Cursor, VS Code, or an agent you build) can read the files you can: their pages and layers, components, design tokens, comments and history. With a read and write token, it can also design in them: on a branch you review and merge, or live while you watch. Nothing is installed: the client talks to your instance over HTTPS with a token you make.

## Make a token

1. Open **Settings → Access tokens**: select your name at the bottom of the dashboard's sidebar, then **Access tokens**.
2. Choose **New token**, name it after the client that will use it ("Claude Code on my laptop"), and pick when it expires.
3. Choose its access:
   - **Read only** (the default): it reads your files and changes nothing.
   - **Read and write**: it can also start design sessions in files you can edit (see [Designing with an agent](#designing-with-an-agent)).
4. Copy the token. It's shown once: Drawpane keeps only a hash of it.

Make one token per client, so you can revoke them one at a time. A token acts as you in every team you're in. Tokens made before access could be chosen are read only; make a new one to let an agent write.

## Connect a client

The server is at `https://<your instance>/api/mcp`. Send the token as `Authorization: Bearer <token>`.

**Claude Code.** The token page shows this command with your address and token filled in:

```sh
claude mcp add --transport http drawpane https://<your instance>/api/mcp \
  --header "Authorization: Bearer <token>"
```

**Cursor.** In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "drawpane": {
      "url": "https://<your instance>/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**VS Code.** In `.vscode/mcp.json`:

```json
{
  "servers": {
    "drawpane": {
      "type": "http",
      "url": "https://<your instance>/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Anything else.** Use the client's Streamable HTTP transport with the same address and header.

## Designing with an agent

An agent with a read and write token designs inside a **session**. It starts one on a file you can edit, and chooses where its changes land:

- **branch** (the default): a new branch of the file, named for the session ("Claude, for Ana"). The file itself isn't touched. When the agent is done, you review the branch's changes and merge what you want, as with any branch.
- **live**: the file itself. People with it open see each change arrive, attributed to you and the session.

Each change the agent makes is one call, and one step:

- **One transaction.** A call's changes, and everything the editor works out from them (text sizing, auto layout, instances, variables), are saved together as one revision. If the call fails, nothing is changed, and the error says why.
- **Exactly once.** Every call has an id; a client can send its own (`callId`) and retry with it after a timeout. A repeated id answers as the first time did, without making the change twice.
- **Undo for agents.** `undo` and `redo` step over the session's own calls only. They refuse, saying who and which layers, when a person has changed those layers since: an agent never reverts your work.
- **Checked every call.** A session belongs to the person and the token that started it, and every call checks that you can still edit its file. Revoke the token, remove the person, or merge the branch, and the session stops.

A session's `targetFileId` is the file its changes land in (the branch, in branch mode). The agent reads it with the read tools, like any file.

### The JSX dialect

`render` builds layers from a small JSX dialect, and `get_jsx` writes layers back in it, so an agent can read a layer, change it and render it over itself (`replaceId`). It's parsed, never run: elements are layer types, attributes are properties, and text inside `<Text>` is its text.

```jsx
<Frame name="Plan card" flex="col" gap={8} p={16} fill="#ffffff" radius={12} w={240}>
  <Text size={20} weight={600}>Pro plan</Text>
  <Text size={14}>Everything in Free, and more.</Text>
  <Rect w="fill" h={1} fill="#e6e4df" />
</Frame>
```

- **Elements:** the layer types: `Frame`, `Group`, `Rect`, `Ellipse`, `Polygon`, `Star`, `Line`, `Path` and `Text`.
- **Short attributes:** `x`, `y`, `w` and `h` (a number, `"hug"` or `"fill"`), `flex` (`"row"`, `"col"`, `"grid"`), `gap`, `p`/`px`/`py`/`pt`/`pr`/`pb`/`pl`, `justify`, `align`, `wrap`, `fill` and `stroke` (`"#rrggbb"` or a list of paints), `radius`, `clip`, `hidden`, `opacity`, `size`, `weight`, `font`, `italic`, `lineHeight`, `tracking`.
- **Any property by its model name**, with JSON in braces: `effects={[...]}`, `strokeWeight={2}`.
- Auto layout frames hug their content unless given a size; a text given a width wraps. Every value is checked against the file format's own schema, and a mistake names the attribute and where it is.

Agents can design only once your instance measures text the way the browser does, with the same fonts. Until that's configured, the server lists only the read tools.

## Tools

### Reading

| Tool | What it returns | Arguments |
| --- | --- | --- |
| `list_files` | Files you can open, most recently edited first, with project and team | `query`, `limit` |
| `get_outline` | A file's pages, and one page's layer tree: ids, kinds, names, sizes and text. Deep or large trees are cut short and say what was left out | `fileId`, `pageId`, `rootId`, `depth`, `limit` |
| `get_node` | One layer's properties, parent, page and children | `fileId`, `nodeId` |
| `find_nodes` | Layers whose name or text contains a query, optionally of one kind (`frame`, `text`, `component`, `instance`…) | `fileId`, `query`, `kind`, `limit` |
| `list_components` | The file's components and sets of variants, with descriptions and how many instances use each | `fileId` |
| `list_tokens` | Variable collections (values by mode) and text styles | `fileId` |
| `get_comments` | Comment threads, where they're pinned, and their replies | `fileId`, `includeResolved`, `limit` |
| `get_history` | Saved versions: named, automatic and restores, with who made them | `fileId`, `limit` |
| `get_jsx` | A layer and what's inside it, as JSX with each layer's id | `fileId`, `id`, `depth` |

### Designing (read and write tokens)

| Tool | What it does | Arguments |
| --- | --- | --- |
| `start_session` | Starts a session on a file you can edit, on a new branch or live. Returns its `sessionId` and `targetFileId` | `fileId`, `mode` (`branch` or `live`), `name` (the agent's, as people see it), `branchName` |
| `render` | Builds layers from JSX, inside a layer or on the page, or over a layer (`replaceId`). Returns their ids and JSX, laid out | `sessionId`, `jsx`, `parentId`, `index`, `replaceId`, `callId` |
| `set_props` | Changes properties of several layers, all or nothing, with the same attributes as JSX | `sessionId`, `changes`, `callId` |
| `move_nodes` | Moves layers into a frame, group or page, at an index | `sessionId`, `ids`, `parentId`, `index`, `callId` |
| `delete_nodes` | Deletes layers and what's inside them | `sessionId`, `ids`, `callId` |
| `bind_token` | Binds a variable to a property of layers (fill, gap, radius…) | `sessionId`, `ids`, `key`, `variableId`, `callId` |
| `set_variable_mode` | Sets which mode of a collection applies inside frames or pages | `sessionId`, `ids`, `collectionId`, `modeId`, `callId` |
| `undo` | Takes back the session's latest change, unless a person has changed those layers since | `sessionId`, `callId` |
| `redo` | Brings back the change the session undid last | `sessionId`, `callId` |
| `end_session` | Ends the session; on a branch, it's then ready for review | `sessionId` |

Clients see `readOnlyHint` on the reading tools, and `destructiveHint` on the tools that change or remove what's there.

Ids are stable: an agent can pass what one tool returns to the next. A file you can't open, or an id that doesn't exist, comes back as a tool error the model can read, not a failure.

Try asking your client: *"Look at the Checkout file in Drawpane. Which components does it use, and which colours aren't tokens?"* With a read and write token: *"On a branch of Checkout, add a pricing card with our tokens."*

## Protocol

- **Transport:** Streamable HTTP, one `POST` per JSON-RPC message, answered with JSON. There are no sessions and no streams (`GET` answers 405).
- **Revisions:** it speaks every revision from 2025-03-26 to 2026-07-28. Older clients start with `initialize` and newer ones may call `server/discover`; both get the same answer. If a client sends `Mcp-Method`, it must match the request.
- **Address:** it lives under `/api`, which the Worker serves before static assets on every install, so self-hosted instances need no configuration.

## Security

- **Tokens:** they're accepted only by the MCP endpoint, and the endpoint never accepts the browser's session cookie. A leaked read only token can read files until it expires or you revoke it, and can't change anything. A read and write token can also change files you can edit, through sessions, every change attributed and undoable; make one only for a client you trust, and prefer branch sessions.
- **Access:** every tool checks your access to the file exactly as the editor does. A token sees only teams you belong to.
- **Browsers:** requests from browsers on other sites are refused.
- **Revoking:** under **Settings → Access tokens**. Whatever uses the token stops working at once.
