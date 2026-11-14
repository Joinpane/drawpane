/**
 * The MCP server (docs/decisions/0011-mcp-server.md): `POST /api/mcp`,
 * stateless JSON-RPC over Streamable HTTP, for every protocol revision since
 * 2025-03-26. A personal access token says who's asking; each tool checks
 * that person's access to the file, exactly as the API does.
 */
import { ID_PATTERN, type NodeRecord } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { requireFileRole } from "../api/access";
import { userForBearer } from "../auth/tokens";
import type { AppContext, Env, User } from "../env";
import { HttpError } from "../lib/http";
import { components, FileDoc, findNodes, nodeDetail, outline, tokens } from "./document";

/** The revisions we speak, oldest first; the last is what we offer a client that names none we know. */
export const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;
const LATEST = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1] as string;

const SERVER_INFO = { name: "drawpane", title: "Drawpane", version: "0.1.0" };
const INSTRUCTIONS =
  "Drawpane design files. Start with list_files, then get_outline for a file's pages and layers; " +
  "get_node for a layer's full properties; list_components and list_tokens for its design system; " +
  "get_comments and get_history for its conversation and versions. Ids are stable: pass them back as given.";

// ---------------------------------------------------------------------------
// JSON-RPC

type Id = string | number;
interface Request {
  readonly jsonrpc: "2.0";
  readonly id?: Id;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const rpcError = (id: Id | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

/** A tool's own failure, shown to the model as the tool's answer (not a protocol error). */
class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Tools

interface ToolContext {
  readonly env: Env;
  readonly user: User;
}

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodObject<z.ZodRawShape>;
  readonly run: (ctx: ToolContext, args: never) => Promise<unknown>;
}

const FileId = z.string().regex(ID_PATTERN, "a file id from list_files");
const NodeId = z.string().regex(ID_PATTERN, "a layer id from get_outline or find_nodes");

/** A file's document, once the person's access to it is checked. */
async function readFile(ctx: ToolContext, fileId: string) {
  try {
    const { file } = await requireFileRole(ctx.env, ctx.user.id, fileId, "viewer");
    const room = ctx.env.FILE_ROOM.get(ctx.env.FILE_ROOM.idFromName(file.id));
    // The RPC stub's types widen tuples; the nodes are as the room stores them.
    const nodes = (await room.allNodes()) as unknown as NodeRecord[];
    return { file, doc: new FileDoc(nodes) };
  } catch (error) {
    if (error instanceof HttpError)
      throw new ToolError(`No file ${fileId} that you can open. Use list_files to find one.`);
    throw error;
  }
}

function tool<S extends z.ZodRawShape>(
  name: string,
  title: string,
  description: string,
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): Tool {
  return { name, title, description, input: z.object(shape), run: run as Tool["run"] };
}

export const TOOLS: readonly Tool[] = [
  tool(
    "list_files",
    "List files",
    "Design files you can open, most recently edited first, with their project and team.",
    {
      query: z.string().max(100).optional().describe("Only files whose name contains this."),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ env, user }, { query, limit }) => {
      const like = query ? `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { results } = await env.DB.prepare(
        `SELECT f.id, f.name, f.updated_at, p.name AS project, t.name AS team
           FROM files f
           JOIN team_members m ON m.team_id = f.team_id AND m.user_id = ?
           JOIN projects p ON p.id = f.project_id
           JOIN teams t ON t.id = f.team_id
          WHERE f.deleted_at IS NULL AND (? IS NULL OR f.name LIKE ? ESCAPE '\\')
          ORDER BY f.updated_at DESC LIMIT ?`,
      )
        .bind(user.id, like, like, limit)
        .all<{ id: string; name: string; updated_at: number; project: string; team: string }>();
      return {
        files: results.map((f) => ({
          id: f.id,
          name: f.name,
          project: f.project,
          team: f.team,
          updatedAt: new Date(f.updated_at).toISOString(),
        })),
      };
    },
  ),
  tool(
    "get_outline",
    "Get a file's outline",
    "A file's pages, and the layer tree of one page (the first, unless pageId is given): ids, kinds, names, sizes and text. Deep or large trees are cut short and say how many children were left out; ask again from a layer with rootId.",
    {
      fileId: FileId,
      pageId: NodeId.optional().describe("The page to outline; the first page when left out."),
      rootId: NodeId.optional().describe("Outline from this layer instead of the whole page."),
      depth: z.number().int().min(1).max(20).default(6),
      limit: z.number().int().min(10).max(2000).default(400).describe("Most layers to list."),
    },
    async (ctx, { fileId, pageId, rootId, depth, limit }) => {
      const { file, doc } = await readFile(ctx, fileId);
      const pages = doc.pages();
      const page = pageId ? doc.get(pageId) : pages[0];
      if (pageId && page?.type !== "page") throw new ToolError(`No page ${pageId} in this file.`);
      const start = rootId ?? page?.id;
      if (rootId && !doc.get(rootId)) throw new ToolError(`No layer ${rootId} in this file.`);
      return {
        file: { id: file.id, name: file.name },
        pages: pages.map((p) => ({ id: p.id, name: p.props.name ?? "Page" })),
        outline: start ? outline(doc, start, depth, limit) : null,
      };
    },
  ),
  tool(
    "get_node",
    "Get a layer",
    "One layer's full properties (as stored: properties at their default are left out), its parent, page and children.",
    { fileId: FileId, nodeId: NodeId },
    async (ctx, { fileId, nodeId }) => {
      const { doc } = await readFile(ctx, fileId);
      const detail = nodeDetail(doc, nodeId);
      if (!detail) throw new ToolError(`No layer ${nodeId} in this file.`);
      return detail;
    },
  ),
  tool(
    "find_nodes",
    "Find layers",
    "Layers whose name or text contains a query (any case), optionally of one kind: frame, text, rect, ellipse, component, instance, component set…",
    {
      fileId: FileId,
      query: z.string().max(200).default(""),
      kind: z.string().max(32).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (ctx, { fileId, query, kind, limit }) => {
      const { doc } = await readFile(ctx, fileId);
      return findNodes(doc, query, kind, limit);
    },
  ),
  tool(
    "list_components",
    "List components",
    "The file's own main components and sets of variants: names, descriptions and how many instances use each. Build with these rather than drawing your own.",
    { fileId: FileId },
    async (ctx, { fileId }) => {
      const { doc } = await readFile(ctx, fileId);
      return { components: components(doc) };
    },
  ),
  tool(
    "list_tokens",
    "List design tokens",
    "The file's variable collections (colours, numbers, strings, with a value per mode) and text styles. Use these names rather than raw values.",
    { fileId: FileId },
    async (ctx, { fileId }) => {
      const { doc } = await readFile(ctx, fileId);
      return tokens(doc);
    },
  ),
  tool(
    "get_comments",
    "Get comments",
    "The file's comment threads, newest activity first: where each is pinned (page and layer), who said what, and whether it's resolved.",
    {
      fileId: FileId,
      includeResolved: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async (ctx, { fileId, includeResolved, limit }) => {
      const { file } = await readFile(ctx, fileId);
      const { results: threads } = await ctx.env.DB.prepare(
        `SELECT id, page_id, node_id, created_at, resolved_at FROM comment_threads
          WHERE file_id = ? AND (? = 1 OR resolved_at IS NULL)
          ORDER BY updated_at DESC LIMIT ?`,
      )
        .bind(file.id, includeResolved ? 1 : 0, limit)
        .all<{
          id: string;
          page_id: string;
          node_id: string | null;
          created_at: number;
          resolved_at: number | null;
        }>();
      if (threads.length === 0) return { threads: [] };
      const { results: comments } = await ctx.env.DB.prepare(
        `SELECT c.thread_id, c.body, c.created_at, u.name AS author FROM comments c
           LEFT JOIN users u ON u.id = c.author_id
          WHERE c.thread_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at`,
      )
        .bind(JSON.stringify(threads.map((t) => t.id)))
        .all<{ thread_id: string; body: string; created_at: number; author: string | null }>();
      return {
        threads: threads.map((t) => ({
          id: t.id,
          pageId: t.page_id,
          nodeId: t.node_id,
          resolved: t.resolved_at !== null,
          comments: comments
            .filter((c) => c.thread_id === t.id)
            .map((c) => ({
              author: c.author ?? "Someone",
              body: c.body,
              at: new Date(c.created_at).toISOString(),
            })),
        })),
      };
    },
  ),
  tool(
    "get_history",
    "Get version history",
    "The file's saved versions, newest first: named versions, autosaves and restores, with who made them.",
    { fileId: FileId, limit: z.number().int().min(1).max(200).default(50) },
    async (ctx, { fileId, limit }) => {
      const { file } = await readFile(ctx, fileId);
      const { results } = await ctx.env.DB.prepare(
        `SELECT v.id, v.revn, v.reason, v.name, v.description, v.created_at, u.name AS by
           FROM versions v LEFT JOIN users u ON u.id = v.created_by
          WHERE v.file_id = ? ORDER BY v.created_at DESC LIMIT ?`,
      )
        .bind(file.id, limit)
        .all<{
          id: string;
          revn: number;
          reason: string;
          name: string | null;
          description: string | null;
          created_at: number;
          by: string | null;
        }>();
      return {
        versions: results.map((v) => ({
          id: v.id,
          revision: v.revn,
          reason: v.reason,
          name: v.name,
          description: v.description,
          by: v.by,
          at: new Date(v.created_at).toISOString(),
        })),
      };
    },
  ),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** A tool as `tools/list` describes it. */
function describe(t: Tool) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input" }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

// ---------------------------------------------------------------------------
// Methods

async function handle(ctx: ToolContext, request: Request) {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize":
    case "server/discover": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      const version =
        asked && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST;
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(describe) };
    case "tools/call": {
      const t = typeof params.name === "string" ? BY_NAME.get(params.name) : undefined;
      if (!t)
        throw Object.assign(new Error(`No tool ${String(params.name)}.`), { rpc: INVALID_PARAMS });
      const args = t.input.safeParse(params.arguments ?? {});
      if (!args.success) {
        const issue = args.error.issues[0];
        return toolResult(
          { error: `${issue?.path.join(".") || "arguments"}: ${issue?.message ?? "invalid"}` },
          true,
        );
      }
      try {
        return toolResult(await t.run(ctx, args.data as never), false);
      } catch (error) {
        if (error instanceof ToolError) return toolResult({ error: error.message }, true);
        throw error;
      }
    }
    default:
      throw Object.assign(new Error(`No method ${request.method}.`), { rpc: METHOD_NOT_FOUND });
  }
}

function toolResult(value: unknown, isError: boolean) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function parseRequest(body: unknown): Request | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return null;
  if (r.id !== undefined && typeof r.id !== "string" && typeof r.id !== "number") return null;
  if (r.params !== undefined && (typeof r.params !== "object" || r.params === null)) return null;
  return r as unknown as Request;
}

export const mcp = new Hono<AppContext>()
  .post("/", async (c) => {
    const auth = await userForBearer(c.env, c.req.header("authorization"));
    if (!auth)
      return c.json(rpcError(null, INVALID_REQUEST, "Sign in with a Drawpane access token."), 401, {
        "www-authenticate": 'Bearer realm="drawpane", error="invalid_token"',
      });
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, PARSE_ERROR, "The body isn't JSON."), 400);
    }
    const request = parseRequest(body);
    if (!request)
      return c.json(rpcError(null, INVALID_REQUEST, "Send one JSON-RPC 2.0 request."), 400);
    // 2026-07-28: routing headers, when sent, must say what the body does.
    const headerMethod = c.req.header("mcp-method");
    if (headerMethod !== undefined && headerMethod !== request.method)
      return c.json(
        rpcError(request.id ?? null, INVALID_REQUEST, "Mcp-Method doesn't match the request."),
        400,
      );
    // A notification (no id) is accepted, and answered with nothing.
    if (request.id === undefined) return c.body(null, 202);
    try {
      const result = await handle({ env: c.env, user: auth.user }, request);
      return c.json({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const code = (error as { rpc?: number }).rpc;
      if (code) return c.json(rpcError(request.id, code, (error as Error).message));
      throw error;
    }
  })
  // No streams and no sessions: one POST per message.
  .on(["GET", "DELETE"], "/", (c) =>
    c.json(rpcError(null, INVALID_REQUEST, "This server takes one POST per message."), 405, {
      allow: "POST",
    }),
  );
