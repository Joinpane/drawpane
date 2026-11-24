/**
 * The agent runner's interface (decision 0033): what runs agent tools (the
 * headless editor, the text measurer, the renderer) and what the file's
 * room does for an agent call, as two separate APIs the main Worker calls
 * in turn (`call.ts`).
 *
 * Everything here is plain data (and, for a cold runner, a stream), so it
 * crosses RPC: the runner is a Durable Object in a script of its own
 * (`apps/agent-runner`), bound here as AGENT_RUNNER. The two scripts are
 * deployed one after the other, the runner first, so each side checks `v`
 * and the runner accepts every version in AGENT_RUNNER_ACCEPTS. Three rules
 * from step 0 (`0033-agent-runner-step0.md`) shape it:
 *
 * - A failed `committed` means the runner dropped its editor, never that the
 *   call failed: a runner can return a valid answer and be reset afterwards.
 * - A runner stub is dead after a reset, so the caller gets a new one for
 *   every call (`AgentDeps.runner` is a factory).
 * - The room never awaits the runner. The main Worker makes every call.
 */
import type { CopiesFormat, Op } from "@drawpane/model";

/**
 * The interface's version, sent with every request and note. 2 added
 * `reset`, `strike` and a run's `late` answer: a runner of version 1
 * refuses a request of version 2 (and the main Worker ignores its `held`),
 * so a main Worker deployed before its runner fails cleanly. 3 (protocol 4,
 * PR 286): a run refuses taking an instance's auto layout away and keeps
 * frozen frames as they are, which a runner from before doesn't, so the room
 * refuses a version 2 commit as out of step, and a runner from before
 * refuses a version 3 run.
 */
export const AGENT_RUNNER_V = 3;
/**
 * The versions the runner answers. A release that changes the interface
 * keeps the one before in this list, because the runner is deployed first
 * and must still understand the main Worker of one release back.
 */
export const AGENT_RUNNER_ACCEPTS: readonly number[] = [1, 2, 3];

/**
 * The most a run may take in the runner, timed by the runner from when it
 * starts the run (decision 0033, item 4.6), not from when it was asked:
 * calls on a file run one at a time, and waiting for the one before isn't
 * the run's time. The runner's own CPU limit is 60 s, so a run still going
 * past this is waiting on something: the runner answers `late`, and is
 * reset to cut the run off.
 */
export const AGENT_RUN_LIMIT_MS = 90_000;
/**
 * How long the main Worker waits for a run beyond its limit, for the calls
 * ahead of it on the file: with AGENT_RUN_LIMIT_MS, the most it waits.
 * Waiting that long is the runner being busy, not the call's fault: it's
 * answered RUNNER_BUSY, with no reset and no strike.
 */
export const AGENT_QUEUE_WAIT_MS = 90_000;
export const TOOK_TOO_LONG =
  "That call took too long, and nothing was changed. Try a smaller part.";
/** Why a runner was reset by the main Worker (`reset`): calls cut off with it are run again. */
export const RUNNER_CUT_OFF = "The agent runner was reset to cut off a call past its time limit.";

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

/**
 * The most ids a run's scope (`AgentReads`, and what the room makes of it)
 * may hold, and the most layers the room looks through to close it
 * (decision 0033). Past either, the run is taken to depend on the whole
 * file: any change since its base revision makes it run again.
 */
export const AGENT_SCOPE_CAP = 5_000;
export const AGENT_SCOPE_SCAN = 50_000;

/**
 * Where a write run read, as its runner's document recorded it (the tool
 * and the layout fix-ups it set off), less the layers it made. Only used
 * to find the run's scope (decision 0033): the top-level layers it worked
 * in, not each layer it read inside them, so a read a cache skipped
 * doesn't matter as long as something in the same top-level layer was
 * read or written.
 *
 * - `units`: the top-level layers (children of a page) it read in, and the
 *   pages and root-level records (variable collections, text styles) it
 *   read, as the runner's editor shows them after the run.
 * - `lists`: pages (or the root) whose list of layers it read.
 * - `absent`: ids it looked for that weren't there: one made meanwhile counts.
 *
 * Null when it read something the runner can't place (every layer), or
 * more than AGENT_SCOPE_CAP ids.
 */
