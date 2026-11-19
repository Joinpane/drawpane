/**
 * An agent call split between the runner and the room (decision 0033,
 * migration step 1): the main Worker's side (`agent/call.ts`) with the
 * runner in its own script (step 3), wrapped so a person can edit between
 * the run and its commit. A commit is refused as stale when someone changed
 * a layer in the run's scope (the top-level layers it worked in, and what
 * they use), and the call then runs again; edits elsewhere don't hold it up.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Doc } from "@drawpane/editor";
import { copyId, type NodeRecord, type Op, type Paint } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  type AgentDeps,
  agentDeps,
  callReadTool,
  callWriteTool,
  KEPT_CHANGING,
  RUNNER_ABORTED,
} from "../src/agent/call";
import {
  AGENT_CLAIM_MS,
  AGENT_RUNNER_V,
  type AgentRunAnswer,
  type AgentRunRequest,
} from "../src/agent/runner-api";
import { openSocket, signedInUser } from "./helpers";
import { call, makeToken } from "./mcp-helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

/** A person in the file, editing over their socket. */
async function join(browser: Parameters<typeof openSocket>[0], fileId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 3,
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
    browser: ana.browser,
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
  it("reports failure when an invalid binding unit rejects the entire atomic agent edit", async () => {
    const { fileId, box, by, session } = await setup();
    const out = await callWriteTool(agentDeps(env, fileId), {
      by,
      session,
      callId: "invalid-binding-unit",
      tool: "set_props",
      input: {
        changes: [
          {
            id: box,
            props: { name: "After", bindings: { opacity: { variable: box, unit: "text" } } },
          },
        ],
      },
    });
    expect((await node(fileId, box))?.props.name).toBe("Box");
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/unit/) });
  });

  it("keeps an explicit nested paint binding written by set_props", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "Colors",
        type: "collection",
        parent: "root",
        key: "a1",
        props: { modes: [{ id: "m", name: "M" }] },
      },
      {
        op: "create",
        id: "Color",
        type: "variable",
        parent: "Colors",
        key: "a0",
        props: { variableType: "color", values: { m: "#123456" } },
      },
      { op: "set", id: box, prop: "fills", value: [{ type: "solid", color: "#abcdef" }] },
    ]);
    const fills = [{ type: "solid", color: "#aabbcc", bind: { color: "Color" } }];
    const out = await callWriteTool(agentDeps(env, fileId), {
      by,
      session,
      callId: "set-paint-binding",
      tool: "set_props",
      input: { changes: [{ id: box, props: { fills } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect((await node(fileId, box))?.props.fills).toEqual(fills);
  });

  it("reruns an edit of a linked fill when its shared paint style changed during the run", async () => {
    const { fileId, person, box, by, session } = await setup();
    const red: Paint[] = [{ type: "solid", color: "#ff0000" }];
    const blue: Paint[] = [{ type: "solid", color: "#0000ff" }];
    await person.edit([
      {
        op: "create",
        id: "PaintStyle",
        type: "paintStyle",
        parent: "root",
        key: "a1",
        props: { fills: red },
      },
      { op: "set", id: box, prop: "fillStyle", value: "PaintStyle" },
      { op: "set", id: box, prop: "fills", value: red },
    ]);
    const { deps, runs } = withPause(fileId, async (run) => {
      if (run === 1)
        await person.edit([{ op: "set", id: "PaintStyle", prop: "fills", value: blue }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "linked-fill-changed-mid-run",
      tool: "set_props",
      input: { changes: [{ id: box, props: { name: "After", fills: blue } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect((await node(fileId, box))?.props).toMatchObject({
      name: "After",
      fillStyle: "PaintStyle",
    });
    expect(runs).toHaveLength(2);
  });

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
    // One to ask where its editor is, one for the run, one to say the commit landed.
    expect(runners).toBe(3);
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

/** Deps that run `between` once after the first run, and keep what each run said it read. */
function firstRunPaused(fileId: string, between: () => Promise<void>) {
  const { deps, runs } = withPause(fileId, async (run) => {
    if (run === 1) await between();
  });
  return { deps, runs };
}

/** The file as a compact document shows it: copy layers presented. */
async function presented(fileId: string) {
  const doc = new Doc({ compactCopies: true });
  doc.resetStored((await roomOf(fileId).allNodes()) as NodeRecord[], "compact");
  return doc;
}

// Review 2 of #195: precise read tracking missed reads behind caches. The scope rule
// doesn't depend on them: each of these committed a stale result at c0d1fe3.
describe("a commit whose inputs a cache hid from the read set", () => {
  it("runs again when a layer inside a group it placed a layer beside moved (a warm scene's cached bounds)", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "x", value: 0 },
      { op: "create", id: "group", type: "group", parent: person.page.id, key: "a1", props: {} },
      {
        op: "create",
        id: "inside",
        type: "rect",
        parent: "group",
        key: "a0",
        props: { x: 500, y: 0, width: 10, height: 10 },
      },
    ]);
    // A first render warms the runner's scene: the group's bounds are cached.
    const prime = await callWriteTool(agentDeps(env, fileId), {
      by,
      session,
      callId: "cached-group-prime",
      tool: "render",
      input: { jsx: `<Rect x={0} y={0} w={10} h={10} />` },
    });
    expect(prime.ok).toBe(true);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([{ op: "set", id: "inside", prop: "x", value: 610 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "cached-group",
      tool: "render",
      input: { jsx: `<Rect w={10} h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? ((out.result as { ids: string[] }).ids[0] as string) : "";
    const x = (await node(fileId, made))?.props.x as number;
    // Not on top of the group's layer where it is now (610 to 620).
    expect(x + 10 <= 610 || x >= 620).toBe(true);
  });

  it("runs again when the main's layers a compact instance lays out changed (its children's provenance)", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "isComponent", value: true },
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      {
        op: "create",
        id: "mainChild",
        type: "rect",
        parent: box,
        key: "a0",
        props: { width: 10, height: 10 },
      },
      {
        op: "create",
        id: "mainChild2",
        type: "rect",
        parent: box,
        key: "a1",
        props: { x: 10, width: 10, height: 10 },
      },
      {
        op: "create",
        id: "instance",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { instanceOf: box, x: 500 },
      },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      // As the main's own layout does: the first child grows, the second moves along.
      await person.edit([
        { op: "set", id: "mainChild", prop: "width", value: 80 },
        { op: "set", id: "mainChild2", prop: "x", value: 80 },
      ]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "compact-provenance",
      tool: "set_props",
      input: { changes: [{ id: "instance", props: { gap: 10 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    // 80 wide, then a gap of 10.
    expect((await presented(fileId)).get(copyId("instance", ["mainChild2"]))?.props.x).toBe(90);
  });

  it("runs again when a layer was added to the main a compact instance lays out (its source list)", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "isComponent", value: true },
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      {
        op: "create",
        id: "a",
        type: "rect",
        parent: box,
        key: "a0",
        props: { width: 10, height: 10 },
      },
      {
        op: "create",
        id: "b",
        type: "rect",
        parent: box,
        key: "a1",
        props: { x: 10, width: 10, height: 10 },
      },
      {
        op: "create",
        id: "i",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { instanceOf: box, x: 500 },
      },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([
        {
          op: "create",
          id: "new-source",
          type: "rect",
          parent: box,
          key: "a2",
          props: { x: 20, width: 10, height: 10 },
        },
      ]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "compact-source-list",
      tool: "set_props",
      input: { changes: [{ id: "i", props: { gap: 10 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    // Two 10 wide layers, each followed by a gap of 10.
    expect((await presented(fileId)).get(copyId("i", ["new-source"]))?.props.x).toBe(40);
  });

  it("runs again when an instance of the main it changed was made meanwhile (a materialized file's cached instance index)", async () => {
    const { fileId, browser, person: first, box, by, session } = await setup();
    const initial = await roomOf(fileId).allNodes();
    await runInDurableObject(roomOf(fileId), (room) => {
      room.compactCopiesOff = true;
    });
    await roomOf(fileId).storeMaterialized(initial as NodeRecord[]);
    first.ws.close();
    const person = await join(browser, fileId);
    await person.edit([{ op: "set", id: box, prop: "isComponent", value: true }]);
    // A first change to the main warms the runner's instance index.
    const prime = await callWriteTool(agentDeps(env, fileId), {
      by,
      session,
      callId: "instance-index-prime",
      tool: "set_props",
      input: { changes: [{ id: box, props: { opacity: 0.7 } }] },
    });
    expect(prime.ok).toBe(true);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([
        {
          op: "create",
          id: "late-instance",
          type: "frame",
          parent: person.page.id,
          key: "a1",
          props: { instanceOf: box, width: 10, height: 10, opacity: 0.7, x: 100 },
        },
      ]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "materialized-new-instance",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 80 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    expect((await node(fileId, box))?.props.width).toBe(80);
    expect((await node(fileId, "late-instance"))?.props.width).toBe(80);
  });
});

describe("a commit's scope", () => {
  it("runs again when a person moved a sibling in the same free-positioned frame", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "width", value: 200 },
      {
        op: "create",
        id: "a",
        type: "rect",
        parent: box,
        key: "a0",
        props: { width: 10, height: 10 },
      },
      { op: "create", id: "b", type: "rect", parent: box, key: "a1", props: { x: 50, width: 10 } },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([{ op: "set", id: "b", prop: "x", value: 60 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "same-frame",
      tool: "set_props",
      input: { changes: [{ id: "a", props: { opacity: 0.5 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
  });

  it("commits at once when a person dragged a layer inside another top-level frame", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "create", id: "a", type: "rect", parent: box, key: "a0", props: { width: 10 } },
      {
        op: "create",
        id: "other",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { x: 400, width: 200, height: 200 },
      },
      { op: "create", id: "c", type: "rect", parent: "other", key: "a0", props: { width: 10 } },
    ]);
    const { deps, runs } = withPause(fileId, async () => {
      await person.edit([{ op: "set", id: "c", prop: "x", value: 40 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "other-frame",
      tool: "set_props",
      input: { changes: [{ id: "a", props: { opacity: 0.5 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(1);
  });

  it("runs again when a person deleted a layer in the frame it works in", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      { op: "create", id: "a", type: "rect", parent: box, key: "a0", props: { width: 10 } },
      { op: "create", id: "b", type: "rect", parent: box, key: "a1", props: { width: 10 } },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([{ op: "delete", id: "a" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "deleted-sibling",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w={10} h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? ((out.result as { ids: string[] }).ids[0] as string) : "";
    // Laid out after b alone, where a was gone.
    expect((await node(fileId, made))?.props.x).toBe(10);
  });

  it("runs again when a person moved a layer out of the frame it works in", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      { op: "create", id: "a", type: "rect", parent: box, key: "a0", props: { width: 10 } },
      {
        op: "create",
        id: "other",
        type: "frame",
        parent: person.page.id,
        key: "a1",
        props: { x: 400, width: 200, height: 200 },
      },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([{ op: "move", id: "a", parent: "other", key: "a0" }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "moved-out",
      tool: "render",
      input: { parentId: box, jsx: `<Rect w={10} h={10} />` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? ((out.result as { ids: string[] }).ids[0] as string) : "";
    // Laid out first, where a was gone.
    expect((await node(fileId, made))?.props.x ?? 0).toBe(0);
  });

  it("reruns when text set in a style it used changed, and measures it again", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "style",
        type: "textStyle",
        parent: "root",
        key: "a1",
        props: { fontSize: 10 },
      },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([{ op: "set", id: "style", prop: "fontSize", value: 20 }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "styled-text",
      tool: "render",
      input: { parentId: box, jsx: `<Text textStyle="style">abc</Text>` },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    const made = out.ok ? ((out.result as { ids: string[] }).ids[0] as string) : "";
    expect((await node(fileId, made))?.props.width).toBe(30);
  });

  it("reruns when the variable a token it bound aliases changed", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      {
        op: "create",
        id: "col",
        type: "collection",
        parent: "root",
        key: "a1",
        props: { name: "Sizes", modes: [{ id: "default", name: "Default" }] },
      },
      {
        op: "create",
        id: "source",
        type: "variable",
        parent: "col",
        key: "a0",
        props: { name: "Source", variableType: "number", values: { default: 20 } },
      },
      {
        op: "create",
        id: "alias",
        type: "variable",
        parent: "col",
        key: "a1",
        props: { name: "Alias", variableType: "number", values: { default: { alias: "source" } } },
      },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([{ op: "set", id: "source", prop: "values", value: { default: 80 } }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "token-alias",
      tool: "bind_token",
      input: { ids: [box], key: "width", variableId: "alias" },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    expect((await node(fileId, box))?.props.width).toBe(80);
  });

  it("reruns a compact main's delete when an instance of it was made meanwhile, which keeps its layers", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "isComponent", value: true },
      {
        op: "create",
        id: "main-child",
        type: "rect",
        parent: box,
        key: "a0",
        props: { width: 10, height: 10 },
      },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      await person.edit([
        {
          op: "create",
          id: "late-compact",
          type: "frame",
          parent: person.page.id,
          key: "a1",
          props: { instanceOf: box, x: 100 },
        },
      ]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "delete-main-race",
      tool: "delete_nodes",
      input: { ids: [box] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
    expect((await presented(fileId)).childIds("late-compact")).toHaveLength(1);
  });
});

describe("a frame someone keeps changing", () => {
  it("gives up after three runs with a clear failure, and commits nothing stale", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "set", id: box, prop: "width", value: 200 },
      { op: "create", id: "a", type: "rect", parent: box, key: "a0", props: { width: 10 } },
      { op: "create", id: "b", type: "rect", parent: box, key: "a1", props: { x: 10, width: 10 } },
    ]);
    // A drag of a sibling in the same frame, landing during every attempt.
    const { deps, runs } = withPause(fileId, async (run) => {
      await person.edit([{ op: "set", id: "b", prop: "x", value: 10 + run }]);
    });
    const started = Date.now();
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "busy-frame",
      tool: "set_props",
      input: { changes: [{ id: "a", props: { opacity: 0.7 } }] },
    });
    expect(out).toEqual({ ok: false, message: KEPT_CHANGING });
    expect(KEPT_CHANGING).toContain("frame");
    expect(runs).toHaveLength(3);
    // It paused between attempts: 250 ms, then a second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_250);
    expect((await node(fileId, "a"))?.props.opacity).toBeUndefined();
    expect(await roomOf(fileId).agentCall(session.id, "busy-frame")).toBeNull();
  });

  it("commits on the next attempt once a drag in the frame has stopped", async () => {
    const { fileId, person, box, by, session } = await setup();
    await person.edit([
      { op: "set", id: box, prop: "layoutMode", value: "row" },
      { op: "create", id: "a", type: "rect", parent: box, key: "a0", props: { width: 10 } },
      { op: "create", id: "b", type: "rect", parent: box, key: "a1", props: { x: 10, width: 10 } },
    ]);
    const { deps, runs } = firstRunPaused(fileId, async () => {
      for (let step = 1; step <= 5; step++)
        await person.edit([{ op: "set", id: "b", prop: "x", value: 10 + step }]);
    });
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "drag-stopped",
      tool: "set_props",
      input: { changes: [{ id: "a", props: { opacity: 0.7 } }] },
    });
    expect(out).toMatchObject({ ok: true });
    expect(runs).toHaveLength(2);
  });
});

describe("claims on call ids", () => {
  /** Runs `body` in the room with Date.now under the test's control. */
  async function withClock<T>(
    fileId: string,
    body: (
      room: InstanceType<typeof import("../src/rooms/file-room").FileRoom>,
      advance: (ms: number) => void,
    ) => Promise<T>,
  ): Promise<T> {
    return runInDurableObject(roomOf(fileId), async (room) => {
      const realNow = Date.now;
      let now = realNow();
      Date.now = () => now;
      try {
        return await body(room, (ms) => {
          now += ms;
        });
      } finally {
        Date.now = realNow;
      }
    });
  }

  it("sweeps claims whose callers stopped renewing them", async () => {
    const { fileId, session } = await setup();
    const held = await withClock(fileId, async (room, advance) => {
      for (let i = 0; i < 100; i++)
        await room.admitAgentCall({
          v: AGENT_RUNNER_V,
          fileId,
          sessionId: session.id,
          callId: `abandoned-${i}`,
        });
      const before = await room.heldAgentClaims();
      advance(AGENT_CLAIM_MS + 1);
      await room.admitAgentCall({
        v: AGENT_RUNNER_V,
        fileId,
        sessionId: session.id,
        callId: "fresh",
      });
      return { before, after: await room.heldAgentClaims() };
    });
    expect(held).toEqual({ before: 100, after: 1 });
  });

  it("holds a renewed claim, and lets a dead one go after its short lease", async () => {
    const { fileId, session } = await setup();
    const ids = { v: AGENT_RUNNER_V, fileId, sessionId: session.id, callId: "leased" };
    const seen = await withClock(fileId, async (room, advance) => {
      const first = await room.admitAgentCall(ids);
      const claim = first.admitted ? (first.claim as string) : "";
      advance(AGENT_CLAIM_MS - 1_000);
      const renewed = await room.renewAgentCall({ ...ids, claim });
      advance(AGENT_CLAIM_MS - 1_000);
      // Past the first lease, but renewed: still busy.
      const whileRenewed = await room.admitAgentCall(ids);
      // Its caller died: no more renewals, and it's gone a lease later.
      advance(1_001);
      const afterLease = await room.admitAgentCall(ids);
      const stale = await room.renewAgentCall({ ...ids, claim });
      return { renewed, whileRenewed, afterLease, stale };
    });
    expect(AGENT_CLAIM_MS).toBeLessThanOrEqual(15_000);
    expect(seen.renewed).toBe(true);
    expect(seen.whileRenewed).toEqual({ admitted: false, busy: true });
    expect(seen.afterLease).toMatchObject({ admitted: true });
    expect(seen.stale).toBe(false);
  });

  it("stops keeping origin notes once an abandoned claim lapses, whoever edits next", async () => {
    // A write call admitted, then its caller died: no renewals, and no agent request afterwards.
    const { fileId, person, session } = await setup();
    const room = roomOf(fileId);
    const realNow = Date.now;
    let now = realNow();
    await runInDurableObject(room, async (r) => {
      Date.now = () => now;
      const admitted = await r.admitAgentCall({
        v: AGENT_RUNNER_V,
        fileId,
        sessionId: session.id,
        callId: "caller-died",
      });
      expect(admitted).toMatchObject({ admitted: true });
    });
    try {
      // While the claim is live, people's edits are noted, for the run that might still commit.
      await person.edit([{ op: "set", id: person.page.id, prop: "name", value: "live" }]);
      expect(await room.agentWatchNotes()).toBe(1);
      // Its lease runs out; only people edit from here on.
      now += AGENT_CLAIM_MS + 1;
      for (let n = 0; n < 20; n++)
        await person.edit([{ op: "set", id: person.page.id, prop: "name", value: `after ${n}` }]);
      expect(await room.agentWatchNotes()).toBe(0);
    } finally {
      await runInDurableObject(room, () => {
        Date.now = realNow;
      });
    }
  });

  it("lets go of the claim when the call is answered, even when its run failed", async () => {
    const { fileId, by, session } = await setup();
    const out = await callWriteTool(agentDeps(env, fileId), {
      by,
      session,
      callId: "failed-run",
      tool: "set_props",
      input: { changes: [{ id: "missing", props: { w: 10 } }] },
    });
    expect(out.ok).toBe(false);
    expect(await roomOf(fileId).heldAgentClaims()).toBe(0);
  });
});
