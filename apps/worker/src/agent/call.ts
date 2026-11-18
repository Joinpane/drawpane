/**
 * An agent call, as the main Worker makes it (decision 0033, item 2): the
 * room admits it, the runner runs the tool, the room commits what it made,
 * and the runner hears how that went. The room never calls the runner and
 * the runner never calls the room; everything goes through here.
 *
 * Today the runner is in-process, hosted by the file's room
 * (`agentDeps`); migration step 3 gives it a script of its own, and only
 * `agentDeps` changes.
 */
import { findTool } from "@drawpane/editor";
import type { Env } from "../env";
import {
  AGENT_CLAIM_RENEW_MS,
  AGENT_RUNNER_V,
  type AgentAdmission,
  type AgentCallResult,
  type AgentCommittedNote,
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

/**
 * Who the call talks to. Each is a factory, called again for every request:
 * a runner's stub is dead after its isolate resets, and a new one works.
 */
export interface AgentDeps {
  room(): AgentRoomApi;
  runner(): AgentRunnerApi;
}

/** The deps for a file: the room, and the runner it hosts in-process for now. */
export function agentDeps(env: Env, fileId: string): AgentDeps {
  const room = () => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
  return {
    // The RPC stub's types lose the unions' narrowing; the answers are as the room returns them.
    room: () => {
      const stub = room();
      return {
        admitAgentCall: async (request) =>
          (await stub.admitAgentCall(request)) as Awaited<
            ReturnType<AgentRoomApi["admitAgentCall"]>
          >,
        commitAgentRun: async (request) =>
          (await stub.commitAgentRun(request)) as CommitAgentAnswer,
        releaseAgentCall: (request) => stub.releaseAgentCall(request),
        renewAgentCall: (request) => stub.renewAgentCall(request),
        recordedAgentCall: async (request) =>
          (await stub.recordedAgentCall(request)) as AgentCallResult | null,
      };
    },
    runner: () => {
      const stub = room();
      return {
        run: async (request) => (await stub.runAgent(request)) as AgentRunAnswer,
        committed: (note) => stub.agentCommitted(note),
        drop: (id) => stub.dropAgent(id),
      };
    },
  };
}

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
  const admission = await admitWrite(deps, ids);
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
    const answer = await runAndCommit(deps, call, tool.title);
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
): Promise<Exclude<AgentAdmission, { busy: true }>> {
  const until = Date.now() + BUSY_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    const admission = await deps.room().admitAgentCall(ids);
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
): Promise<AgentCallResult> {
  const { fileId } = call.session;
  for (let attempt = 0; attempt < AGENT_ATTEMPTS; attempt++) {
    if (attempt > 0) await pause(STALE_PAUSES_MS[attempt - 1] ?? 1_000);
    const run = await runOnce(deps, {
      v: AGENT_RUNNER_V,
      fileId,
      tool: call.tool,
      input: call.input,
    });
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
  const admission = await deps.room().admitAgentCall({ v: AGENT_RUNNER_V, fileId: call.fileId });
  // A read has no call id, so nothing is ever busy for it.
  if (!admission.admitted)
    return "busy" in admission ? { ok: false, message: KEPT_BUSY } : admission.answer;
  const run = await runOnce(deps, {
    v: AGENT_RUNNER_V,
    fileId: call.fileId,
    tool: call.tool,
    input: call.input,
  });
  if (!run.ok) return run;
  return {
    ok: true,
    revn: null,
    result: run.result,
    ...(run.image ? { image: run.image } : {}),
    replayed: false,
  };
}

/**
 * One run on a fresh runner stub. A runner that ran out of memory (or CPU)
 * fails its call, and nothing was committed: that's the agent's answer,
 * and it isn't retried. A reset for an update is retried once.
 */
async function runOnce(deps: AgentDeps, request: AgentRunRequest): Promise<AgentRunAnswer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.runner().run(request);
    } catch (error) {
      if (attempt === 0 && retryable(error)) continue;
      if (aborted(error)) return { ok: false, message: RUNNER_ABORTED };
      throw error;
    }
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

/** A reset Cloudflare says to retry (a code update), not an overrun. */
function retryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as RemoteError).retryable === true &&
    (error as RemoteError).overloaded !== true
  );
}
