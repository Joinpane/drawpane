/**
 * The agent runner's interface (decision 0033): what runs agent tools (the
 * headless editor, the text measurer, the renderer) and what the file's
 * room does for an agent call, as two separate APIs the main Worker calls
 * in turn (`call.ts`).
 *
 * Everything here is plain data, so it can cross RPC. Today the runner is
 * implemented in-process, hosted by the room (`runner.ts`); migration step 3
 * moves it into a script of its own behind the same interface. Three rules
 * from step 0 (`0033-agent-runner-step0.md`) shape it:
 *
 * - A failed `committed` means the runner dropped its editor, never that the
 *   call failed: a runner can return a valid answer and be reset afterwards.
 * - A runner stub is dead after a reset, so the caller gets a new one for
 *   every call (`AgentDeps.runner` is a factory).
 * - The room never awaits the runner. The main Worker makes every call.
 */
import type { Op } from "@drawpane/model";

/** The runner's RPC version: the main Worker of one release back must still be understood. */
export const AGENT_RUNNER_V = 1;

/** An agent session writing to a file (decision 0021), checked by the Worker. */
export interface AgentSessionRef {
  readonly id: string;
  /** "Claude, for Ana". */
  readonly name: string;
  /** The file it writes to: the session's target. */
  readonly fileId: string;
}

/** The person an agent works for, as the room is told. */
export interface AgentRequester {
  readonly userId: string;
  readonly name: string;
}

/** What an agent call answers. A failure is worded for the model and committed nothing. */
export type AgentCallResult =
  | {
      readonly ok: true;
      /** The revision it committed; null when it changed nothing. */
      readonly revn: number | null;
      readonly result: unknown;
      /** A picture the tool answered with (export_image), for the model to see. */
      readonly image?: { readonly mimeType: string; readonly base64: string };
      /** True when the call id was seen before: this is the recorded answer, and nothing ran. */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// The runner

export interface AgentRunRequest {
  readonly v: number;
  readonly fileId: string;
  readonly tool: string;
  readonly input: unknown;
}

export type AgentRunAnswer =
  | {
      readonly ok: true;
      /**
       * Names this run, for `committed`. Its editor holds the run's changes
       * until it hears how the commit went.
       */
      readonly runId: string;
      /** The room revision the tool ran on. */
      readonly baseRevn: number;
      /** What the tool changed, fix-ups included, as stored: empty for a read. */
      readonly ops: Op[];
      readonly result: unknown;
      readonly image?: { readonly mimeType: string; readonly base64: string };
    }
  | { readonly ok: false; readonly message: string };

/** How the commit of a run went: `revn` is where it landed, or null when it didn't. */
export interface AgentCommittedNote {
  readonly v: number;
  readonly fileId: string;
  readonly runId: string;
  readonly baseRevn: number;
  readonly revn: number | null;
}

/**
 * Runs agent tools on a file. Calls on one file are answered one at a
 * time in the order made. The runner never commits and never calls the
 * room: what it changed goes back to the caller, which hands it to the
 * room (`AgentRoomApi.commitAgentRun`) and says how that went.
 */
export interface AgentRunnerApi {
  /** Runs a tool on the file as the runner gets it. A tool's failure is an answer, not a throw. */
  run(request: AgentRunRequest): Promise<AgentRunAnswer>;
  /**
   * The commit of `runId` landed at `revn`, or didn't (null). Landed right
   * after the revision it ran on, the runner's editor carries on warm;
   * otherwise it's dropped. The caller ignores a failure here.
   */
  committed(note: AgentCommittedNote): Promise<void>;
  /** Lets go of everything held for the file: the next call starts cold. */
  drop(fileId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The room

export interface AgentAdmissionRequest {
  readonly v: number;
  readonly fileId: string;
  /** For a write: the session and call id, to answer a repeated id as recorded. */
  readonly sessionId?: string;
  readonly callId?: string;
}

/** Whether a call may run: refused (too large, or a replay) answers at once. */
export type AgentAdmission =
  | { readonly admitted: true; readonly revn: number }
  | { readonly admitted: false; readonly answer: AgentCallResult };

export interface CommitAgentRun {
  readonly v: number;
  readonly by: AgentRequester;
  readonly session: AgentSessionRef;
  readonly callId: string;
  /** The tool's name and its title, as the change is labelled. */
  readonly tool: string;
  readonly label: string;
  /** The revision the run's changes were made on. */
  readonly baseRevn: number;
  readonly ops: Op[];
  readonly result: unknown;
}

/**
 * The commit's answer. `stale`: someone changed a layer the run changed
 * (or put a layer inside one) after its base revision, so nothing was
 * committed and the call should run again on the file as it is now.
 */
export type CommitAgentAnswer =
  | AgentCallResult
  | { readonly ok: false; readonly stale: true; readonly message: string };

/** The room's part in an agent call: two short steps, neither of which waits on the runner. */
export interface AgentRoomApi {
  admitAgentCall(request: AgentAdmissionRequest): Promise<AgentAdmission>;
  commitAgentRun(request: CommitAgentRun): Promise<CommitAgentAnswer>;
}
