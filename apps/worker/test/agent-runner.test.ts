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

describe("a commit after the file moved on, checked against what the run read", () => {
  it("runs again when a person resized the auto layout parent it filled", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: box, prop: "width", value: 400 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "fill-parent-1",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w="fill" h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? (out.result as { ids: string[] }).ids[0] : "";
    expect((await node(fileId, box))?.props.width).toBe(400);
    expect((await node(fileId, made as string))?.props.width).toBe(400);
  });

  it("runs again when a person moved the parent it moves a layer into", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "x", value: 100 },
      {
        op: "create",
        id: "destination",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { x: 200, y: 0, width: 100, height: 100 },
      },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "destination", prop: "x", value: 400 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "reparent-1",
      tool: "move_nodes",
      input: { ids: [box], parentId: "destination" },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    // It keeps its place on the page: x=100, inside a parent now at x=400.
    const moved = await node(fileId, box);
    expect(moved?.parent).toBe("destination");
    expect(moved?.props.x).toBe(-300);
  });

  it("runs again when a person moved a sibling it placed a new layer beside", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([{ op: "set", id: box, prop: "x", value: 0 }]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: box, prop: "x", value: 110 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "placement-1",
      tool: "render",
      input: { jsx: `<Rect w={10} h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? (out.result as { ids: string[] }).ids[0] : "";
    // Placed beside the box where it is now, not where it was.
    expect((await node(fileId, made as string))?.props.x).not.toBe(110);
  });

  it("still commits at once when a person edited a layer it didn't read", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      {
        op: "create",
        id: "note",
        type: "rect",
        parent: person.page.id,
        key: "a1",
        props: { name: "Note", x: 0, y: 400, width: 10, height: 10 },
      },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "note", prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "unread-1",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w="fill" h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });

  it("runs again after any change at all when the run read more than it can name", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "note",
        type: "rect",
        parent: person.page.id,
        key: "a1",
        props: { name: "Note", x: 0, y: 400, width: 10, height: 10 },
      },
    ]);
    // As the runner answers a run that read the whole file, or past AGENT_READ_CAP ids.
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
              await person.edit([{ op: "set", id: "note", prop: "name", value: "Ana's" }]);
            return answer.ok ? { ...answer, reads: null } : answer;
          },
        };
      },
    };
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "read-everything-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toBe(2);
  });
});

describe("a delete committed after the file moved on", () => {
  it("runs again when a person changed a layer inside what it deletes", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "child",
        type: "rect",
        parent: box,
        key: "a0",
        props: { width: 10, height: 10, name: "before" },
      },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "child", prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-changed-child-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    expect(await node(fileId, "child")).toBeUndefined();
  });

  it("runs again when a person put a layer deeper inside what it deletes", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "create", id: "child", type: "frame", parent: box, key: "a0", props: { width: 10 } },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1)
        await person.edit([
          { op: "create", id: "grandchild", type: "rect", parent: "child", key: "a0", props: {} },
        ]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-deeper-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
  });

  it("commits at once when a person changed a layer outside what it deletes", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "outside",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { x: 300, width: 10, height: 10 },
      },
      { op: "create", id: "inside", type: "rect", parent: "outside", key: "a0", props: {} },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "inside", prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-elsewhere-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });
});

describe("requests with the same call id at once", () => {
  /** Deps whose runner waits at `gate` before running, saying when it got there. */
  function gated(fileId: string) {
    const real = agentDeps(env, fileId);
    let reached!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const deps: AgentDeps = {
      room: real.room,
      runner: () => ({
        ...real.runner(),
        run: async (request) => {
          reached();
          await gate;
          return real.runner().run(request);
        },
      }),
    };
    return { real, deps, waiting, resume };
  }

  it("agree: the later one waits for the first and answers as it did", async () => {
    const { fileId, box, by, session } = await setup();
    const { real, deps: slow, waiting, resume } = gated(fileId);
    let busy!: () => void;
    const sawBusy = new Promise<void>((r) => {
      busy = r;
    });
    const watching: AgentDeps = {
      runner: real.runner,
      room: () => {
        const room = real.room();
        return {
          ...room,
          admitAgentCall: async (request) => {
            const admission = await room.admitAgentCall(request);
            if ("busy" in admission) busy();
            return admission;
          },
        };
      },
    };
    const args = {
      by,
      session,
      callId: "same-delete-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    };
    const first = callWriteTool(slow, args);
    await waiting;
    const second = callWriteTool(watching, args);
    // The second is held until the first is answered; before claims it ran and committed.
    await Promise.race([second, sawBusy]);
    resume();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true, replayed: false });
    expect(b).toMatchObject({ ok: true, replayed: true, revn: a.ok ? a.revn : -1 });
  });

  it("answer a failed run with the call's recorded success when another committed it", async () => {
    const { fileId, box, by, session } = await setup();
    const { real, deps, waiting, resume } = gated(fileId);
    // As if the room restarted after admitting it, forgetting its claim.
    const forgetful: AgentDeps = {
      runner: deps.runner,
      room: () => {
        const room = real.room();
        return {
          ...room,
          admitAgentCall: async (request) => {
            const admission = await room.admitAgentCall(request);
            if (admission.admitted && admission.claim && request.sessionId && request.callId)
              await room.releaseAgentCall({
                v: request.v,
                fileId: request.fileId,
                sessionId: request.sessionId,
                callId: request.callId,
                claim: admission.claim,
              });
            return admission;
          },
        };
      },
    };
    const args = {
      by,
      session,
      callId: "same-delete-2",
      tool: "delete_nodes",
      input: { ids: [box] },
    };
    const second = callWriteTool(forgetful, args);
    await waiting;
    const first = await callWriteTool(real, args);
    resume();
    // Its run fails (the box is gone), and the ledger has the first one's success.
    const out = await second;
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(out).toMatchObject({ ok: true, replayed: true, revn: first.ok ? first.revn : -1 });
  });
});

describe("a commit after the file moved on, checked against what the run read", () => {
  it("runs again when a person resized the auto layout parent it filled", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: box, prop: "width", value: 400 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "fill-parent-1",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w="fill" h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? (out.result as { ids: string[] }).ids[0] : "";
    expect((await node(fileId, box))?.props.width).toBe(400);
    expect((await node(fileId, made as string))?.props.width).toBe(400);
  });

  it("runs again when a person moved the parent it moves a layer into", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "x", value: 100 },
      {
        op: "create",
        id: "destination",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { x: 200, y: 0, width: 100, height: 100 },
      },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "destination", prop: "x", value: 400 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "reparent-1",
      tool: "move_nodes",
      input: { ids: [box], parentId: "destination" },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    // It keeps its place on the page: x=100, inside a parent now at x=400.
    const moved = await node(fileId, box);
    expect(moved?.parent).toBe("destination");
    expect(moved?.props.x).toBe(-300);
  });

  it("runs again when a person moved a sibling it placed a new layer beside", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([{ op: "set", id: box, prop: "x", value: 0 }]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: box, prop: "x", value: 110 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "placement-1",
      tool: "render",
      input: { jsx: `<Rect w={10} h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? (out.result as { ids: string[] }).ids[0] : "";
    // Placed beside the box where it is now, not where it was.
    expect((await node(fileId, made as string))?.props.x).not.toBe(110);
  });

  it("still commits at once when a person edited a layer it didn't read", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      {
        op: "create",
        id: "note",
        type: "rect",
        parent: person.page.id,
        key: "a1",
        props: { name: "Note", x: 0, y: 400, width: 10, height: 10 },
      },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "note", prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "unread-1",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w="fill" h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });

  it("runs again after any change at all when the run read more than it can name", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "note",
        type: "rect",
        parent: person.page.id,
        key: "a1",
        props: { name: "Note", x: 0, y: 400, width: 10, height: 10 },
      },
    ]);
    // As the runner answers a run that read the whole file, or past AGENT_READ_CAP ids.
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
              await person.edit([{ op: "set", id: "note", prop: "name", value: "Ana's" }]);
            return answer.ok ? { ...answer, reads: null } : answer;
          },
        };
      },
    };
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "read-everything-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toBe(2);
  });
});

