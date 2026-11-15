# 0011. A remote MCP server, reached with personal access tokens

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

The PRD makes AI agents collaborators: every instance serves a remote MCP server, any MCP client and model can use it, and agents write on branches that people review. The first step is reading: an agent asked to build a screen "with our components" has to see the file's outline, its components, its tokens and the conversation around it. Writing comes with branches.

MCP clients connect over Streamable HTTP and authenticate with a bearer token (OAuth, or a token the person pastes). The protocol changed this year: the 2026-07-28 revision retires the `initialize` handshake and sessions (every request carries its version; `server/discover` is optional) and adds `Mcp-Method`/`Mcp-Name` headers, while clients built on 2025 revisions still open with `initialize`.

## Decision

1. **Personal access tokens.** People create tokens on their account page: a name and an expiry (30, 90 or 365 days, or none). The token (`dp_pat_` and 43 random characters) is shown once; D1 keeps its SHA-256, a short prefix to recognise it by, when it was last used, and its expiry. A token acts as its person, read-only for now, in every team they're in. Revoking deletes it.
2. **Tokens are accepted on the MCP endpoint only**, as `Authorization: Bearer`. The cookie API never takes them, so a leaked token can't drive the browser's API, and the MCP endpoint never takes the session cookie.
3. **The server is stateless and speaks every revision since 2025-03-26** at `POST /api/mcp` (under `/api`, which the Worker serves before static assets on every install): JSON-RPC requests in, JSON responses out, no sessions and no streams (`GET` answers 405). `initialize` and `server/discover` answer alike, echoing the client's protocol version when it's one we speak; notifications are accepted with 202. When `Mcp-Method` is sent, it must match the body. Cross-site browser requests are refused, as for the whole API.
4. **Read tools**, each checking the file access the person has, exactly as the API does: `list_files`, `get_outline`, `get_node`, `find_nodes`, `list_components`, `list_tokens`, `get_comments`, `get_history`. They read the document from the file's FileRoom (`allNodes`), so they see the latest edits, and answer as JSON text (and `structuredContent`), bounded so a big file can't flood a model's context. A tool's own failures (no such file, a bad id) come back as `isError` results the model can read; protocol mistakes are JSON-RPC errors.

## Consequences

- Any MCP client (Claude Code, Cursor, an IDE, a custom agent) can read any file its person can, with one command and nothing installed.
- No OAuth yet: the token is pasted into the client's config. OAuth (with dynamic or metadata-document clients) can sit in front of the same tools later.
- Writing (`start_branch`, `apply_ops`) waits for branches, so an agent can't change a file anyone is working in. (Since decided in [0021](0021-agent-tools.md): write tokens, and sessions on a branch or live.)
