/**
 * Chaos in the agent runner (decision 0033, migration step 4): the runner,
 * a script of its own beside the main Worker (vitest.config.ts), fails as
 * Cloudflare makes it fail, through its test hooks (agent-runner/src/hooks.ts):
 * it resets itself mid-call (`ctx.abort()`, as when it runs out of memory),
 * resets after the room committed, or never answers. People in the file stay
 * connected, nothing commits twice, and a call that keeps running the
 * runner out of memory stops being run (strikes). A strike is recorded only
 * when the main Worker saw that error: a routine restart isn't one, and the
 * time limit is the run's own, not the time it waited for the calls ahead.
 */
import { env } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import {
  CALL_REFUSED,
  CALL_REFUSED_MS,
  FILE_PAUSE_MS,
  FILE_WINDOW_MS,
  filePaused,
  strikeRefusal,
} from "../../agent-runner/src/strikes";
import {
  type AgentDeps,
  agentDeps,
  callReadTool,
  callWriteTool,
  RUNNER_ABORTED,
  RUNNER_RESET,
  TOOK_TOO_LONG,
} from "../src/agent/call";
import { AGENT_RUNNER_V } from "../src/agent/runner-api";
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
    protocol: 4,
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

/** Ana's file with a box the agent made, a person in it since before, and the session. */
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
  const made = await call(token, "render", {
    sessionId,
    jsx: `<Frame name="Box" w={10} h={10} />`,
  });
  const box = (made.structuredContent as { ids: string[] }).ids[0] as string;
  await person.next("txn");
  return {
    fileId,
    token,
    person,
    box,
    sessionId,
    by: { userId: ana.userId, name: "Ana Lima" },
    session: { id: sessionId, name, fileId },
  };
}

const node = async (fileId: string, id: string) =>
  (await roomOf(fileId).allNodes()).find((n) => n.id === id);

const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
  result.isError ? String((result.structuredContent as { error: string }).error) : null;

describe("a runner that resets before the commit", () => {
  it("changes nothing, keeps the people in the file connected, and the retry runs once", async () => {
    const { fileId, token, person, box, sessionId, session } = await setup();
    const before = (await roomOf(fileId).stats()).revn;
    await runnerOf(fileId).arm("abort-mid-run");
    const args = { sessionId, callId: "abort-before-1", changes: [{ id: box, props: { w: 50 } }] };

    const failed = await call(token, "set_props", args);
    expect(errorOf(failed)).toBe(RUNNER_ABORTED);
    // Nothing committed, nothing in the ledger.
    expect((await roomOf(fileId).stats()).revn).toBe(before);
    expect(await roomOf(fileId).agentCall(session.id, "abort-before-1")).toBeNull();
    expect((await node(fileId, box))?.props.width).toBe(10);
    // The socket opened before the call is still open, and its edits are acked.
    expect(person.inbox.some((m) => m.t === "error")).toBe(false);
    const edited = await person.edit([{ op: "set", id: box, prop: "name", value: "Still here" }]);
    expect(edited).toBe(before + 1);

    // The agent retries with the same call id: it runs once and commits once.
    const retried = await call(token, "set_props", args);
    expect(errorOf(retried)).toBeNull();
    expect((await node(fileId, box))?.props).toMatchObject({ name: "Still here", width: 50 });
    const txn = await person.next<{ revn: number; ops: Op[] }>("txn");
    expect(txn.revn).toBe(before + 2);
    expect(person.inbox.filter((m) => m.t === "txn")).toEqual([]);
    expect(await roomOf(fileId).agentCall(session.id, "abort-before-1")).toMatchObject({
      revn: before + 2,
    });
    // The main Worker saw it run out of memory: a strike (one isn't enough to refuse it).
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 1, builds: 1 });
  });
});

