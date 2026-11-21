import { expect, it, vi } from "vitest";
import { fallbackSliceLoader } from "./fallback-client";

it("batches slices and retries a rate-limited batch after Retry-After", async () => {
  vi.useFakeTimers();
  try {
    const batch = [
      { family: "Noto Sans JP", slice: "3000" },
      { family: "Noto Sans TC", slice: "4e00" },
    ];
    const form = new FormData();
    form.set("1", new Blob(["face"]), "slice.ttf");
    const fetchBatch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(new Response(form));
    const load = fallbackSliceLoader(fetchBatch);
    const result = Promise.all(batch.map(({ family, slice }) => load(family, slice)));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    const first = fetchBatch.mock.calls[0];
    expect(JSON.parse(String(first?.[1]?.body))).toEqual(batch);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
    const [missing, found] = await result;
    expect(missing).toBeNull();
    expect(new TextDecoder().decode(found ?? undefined)).toBe("face");
  } finally {
    vi.useRealTimers();
  }
});
