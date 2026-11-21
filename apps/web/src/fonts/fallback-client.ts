import { SCRIPT_SLICE_BATCH_SIZE } from "@drawpane/model";

interface PendingSlice {
  readonly family: string;
  readonly slice: string;
  readonly resolve: (bytes: ArrayBuffer | null) => void;
}

const fallbackPauses = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

function retryAfter(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : 0;
  const backoff = fallbackPauses[Math.min(attempt, fallbackPauses.length - 1)] ?? 30_000;
  return Math.max(seconds, backoff);
}

/** The engine's shared queue combines neighbours and pauses all new slices on 429. */
export function fallbackSliceLoader(
  fetchBatch: typeof fetch = (...args) => fetch(...args),
): (family: string, slice: string) => Promise<ArrayBuffer | null> {
  const queue: PendingSlice[] = [];
  let active = false;

  async function drain(): Promise<void> {
    let attempt = 0;
    while (queue.length > 0) {
      const batch = queue.splice(0, SCRIPT_SLICE_BATCH_SIZE);
      try {
        const response = await fetchBatch("/api/fonts/fallback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch.map(({ family, slice }) => ({ family, slice }))),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 429) {
          queue.unshift(...batch);
          await new Promise((resume) => setTimeout(resume, retryAfter(response, attempt++)));
          continue;
        }
        attempt = 0;
        const form = response.ok ? await response.formData() : null;
        const bytes = await Promise.all(
          batch.map((_, index) => {
            const file = form?.get(String(index));
            return file instanceof Blob ? file.arrayBuffer() : null;
          }),
        );
        for (const [index, slice] of batch.entries()) slice.resolve(bytes[index] ?? null);
      } catch {
        for (const slice of batch) slice.resolve(null);
      }
    }
    active = false;
  }

  return (family, slice) =>
    new Promise((resolve) => {
      queue.push({ family, slice, resolve });
      if (active) return;
      active = true;
      queueMicrotask(() => void drain());
    });
}
