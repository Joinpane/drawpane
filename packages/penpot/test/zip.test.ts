import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readZip } from "../src/zip";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe("readZip", () => {
  it("lists an export's entries and inflates them on demand", async () => {
    const entries = readZip(fixture("file-with-library.penpot"));
    expect([...entries.keys()]).toContain("manifest.json");
    const manifest = JSON.parse(
      new TextDecoder().decode(await entries.get("manifest.json")?.read()),
    );
    expect(manifest.type).toBe("penpot/export-files");
    expect(manifest.files).toHaveLength(2);
  });

  it("refuses something that isn't a zip", () => {
    expect(() => readZip(new TextEncoder().encode("not a zip at all, not even close"))).toThrow(
      /readable .penpot/,
    );
  });
});
