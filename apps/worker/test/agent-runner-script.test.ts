/**
 * The agent runner as a script of its own (decision 0033, migration step 3):
 * the main Worker under test binds `drawpane-agent-runner`, built as it
 * deploys and run beside it (vitest.config.ts). A call gets the file from
 * the room: the log since the revision the runner's editor shows when it's
 * warm, a snapshot when it's cold or too far behind. The runner never
 * commits; the room does, and refuses a run someone overtook (`stale`).
 */
import { env, runInDurableObject } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type AgentDeps, agentDeps, callWriteTool } from "../src/agent/call";
import type { AgentFileSource, AgentRunRequest } from "../src/agent/runner-api";
import { openSocket, signedInUser } from "./helpers";
import { call, makeToken } from "./mcp-helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
const runnerOf = (fileId: string) => {
  const ns = env.AGENT_RUNNER;
  if (!ns) throw new Error("no AGENT_RUNNER binding");
  return ns.get(ns.idFromName(fileId));
};

/** A person in the file, editing over their socket. */
async function join(browser: Parameters<typeof openSocket>[0], fileId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 2,
    clientId: "person",
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

/** Ana's file, a person in it, and a live session with a write token. */
async function setup() {
  const ana = await signedInUser("Ana Lima");
  const { file } = await ana.browser.json<{ file: { id: string } }>(
    `/api/projects/${ana.projectId}/files`,
    { method: "POST", json: { name: "Checkout" } },
  );
  const fileId = file.id;
  const { token } = await makeToken(ana.browser, "Claude Code", 90, "write");
  const person = await join(ana.browser, fileId);
  const started = await call(token, "start_session", { fileId, mode: "live", name: "Claude" });
  const { sessionId, name } = started.structuredContent as { sessionId: string; name: string };
  return {
    fileId,
    token,
    person,
    browser: ana.browser,
    sessionId,
    by: { userId: ana.userId, name: "Ana Lima" },
    session: { id: sessionId, name, fileId },
  };
}

/** The real deps, keeping the source each run was given. */
function watched(fileId: string) {
  const real = agentDeps(env, fileId);
  const sources: Array<AgentFileSource["kind"]> = [];
  /** Where each snapshot came from: R2 (the saved version) or the room's stream. */
  const from: Array<"saved" | "room" | null> = [];
  const deps: AgentDeps = {
    room: real.room,
    runner: () => {
      const runner = real.runner();
      return {
        ...runner,
        run: (request: AgentRunRequest) => {
          const { source } = request;
          sources.push(source.kind);
          from.push(source.kind === "snapshot" ? (source.key ? "saved" : "room") : null);
          return runner.run(request);
        },
      };
    },
  };
  return { deps, sources, from };
}

const ok = <T>(result: Awaited<ReturnType<typeof call>>) => {
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent as T;
};

const node = async (fileId: string, id: string) =>
  (await roomOf(fileId).allNodes()).find((n) => n.id === id);

describe("the runner's editor", () => {
  it("is built cold on the first call, then catches up warm from the log after a person's edit", async () => {
    const { fileId, token, person, sessionId } = await setup();
    expect(await runnerOf(fileId).stats()).toEqual({ revn: null, builds: 0 });

    const made = ok<{ ids: string[] }>(
      await call(token, "render", { sessionId, jsx: `<Frame name="Box" w={10} h={10} />` }),
    );
    const box = made.ids[0] as string;
    await person.next("txn");
    const afterFirst = (await roomOf(fileId).stats()).revn;
    // Built once, from a snapshot, and kept warm at the revision its run landed at.
    expect(await runnerOf(fileId).stats()).toEqual({ revn: afterFirst, builds: 1 });

    // A person's edit, then a call that reads it: the runner follows the log, no rebuild.
    const edited = await person.edit([{ op: "set", id: box, prop: "name", value: "Ana's box" }]);
    const jsx = ok<{ jsx: string }>(await call(token, "get_jsx", { fileId, id: box }));
    expect(jsx.jsx).toContain("Ana's box");
    expect(await runnerOf(fileId).stats()).toEqual({ revn: edited, builds: 1 });

    // And a write on top of it, still warm.
    ok(await call(token, "set_props", { sessionId, changes: [{ id: box, props: { w: 40 } }] }));
    expect((await node(fileId, box))?.props.width).toBe(40);
    const stats = await runnerOf(fileId).stats();
    expect(stats.builds).toBe(1);
    expect(stats.revn).toBe((await roomOf(fileId).stats()).revn);
  });

  it("gets the log since its revision when warm, and a snapshot when cold", async () => {
    const { fileId, person, by, session } = await setup();
    const { deps, sources } = watched(fileId);
    const first = await callWriteTool(deps, {
      by,
      session,
      callId: "source-1",
      tool: "render",
      input: { jsx: `<Frame name="Box" w={10} h={10} />` },
    });
    expect(first).toMatchObject({ ok: true });
    await person.next("txn");
    await person.edit([
      { op: "create", id: "r1", type: "rect", parent: person.page.id, key: "a5", props: {} },
    ]);
    const second = await callWriteTool(deps, {
      by,
      session,
      callId: "source-2",
      tool: "set_props",
      input: { changes: [{ id: "r1", props: { w: 25 } }] },
    });
    expect(second).toMatchObject({ ok: true });
    expect(sources).toEqual(["snapshot", "log"]);
    expect((await node(fileId, "r1"))?.props.width).toBe(25);
  });

  it("reads the latest saved version from R2 when cold, and the log after it", async () => {
    const { fileId, token, person, sessionId, browser, by, session } = await setup();
    const made = ok<{ ids: string[] }>(
      await call(token, "render", { sessionId, jsx: `<Frame name="Box" w={10} h={10} />` }),
    );
    const box = made.ids[0] as string;
    await person.next("txn");
    await browser.json(`/api/files/${fileId}/versions`, { method: "POST", json: { name: "v1" } });
    await person.edit([{ op: "set", id: box, prop: "name", value: "After the save" }]);
    await runnerOf(fileId).drop(fileId);
    const { deps, sources, from } = watched(fileId);
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "saved-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 21 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(sources).toEqual(["snapshot"]);
    expect(from).toEqual(["saved"]);
    expect((await node(fileId, box))?.props).toMatchObject({ name: "After the save", width: 21 });
  });

  it("goes cold when the log no longer reaches back to its revision", async () => {
    const { fileId, token, person, sessionId } = await setup();
    const made = ok<{ ids: string[] }>(
      await call(token, "render", { sessionId, jsx: `<Frame name="Box" w={10} h={10} />` }),
    );
    const box = made.ids[0] as string;
    await person.next("txn");
    const warmAt = (await runnerOf(fileId).stats()).revn as number;
    await person.edit([{ op: "set", id: box, prop: "name", value: "One" }]);
    await person.edit([{ op: "set", id: box, prop: "name", value: "Two" }]);
    // The log loses the transaction right after the runner's revision (as pruning would).
    await runInDurableObject(roomOf(fileId), (_room, state) => {
      state.storage.sql.exec("DELETE FROM log WHERE revn <= ?", warmAt + 1);
    });
    const { deps, sources } = watched(fileId);
    const out = await callWriteTool(deps, {
      by: { userId: "", name: "" },
      session: { id: sessionId, name: "Claude, for Ana", fileId },
      callId: "behind-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 33 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(sources).toEqual(["snapshot"]);
    expect(await runnerOf(fileId).stats()).toMatchObject({ builds: 2 });
    expect((await node(fileId, box))?.props).toMatchObject({ name: "Two", width: 33 });
  });

  it("goes cold when what it was sent doesn't line up with what it holds", async () => {
    const { fileId, token, person, sessionId, by, session } = await setup();
    const made = ok<{ ids: string[] }>(
      await call(token, "render", { sessionId, jsx: `<Frame name="Box" w={10} h={10} />` }),
    );
    const box = made.ids[0] as string;
    await person.next("txn");
    // A row changed behind the log's back (as an unlogged repair would): the counts differ.
    await runInDurableObject(roomOf(fileId), (_room, state) => {
      state.storage.sql.exec(
        "INSERT INTO nodes (id, parent, key, type, props) VALUES ('hidden', ?, 'z9', 'rect', '{}')",
        person.page.id,
      );
    });
    await person.edit([{ op: "set", id: box, prop: "name", value: "Moved on" }]);
    const { deps, sources } = watched(fileId);
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "drift-1",
      tool: "set_props",
      input: { changes: [{ id: "hidden", props: { w: 12 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    // Sent the log, found it didn't add up, asked again cold.
    expect(sources).toEqual(["log", "snapshot"]);
    expect((await node(fileId, "hidden"))?.props.width).toBe(12);
  });
});

describe("a commit through the runner's script", () => {
  it("is refused as stale when a person changed the same layer between run and commit, and runs again", async () => {
    const { fileId, token, person, sessionId, by, session } = await setup();
    const made = ok<{ ids: string[] }>(
      await call(token, "render", { sessionId, jsx: `<Frame name="Box" w={10} h={10} />` }),
    );
    const box = made.ids[0] as string;
    await person.next("txn");
    const real = agentDeps(env, fileId);
    let runs = 0;
    const deps: AgentDeps = {
      room: real.room,
      runner: () => {
        const runner = real.runner();
        return {
          ...runner,
          run: async (request) => {
            const answer = await runner.run(request);
            if (++runs === 1)
              await person.edit([{ op: "set", id: box, prop: "name", value: "Ana's" }]);
            return answer;
          },
        };
      },
    };
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "stale-script-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(out).toMatchObject({ ok: true, replayed: false });
    expect(runs).toBe(2);
    expect((await node(fileId, box))?.props).toMatchObject({ name: "Ana's", width: 80 });
    // The runner dropped the stale run's editor and built again for the second.
    expect((await runnerOf(fileId).stats()).revn).toBe((await roomOf(fileId).stats()).revn);
  });

  it("answers a repeated call id as recorded, without running it", async () => {
    const { fileId, token, person, sessionId } = await setup();
    const args = { sessionId, callId: "replay-1", jsx: `<Frame name="Once" w={10} h={10} />` };
    const first = ok<{ ids: string[] }>(await call(token, "render", args));
    await person.next("txn");
    const revn = (await roomOf(fileId).stats()).revn;
    const before = await runnerOf(fileId).stats();
    const again = await call(token, "render", args);
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toEqual({ ...first, replayed: true });
    // Nothing ran, nothing was committed, and the runner wasn't asked.
    expect((await roomOf(fileId).stats()).revn).toBe(revn);
    expect(await runnerOf(fileId).stats()).toEqual(before);
    const frames = (await roomOf(fileId).allNodes()).filter((n) => n.props.name === "Once");
    expect(frames).toHaveLength(1);
  });
});