export type AgentReads = {
  readonly units: readonly string[];
  readonly lists: readonly string[];
  readonly absent: readonly string[];
} | null;

/** A logged transaction, as the room keeps it: its revision and its operations' JSON. */
export interface AgentLoggedTxn {
  readonly revn: number;
  readonly ops: string;
}

/**
 * The file as the runner gets it for a run, at the room's revision `revn`
 * (decision 0033, "Getting the file"). The main Worker asks the room for it
 * (`AgentRoomApi.agentSource`, or with admission) and hands it over; the
 * runner never reads the room.
 *
 * - `log`: warm. What was logged after `from`, the revision the runner said
 *   its editor shows (`AgentRunnerApi.held`); none when it's `revn`.
 * - `snapshot`: cold. A version 2 snapshot at revision `at`: the latest saved
 *   version in R2 (`key`), or the file as it is streamed from the room
 *   (`body`, shared with downloads of that revision), then what was logged
 *   after `at`.
 *
 * `count` (the stored nodes at `revn`) and `copies` let the runner check
 * that what it built is the room's file.
 */
export type AgentFileSource = {
  readonly revn: number;
  readonly count: number;
  readonly copies: CopiesFormat;
} & (
  | { readonly kind: "log"; readonly from: number; readonly txns: readonly AgentLoggedTxn[] }
  | {
      readonly kind: "snapshot";
      readonly at: number;
      readonly key?: string;
      readonly body?: ReadableStream<Uint8Array>;
      readonly txns: readonly AgentLoggedTxn[];
    }
);

/**
 * What the main Worker asks for the file with: the revision the runner's
 * editor shows (null: cold), and `live` to skip the saved version (the
 * runner couldn't use it).
 */
export interface AgentSourceRequest {
  readonly v: number;
  readonly fileId: string;
  readonly from: number | null;
  readonly live?: boolean;
}

/** The source, or `busy` when as many people are downloading the file as the room serves at once. */
export type AgentSourceAnswer =
  | { readonly ok: true; readonly source: AgentFileSource }
  | { readonly ok: false; readonly busy: true };

export interface AgentRunRequest {
  readonly v: number;
  readonly fileId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly source: AgentFileSource;
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
      /** Where it read to make them: with its operations, its scope (`CommitAgentRun`). */
      readonly reads: AgentReads;
      readonly result: unknown;
      readonly image?: { readonly mimeType: string; readonly base64: string };
    }
  | {
      readonly ok: false;
      readonly message: string;
      /**
       * The run went past its limit (AGENT_RUN_LIMIT_MS) and may still be
       * running: reset the runner (`reset`) to cut it off.
       */
      readonly late?: true;
    }
  /**
   * The runner couldn't use the source (its editor moved on meanwhile, the
   * saved version didn't match, or it loaded fonts and has to build again):
   * ask the room again, cold (`from: null`), with `live` when said.
   */
  | { readonly ok: false; readonly again: true; readonly live?: boolean };

/**
 * A call that ran the runner out of memory, as the main Worker saw it fail
 * (`overloaded`, "exceeded its memory limit"), and when (`at`, ms since the
 * epoch): a strike against the call's tool and input.
 */
export interface AgentStrike {
  readonly v: number;
  readonly fileId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly at: number;
}