describe("a runner that resets after the commit, before the answer", () => {
  it("still answers, and the retry replays without running anything twice", async () => {
    const { fileId, token, person, box, sessionId } = await setup();
    await runnerOf(fileId).arm("abort-in-committed");
    const args = { sessionId, callId: "abort-after-1", changes: [{ id: box, props: { w: 60 } }] };
    // The room committed; the runner died hearing so, which only means it dropped its editor.
    const first = await call(token, "set_props", args);
    expect(errorOf(first)).toBeNull();
    await person.next("txn");
    const revn = (await roomOf(fileId).stats()).revn;
    const runner = await runnerOf(fileId).stats();
    // A fresh runner, which never held the editor: nothing to strike, nothing warm.
    expect(runner).toMatchObject({ revn: null, builds: 0, strikes: 0 });

    const again = await call(token, "set_props", args);
    expect(again.structuredContent).toEqual({ ...first.structuredContent, replayed: true });
    expect((await roomOf(fileId).stats()).revn).toBe(revn);
    expect(await runnerOf(fileId).stats()).toMatchObject({ builds: 0 });
    expect(person.inbox.filter((m) => m.t === "txn")).toEqual([]);
  });

  it("replays when the main Worker's request died after the commit", async () => {
    const { fileId, person, box, by, session } = await setup();
    const real = agentDeps(env, fileId);
    let runs = 0;
    const counted = (): AgentDeps["runner"] => () => {
      const runner = real.runner();
      return {
        ...runner,
        run: (request) => {
          runs++;
          return runner.run(request);
        },
      };
    };
    const dying: AgentDeps = {
      runner: counted(),
      room: () => {
        const room = real.room();
        return {
          ...room,
          commitAgentRun: async (request) => {
            await room.commitAgentRun(request);
            throw new Error("The main Worker's request went away.");
          },
        };
      },
    };
    const args = {
      by,
      session,
      callId: "lost-answer-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 70 } }] },
    };
    await expect(callWriteTool(dying, args)).rejects.toThrow("went away");
    await person.next("txn");
    const revn = (await roomOf(fileId).stats()).revn;
    expect(runs).toBe(1);

    const out = await callWriteTool({ room: real.room, runner: counted() }, args);
    expect(out).toMatchObject({ ok: true, replayed: true, revn });
    expect(runs).toBe(1);
    expect((await roomOf(fileId).stats()).revn).toBe(revn);
    expect((await node(fileId, box))?.props.width).toBe(70);
  });
});

describe("crash strikes", () => {
  it("stop running a call that keeps killing the runner, then pause the file", async () => {
    const { fileId, token, box, sessionId } = await setup();
    await runnerOf(fileId).arm("abort-mid-run", 10);
    const heavy = { sessionId, callId: "heavy-call-1", changes: [{ id: box, props: { w: 90 } }] };

    expect(errorOf(await call(token, "set_props", heavy))).toBe(RUNNER_ABORTED);
    // Its retry runs (one strike could be another file's fault), and dies again.
    expect(errorOf(await call(token, "set_props", heavy))).toBe(RUNNER_ABORTED);
    // Two strikes: refused without running, with a new call id too (same fingerprint).
    expect(errorOf(await call(token, "set_props", heavy))).toBe(CALL_REFUSED);
    expect(errorOf(await call(token, "set_props", { ...heavy, callId: "heavy-call-2" }))).toBe(
      CALL_REFUSED,
    );
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 2 });
    expect((await node(fileId, box))?.props.width).toBe(10);

    // Another call dies too: the third strike in ten minutes pauses the file, any call.
    const other = { sessionId, callId: "other-call-1", changes: [{ id: box, props: { h: 20 } }] };
    expect(errorOf(await call(token, "set_props", other))).toBe(RUNNER_ABORTED);
    const paused = errorOf(
      await call(token, "set_props", {
        sessionId,
        callId: "light-call-1",
        changes: [{ id: box, props: { x: 5 } }],
      }),
    );
    expect(paused).toBe(filePaused(10));
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 3 });
  });

  it("aren't made by routine restarts, however many", async () => {
    // #200's review: three resets during healthy calls (deploys) paused the file.
    const { fileId, token, box, sessionId } = await setup();
    await runnerOf(fileId).arm("restart-mid-run", 3);
    const answers: Array<string | null> = [];
    for (let n = 0; n < 3; n++)
      answers.push(
        errorOf(
          await call(token, "set_props", {
            sessionId,
            callId: `restart-${n}`,
            changes: [{ id: box, props: { w: 30 + n } }],
          }),
        ),
      );
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 0 });
    // Run once more on a fresh runner, or answered as a restart: never as running out of memory.
    for (const answer of answers) expect([null, RUNNER_RESET]).toContain(answer);
    const ordinary = await call(token, "set_props", {
      sessionId,
      callId: "after-restarts",
      changes: [{ id: box, props: { h: 44 } }],
    });
    expect(errorOf(ordinary)).toBeNull();
    expect((await node(fileId, box))?.props.height).toBe(44);
  });

  it("are dated when they happened, and old ones count for nothing", async () => {
    const { fileId } = await setup();
    const strike = (minutesAgo: number) =>
      runnerOf(fileId).strike({
        v: AGENT_RUNNER_V,
        fileId,
        tool: "set_props",
        input: { changes: [] },
        at: Date.now() - minutesAgo * 60_000,
      });
    // A week old (#200's review promoted such a leftover to a new strike): not kept.
    await strike(7 * 24 * 60);
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 0 });
    // Over an hour old (the strikes kept): not kept either. One from now is.
    await strike(CALL_REFUSED_MS / 60_000 + 1);
    await strike(0);
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 1 });
    // Dated when it happened, not when it was recorded: 59 minutes ago still counts.
    await strike(59);
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 2 });
    const now = Date.now();
    expect(
      strikeRefusal(
        [
          { fingerprint: "a", at: now - CALL_REFUSED_MS - 60_000 },
          { fingerprint: "a", at: now },
        ],
        "a",
        now,
      ),
    ).toBeNull();
  });

  it("refuse a call after its second strike for an hour, and a file after three in ten minutes", () => {
    const now = 1_000_000_000;
    const at = (minutesAgo: number, fingerprint = "a") => ({
      fingerprint,
      at: now - minutesAgo * 60_000,
    });
    expect(strikeRefusal([], "a", now)).toBeNull();
    expect(strikeRefusal([at(1)], "a", now)).toBeNull();
    expect(strikeRefusal([at(30), at(1)], "a", now)).toBe(CALL_REFUSED);
    expect(strikeRefusal([at(30), at(1)], "b", now)).toBeNull();
    // An hour on, the older strike no longer counts.
    expect(strikeRefusal([at(CALL_REFUSED_MS / 60_000), at(1)], "a", now)).toBeNull();
    // Three in ten minutes, from any calls: paused for ten minutes from the third.
    expect(strikeRefusal([at(9, "x"), at(5, "y"), at(2, "z")], "b", now)).toBe(filePaused(8));
    expect(strikeRefusal([at(9, "x"), at(5, "y"), at(0, "z")], "b", now)).toBe(
      filePaused(FILE_PAUSE_MS / 60_000),
    );
    // Spread wider than the window, or the pause over: not paused.
    expect(strikeRefusal([at(25, "x"), at(12, "y"), at(1, "z")], "b", now)).toBeNull();
    expect(
      strikeRefusal([at(19, "x"), at(15, "y"), at(FILE_PAUSE_MS / 60_000, "z")], "b", now),
    ).toBeNull();
    expect(FILE_WINDOW_MS).toBe(10 * 60_000);
  });
});

