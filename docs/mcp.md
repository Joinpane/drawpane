# Connecting AI clients

Every Drawpane instance serves an [MCP](https://modelcontextprotocol.io) server. Any MCP client (Claude Code, Cursor, VS Code, or an agent you build) can read the files you can: their pages and layers, components, design tokens, comments and history. Nothing is installed: the client talks to your instance over HTTPS with a token you make.

The server reads and never writes. Agents that change files will work on branches people review and merge (see the [PRD](PRD.md)).

## Make a token

1. Open **Settings → Access tokens**: select your name at the bottom of the dashboard's sidebar, then **Access tokens**.
2. Choose **New token**, name it after the client that will use it ("Claude Code on my laptop"), and pick when it expires.
3. Copy the token. It's shown once: Drawpane keeps only a hash of it.

Make one token per client, so you can revoke them one at a time. A token acts as you in every team you're in.

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

## Tools

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

Ids are stable: an agent can pass what one tool returns to the next. A file you can't open, or an id that doesn't exist, comes back as a tool error the model can read, not a failure.

Try asking your client: *"Look at the Checkout file in Drawpane. Which components does it use, and which colours aren't tokens?"*

## Protocol

- **Transport:** Streamable HTTP, one `POST` per JSON-RPC message, answered with JSON. There are no sessions and no streams (`GET` answers 405).
- **Revisions:** it speaks every revision from 2025-03-26 to 2026-07-28. Older clients start with `initialize` and newer ones may call `server/discover`; both get the same answer. If a client sends `Mcp-Method`, it must match the request.
- **Address:** it lives under `/api`, which the Worker serves before static assets on every install, so self-hosted instances need no configuration.

## Security

- **Tokens:** they're accepted only by the MCP endpoint, and the endpoint never accepts the browser's session cookie. A leaked token can read files until it expires or you revoke it; it can't change anything.
- **Access:** every tool checks your access to the file exactly as the editor does. A token sees only teams you belong to.
- **Browsers:** requests from browsers on other sites are refused.
- **Revoking:** under **Settings → Access tokens**. Whatever uses the token stops working at once.
