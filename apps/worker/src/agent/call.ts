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
  AGENT_RUNNER_V,
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

/** How often a call runs again because someone changed what it changed meanwhile, before giving up. */
export const AGENT_ATTEMPTS = 3;

export const RUNNER_ABORTED =
  "The agent runner ran out of memory on that call. Nothing was changed. Try a smaller part.";
export const KEPT_CHANGING = "The file kept changing while that ran. Try again.";

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

/**
 * Runs a write tool for a session and commits what it did as one
 * transaction. A repeated call id answers as recorded. When someone changed
 * the layers it changed while it ran (`stale`), it runs again on the file
 * as it is, up to AGENT_ATTEMPTS times.
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
  const admission = await deps
    .room()
    .admitAgentCall({ v: AGENT_RUNNER_V, fileId, sessionId: call.session.id, callId: call.callId });
  if (!admission.admitted) return admission.answer;
  for (let attempt = 0; attempt < AGENT_ATTEMPTS; attempt++) {
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
        label: tool.title,
        baseRevn: run.baseRevn,
        ops: run.ops,
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
  if (!admission.admitted) return admission.answer;
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
async function quietly(tell: () => Promise<void>): Promise<void> {
  try {
    await tell();
  } catch (error) {
    console.warn("the agent runner didn't hear back", error);
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
