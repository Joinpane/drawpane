/**
 * Reading a whole Figma file through its REST API, however large.
 *
 * One request for the whole file is cheapest, so that comes first. Figma
 * refuses a file too large to send in one response ("Request too large",
 * a 400, after it has worked on it for most of a minute). Then the file is
 * read in parts: an outline of its pages and their top-level layers, then
 * each page on its own, and a page still too large in halves of its
 * top-level layers, down to single layers. The parts are put back together
 * as the one file Figma would have sent.
 *
 * Every request counts against Figma's limits on reading files, which on its
 * free plan are a few a month, so nothing is read twice and nothing retries
 * by itself, except after a short wait Figma names (`Retry-After`).
 */
import type { Figma } from "@drawpane/figma";

/** What Figma's API said, in words someone importing can act on. */
export class FigmaError extends Error {
  /** Figma couldn't send that much in one response, or the browser couldn't read it: ask for less. */
  readonly tooLarge: boolean;

  constructor(
    message: string,
    readonly status: number,
    /** Figma's own reason, when it gave one. */
    readonly reason: string | null = null,
    tooLarge?: boolean,
  ) {
    super(message);
    this.tooLarge =
      tooLarge ??
      ((status === 400 || status === 413 || status === 504) &&
        /too large|too big|timeout|timed out|smaller request/i.test(reason ?? ""));
  }

  /** Figma asked for a wait short enough to sit out (in seconds), or null. */
  retryAfter: number | null = null;
}

/** Figma's reason for a refusal: `err` on most endpoints, `message` on newer ones. */
async function reasonOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { err?: unknown; message?: unknown };
    const text = typeof body.err === "string" ? body.err : body.message;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

export async function figmaError(response: Response): Promise<FigmaError> {
  const reason = await reasonOf(response);
  const status = response.status;
  if (status === 403)
    return new FigmaError(
      "Figma turned the token away. Check it's still valid and can read file content.",
      status,
      reason,
    );
  if (status === 404)
    return new FigmaError(
      "Figma has no file at that link, or the token's account can't open it.",
      status,
      reason,
    );
  if (status === 429) {
    const wait = Number(response.headers.get("Retry-After") ?? "");
    const plan = response.headers.get("X-Figma-Plan-Tier");
    const when =
      Number.isFinite(wait) && wait > 0 ? ` Try again in ${duration(wait)}.` : " Try again later.";
    const error = new FigmaError(
      `Figma's limit on reading files was reached${plan === "starter" ? " (files on Figma's free plan can be read only a few times a month)" : ""}.${when}`,
      status,
      reason,
    );
    if (Number.isFinite(wait) && wait > 0) error.retryAfter = wait;
    return error;
  }
  if (reason)
    return new FigmaError(`Figma couldn't send the file: ${sentence(reason)}`, status, reason);
  return new FigmaError(`Figma couldn't send the file (${status}). Try again.`, status, reason);
}

/**
 * The most of one reply read as a whole. A browser can't hold a string much
 * longer than 512 MB (Chrome's `response.json()` then fails with "Unexpected
 * end of JSON input"), and parsing one near that size takes gigabytes. A
 * reply past this is read in smaller parts instead.
 */
export const LONGEST_REPLY = 384 * 1024 * 1024;

/**
 * A successful reply's JSON, read as it arrives so one too large to parse is
 * let go as soon as it's known to be, not after it has all downloaded.
 */
export async function figmaJson<T>(response: Response, limit = LONGEST_REPLY): Promise<T> {
  const tooLarge = () =>
    new FigmaError(
      "Figma's reply is too large to read in this browser.",
      response.status,
      null,
      true,
    );
  const declared = Number(response.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader?.cancel().catch(() => undefined);
        throw tooLarge();
      }
      parts.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof FigmaError) throw error;
    throw new FigmaError(
      "The connection to Figma dropped while the file was coming in. Try again.",
      response.status,
    );
  }
  const text = await new Blob(parts as BlobPart[]).text();
  parts.length = 0;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FigmaError("Figma's reply came in cut short. Try again.", response.status);
  }
}

/** A wait in words: "40 seconds", "3 minutes", "about 5 hours", "about 2 days". */
function duration(seconds: number): string {
  const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (seconds < 60) return n(Math.ceil(seconds), "second");
  if (seconds <= 3600) return n(Math.ceil(seconds / 60), "minute");
  if (seconds <= 48 * 3600) return `about ${n(Math.ceil(seconds / 3600), "hour")}`;
  return `about ${n(Math.ceil(seconds / 86400), "day")}`;
}

/** Figma's reason as a sentence. */
function sentence(text: string): string {
  const t = text.replace(/\s+/g, " ");
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** GETs a path under Figma's API and parses it; throws a FigmaError on a refusal. */
export type FigmaGet = (path: string) => Promise<unknown>;

/** Waits; replaced in tests. */
export type Sleep = (seconds: number) => Promise<void>;

/** The longest wait Figma can ask for that's worth sitting out instead of failing. */
const LONGEST_WAIT = 90;

export interface ReadProgress {
  /** Parts read so far, and how many there are (it grows when a part is split). */
  readonly done: number;
  readonly total: number;
  /** Seconds left of a wait Figma asked for, or 0. */
  readonly waiting: number;
}

interface NodesResponse {
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly document: Figma.Node;
        readonly components?: Figma.File["components"];
        readonly componentSets?: Figma.File["componentSets"];
        readonly styles?: Figma.File["styles"];
      } | null
    >
  >;
}

