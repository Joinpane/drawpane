/**
 * An agent call, as the main Worker makes it (decision 0033, item 2): the
 * room admits it, the runner runs the tool, the room commits what it made,
 * and the runner hears how that went. The room never calls the runner and
 * the runner never calls the room; everything goes through here.
 *
 * The runner is a Durable Object in a script of its own (`apps/agent-runner`),
 * one per file, bound as AGENT_RUNNER. Step 0's rules
 * (`0033-agent-runner-step0.md`) hold here: a new runner stub for every
 * call; a failed `committed` only means the runner dropped its editor; the
 * room never awaits the runner, since only this code calls it; and a runner
 * that ran out of memory is the agent's failure, never retried.
 *
 * Each run gets the file from the room (`AgentFileSource`): first the
 * runner says which revision its editor shows (`held`), then the room
 * answers with the log since (warm) or a snapshot (cold), along with
 * admission for the first run.
 */
import { findTool } from "@drawpane/editor";
import type { Env } from "../env";
import {
  AGENT_CLAIM_RENEW_MS,
  AGENT_RUNNER_V,
  type AgentAdmission,
  type AgentCallResult,
  type AgentCommittedNote,
  type AgentFileSource,
  type AgentRequester,
  type AgentRoomApi,
  type AgentRunAnswer,
  type AgentRunnerApi,
  type AgentRunRequest,
  type AgentSessionRef,
  type CommitAgentAnswer,
} from "./runner-api";

/** How often a call runs, when someone keeps changing the frame it works in meanwhile, before giving up. */
export const AGENT_ATTEMPTS = 3;
/** The pauses before running again after a stale commit: the frame is busy, so let it settle. */
export const STALE_PAUSES_MS = [250, 1_000];
/** How long a call waits for another request with the same call id before giving up. */
const BUSY_WAIT_MS = 60_000;

export const RUNNER_ABORTED =
  "The agent runner ran out of memory on that call. Nothing was changed. Try a smaller part.";
export const KEPT_CHANGING =
  "Someone kept changing the frame that call works in while it ran, so nothing was changed. Try again.";
const KEPT_BUSY = "That call is still running from an earlier request. Try again shortly.";
const DOWNLOADS_BUSY =
  "Many people are opening this file right now, so the agent runner couldn't load it. Nothing was changed. Try again shortly.";
const OUT_OF_STEP =
  "The agent runner couldn't get in step with the file, and nothing was changed. Try again.";
/** How often a run asks for the file again (a runner that moved on, loaded fonts, or was reset). */
const RUN_TRIES = 4;
/**
 * How long the main Worker waits for a run before answering that it took
 * too long (decision 0033, item 4.6). The runner's own CPU limit is 60 s,
 * so a run still going past this is waiting on something; the runner is
 * reset, which cuts it off and counts a strike against it.
 */
export const AGENT_RUN_LIMIT_MS = 90_000;
export const TOOK_TOO_LONG =
  "That call took too long, and nothing was changed. Try a smaller part.";

/**
 * Who the call talks to. Each is a factory, called again for every request:
 * a runner's stub is dead after its isolate resets, and a new one works.
 */
export interface AgentDeps {
  room(): AgentRoomApi;
  runner(): AgentRunnerApi;
  /** How long to wait for a run: AGENT_RUN_LIMIT_MS unless said (tests say less). */
  readonly runLimitMs?: number;
}

/** The deps for a file: its room, and its runner in the runner's script. */
export function agentDeps(env: Env, fileId: string): AgentDeps {
  const room = () => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
  const runner = env.AGENT_RUNNER;
  return {
    // The RPC stubs' types lose the unions' narrowing; the answers are as each side returns them.
    room: () => {
      const stub = room();
      return {
        admitAgentCall: async (request) =>
          (await stub.admitAgentCall(request)) as Awaited<
            ReturnType<AgentRoomApi["admitAgentCall"]>
          >,
        agentSource: async (request) =>
          (await stub.agentSource(request)) as Awaited<ReturnType<AgentRoomApi["agentSource"]>>,
        commitAgentRun: async (request) =>
          (await stub.commitAgentRun(request)) as CommitAgentAnswer,
        releaseAgentCall: (request) => stub.releaseAgentCall(request),
        renewAgentCall: (request) => stub.renewAgentCall(request),
        recordedAgentCall: async (request) =>
          (await stub.recordedAgentCall(request)) as AgentCallResult | null,
      };
    },
    runner: () => {
      if (!runner) throw new Error("This Worker has no AGENT_RUNNER binding.");
      // A new stub every time: one whose runner was reset fails every later call.
      const stub = runner.get(runner.idFromName(fileId));
      return {
        held: (id) => stub.held(id),
        run: async (request) => (await stub.run(request)) as AgentRunAnswer,
        committed: (note) => stub.committed(note),
        drop: (id) => stub.drop(id),
        reset: () => stub.reset(),
      };
    },
  };
}

/**
 * Whether agents can design here: the runner is bound and the tools aren't
 * turned off (the Workers Free plan, `AGENT_TOOLS=off`).
 */
