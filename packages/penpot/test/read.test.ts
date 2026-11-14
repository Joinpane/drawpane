import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPenpot } from "../src/read";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe("readPenpot", () => {
  it("reads every file, its pages and shapes, and the export's images", async () => {
    const exp = await readPenpot(fixture("svg-attrs-camel-case.penpot"));
    expect(exp.files).toHaveLength(1);
    const [file] = exp.files;
    expect(file?.name).toBe("New File 15");
    expect(file?.pages.map((p) => p.record.name)).toEqual(["Page 1"]);
    expect(file?.pages[0]?.shapes.has("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(exp.objects.size).toBeGreaterThan(0);
    const [object] = exp.objects.values();
    expect((await object?.entry?.read())?.byteLength).toBeGreaterThan(0);
  });

  it("reads a file and the library it uses", async () => {
    const exp = await readPenpot(fixture("file-with-library.penpot"));
    expect(exp.files).toHaveLength(2);
    expect(exp.files.some((f) => f.components.size > 0)).toBe(true);
  });

  it("explains an old binary export", async () => {
    await expect(readPenpot(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/older format/);
  });
});
