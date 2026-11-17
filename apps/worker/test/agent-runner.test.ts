/**
 * An agent call split between the runner and the room (decision 0033,
 * migration step 1): the main Worker's side (`agent/call.ts`) with the
 * runner the room hosts in-process, wrapped so a person can edit between
 * the run and its commit. A commit is refused as stale only when someone
 * changed the layers the run changed, and the call then runs again.
 */
import { env } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  type AgentDeps,
  agentDeps,
  callReadTool,
  callWriteTool,
  KEPT_CHANGING,
  RUNNER_ABORTED,
} from "../src/agent/call";
import type { AgentRunAnswer, AgentRunRequest } from "../src/agent/runner-api";
import { openSocket, signedInUser } from "./helpers";
import { call, makeToken } from "./mcp-helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

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

/** Ana's file, a live session on it, and a box the agent made. */
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
  const s = started.structuredContent as { sessionId: string; name: string };
  const made = await call(token, "render", {
    sessionId: s.sessionId,
    jsx: `<Frame name="Box" w={10} h={10} />`,
  });
  const box = (made.structuredContent as { ids: string[] }).ids[0] as string;
  await person.next("txn");
  return {
    fileId,
    person,
    box,
    by: { userId: ana.userId, name: "Ana Lima" },
    session: { id: s.sessionId, name: s.name, fileId },
  };
}

/** The real deps, with `between` run after each run and before its commit; counts the runs. */
function withPause(fileId: string, between: (run: number) => Promise<void>) {
  const real = agentDeps(env, fileId);
  const runs: AgentRunRequest[] = [];
  const deps: AgentDeps = {
    room: real.room,
    runner: () => {
      const runner = real.runner();
      return {
        ...runner,
        run: async (request): Promise<AgentRunAnswer> => {
          const answer = await runner.run(request);
          runs.push(request);
          await between(runs.length);
          return answer;
        },
      };
    },
  };
  return { deps, runs };
}

const node = async (fileId: string, id: string) =>
  (await roomOf(fileId).allNodes()).find((n) => n.id === id);

describe("a commit after the file moved on", () => {
  it("is refused as stale when a person changed the same layer, and the call runs again", async () => {
    const { fileId, person, box, by, session } = await setup();
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: box, prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "stale-then-rerun-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(out).toMatchObject({ ok: true, replayed: false });
    expect(runs).toHaveLength(2);
    // Both changes are there: the person's, and the agent's made on top of it.
    expect((await node(fileId, box))?.props).toMatchObject({ name: "Ana's", width: 80 });
    // One commit: the person saw the agent's transaction arrive once, after their own.
    const txn = await person.next<{ revn: number; ops: Op[] }>("txn");
    expect(txn.revn).toBe(out.ok ? out.revn : null);
    expect(txn.ops.some((o) => o.op === "set" && o.id === box && o.prop === "width")).toBe(true);
    expect(person.inbox.filter((m) => m.t === "txn")).toEqual([]);
    // Recorded once: a retry answers as recorded.
    expect(await roomOf(fileId).agentCall(session.id, "stale-then-rerun-1")).toMatchObject({
      revn: out.ok ? out.revn : -1,
    });
  });

  it("commits without running again when a person edited another layer", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "note",
        type: "rect",
        parent: person.page.id,
        key: "a0",
        props: { name: "Note", x: 0, y: 400, width: 10, height: 10 },
      },
    ]);
    const before = (await roomOf(fileId).stats()).revn;
    const { deps, runs } = withPause(fileId, async () => {
      await person.edit([{ op: "set", id: "note", prop: "name", value: "Ana's note" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "elsewhere-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(runs).toHaveLength(1);
    // Committed after the person's edit, which landed between the run and the commit.
    expect(out).toMatchObject({ ok: true, revn: before + 2 });
    expect((await node(fileId, box))?.props.width).toBe(80);
    expect((await node(fileId, "note"))?.props.name).toBe("Ana's note");
    // The runner's editor didn't see the person's edit land in the middle: it was let go,
    // and the next call builds it again and sees both.
    const read = await callReadTool(agentDeps(env, fileId), {
      fileId,
      tool: "get_jsx",
      input: { id: "note" },
    });
    expect(read.ok && JSON.stringify(read.result)).toContain("Ana's note");
  });

  it("runs again when the layer it made a layer in was deleted meanwhile, and then fails cleanly", async () => {
    const { fileId, person, box, by, session } = await setup();
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "delete", id: box }]);
    });
    const before = (await roomOf(fileId).stats()).revn;
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "parent-gone-1",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w={4} h={4} />` },
    });
    // The commit didn't apply on the file as it is now: run again, where the tool says why.
    expect(runs).toHaveLength(2);
    expect(out).toMatchObject({ ok: false, message: expect.stringContaining(box) });
    // Only the person's delete landed.
    expect((await roomOf(fileId).stats()).revn).toBe(before + 1);
  });

  it("gives up after three runs when the same layer keeps changing", async () => {
    const { fileId, person, box, by, session } = await setup();
    const { deps, runs } = withPause(fileId, async (run) => {
      await person.edit([{ op: "set", id: box, prop: "name", value: `Edit ${run}` }]);
    });
    const before = (await roomOf(fileId).stats()).revn;
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "kept-changing-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(out).toEqual({ ok: false, message: KEPT_CHANGING });
    expect(runs).toHaveLength(3);
    expect((await roomOf(fileId).stats()).revn).toBe(before + 3);
    expect((await node(fileId, box))?.props.width).toBe(10);
    expect(await roomOf(fileId).agentCall(session.id, "kept-changing-1")).toBeNull();
  });
});

describe("the main Worker's side of a call", () => {
  it("asks for a fresh runner for every request, and ignores a runner that doesn't hear back", async () => {
    const { fileId, box, by, session } = await setup();
    const real = agentDeps(env, fileId);
    let runners = 0;
    const deps: AgentDeps = {
      room: real.room,
      runner: () => {
        runners++;
        return {
          ...real.runner(),
          committed: async () => {
            throw Object.assign(new Error("Durable Object reset"), { durableObjectReset: true });
          },
        };
      },
    };
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "deaf-runner-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 30 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    // One for the run, one to say the commit landed.
    expect(runners).toBe(2);
    expect((await node(fileId, box))?.props.width).toBe(30);
  });

  it("answers a runner that ran out of memory as the agent's failure, commits nothing, and doesn't retry", async () => {
    const { fileId, box, by, session } = await setup();
    const real = agentDeps(env, fileId);
    let runs = 0;
    const deps: AgentDeps = {
      room: real.room,
      runner: () => ({
        ...real.runner(),
        run: async () => {
          runs++;
          throw Object.assign(
            new Error("Durable Object's isolate exceeded its memory limit and was reset."),
            { remote: true, overloaded: true, durableObjectReset: true },
          );
        },
      }),
    };
    const before = (await roomOf(fileId).stats()).revn;
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "out-of-memory-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 30 } }] },
    });
    expect(out).toEqual({ ok: false, message: RUNNER_ABORTED });
    expect(runs).toBe(1);
    expect((await roomOf(fileId).stats()).revn).toBe(before);
  });
});