export function agentToolsEnabled(env: Env): boolean {
  return env.AGENT_TOOLS !== "off" && env.AGENT_RUNNER !== undefined;
}

/** What agents are told when the tools that design are off. */
export const AGENT_TOOLS_OFF =
  "This instance runs on Cloudflare's Workers Free plan, so the tools that design (start_session, render and the rest) are off: they need the Workers Paid plan. Reading files works.";

/** The pauses before asking again about a call id another request holds, growing to the last. */
const BUSY_PAUSES_MS = [25, 50, 100, 200, 400, 800, 1000];

/**
 * Runs a write tool for a session and commits what it did as one
 * transaction. A repeated call id answers as recorded, and one still under
 * way elsewhere is waited for and then answers as it did, so concurrent
 * requests with one call id agree. Its claim on the call id is renewed
 * while it runs, and let go when it's answered, so a request that died
 * holds up another only for AGENT_CLAIM_MS. When someone changed a layer
 * in the run's scope while it ran (`stale`), it runs again on the file as
 * it is, after a pause, up to AGENT_ATTEMPTS times; it never commits a
 * stale run.
 */
export async function callWriteTool(
  deps: AgentDeps,
  call: {
    readonly by: AgentRequester;
    readonly session: AgentSessionRef;
    readonly callId: string;
    readonly tool: string;
    readonly input: unknown;
  },
): Promise<AgentCallResult> {
  const tool = findTool(call.tool);
  if (tool?.level !== "write") return { ok: false, message: `There's no write tool ${call.tool}.` };
  const { fileId } = call.session;
  const ids = { v: AGENT_RUNNER_V, fileId, sessionId: call.session.id, callId: call.callId };
  const admission = await admitWrite(deps, ids, await heldRevn(deps, fileId));
  if (!admission.admitted) return admission.answer;
  const claim = admission.claim;
  const renewing =
    claim === undefined
      ? undefined
      : setInterval(
          () =>
            void quietly(
              async () => void (await deps.room().renewAgentCall({ ...ids, claim })),
              "the room",
            ),
          AGENT_CLAIM_RENEW_MS,
        );
  try {
    const answer = await runAndCommit(deps, call, tool.title, admission.source);
    if (answer.ok) return answer;
    // A request with this call id that ran despite the claim (the room restarted meanwhile)
    // may have committed: its recorded answer is the call's.
    return (await deps.room().recordedAgentCall(ids)) ?? answer;
  } finally {
    clearInterval(renewing);
    if (claim !== undefined)
      await quietly(() => deps.room().releaseAgentCall({ ...ids, claim }), "the room");
  }
}

/** Admits a write, waiting out another request with the same call id until it's answered. */
async function admitWrite(
  deps: AgentDeps,
  ids: { v: number; fileId: string; sessionId: string; callId: string },
  from: number | null,
): Promise<Exclude<AgentAdmission, { busy: true }>> {
  const until = Date.now() + BUSY_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    const admission = await deps.room().admitAgentCall({ ...ids, from });
    if (!("busy" in admission)) return admission;
    // A claim its caller stopped renewing goes after AGENT_CLAIM_MS: a live one is waited for.
    if (Date.now() > until) return { admitted: false, answer: { ok: false, message: KEPT_BUSY } };
    await pause(BUSY_PAUSES_MS[Math.min(attempt, BUSY_PAUSES_MS.length - 1)] as number);
  }
}

async function runAndCommit(
  deps: AgentDeps,
  call: {
    readonly by: AgentRequester;
    readonly session: AgentSessionRef;
    readonly callId: string;
    readonly tool: string;
    readonly input: unknown;
  },
  label: string,
  first: AgentFileSource | undefined,
): Promise<AgentCallResult> {
  const { fileId } = call.session;
  for (let attempt = 0; attempt < AGENT_ATTEMPTS; attempt++) {
    if (attempt > 0) await pause(STALE_PAUSES_MS[attempt - 1] ?? 1_000);
    const run = await runOnFile(
      deps,
      { fileId, tool: call.tool, input: call.input },
      attempt === 0 ? first : undefined,
    );
    if (!run.ok) return run;
    let answer: CommitAgentAnswer;
    try {
      answer = await deps.room().commitAgentRun({
        v: AGENT_RUNNER_V,
        by: call.by,
        session: call.session,
        callId: call.callId,
        tool: call.tool,
        label,
        baseRevn: run.baseRevn,
        ops: run.ops,
        reads: run.reads,
        result: run.result,
      });
    } catch (error) {
      // Whether it landed isn't known: the runner's editor can't be trusted to show the file.
      await quietly(() => deps.runner().drop(fileId));
      throw error;
    }
    const landed = answer.ok && !answer.replayed ? answer.revn : null;
    await quietly(() =>
      deps.runner().committed(committedNote(fileId, run.runId, run.baseRevn, landed)),
    );
    if (!("stale" in answer)) return answer;
  }
  return { ok: false, message: KEPT_CHANGING };
}

