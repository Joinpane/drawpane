/**
 * The MCP server (decision 0011): personal access tokens, the protocol over
 * Streamable HTTP for old and new clients, and the read tools on a real file.
 */
import { env, runInDurableObject } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Browser, openSocket, signedInUser } from "./helpers";
import { call, makeToken, rpc } from "./mcp-helpers";

/** A file with a page holding a card frame (with text), a component and an instance of it. */
async function seededFile(browser: Browser, projectId: string) {
  const { file } = await browser.json<{ file: { id: string } }>(
    `/api/projects/${projectId}/files`,
    { method: "POST", json: { name: "Checkout" } },
  );
  const socket = await openSocket(browser, file.id);
  socket.send({
    t: "hello",
    protocol: 2,
    clientId: "seed",
    revn: null,
    copies: ["materialized", "compact"],
  });
  await socket.next("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  const page = nodes.find((n) => n.type === "page") as NodeRecord;
  const ops: Op[] = [
    {
      op: "create",
      id: "card",
      type: "frame",
      parent: page.id,
      key: "a0",
      props: { name: "Card", x: 0, y: 0, width: 320, height: 200 },
    },
    {
      op: "create",
      id: "title",
      type: "text",
      parent: "card",
      key: "a0",
      props: { x: 16, y: 16, width: 200, height: 24, characters: "Order summary" },
    },
    {
      op: "create",
      id: "btn",
      type: "frame",
      parent: page.id,
      key: "a1",
      props: { name: "Button", x: 400, y: 0, width: 120, height: 40, isComponent: true },
    },
    {
      op: "create",
      id: "btn1",
      type: "frame",
      parent: "card",
      key: "a1",
      props: { name: "Button", x: 16, y: 140, width: 120, height: 40, instanceOf: "btn" },
    },
    {
      op: "create",
      id: "brand",
      type: "collection",
      parent: "root",
      key: "a5",
      props: { name: "Brand", modes: [{ id: "m1", name: "Light" }] },
    },
    {
      op: "create",
      id: "primary",
      type: "variable",
      parent: "brand",
      key: "a0",
      props: { name: "color/primary", variableType: "color", values: { m1: "#e04f1a" } },
    },
  ];
  socket.send({ t: "txn", seq: 1, ops });
  await socket.next("ack");
  return { fileId: file.id, pageId: page.id };
}

describe("personal access tokens", () => {
  it("are made, shown once, listed by prefix and revoked", async () => {
    const ana = await signedInUser("Ana");
    const { token, info } = await makeToken(ana.browser);
    expect(token).toMatch(/^dp_pat_[A-Za-z0-9_-]{43}$/);
    expect(info.prefix).toBe(token.slice(0, 11));
    expect(info.expiresAt).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    const listed = await ana.browser.json<{ tokens: Array<Record<string, unknown>> }>(
      "/api/account/tokens",
    );
    expect(listed.tokens.map((t) => t.name)).toEqual(["Claude Code"]);
    expect(JSON.stringify(listed)).not.toContain(token);
    // Only the hash is kept.
    const row = await env.DB.prepare("SELECT token_hash FROM api_tokens WHERE id = ?")
      .bind(info.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Someone else can't revoke it.
    const sam = await signedInUser("Sam");
    expect(
      (await sam.browser.fetch(`/api/account/tokens/${info.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await ana.browser.fetch(`/api/account/tokens/${info.id}`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("need a name and a known expiry", async () => {
    const ana = await signedInUser("Ana");
    const post = (json: unknown) =>
      ana.browser.fetch("/api/account/tokens", { method: "POST", json });
    expect((await post({ name: " ", expiresInDays: 30 })).status).toBe(400);
    expect((await post({ name: "x", expiresInDays: 7 })).status).toBe(400);
    expect((await post({ name: "Forever", expiresInDays: null })).status).toBe(201);
  });
});

describe("the MCP endpoint", () => {
  const init = (version = "2025-06-18") => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });

  it("takes a token, and nothing else", async () => {
    const ana = await signedInUser("Ana");
    const { token, info } = await makeToken(ana.browser);
    expect((await rpc(token, init())).status).toBe(200);
    const none = await rpc(null, init());
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await rpc("dp_pat_nope", init())).status).toBe(401);
    // The session cookie isn't a token.
    const withCookie = await ana.browser.fetch("/api/mcp", {
      method: "POST",
      json: init(),
    });
    expect(withCookie.status).toBe(401);
    // Expired, then revoked: refused.
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, info.id)
      .run();
    expect((await rpc(token, init())).status).toBe(401);
    const fresh = await makeToken(ana.browser, "Again");
    await ana.browser.fetch(`/api/account/tokens/${fresh.info.id}`, { method: "DELETE" });
    expect((await rpc(fresh.token, init())).status).toBe(401);
    // A browser on another site can't use one either.
    const other = await makeToken(ana.browser, "Third");
    expect((await rpc(other.token, init(), { origin: "https://evil.example" })).status).toBe(403);
  });

  it("speaks old and new revisions, statelessly", async () => {
    const ana = await signedInUser("Ana");
    const { token } = await makeToken(ana.browser);
    const old = await rpc(token, init("2025-06-18"));
    expect(old.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "drawpane" },
    });
    // A version we don't know gets the newest we do.
    expect((await rpc(token, init("2024-01-01"))).body.result.protocolVersion).toBe("2026-07-28");
    const discover = await rpc(token, { jsonrpc: "2.0", id: 2, method: "server/discover" });
    expect(discover.body.result.serverInfo.name).toBe("drawpane");
    // Notifications are accepted with nothing to say.
    const note = await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect((await rpc(token, { jsonrpc: "2.0", id: 3, method: "ping" })).body.result).toEqual({});
    // Routing headers must match the body.
    const mismatch = await rpc(
      token,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { "mcp-method": "tools/call" },
    );
    expect(mismatch.status).toBe(400);
    expect((await rpc(token, { jsonrpc: "2.0", id: 5, method: "nope" })).body.error.code).toBe(
      -32601,
    );
    expect((await rpc(token, { id: 6 })).status).toBe(400);
    const get = await new Browser().fetch("/api/mcp");
    expect(get.status).toBe(405);
  });

  it("lists the read tools first, read-only, with input schemas", async () => {
    const ana = await signedInUser("Ana");
    const { token } = await makeToken(ana.browser);
    const { body } = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = body.result.tools as Array<{
      name: string;
      inputSchema: { type: string; properties: Record<string, unknown> };
      annotations: { readOnlyHint: boolean };
    }>;
    expect(tools.slice(0, 8).map((t) => t.name)).toEqual([
      "list_files",
      "get_outline",
      "get_node",
      "find_nodes",
      "list_components",
      "list_tokens",
      "get_comments",
      "get_history",
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    for (const t of tools.slice(0, 8)) expect(t.annotations.readOnlyHint).toBe(true);
    expect(Object.keys(tools[1]?.inputSchema.properties ?? {})).toContain("fileId");
  });
});

describe("the read tools", () => {
  it("find files and read a file's outline, layers, components and tokens", async () => {
    const ana = await signedInUser("Ana");
    const { fileId, pageId } = await seededFile(ana.browser, ana.projectId);
    const { token } = await makeToken(ana.browser);

    const files = await call(token, "list_files", { query: "check" });
    expect(files.structuredContent.files).toEqual([
      expect.objectContaining({ id: fileId, name: "Checkout", project: "Drafts" }),
    ]);

    const outline = await call(token, "get_outline", { fileId });
    expect(outline.isError).toBe(false);
    const tree = (outline.structuredContent.outline as { tree: Record<string, unknown> }).tree;
    expect(tree).toMatchObject({ id: pageId, kind: "page" });
    expect(JSON.stringify(tree)).toContain('"text":"Order summary"');
    expect(JSON.stringify(tree)).toContain('"kind":"instance"');
    // Depth 1 cuts the card's children short, and says so.
    const shallow = await call(token, "get_outline", { fileId, rootId: "card", depth: 1 });
    expect(shallow.structuredContent.outline).toMatchObject({
      truncated: false,
      tree: { id: "card", children: [{ id: "title" }, { id: "btn1" }] },
    });
    const cut = await call(token, "get_outline", { fileId, depth: 1 });
    expect((cut.structuredContent.outline as { truncated: boolean }).truncated).toBe(true);

    const node = await call(token, "get_node", { fileId, nodeId: "btn1" });
    expect(node.structuredContent).toMatchObject({
      kind: "instance",
      parent: "card",
      props: { instanceOf: "btn" },
    });
    const found = await call(token, "find_nodes", { fileId, query: "order" });
    expect(found.structuredContent).toMatchObject({ total: 1, nodes: [{ id: "title" }] });
    const instances = await call(token, "find_nodes", { fileId, kind: "instance" });
    expect(instances.structuredContent.total).toBe(1);

    const components = await call(token, "list_components", { fileId });
    expect(components.structuredContent.components).toEqual([
      expect.objectContaining({ id: "btn", name: "Button", instances: 1 }),
    ]);
    const tokens = await call(token, "list_tokens", { fileId });
    expect(tokens.structuredContent.collections).toEqual([
      expect.objectContaining({
        name: "Brand",
        modes: ["Light"],
        variables: [
          expect.objectContaining({ name: "color/primary", values: { Light: "#e04f1a" } }),
        ],
      }),
    ]);
  });

  it("read a layer with 150,000 children without holding them all", {
    timeout: 120_000,
  }, async () => {
    const ana = await signedInUser("Ana");
    const { fileId } = await seededFile(ana.browser, ana.projectId);
    const { token } = await makeToken(ana.browser);
    const stub = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
    // 150,000 rectangles side by side in the card, written straight into the room's table.
    await runInDurableObject(stub, (_room, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149999)
         INSERT INTO nodes (id, parent, key, type, props)
         SELECT 'W' || i, 'card', 'b0', 'rect', '{"name":"Wide ' || i || '","width":1,"height":1}' FROM n`,
      );
    });
    const found = await call(token, "find_nodes", { fileId, query: "wide 14999", limit: 5 });
    expect(found.isError).toBe(false);
    // Wide 14999 and Wide 149990 to 149999.
    expect(found.structuredContent.total).toBe(11);
    const outline = await call(token, "get_outline", {
      fileId,
      rootId: "card",
      depth: 2,
      limit: 50,
    });
    expect(outline.isError).toBe(false);
    const tree = (
      outline.structuredContent.outline as { tree: { more: number; children: unknown[] } }
    ).tree;
    expect(tree.children.length + tree.more).toBe(150_002);
    const node = await call(token, "get_node", { fileId, nodeId: "card" });
    expect(node.isError).toBe(false);
    const detail = node.structuredContent as { children: unknown[]; moreChildren?: number };
    expect(detail.children.length).toBeLessThan(2_000);
    expect(detail.children.length + (detail.moreChildren ?? 0)).toBe(150_002);
    const components = await call(token, "list_components", { fileId });
    expect(components.structuredContent.components).toEqual([
      expect.objectContaining({ id: "btn", instances: 1 }),
    ]);
  });

  it("read comments and history", async () => {
    const ana = await signedInUser("Ana");
    const { fileId, pageId } = await seededFile(ana.browser, ana.projectId);
    const { token } = await makeToken(ana.browser);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO comment_threads (id, file_id, page_id, x, y, node_id, node_x, node_y, created_by, created_at, updated_at)
         VALUES ('t1', ?, ?, 0, 0, 'card', 10, 10, ?, ?, ?)`,
      ).bind(fileId, pageId, ana.userId, now, now),
      env.DB.prepare(
        "INSERT INTO comments (id, thread_id, author_id, body, created_at) VALUES ('c1', 't1', ?, 'Tighten the padding', ?)",
      ).bind(ana.userId, now),
    ]);
    const comments = await call(token, "get_comments", { fileId });
    expect(comments.structuredContent.threads).toEqual([
      expect.objectContaining({
        nodeId: "card",
        resolved: false,
        comments: [expect.objectContaining({ author: "Ana", body: "Tighten the padding" })],
      }),
    ]);
    await ana.browser.fetch(`/api/files/${fileId}/versions`, {
      method: "POST",
      json: { name: "Before review" },
    });
    const history = await call(token, "get_history", { fileId });
    expect(history.structuredContent.versions).toEqual([
      expect.objectContaining({ name: "Before review", by: "Ana", reason: "named" }),
    ]);
  });

  it("answer a file you can't open, or a bad argument, as a tool error", async () => {
    const ana = await signedInUser("Ana");
    const { fileId } = await seededFile(ana.browser, ana.projectId);
    const sam = await signedInUser("Sam");
    const { token } = await makeToken(sam.browser);
    const denied = await call(token, "get_outline", { fileId });
    expect(denied.isError).toBe(true);
    expect(String(denied.structuredContent.error)).toContain("list_files");
    expect((await call(token, "list_files")).structuredContent.files).toEqual([]);
    const bad = await call(token, "get_node", { fileId: "x/../y" });
    expect(bad.isError).toBe(true);
    // A teammate who can only view reads it fine.
    const vic = await signedInUser("Vic", "viewer", ana.teamId);
    const vicToken = (await makeToken(vic.browser)).token;
    expect((await call(vicToken, "get_outline", { fileId })).isError).toBe(false);
  });
});
