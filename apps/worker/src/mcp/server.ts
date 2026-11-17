/**
 * The MCP server (docs/decisions/0011-mcp-server.md): `POST /api/mcp`,
 * stateless JSON-RPC over Streamable HTTP, for every protocol revision since
 * 2025-03-26. A personal access token says who's asking; each tool checks
 * that person's access to the file, exactly as the API does.
 *
 * Agents also design here (decision 0021): with a write token they start a
 * session, live in a file or on a branch of it, and call the agent tools
 * (render, set_props…), which the file's room runs on its headless editor.
 */
import { AGENT_TOOLS, type AgentTool, type ToolLevel } from "@drawpane/editor";
import { ID_PATTERN, newId } from "@drawpane/model";
import { Hono } from "hono";
import { z } from "zod";
import { agentToolsEnabled } from "../agent/measurer";
import {
  type AgentSession,
  endSession,
  requireSession,
  SessionError,
  startSession,
} from "../agent/sessions";
import { type FileRow, requireFileRole } from "../api/access";
import { type TokenScope, userForBearer } from "../auth/tokens";
import type { AppContext, Env, User } from "../env";
import { HttpError } from "../lib/http";
import type { AgentCallResult } from "../rooms/file-room";
import type { DocumentRequest } from "./document";

/** The revisions we speak, oldest first; the last is what we offer a client that names none we know. */
export const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;
const LATEST = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1] as string;

const SERVER_INFO = { name: "drawpane", title: "Drawpane", version: "0.1.0" };
const READ_INSTRUCTIONS =
  "Drawpane design files. Start with list_files, then get_outline for a file's pages and layers; " +
  "get_node for a layer's full properties; list_components and list_tokens for its design system; " +
  "get_comments and get_history for its conversation and versions. Ids are stable: pass them back as given.";
const WRITE_INSTRUCTIONS =
  ' To design, start_session on a file: mode "branch" (the default; a person reviews and merges it) or "live" ' +
  "(edits the file as people watch). Pass its sessionId to every change, and read the session's targetFileId. " +
  'Build with render (JSX: <Frame flex="col" gap={12} p={16}><Text size={20}>Title</Text></Frame>), read back ' +
  "with get_jsx, look at it with export_image, adjust with set_props, move_nodes, delete_nodes, bind_token and set_variable_mode; prefer the " +
  "file's components and tokens. undo and redo step over your own changes only. end_session when you're done.";

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
  /** The token asking, and what it may do. */
  readonly tokenId: string;
  readonly scope: TokenScope;
  /** This request's call id, for a write call that brings none (exactly-once, decision 0021). */
  readonly callId: string;
}

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** read tools work with any token; write tools need a write token. */
  readonly level: ToolLevel;
  /**
   * A write that changes or removes what's there (destructiveHint), rather
   * than only adding (starting and ending sessions).
   */
  readonly destructive?: boolean;
  /** One of the agent tools, listed once a text measurer is configured. */
  readonly agent?: boolean;
  readonly input: z.ZodObject<z.ZodRawShape>;
  readonly run: (ctx: ToolContext, args: never) => Promise<unknown>;
}

const FileId = z.string().regex(ID_PATTERN, "a file id from list_files");
const NodeId = z.string().regex(ID_PATTERN, "a layer id from get_outline or find_nodes");

/** A file, once the person's access to it is checked. */
async function readFile(ctx: ToolContext, fileId: string) {
  try {
    const { file } = await requireFileRole(ctx.env, ctx.user.id, fileId, "viewer");
    return { file };
  } catch (error) {
    if (error instanceof HttpError)
      throw new ToolError(`No file ${fileId} that you can open. Use list_files to find one.`);
    throw error;
  }
}

/**
 * A read of a file's document, answered by its room from SQLite (a large
 * file is never sent whole, decision 0026).
 */