/** Runs a read tool (get_jsx, export_image) on a file: nothing is committed or recorded. */
export async function callReadTool(
  deps: AgentDeps,
  call: { readonly fileId: string; readonly tool: string; readonly input: unknown },
): Promise<AgentCallResult> {
  const tool = findTool(call.tool);
  if (!tool || tool.level === "write")
    return { ok: false, message: `There's no read tool ${call.tool}.` };
  const admission = await deps.room().admitAgentCall({
    v: AGENT_RUNNER_V,
    fileId: call.fileId,
    from: await heldRevn(deps, call.fileId),
  });
  // A read has no call id, so nothing is ever busy for it.
  if (!admission.admitted)
    return "busy" in admission ? { ok: false, message: KEPT_BUSY } : admission.answer;
  const run = await runOnFile(deps, call, admission.source);
  if (!run.ok) return run;
  return {
    ok: true,
    revn: null,
    result: run.result,
    ...(run.image ? { image: run.image } : {}),
    replayed: false,
  };
}

/** The revision the runner's editor shows for the file; null when it's cold or doesn't answer. */
async function heldRevn(deps: AgentDeps, fileId: string): Promise<number | null> {
  try {
    const held = await deps.runner().held(fileId);
    return held.v === AGENT_RUNNER_V ? held.revn : null;
  } catch (error) {
    console.warn("the agent runner didn't say where it is", error);
    return null;
  }
}

/** A run's answer once it had a file it could use: a result, or a failure for the agent. */
type RunDone = Exclude<AgentRunAnswer, { again: true }>;

/**
 * Runs a tool on the file, each time on a fresh runner stub, with the file
 * as the room gives it (`first`, when admission brought it). A runner that
 * couldn't use what it got asks for it again, cold. A runner that ran out
 * of memory (or CPU) fails its call, and nothing was committed: that's the
 * agent's answer, and it isn't retried. A reset for an update is retried
 * once, with the file asked for again, since a stream is read only once.
 */
async function runOnFile(
  deps: AgentDeps,
  call: { readonly fileId: string; readonly tool: string; readonly input: unknown },
  first: AgentFileSource | undefined,
): Promise<RunDone> {
  const { fileId } = call;
  let source = first;
  let live = false;
  let reset = false;
  for (let tries = 0; tries < RUN_TRIES; tries++) {
    if (!source) {
      const from = tries === 0 ? await heldRevn(deps, fileId) : null;
      const got = await deps.room().agentSource({ v: AGENT_RUNNER_V, fileId, from, live });
      if (!got.ok) return { ok: false, message: DOWNLOADS_BUSY };
      source = got.source;
    }
    const request: AgentRunRequest = { v: AGENT_RUNNER_V, ...call, source };
    source = undefined;
    let run: AgentRunAnswer | "late";
    try {
      run = await withinLimit(deps.runner().run(request), deps.runLimitMs ?? AGENT_RUN_LIMIT_MS);
    } catch (error) {
      if (!reset && retryable(error)) {
        reset = true;
        continue;
      }
      if (outOfCpu(error)) return { ok: false, message: TOOK_TOO_LONG };
      if (aborted(error)) return { ok: false, message: RUNNER_ABORTED };
      throw error;
    }
    if (run === "late") {
      // Cut it off: it can't commit (it never does), but it would hold up the file's next calls.
      await quietly(() => deps.runner().reset(fileId));
      return { ok: false, message: TOOK_TOO_LONG };
    }
    if (run.ok || !("again" in run)) return run;
    live = run.live === true;
  }
  return { ok: false, message: OUT_OF_STEP };
}

/** The run's answer, or "late" when it hasn't come within `ms`. */
async function withinLimit<T>(run: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
    // A run answered after the limit, or failing then, is nobody's answer.
    run.catch(() => {});
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function committedNote(
  fileId: string,
  runId: string,
  baseRevn: number,
  revn: number | null,
): AgentCommittedNote {
  return { v: AGENT_RUNNER_V, fileId, runId, baseRevn, revn };
}

/**
 * Tells the runner something it may not hear: a runner reset after
 * answering (a WASM overrun is enforced after the call) has dropped its
 * editor anyway, which is what any failure here means.
 */
async function quietly(tell: () => Promise<void>, who = "the agent runner"): Promise<void> {
  try {
    await tell();
  } catch (error) {
    console.warn(`${who} didn't hear back`, error);
  }
}

type RemoteError = { overloaded?: unknown; durableObjectReset?: unknown; retryable?: unknown };

/** A runner isolate that went over its memory or CPU, or was reset: `overloaded` on Cloudflare. */
export function aborted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as RemoteError;
  return e.overloaded === true || e.durableObjectReset === true;
}

/** A runner that went over its CPU limit: the call took too long, rather than too much memory. */
function outOfCpu(error: unknown): boolean {
  return error instanceof Error && /\bCPU\b/i.test(error.message) && aborted(error);
}

/** A reset Cloudflare says to retry (a code update), not an overrun. */
function retryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as RemoteError).retryable === true &&
    (error as RemoteError).overloaded !== true
  );
}
