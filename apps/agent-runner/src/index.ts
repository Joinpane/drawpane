/**
 * The agent runner's Worker (decision 0033): the `AgentRunner` Durable
 * Object, one per file (`idFromName(fileId)`), which runs agent tools with
 * the headless editor, HarfBuzz and resvg, in isolates of this script's own.
 * When a call runs out of memory, this isolate is reset and the main
 * Worker's call fails; the file's room, in the main Worker's script, never
 * notices (step 0, `0033-agent-runner-step0.md`).
 *
 * Only the main Worker calls it, through its AGENT_RUNNER binding
 * (`script_name`), with a new stub for every call. It has no route.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  AgentCommittedNote,
  AgentHeld,
  AgentRunAnswer,
  AgentRunRequest,
} from "@drawpane/worker/src/agent/runner-api";
import type { Env } from "./env";
import { FileRunner } from "./runner";

export class AgentRunner extends DurableObject<Env> {
  #runner: FileRunner | null = null;

  /** The file's runner. A runner is named for its file, so it only ever sees one. */
  #for(fileId: string): FileRunner {
    this.#runner ??= new FileRunner(this.env, fileId);
    return this.#runner;
  }

  async held(fileId: string): Promise<AgentHeld> {
    return this.#for(fileId).held(fileId);
  }

  async run(request: AgentRunRequest): Promise<AgentRunAnswer> {
    return this.#for(request.fileId).run(request);
  }

  async committed(note: AgentCommittedNote): Promise<void> {
    await this.#runner?.committed(note);
  }

  async drop(fileId: string): Promise<void> {
    await this.#runner?.drop(fileId);
  }

  /** What tests check about warmth: the revision held and how many cold builds there were. */
  async stats(): Promise<{ revn: number | null; builds: number }> {
    const held = this.#runner ? await this.#runner.held("") : null;
    return { revn: held?.revn ?? null, builds: this.#runner?.builds ?? 0 };
  }
}

/** Nothing answers here: the runner is reached only through the main Worker's binding. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