async function readDocument<T>(
  ctx: ToolContext,
  fileId: string,
  request: DocumentRequest,
): Promise<{ file: FileRow; answer: T }> {
  const { file } = await readFile(ctx, fileId);
  const room = ctx.env.FILE_ROOM.get(ctx.env.FILE_ROOM.idFromName(file.id));
  const answer = (await room.readDocument(file.id, request)) as T | { error: string };
  if (answer && typeof answer === "object" && "error" in answer && typeof answer.error === "string")
    throw new ToolError(answer.error);
  return { file, answer: answer as T };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  title: string,
  description: string,
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): Tool {
  return {
    name,
    title,
    description,
    level: "read",
    input: z.object(shape),
    run: run as Tool["run"],
  };
}

const READ_TOOLS: readonly Tool[] = [
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
          WHERE f.deleted_at IS NULL AND f.branch_of IS NULL AND (? IS NULL OR f.name LIKE ? ESCAPE '\\')
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
    "A file's pages (at most limit of them; morePages counts the rest), and the layer tree of one page (the first, unless pageId is given): ids, kinds, names, sizes and text. Deep or large trees are cut short and say how many children were left out; ask again from a layer with rootId.",
    {
      fileId: FileId,
      pageId: NodeId.optional().describe("The page to outline; the first page when left out."),
      rootId: NodeId.optional().describe("Outline from this layer instead of the whole page."),
      depth: z.number().int().min(1).max(20).default(6),
      limit: z.number().int().min(10).max(2000).default(400).describe("Most layers to list."),
    },
    async (ctx, { fileId, pageId, rootId, depth, limit }) => {
      const { file, answer } = await readDocument<{ pages: unknown; outline: unknown }>(
        ctx,
        fileId,
        {
          kind: "outline",
          ...(pageId ? { pageId } : {}),
          ...(rootId ? { rootId } : {}),
          depth,
          limit,
        },
      );
      return { file: { id: file.id, name: file.name }, ...answer };
    },
  ),
  tool(
    "get_node",
    "Get a layer",
    "One layer's full properties (as stored: properties at their default are left out), its parent, page and children.",
    { fileId: FileId, nodeId: NodeId },
    async (ctx, { fileId, nodeId }) => {
      return (await readDocument(ctx, fileId, { kind: "node", nodeId })).answer;
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
      const request = { kind: "find", query, ...(kind ? { nodeKind: kind } : {}), limit } as const;
      return (await readDocument(ctx, fileId, request)).answer;
    },
  ),
  tool(
    "list_components",
    "List components",
    "The file's own main components and sets of variants: names, descriptions and how many instances use each. Build with these rather than drawing your own.",
    { fileId: FileId },
    async (ctx, { fileId }) => {
      return (await readDocument(ctx, fileId, { kind: "components" })).answer;
    },
  ),
  tool(
    "list_tokens",
    "List design tokens",
    "The file's variable collections (colours, numbers, strings, with a value per mode) and text styles. Use these names rather than raw values.",
    { fileId: FileId },
    async (ctx, { fileId }) => {
      return (await readDocument(ctx, fileId, { kind: "tokens" })).answer;
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

// ---------------------------------------------------------------------------
// Agent tools (decision 0021)

const SessionId = z.string().regex(ID_PATTERN, "a session id from start_session");
const CallId = z
  .string()
  .regex(/^[\w.:-]{8,100}$/, "8 to 100 letters, digits, dots, colons, dashes or underscores")
  .optional()
  .describe(
    "Makes the call exactly-once: send the same id again (a retry after a timeout) and you get the first answer back, without the change being made twice. Made for you when left out.",
  );

const WRITE_TOKEN_NEEDED =
  "This token can only read. To let an agent change files, its person makes a token with “Read and write” access in Drawpane (Settings → Access tokens → New token) and connects the client with that one.";

function fileRoom(env: Env, fileId: string) {
  return env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
}

/** The session, checked for this caller, or a tool error saying what's wrong. */
async function session(ctx: ToolContext, sessionId: string): Promise<AgentSession> {
  try {
    return await requireSession(ctx.env, { user: ctx.user, tokenId: ctx.tokenId }, sessionId);
  } catch (error) {
    if (error instanceof SessionError) throw new ToolError(error.message);
    throw error;
  }
}

/** A room's answer to an agent call, as the tool's result (or its error). */
function answer(out: AgentCallResult, callId: string): Record<string, unknown> {
  if (!out.ok) throw new ToolError(out.message);
  const data =
    out.result && typeof out.result === "object" && !Array.isArray(out.result)
      ? (out.result as Record<string, unknown>)
      : { result: out.result };
  return { ...data, revision: out.revn, callId, ...(out.replayed ? { replayed: true } : {}) };
}

const roomRef = (s: AgentSession) => ({ id: s.id, name: s.name, fileId: s.targetId });
const requester = (ctx: ToolContext) => ({ userId: ctx.user.id, name: ctx.user.name });

/** An agent tool from the editor's tool layer, run by the file's room on its headless editor. */
function agentTool(t: AgentTool): Tool {
  const base = t.input as unknown as z.ZodObject<z.ZodRawShape>;
  if (t.level !== "write") {
    return {
      name: t.name,
      title: t.title,
      description: `${t.description} Pass the fileId (a session's targetFileId to read its branch).`,
      level: t.level,
      agent: true,
      input: base.extend({ fileId: FileId }),
      run: (async (ctx: ToolContext, args: { fileId: string } & Record<string, unknown>) => {
        const { fileId, ...input } = args;
        const { file } = await readFile(ctx, fileId);
        // The RPC stub's types lose the union's narrowing; the answer is as the room returns it.
        const out = (await fileRoom(ctx.env, file.id).readAgentTool(
          file.id,
          t.name,
          input,
        )) as AgentCallResult;
        if (!out.ok) throw new ToolError(out.message);
        return out.image ? new WithImage(out.result, out.image) : out.result;
      }) as Tool["run"],
    };
  }
  return {
    name: t.name,
    title: t.title,
    description: `${t.description} Needs a sessionId from start_session; the change lands in that session's file.`,
    level: "write",
    destructive: true,
    agent: true,
    input: base.extend({ sessionId: SessionId, callId: CallId }),
    run: (async (
      ctx: ToolContext,
      args: { sessionId: string; callId?: string } & Record<string, unknown>,
    ) => {
      const { sessionId, callId = ctx.callId, ...input } = args;
      const s = await session(ctx, sessionId);
      const out = await fileRoom(ctx.env, s.targetId).runAgentTool(
        requester(ctx),
        roomRef(s),
        callId,
        t.name,
        input,
      );
      return answer(out, callId);
    }) as Tool["run"],
  };
}

function sessionInfo(s: AgentSession) {
  return {
    sessionId: s.id,
    name: s.name,
    mode: s.mode,
    fileId: s.fileId,
    targetFileId: s.targetId,
    ended: s.endedAt !== null,
  };
}

function stepTool(direction: "undo" | "redo"): Tool {
  return {
    name: direction,
    title: direction === "undo" ? "Undo your last change" : "Redo what you undid",
    description:
      direction === "undo"
        ? "Takes back this session's latest change (one call), as one step. Only your own changes: it refuses, and says who and which layers, when a person has changed them since."
        : "Brings back the change this session undid last. Refuses when a person has changed those layers since. A new change ends what can be redone.",
    level: "write",
    destructive: true,
    agent: true,
    input: z.object({ sessionId: SessionId, callId: CallId }),
    run: (async (
      ctx: ToolContext,
      { sessionId, callId = ctx.callId }: { sessionId: string; callId?: string },
    ) => {
      const s = await session(ctx, sessionId);
      const out = await fileRoom(ctx.env, s.targetId).stepAgentCall(
        requester(ctx),
        roomRef(s),
        callId,
        direction,
      );
      return answer(out, callId);
    }) as Tool["run"],
  };
}

const SESSION_TOOLS: readonly Tool[] = [
  {
    name: "start_session",
    title: "Start a design session",
    description:
      'Starts working on a file you can edit. mode "branch" (the default) makes a branch: your changes land there, and a person reviews and merges them; the file itself is untouched. mode "live" edits the file directly, as people watch. Returns a sessionId to pass to every change, and the targetFileId your changes land in (read it with get_outline and get_jsx). name is yours as people see it ("Claude"): the session shows as "Claude, for Ana".',
    level: "write",
    agent: true,
    input: z.object({
      fileId: FileId,
      mode: z.enum(["live", "branch"]).default("branch"),
      name: z.string().trim().min(1).max(40).optional().describe("Your name, as people see it."),
      branchName: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe("The branch's name, in branch mode."),
    }),
    run: (async (
      ctx: ToolContext,
      args: { fileId: string; mode: "live" | "branch"; name?: string; branchName?: string },
    ) => {
      try {
        const s = await startSession(
          ctx.env,
          { user: ctx.user, tokenId: ctx.tokenId },
          {
            fileId: args.fileId,
            mode: args.mode,
            ...(args.name ? { agent: args.name } : {}),
            ...(args.branchName ? { branchName: args.branchName } : {}),
          },
        );
        return {
          ...sessionInfo(s),
          next:
            s.mode === "branch"
              ? `Your changes land on the branch ${s.targetId}; ${s.fileId} stays as it is until a person merges them.`
              : `Your changes land in ${s.fileId}, live, as people watch.`,
        };
      } catch (error) {
        if (error instanceof SessionError) throw new ToolError(error.message);
        throw error;
      }
    }) as Tool["run"],
  },
  {
    name: "end_session",
    title: "End a design session",
    description:
      "Ends a session when you're done: it takes no more changes. On a branch, tell the person it's ready to review.",
    level: "write",
    agent: true,
    input: z.object({ sessionId: SessionId }),
    run: (async (ctx: ToolContext, { sessionId }: { sessionId: string }) => {
      try {
        const s = await endSession(ctx.env, { user: ctx.user, tokenId: ctx.tokenId }, sessionId);
        return {
          ...sessionInfo(s),
          next:
            s.mode === "branch"
              ? `The branch ${s.targetId} is ready for review: open ${s.fileId} in Drawpane, then Branches.`
              : "Done. Your changes are in the file and its history.",
        };
      } catch (error) {
        if (error instanceof SessionError) throw new ToolError(error.message);
        throw error;
      }
    }) as Tool["run"],
  },
  stepTool("undo"),
  stepTool("redo"),
];

export const TOOLS: readonly Tool[] = [
  ...READ_TOOLS,
  ...SESSION_TOOLS.slice(0, 1),
  ...AGENT_TOOLS.map(agentTool),
  ...SESSION_TOOLS.slice(1),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools this instance offers: the agent tools only once a text measurer is configured. */
export const offered = (env: Env) => TOOLS.filter((t) => !t.agent || agentToolsEnabled(env));

/** A tool as `tools/list` describes it. */
function describe(t: Tool) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input" }),
    annotations:
      t.level === "read"
        ? { readOnlyHint: true, openWorldHint: false }
        : {
            readOnlyHint: false,
            destructiveHint: t.destructive ?? false,
            idempotentHint: false,
            openWorldHint: false,
          },
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
        instructions: agentToolsEnabled(ctx.env)
          ? READ_INSTRUCTIONS + WRITE_INSTRUCTIONS
          : READ_INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: offered(ctx.env).map(describe) };
    case "tools/call": {
      const t = typeof params.name === "string" ? BY_NAME.get(params.name) : undefined;
      if (!t || (t.agent && !agentToolsEnabled(ctx.env)))
        throw Object.assign(new Error(`No tool ${String(params.name)}.`), { rpc: INVALID_PARAMS });
      if (t.level === "write" && ctx.scope !== "write")
        return toolResult({ error: WRITE_TOKEN_NEEDED }, true);
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

/** A tool's answer with a picture for the model to see (export_image). */
class WithImage {
  constructor(
    readonly value: unknown,
    readonly image: { readonly mimeType: string; readonly base64: string },
  ) {}
}

function toolResult(answer: unknown, isError: boolean) {
  const value = answer instanceof WithImage ? answer.value : answer;
  const content: Array<Record<string, string>> = [{ type: "text", text: JSON.stringify(value) }];
  if (answer instanceof WithImage)
    content.push({ type: "image", data: answer.image.base64, mimeType: answer.image.mimeType });
  return { content, structuredContent: value, isError };
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
      const result = await handle(
        {
          env: c.env,
          user: auth.user,
          tokenId: auth.tokenId,
          scope: auth.scope,
          callId: newId(),
        },
        request,
      );
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