describe("a delete committed after the file moved on", () => {
  it("runs again when a person changed a layer inside what it deletes", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "child",
        type: "rect",
        parent: box,
        key: "a0",
        props: { width: 10, height: 10, name: "before" },
      },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "child", prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-changed-child-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    expect(await node(fileId, "child")).toBeUndefined();
  });

  it("runs again when a person put a layer deeper inside what it deletes", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "create", id: "child", type: "frame", parent: box, key: "a0", props: { width: 10 } },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1)
        await person.edit([
          { op: "create", id: "grandchild", type: "rect", parent: "child", key: "a0", props: {} },
        ]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-deeper-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
  });

  it("commits at once when a person changed a layer outside what it deletes", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "outside",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { x: 300, width: 10, height: 10 },
      },
      { op: "create", id: "inside", type: "rect", parent: "outside", key: "a0", props: {} },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1) await person.edit([{ op: "set", id: "inside", prop: "name", value: "Ana's" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-elsewhere-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });
});

describe("requests with the same call id at once", () => {
  /** Deps whose runner waits at `gate` before running, saying when it got there. */
  function gated(fileId: string) {
    const real = agentDeps(env, fileId);
    let reached!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    const deps: AgentDeps = {
      room: real.room,
      runner: () => ({
        ...real.runner(),
        run: async (request) => {
          reached();
          await gate;
          return real.runner().run(request);
        },
      }),
    };
    return { real, deps, waiting, resume };
  }

  it("agree: the later one waits for the first and answers as it did", async () => {
    const { fileId, box, by, session } = await setup();
    const { real, deps: slow, waiting, resume } = gated(fileId);
    let busy!: () => void;
    const sawBusy = new Promise<void>((r) => {
      busy = r;
    });
    const watching: AgentDeps = {
      runner: real.runner,
      room: () => {
        const room = real.room();
        return {
          ...room,
          admitAgentCall: async (request) => {
            const admission = await room.admitAgentCall(request);
            if ("busy" in admission) busy();
            return admission;
          },
        };
      },
    };
    const args = {
      by,
      session,
      callId: "same-delete-1",
      tool: "delete_nodes",
      input: { ids: [box] },
    };
    const first = callWriteTool(slow, args);
    await waiting;
    const second = callWriteTool(watching, args);
    // The second is held until the first is answered; before claims it ran and committed.
    await Promise.race([second, sawBusy]);
    resume();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true, replayed: false });
    expect(b).toMatchObject({ ok: true, replayed: true, revn: a.ok ? a.revn : -1 });
  });

  it("answer a failed run with the call's recorded success when another committed it", async () => {
    const { fileId, box, by, session } = await setup();
    const { real, deps, waiting, resume } = gated(fileId);
    // As if the room restarted after admitting it, forgetting its claim.
    const forgetful: AgentDeps = {
      runner: deps.runner,
      room: () => {
        const room = real.room();
        return {
          ...room,
          admitAgentCall: async (request) => {
            const admission = await room.admitAgentCall(request);
            if (admission.admitted && admission.claim && request.sessionId && request.callId)
              await room.releaseAgentCall({
                v: request.v,
                fileId: request.fileId,
                sessionId: request.sessionId,
                callId: request.callId,
                claim: admission.claim,
              });
            return admission;
          },
        };
      },
    };
    const args = {
      by,
      session,
      callId: "same-delete-2",
      tool: "delete_nodes",
      input: { ids: [box] },
    };
    const second = callWriteTool(forgetful, args);
    await waiting;
    const first = await callWriteTool(real, args);
    resume();
    // Its run fails (the box is gone), and the ledger has the first one's success.
    const out = await second;
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(out).toMatchObject({ ok: true, replayed: true, revn: first.ok ? first.revn : -1 });
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
