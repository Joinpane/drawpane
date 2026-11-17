/**
 * Agents that write (decision 0021): scoped tokens, sessions live and on a
 * branch, the headless engine in the room committing each call as one
 * transaction with its fix-ups, exactly-once call ids, and undo and redo
 * that step over the session's own calls and never over a person's.
 * Text is measured by the stand-in measurer (vitest.config.ts).
 */
import { env } from "cloudflare:test";
import { keyBetween, type NodeRecord, type Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { provideHarfBuzzMeasurer } from "../src/agent/harfbuzz";
import { provideMeasurer } from "../src/agent/measurer";
import type { Env } from "../src/env";
import { offered } from "../src/mcp/server";
import { type Browser, openSocket, signedInUser } from "./helpers";
import { call, makeToken, rpc } from "./mcp-helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

interface Txn {
  revn: number;
  ops: Op[];
  author: { userId: string; sessionId: string };
}

/** A person in the file: their socket, the page, and a way to edit as them. */
async function join(browser: Browser, fileId: string, clientId = "person") {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 2,
    clientId,
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
  let seq = 0;
  const edit = async (ops: Op[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    return (await socket.next<{ revn: number }>("ack")).revn;
  };
  const page = nodes.find((n) => n.type === "page") as NodeRecord;
  return { ...socket, page, edit };
}

/** Ana, owner of a fresh file, with a write token. */
async function setup(name = "Checkout") {
  const ana = await signedInUser("Ana Lima");
  const { file } = await ana.browser.json<{ file: { id: string } }>(
    `/api/projects/${ana.projectId}/files`,
    { method: "POST", json: { name } },
  );
  const { token } = await makeToken(ana.browser, "Claude Code", 90, "write");
  return { ...ana, fileId: file.id, token };
}

async function start(token: string, fileId: string, mode: "live" | "branch" = "live") {
  const started = await call(token, "start_session", { fileId, mode, name: "Claude" });
  expect(started.isError).toBe(false);
  return started.structuredContent as {
    sessionId: string;
    name: string;
    targetFileId: string;
    fileId: string;
  };
}

const ok = <T = Record<string, unknown>>(result: Awaited<ReturnType<typeof call>>) => {
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent as T;
};

describe("token scopes", () => {
  it("are read unless asked otherwise, and listed", async () => {
    const ana = await signedInUser("Ana");
    expect((await makeToken(ana.browser)).info.scope).toBe("read");
    expect((await makeToken(ana.browser, "Agent", 30, "write")).info.scope).toBe("write");
    const listed = await ana.browser.json<{ tokens: Array<{ scope: string }> }>(
      "/api/account/tokens",
    );
    expect(listed.tokens.map((t) => t.scope).sort()).toEqual(["read", "write"]);
    const bad = await ana.browser.fetch("/api/account/tokens", {
      method: "POST",
      json: { name: "x", expiresInDays: 30, scope: "admin" },
    });
    expect(bad.status).toBe(400);
  });

  it("keep a read token from writing, and say how to make a write token", async () => {
    const { browser, fileId } = await setup();
    const { token } = await makeToken(browser);
    for (const [name, args] of [
      ["start_session", { fileId, mode: "live" }],
      ["render", { sessionId: "s", jsx: "<Rect />" }],
      ["undo", { sessionId: "s" }],
    ] as const) {
      const refused = await call(token, name, args);
      expect(refused.isError).toBe(true);
      expect(String(refused.structuredContent.error)).toContain("Read and write");
    }
    // It still reads, the agent tools included.
    expect((await call(token, "get_outline", { fileId })).isError).toBe(false);
    expect((await roomOf(fileId).stats()).revn).toBe(1);
  });
});

describe("the agent tools on MCP", () => {
  it("are listed from the tool layer with schemas and hints from their level", async () => {
    const { token } = await setup();
    const { body } = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = body.result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown>; required?: string[] };
      annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
    }>;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "start_session",
      "get_jsx",
      "export_image",
      "render",
      "set_props",
      "move_nodes",
      "delete_nodes",
      "bind_token",
      "set_variable_mode",
      "end_session",
      "undo",
      "redo",
    ])
      expect(byName.has(name)).toBe(true);
    const render = byName.get("render");
    expect(render?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(render?.inputSchema.required).toEqual(expect.arrayContaining(["jsx", "sessionId"]));
    expect(Object.keys(render?.inputSchema.properties ?? {})).toContain("callId");
    expect(byName.get("get_jsx")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("export_image")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("start_session")?.annotations.destructiveHint).toBe(false);
    // The instructions tell the model how to design.
    const init = await rpc(token, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect(init.body.result.instructions).toContain("start_session");
  });

  it("are off when no text measurer is configured", () => {
    // The Worker registers the HarfBuzz measurer as it starts: take it away for this check.
    provideMeasurer(null);
    try {
      const names = offered({ ...env, AGENT_MEASURER: undefined } as unknown as Env).map(
        (t) => t.name,
      );
      expect(names).toContain("get_outline");
      expect(names).not.toContain("render");
      expect(names).not.toContain("start_session");
    } finally {
      provideHarfBuzzMeasurer();
    }
  });

  it("are on with the HarfBuzz measurer the Worker registers", () => {
    provideHarfBuzzMeasurer();
    const names = offered({ ...env, AGENT_MEASURER: undefined } as unknown as Env).map(
      (t) => t.name,
    );
    expect(names).toContain("render");
    expect(names).toContain("start_session");
  });
});