describe("a runner that never answers", () => {
  it("answers at its own limit, changes nothing, and is reset so the next call runs", async () => {
    const { fileId, person, box, by, session } = await setup();
    const before = (await roomOf(fileId).stats()).revn;
    // The limit is 90 s (AGENT_RUN_LIMIT_MS); the test's runner has 300 ms.
    await runnerOf(fileId).arm("run-limit", 1, 300);
    await runnerOf(fileId).arm("hang");
    const real = agentDeps(env, fileId);
    const deps: AgentDeps = { ...real, runLimitMs: 300, queueWaitMs: 5_000 };
    const out = await callWriteTool(deps, {
      by,
      session,
      callId: "hang-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 15 } }] },
    });
    expect(out).toEqual({ ok: false, message: TOOK_TOO_LONG });
    expect((await roomOf(fileId).stats()).revn).toBe(before);
    expect(await person.edit([{ op: "set", id: box, prop: "name", value: "Fine" }])).toBe(
      before + 1,
    );
    // The hung call was cut off by the reset, and the file's next call runs. Not a strike:
    // only running out of memory is.
    await runnerOf(fileId).arm("run-limit", 0);
    const next = await callWriteTool(real, {
      by,
      session,
      callId: "after-hang-1",
      tool: "set_props",
      input: { changes: [{ id: box, props: { w: 16 } }] },
    });
    expect(next).toMatchObject({ ok: true });
    expect((await node(fileId, box))?.props).toMatchObject({ name: "Fine", width: 16 });
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 0 });
  });
});

describe("the time limit", () => {
  it("is the run's own: calls waiting their turn aren't timed out or struck", async () => {
    // #200's review (QUEUE_DEADLINE): two calls of 250 ms under a 400 ms limit, one queued
    // behind the other. Timed from when they were asked, the second was cut off.
    const { fileId, box } = await setup();
    await runnerOf(fileId).arm("run-limit", 1, 400);
    await runnerOf(fileId).arm("slow", 2, 250);
    const deps: AgentDeps = { ...agentDeps(env, fileId), runLimitMs: 400, queueWaitMs: 5_000 };
    const read = (id: string) => callReadTool(deps, { fileId, tool: "get_jsx", input: { id } });
    const [a, b] = await Promise.all([read(box), read(box)]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(await runnerOf(fileId).stats()).toMatchObject({ strikes: 0 });
    await runnerOf(fileId).arm("run-limit", 0);
  });
});

describe("the runner's interface version", () => {
  it("is 2, and a request of the version before still runs", async () => {
    // `reset` and `strike` came with version 2: a runner of version 1 refuses a version 2 call.
    expect(AGENT_RUNNER_V).toBe(2);
    const { fileId, box } = await setup();
    expect((await runnerOf(fileId).held(fileId)).v).toBe(2);
    const answer = await runnerOf(fileId).run({
      v: 1,
      fileId,
      tool: "get_jsx",
      input: { id: box },
      source: { kind: "log", from: 0, revn: 0, count: 0, copies: "materialized", txns: [] },
    });
    // Accepted (the source doesn't line up, so it asks for the file again): not refused as out of step.
    expect(answer).toEqual({ ok: false, again: true });
  });
});
