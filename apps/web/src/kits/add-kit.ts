/**
 * Adding a kit to a team, in one go: download its file (through this
 * server, from where the registry says it's hosted), check it's the file the
 * registry lists, and import it with the Penpot importer into the team's
 * "Kits" project, with the kit's credit on its first page. Then the team
 * remembers it added the kit, for the store's "Added" badge.
 *
 * A kit lands in a "Kits" project (made the first time) rather than the
 * project you're looking at: kits are shared material, like libraries, and
 * keeping them together keeps Drafts and real projects tidy.
 */
import { ApiError, api, type Project } from "../api/client";
import { type FileImport, importPenpot } from "../dashboard/penpot-import";
import { withCredit } from "./credits";
import { creditLines, type Kit, verifyKitFile } from "./registry";

export const KITS_PROJECT = "Kits";

export type AddStage = "downloading" | "checking" | "importing" | "done" | "failed";

export interface KitAdd {
  readonly stage: AddStage;
  /** Bytes downloaded, and how many there are (null when the host doesn't say). */
  readonly received: number;
  readonly total: number | null;
  readonly files: readonly FileImport[];
  readonly projectId: string | null;
  readonly error: string | null;
}

export const ADD_START: KitAdd = {
  stage: "downloading",
  received: 0,
  total: null,
  files: [],
  projectId: null,
  error: null,
};

/** The team's Kits project, made if there isn't one. */
async function kitsProject(teamId: string): Promise<Project> {
  const { projects } = await api.projects(teamId);
  const existing = projects.find((p) => p.name === KITS_PROJECT);
  if (existing) return existing;
  const { project } = await api.post<{ project: Project }>(`/teams/${teamId}/projects`, {
    name: KITS_PROJECT,
  });
  return project;
}

/** Downloads a kit's file through this server, reporting bytes as they arrive. */
async function download(
  kit: Kit,
  onProgress: (received: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(`/api/kits/${encodeURIComponent(kit.id)}/file`, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    let message = "The kit's file couldn't be downloaded. Try again.";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not JSON: the sentence above.
    }
    throw new ApiError(response.status, "download", message);
  }
  const header = Number(response.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : (kit.file?.bytes ?? null);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function addKit(
  kit: Kit,
  teamId: string,
  onChange: (state: KitAdd) => void,
  signal?: AbortSignal,
): Promise<KitAdd> {
  let state = ADD_START;
  const set = (patch: Partial<KitAdd>) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  try {
    if (!kit.file) throw new Error("This kit has no file to add. Open its page to get it.");
    const file = kit.file;
    set({ total: file.bytes });
    const bytes = await download(kit, (received, total) => set({ received, total }), signal);
    set({ stage: "checking" });
    await verifyKitFile(bytes, file);
    const project = await kitsProject(teamId);
    set({ stage: "importing", projectId: project.id });
    const lines = creditLines(kit);
    const files = await importPenpot(bytes, project.id, (files) => set({ files }), {
      finish: (nodes) => withCredit(nodes, kit.name, lines),
    });
    const added = files.filter((f) => f.stage === "done" && f.fileId);
    if (added.length === 0)
      throw new Error(files.find((f) => f.error)?.error ?? "The kit couldn't be imported.");
    for (const f of added)
      await api.post(`/teams/${teamId}/kits`, { kitId: kit.id, fileId: f.fileId });
    set({ stage: "done", files });
  } catch (error) {
    set({
      stage: "failed",
      error:
        error instanceof DOMException && error.name === "AbortError"
          ? "Stopped."
          : error instanceof Error
            ? readable(error.message)
            : "The kit couldn't be added.",
    });
  }
  return state;
}

/** The Penpot reader's errors are written for a file someone chose; a kit's are the store's. */
function readable(message: string): string {
  return message.replace(/^That file isn't/, "This kit's file isn't");
}

/** Publishes a file that came from a kit as a team library (decision 0010). */
export function publishKitLibrary(fileId: string, kit: Kit) {
  return api.post(`/files/${fileId}/library/publish`, {
    description: `Added from the kit store: ${kit.name}`,
  });
}