describe("a live session", () => {
  it("commits each call as one transaction by the agent, fix-ups included, as people watch", async () => {
    const { browser, fileId, token, userId } = await setup();
    const person = await join(browser, fileId);
    const session = await start(token, fileId, "live");
    expect(session.name).toBe("Claude, for Ana");
    expect(session.targetFileId).toBe(fileId);

    const stack = ok<{ ids: string[]; revision: number }>(
      await call(token, "render", {
        sessionId: session.sessionId,
        jsx: `<Frame name="Stack" flex="col" gap={10} p={10} w={300} />`,
      }),
    );
    const first = await person.next<Txn>("txn");
    expect(first.author).toEqual({ userId, sessionId: session.sessionId });
    expect(first.revn).toBe(stack.revision);
    const stackId = stack.ids[0] as string;

    // A text inside the hugging stack: one transaction, with the text sized by the
    // measurer and the stack grown around it.
    const added = ok<{ ids: string[]; revision: number }>(
      await call(token, "render", {
        sessionId: session.sessionId,
        parentId: stackId,
        jsx: `<Text size={20}>Hello</Text>`,
      }),
    );
    expect(added.revision).toBe(stack.revision + 1);
    const second = await person.next<Txn>("txn");
    expect(second.revn).toBe(added.revision);
    const textId = added.ids[0] as string;
    // "Hello" at 20 px: five characters of half an em, measured in the same transaction.
    const widths = second.ops.flatMap((o) =>
      o.op === "create" && o.id === textId
        ? [o.props.width]
        : o.op === "set" && o.id === textId && o.prop === "width"
          ? [o.value]
          : [],
    );
    expect(widths.at(-1)).toBe(50);
    const grown = second.ops.find(
      (o) => o.op === "set" && o.id === stackId && o.prop === "height",
    ) as Extract<Op, { op: "set" }> | undefined;
    expect(grown?.value).toBeGreaterThan(20);
    // Nothing else arrived: one call, one transaction.
    expect(person.inbox.filter((m) => m.t === "txn")).toEqual([]);

    // A person's edit is followed by the warm editor: the agent can change their layer next.
    await person.edit([
      {
        op: "create",
        id: "note",
        type: "rect",
        parent: person.page.id,
        key: keyBetween(null, "a0"),
        props: { name: "Note", x: 0, y: 400, width: 10, height: 10 },
      },
    ]);
    ok(
      await call(token, "set_props", {
        sessionId: session.sessionId,
        changes: [{ id: "note", props: { w: 80, fill: "#2563eb" } }],
      }),
    );
    const jsx = ok<{ jsx: string }>(await call(token, "get_jsx", { fileId, id: "note" }));
    expect(jsx.jsx).toContain("w={80}");
  });

  it("commits nothing when a tool fails, and says why", async () => {
    const { browser, fileId, token } = await setup();
    const person = await join(browser, fileId);
    const session = await start(token, fileId);
    await person.edit([
      {
        op: "create",
        id: "rect",
        type: "rect",
        parent: person.page.id,
        key: "a0",
        props: { name: "Rect", x: 0, y: 0, width: 10, height: 10 },
      },
    ]);
    const before = (await roomOf(fileId).stats()).revn;

    const bad = await call(token, "render", { sessionId: session.sessionId, jsx: "<Frame w=" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("error");
    // All or nothing: one unknown layer, and no change is made.
    const partly = await call(token, "set_props", {
      sessionId: session.sessionId,
      changes: [
        { id: "rect", props: { name: "Renamed" } },
        { id: "missing", props: { w: 10 } },
      ],
    });
    expect(partly.isError).toBe(true);
    expect(String(partly.structuredContent.error)).toContain("missing");
    const wrongArgs = await call(token, "render", { sessionId: session.sessionId });
    expect(wrongArgs.isError).toBe(true);

    expect((await roomOf(fileId).stats()).revn).toBe(before);
    expect(person.inbox.filter((m) => m.t === "txn")).toEqual([]);
    // The engine is still good afterwards.
    ok(
      await call(token, "render", { sessionId: session.sessionId, jsx: "<Rect w={10} h={10} />" }),
    );
    expect((await roomOf(fileId).stats()).revn).toBe(before + 1);
  });

  it("runs a repeated call id once, answering the retry as recorded", async () => {
    const { fileId, token } = await setup();
    const session = await start(token, fileId);
    const args = {
      sessionId: session.sessionId,
      callId: "retry-after-timeout-1",
      jsx: `<Rect name="Once" w={10} h={10} />`,
    };
    const first = ok<{ ids: string[]; revision: number }>(await call(token, "render", args));
    const again = ok<{ ids: string[]; revision: number; replayed: boolean }>(
      await call(token, "render", args),
    );
    expect(again.replayed).toBe(true);
    expect(again.ids).toEqual(first.ids);
    expect(again.revision).toBe(first.revision);
    expect((await roomOf(fileId).stats()).revn).toBe(first.revision);
    const found = ok<{ nodes: unknown[] }>(
      await call(token, "find_nodes", { fileId, query: "Once" }),
    );
    expect(found.nodes).toHaveLength(1);
    // Another engine can ask whether it committed.
    expect(await roomOf(fileId).agentCall(session.sessionId, args.callId)).toMatchObject({
      revn: first.revision,
    });
    expect(await roomOf(fileId).agentCall(session.sessionId, "never-made-1")).toBeNull();
    // Without an id each call is its own.
    const { callId: _, ...noId } = args;
    const other = ok<{ ids: string[] }>(await call(token, "render", noId));
    expect(other.ids).not.toEqual(first.ids);
  });
});

describe("sessions", () => {
  it("on a branch write only there, and main stays as it was", async () => {
    const { browser, fileId, token } = await setup();
    const main = await join(browser, fileId);
    const mainRevn = (await roomOf(fileId).stats()).revn;
    const session = await start(token, fileId, "branch");
    expect(session.targetFileId).not.toBe(fileId);

    const made = ok<{ ids: string[] }>(
      await call(token, "render", {
        sessionId: session.sessionId,
        jsx: `<Frame name="Proposal" w={200} h={100} />`,
      }),
    );
    const branchNodes = await roomOf(session.targetFileId).allNodes();
    expect(branchNodes.some((n) => n.id === made.ids[0])).toBe(true);
    expect((await roomOf(fileId).stats()).revn).toBe(mainRevn);
    expect((await roomOf(fileId).allNodes()).some((n) => n.id === made.ids[0])).toBe(false);
    expect(main.inbox.filter((m) => m.t === "txn")).toEqual([]);
    // The branch is listed on the main file, named for the session.
    const { branches } = await browser.json<{ branches: Array<{ id: string; name: string }> }>(
      `/api/files/${fileId}/branches`,
    );
    expect(branches).toEqual([
      expect.objectContaining({ id: session.targetFileId, name: "Claude, for Ana" }),
    ]);
    // The agent reads its branch by its id.
    const outline = ok<{ outline: unknown }>(
      await call(token, "get_outline", { fileId: session.targetFileId }),
    );
    expect(JSON.stringify(outline)).toContain("Proposal");

    // Ended: no more changes. Ending twice is fine.
    ok(await call(token, "end_session", { sessionId: session.sessionId }));
    ok(await call(token, "end_session", { sessionId: session.sessionId }));
    const after = await call(token, "render", { sessionId: session.sessionId, jsx: "<Rect />" });
    expect(String(after.structuredContent.error)).toContain("ended");
  });

  it("belong to their token, and stop when the person can no longer edit", async () => {
    const { browser, fileId, token, teamId } = await setup();
    const session = await start(token, fileId);
    const render = (t: string) =>
      call(t, "render", { sessionId: session.sessionId, jsx: "<Rect w={4} h={4} />" });

    const second = (await makeToken(browser, "Another client", 30, "write")).token;
    expect(String((await render(second)).structuredContent.error)).toContain("No session");
    const sam = await signedInUser("Sam", "editor", teamId);
    const samToken = (await makeToken(sam.browser, "Sam's", 30, "write")).token;
    expect((await render(samToken)).isError).toBe(true);

    // A viewer can't start one at all.
    const vic = await signedInUser("Vic", "viewer", teamId);
    const vicToken = (await makeToken(vic.browser, "Vic's", 30, "write")).token;
    const refused = await call(vicToken, "start_session", { fileId, mode: "live" });
    expect(String(refused.structuredContent.error)).toContain("can view");

    // Made a viewer after starting: the next call is refused.
    expect((await render(token)).isError).toBe(false);
    await env.DB.prepare("UPDATE team_members SET role = 'viewer' WHERE user_id = ?")
      .bind(
        (
          await env.DB.prepare("SELECT user_id FROM agent_sessions WHERE id = ?")
            .bind(session.sessionId)
            .first<{ user_id: string }>()
        )?.user_id,
      )
      .run();
    expect((await render(token)).isError).toBe(true);
  });
});

describe("agent undo and redo", () => {
  it("step over the session's own calls", async () => {
    const { browser, fileId, token } = await setup();
    const person = await join(browser, fileId);
    const session = await start(token, fileId);
    const s = { sessionId: session.sessionId };
    expect(String((await call(token, "undo", s)).structuredContent.error)).toContain(
      "Nothing to undo",
    );
    const card = ok<{ ids: string[] }>(
      await call(token, "render", {
        ...s,
        jsx: `<Frame name="Card" flex="col" p={8}><Text>Hi</Text></Frame>`,
      }),
    );
    const cardId = card.ids[0] as string;
    ok(
      await call(token, "set_props", {
        ...s,
        changes: [{ id: cardId, props: { name: "Card 2" } }],
      }),
    );
    await person.next("txn");
    await person.next("txn");

    // Undo takes back the rename, then the card: each one transaction.
    expect(ok(await call(token, "undo", s)).undone).toMatchObject({ tool: "set_props" });
    expect((await person.next<Txn>("txn")).author.sessionId).toBe(session.sessionId);
    const nodes = async () => roomOf(fileId).allNodes();
    expect((await nodes()).find((n) => n.id === cardId)?.props.name).toBe("Card");
    ok(await call(token, "undo", s));
    expect((await nodes()).some((n) => n.id === cardId)).toBe(false);
    // Redo brings the card back; a new call then ends what's left to redo.
    expect(ok(await call(token, "redo", s)).redone).toMatchObject({ tool: "render" });
    expect((await nodes()).some((n) => n.id === cardId)).toBe(true);
    ok(await call(token, "render", { ...s, jsx: "<Rect w={4} h={4} />" }));
    expect(String((await call(token, "redo", s)).structuredContent.error)).toContain(
      "Nothing to redo",
    );
    // A retried undo doesn't undo twice.
    const once = { ...s, callId: "undo-once-1" };
    const undone = ok<{ revision: number }>(await call(token, "undo", once));
    const replayed = ok<{ revision: number; replayed: boolean }>(await call(token, "undo", once));
    expect(replayed).toMatchObject({ revision: undone.revision, replayed: true });
    expect((await nodes()).some((n) => n.id === cardId)).toBe(true);
  });

  it("refuse when a person changed the same layers since, and say who", async () => {
    const { browser, fileId, token } = await setup();
    const person = await join(browser, fileId);
    const session = await start(token, fileId);
    const s = { sessionId: session.sessionId };
    const card = ok<{ ids: string[] }>(
      await call(token, "render", { ...s, jsx: `<Frame name="Card" w={100} h={100} />` }),
    );
    const cardId = card.ids[0] as string;
    await person.next("txn");
    // Ana moves her own rectangle into the agent's card.
    await person.edit([
      {
        op: "create",
        id: "mine",
        type: "rect",
        parent: cardId,
        key: "a0",
        props: { name: "Mine", x: 0, y: 0, width: 10, height: 10 },
      },
    ]);
    const before = (await roomOf(fileId).stats()).revn;
    const refused = await call(token, "undo", s);
    expect(refused.isError).toBe(true);
    expect(String(refused.structuredContent.error)).toMatch(/Ana Lima changed “Card”/);
    expect((await roomOf(fileId).stats()).revn).toBe(before);
    expect((await roomOf(fileId).allNodes()).some((n) => n.id === "mine")).toBe(true);
  });
});