/** A part to read: a whole page, or some of its top-level layers. */
interface Part {
  readonly page: Figma.Node;
  readonly ids: readonly string[];
}

/** Most ids in one request, so its address stays short. */
const MOST_IDS = 100;

/** Layers under a node, itself not counted. */
function layersUnder(node: Figma.Node): number {
  let n = 0;
  const stack = [...(node.children ?? [])];
  for (let at = stack.pop(); at; at = stack.pop()) {
    n++;
    if (at.children) stack.push(...at.children);
  }
  return n;
}

/** The file has more layers than one Drawpane file holds; its .fig can be imported in part. */
export function tooManyLayers(most: number): FigmaError {
  return new FigmaError(
    `This file has more than ${most.toLocaleString("en")} layers, more than one Drawpane file holds. In Figma, choose File → Save local copy and drop the .fig file here to choose which pages to import.`,
    200,
  );
}

/**
 * Reads the whole file; `maxLayers`: stops, and throws `tooManyLayers`, as soon as it has more
 * (pages not counted), so a file too large to import isn't read to the end.
 */
export async function readFigmaFile(
  key: string,
  get: FigmaGet,
  onProgress: (progress: ReadProgress) => void = () => undefined,
  sleep: Sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)),
  maxLayers = Number.POSITIVE_INFINITY,
): Promise<Figma.File> {
  let layers = 0;
  const counted = (node: Figma.Node, self: boolean) => {
    layers += layersUnder(node) + (self ? 1 : 0);
    if (layers > maxLayers) throw tooManyLayers(maxLayers);
  };
  let done = 0;
  let total = 1;
  const report = (waiting = 0) => onProgress({ done, total, waiting });
  const read = async <T>(path: string): Promise<T> => {
    for (;;) {
      try {
        return (await get(path)) as T;
      } catch (error) {
        const wait = error instanceof FigmaError ? error.retryAfter : null;
        if (wait === null || wait > LONGEST_WAIT) throw error;
        for (let left = Math.ceil(wait); left > 0; left--) {
          report(left);
          await sleep(1);
        }
        report();
      }
    }
  };
  const tooLarge = (error: unknown) => error instanceof FigmaError && error.tooLarge;

  report();
  let whole: Figma.File | null = null;
  try {
    whole = await read<Figma.File>(`files/${key}?geometry=paths`);
  } catch (error) {
    if (!tooLarge(error)) throw error;
  }
  if (whole) {
    for (const page of whole.document.children ?? []) counted(page, false);
    done = 1;
    report();
    return whole;
  }

  // The outline: pages and the layers at their top.
  const outline = await read<Figma.File>(`files/${key}?depth=2`);
  const pages = outline.document.children ?? [];
  const queue: Part[] = pages.map((page) => ({ page, ids: [page.id] }));
  done = 1;
  total = 1 + queue.length;
  report();

  const wholePages = new Map<string, Figma.Node>();
  const partLayers = new Map<string, Figma.Node>();
  const components: Record<string, NonNullable<Figma.File["components"]>[string]> = {
    ...outline.components,
  };
  const componentSets: Record<string, NonNullable<Figma.File["componentSets"]>[string]> = {
    ...outline.componentSets,
  };
  const styles: Record<string, NonNullable<Figma.File["styles"]>[string]> = {
    ...outline.styles,
  };

  for (let part = queue.shift(); part; part = queue.shift()) {
    const { page, ids } = part;
    const wholePage = ids.length === 1 && ids[0] === page.id;
    let response: NodesResponse;
    try {
      response = await read<NodesResponse>(
        `files/${key}/nodes?ids=${ids.map(encodeURIComponent).join(",")}&geometry=paths`,
      );
    } catch (error) {
      if (!tooLarge(error)) throw error;
      // Smaller parts, read next, in the same order.
      const split = wholePage
        ? chunks(
            (page.children ?? []).map((c) => c.id),
            MOST_IDS,
          )
        : ids.length > 1
          ? halves(ids)
          : null;
      if (!split || split.length === 0) {
        const layer = page.children?.find((c) => c.id === ids[0]);
        throw new FigmaError(
          `"${layer?.name ?? page.name}" is too large for Figma to send through its API, even on its own.`,
          (error as FigmaError).status,
          (error as FigmaError).reason,
        );
      }
      queue.unshift(...split.map((part) => ({ page, ids: part })));
      total += split.length - 1;
      report();
      continue;
    }
    for (const [id, entry] of Object.entries(response.nodes)) {
      if (!entry) continue;
      counted(entry.document, !wholePage);
      if (wholePage) wholePages.set(id, entry.document);
      else partLayers.set(id, entry.document);
      Object.assign(components, entry.components);
      Object.assign(componentSets, entry.componentSets);
      Object.assign(styles, entry.styles);
    }
    done++;
    report();
  }

  const document: Figma.Node = {
    ...outline.document,
    children: pages.map(
      (page) =>
        wholePages.get(page.id) ?? {
          ...page,
          children: (page.children ?? [])
            .map((layer) => partLayers.get(layer.id))
            .filter((layer): layer is Figma.Node => layer !== undefined),
        },
    ),
  };
  return { ...outline, document, components, componentSets, styles };
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  // Halves first (a page that was too large is likely too large in big parts too).
  const first = Math.min(size, Math.max(1, Math.ceil(list.length / 2)));
  for (let i = 0; i < list.length; i += first) out.push(list.slice(i, i + first));
  return out;
}

function halves<T>(list: readonly T[]): T[][] {
  const mid = Math.ceil(list.length / 2);
  return [list.slice(0, mid), list.slice(mid)];
}