/** What the runner's editor shows for a file: the revision, or null when it's cold. */
export interface AgentHeld {
  readonly v: number;
  readonly revn: number | null;
}

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
  /** The revision its editor shows for the file, to ask the room for the log since. */
  held(fileId: string): Promise<AgentHeld>;
  /** Runs a tool on the file as `request.source` gives it. A tool's failure is an answer, not a throw. */
  run(request: AgentRunRequest): Promise<AgentRunAnswer>;
  /**
   * The commit of `runId` landed at `revn`, or didn't (null). Landed right
   * after the revision it ran on, the runner's editor carries on warm;
   * otherwise it's dropped. The caller ignores a failure here.
   */
  committed(note: AgentCommittedNote): Promise<void>;
  /** Lets go of everything held for the file: the next call starts cold. */
  drop(fileId: string): Promise<void>;
  /**
   * Resets the runner, cutting off a run still going past its limit (the
   * run answered `late`). Not a strike. The caller ignores a failure here.
   */
  reset(fileId: string): Promise<void>;
  /**
   * Records a strike against a call that ran the runner out of memory: only
   * the caller sees that error. The caller ignores a failure here.
   */
  strike(note: AgentStrike): Promise<void>;
}

// ---------------------------------------------------------------------------
// The room

export interface AgentAdmissionRequest {
  readonly v: number;
  readonly fileId: string;
  /** For a write: the session and call id, to answer a repeated id as recorded. */
  readonly sessionId?: string;
  readonly callId?: string;
  /** The revision the runner's editor shows (null: cold), so admission brings the source too. */
  readonly from?: number | null;
}

/**
 * Whether a call may run: refused (too large, or a replay) answers at once.
 * A write is admitted with a `claim` on its call id, held until it's
 * released (`releaseAgentCall`) or AGENT_CLAIM_MS passes without the
 * caller renewing it (`renewAgentCall`): meanwhile the same call id is
 * `busy`, and asked again after a pause it answers as the first one did.
 * Nothing else holds it up.
 */
export type AgentAdmission =
  | {
      readonly admitted: true;
      readonly revn: number;
      readonly claim?: string;
      /** The file for the first run, when `from` was given and the room could send it. */
      readonly source?: AgentFileSource;
    }
  | { readonly admitted: false; readonly busy: true }
  | { readonly admitted: false; readonly answer: AgentCallResult };

/**
 * How long a claim on a call id holds unless renewed: a caller that died
 * (and so stopped renewing) lets go after it. The caller renews every
 * AGENT_CLAIM_RENEW_MS while its request runs.
 */
export const AGENT_CLAIM_MS = 15_000;
export const AGENT_CLAIM_RENEW_MS = 5_000;

export interface AgentRelease {
  readonly v: number;
  readonly fileId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly claim: string;
}

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
  /** Where the run read (`AgentRunAnswer.reads`). */
  readonly reads: AgentReads;
  readonly result: unknown;
}

/**
 * The commit's answer. `stale`: after its base revision someone changed a
 * layer in the run's scope, so nothing was committed and the call should
 * run again on the file as it is now. The scope (`agent-scope.ts`): the
 * top-level layers the run read in or changed, the page's list of
 * top-level layers when it put one in or took one out (or read the list),
 * and the mains, styles and variables used inside any of those, with their
 * own top-level layers.
 */
export type CommitAgentAnswer =
  | AgentCallResult
  | { readonly ok: false; readonly stale: true; readonly message: string };

/** The room's part in an agent call: two short steps, neither of which waits on the runner. */
export interface AgentRoomApi {
  admitAgentCall(request: AgentAdmissionRequest): Promise<AgentAdmission>;
  /** The file for a run, from where the runner is (`AgentFileSource`). */
  agentSource(request: AgentSourceRequest): Promise<AgentSourceAnswer>;
  commitAgentRun(request: CommitAgentRun): Promise<CommitAgentAnswer>;
  /** Lets go of an admitted write's claim on its call id; a claim already gone is fine. */
  releaseAgentCall(request: AgentRelease): Promise<void>;
  /** Keeps an admitted write's claim for another AGENT_CLAIM_MS; false when it's gone. */
  renewAgentCall(request: AgentRelease): Promise<boolean>;
  /** What the ledger recorded for a session's call, as a replay; null when it didn't. */
  recordedAgentCall(request: {
    readonly v: number;
    readonly fileId: string;
    readonly sessionId: string;
    readonly callId: string;
  }): Promise<AgentCallResult | null>;
}
