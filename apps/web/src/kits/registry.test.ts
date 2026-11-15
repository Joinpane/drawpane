import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  creditLines,
  formatBytes,
  gitBlobSha1,
  isLfsPointer,
  type Kit,
  LICENCE_UNSTATED,
  licenceOf,
  parseIndex,
  readKit,
  searchKits,
  verifyKitFile,
} from "./registry";

const penpot = {
  id: "penpot-lucide-icons",
  name: "Lucide Icons",
  provider: "penpot",
  kind: "icons",
  categories: ["Icon set", "Libraries"],
  description: "Lucide is an open-source SVG icon library.",
  author: { name: "Kemie Guaida" },
  source: {
    name: "Penpot's libraries and templates hub",
    page: "https://penpot.app/penpothub/libraries-templates/lucide-icons",
    repository: "https://github.com/penpot/penpot-files/blob/main/Lucide-icons.penpot",
  },
  licence: null,
  file: {
    url: "https://penpot.github.io/penpot-files/Lucide-icons.penpot",
    format: "penpot",
    bytes: 4,
    gitSha1: "0".repeat(40),
  },
  cover: "https://site-assets.example.com/lucide.webp",
  published: "2024-02-13",
  updated: "2025-06-06",
};

const hosted = {
  id: "material-3",
  name: "Material 3",
  provider: "drawpane",
  kind: "ui-kit",
  categories: ["Design system"],
  description: "Google's Material 3, converted.",
  author: { name: "Google", url: "https://m3.material.io" },
  source: { name: "Google", page: "https://www.figma.com/community/file/1", repository: null },
  licence: { spdx: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/", text: null },
  attribution: '"Material 3" by Google, CC BY 4.0. Converted to Drawpane from the original.',
  modified: true,
  file: { url: "kits/material-3/kit.penpot", format: "penpot", bytes: 10, sha256: "a".repeat(64) },
  cover: "kits/material-3/cover.png",
  published: "2026-11-15",
  updated: "2026-11-15",
};

describe("kit index", () => {
  it("reads both sources' entries", () => {
    const { kits, skipped } = parseIndex({ format: 1, kits: [penpot, hosted] });
    expect(skipped).toBe(0);
    expect(kits.map((k) => [k.id, k.provider, k.kind])).toEqual([
      ["penpot-lucide-icons", "penpot", "icons"],
      ["material-3", "drawpane", "ui-kit"],
    ]);
    const [lucide] = kits as [Kit];
    expect(lucide.author).toEqual({ name: "Kemie Guaida", url: null });
    expect(lucide.file?.gitSha1).toBe("0".repeat(40));
    expect(lucide.hasCover).toBe(true);
  });

  it("refuses something that isn't an index, or a newer format", () => {
    expect(() => parseIndex({ nope: [] })).toThrow(/format/);
    expect(() => parseIndex([])).toThrow(/format/);
    expect(() => parseIndex({ format: 2, kits: [] })).toThrow(/newer/);
  });

  it("leaves out entries that don't make sense, and duplicates", () => {
    const { kits, skipped } = parseIndex({
      kits: [
        penpot,
        penpot,
        { ...penpot, id: "" },
        { ...penpot, id: "x", provider: "elsewhere" },
        { ...penpot, id: "y", file: { url: "a.zip", format: "zip" } },
        null,
      ],
    });
    expect(kits).toHaveLength(1);
    expect(skipped).toBe(5);
  });

  it("passes Penpot entries through without a licence or a file", () => {
    const kit = readKit({ ...penpot, file: null, licence: null, kind: "something new" });
    expect(kit?.file).toBeNull();
    expect(kit?.licence).toBeNull();
    expect(kit?.kind).toBe("other");
  });

  it("holds kits hosted in the registry to its licence rules", () => {
    expect(readKit(hosted)).not.toBeNull();
    // Not an allowed licence.
    expect(readKit({ ...hosted, licence: { ...hosted.licence, spdx: "CC-BY-NC-4.0" } })).toBeNull();
    // No licence link, no attribution, no sha256, too big.
    expect(readKit({ ...hosted, licence: { spdx: "MIT" } })).toBeNull();
    expect(readKit({ ...hosted, attribution: "" })).toBeNull();
    expect(readKit({ ...hosted, file: { ...hosted.file, sha256: undefined } })).toBeNull();
    expect(readKit({ ...hosted, file: { ...hosted.file, bytes: 26 * 1024 * 1024 } })).toBeNull();
  });

  it("keeps only https links", () => {
    const kit = readKit({
      ...penpot,
      source: { page: "javascript:alert(1)", repository: "http://example.com" },
      author: { name: "A", url: "data:text/html,hi" },
    });
    expect(kit?.source.page).toBeNull();
    expect(kit?.source.repository).toBeNull();
    expect(kit?.author?.url).toBeNull();
  });
});

describe("kit licences", () => {
  it("says when Penpot's author didn't state one, and links the hub", () => {
    const kit = readKit(penpot) as Kit;
    expect(licenceOf(kit)).toEqual({
      kind: "unstated",
      label: LICENCE_UNSTATED,
      url: "https://penpot.app/penpothub/libraries-templates/lucide-icons",
    });
  });

  it("shows a Penpot LICENSE file as written", () => {
    const kit = readKit({
      ...penpot,
      licence: {
        text: "The MIT License (MIT)\n\nCopyright...",
        url: "https://github.com/x.LICENSE",
      },
    }) as Kit;
    expect(licenceOf(kit)).toMatchObject({
      kind: "file",
      text: "The MIT License (MIT)\n\nCopyright...",
      url: "https://github.com/x.LICENSE",
    });
  });

  it("names an SPDX licence", () => {
    expect(licenceOf(readKit(hosted) as Kit)).toEqual({
      kind: "spdx",
      label: "Creative Commons Attribution 4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    });
  });

  it("writes a credit with the source, licence and conversion", () => {
    const day = new Date("2026-11-15T12:00:00Z");
    expect(creditLines(readKit(penpot) as Kit, day)).toEqual([
      '"Lucide Icons" by Kemie Guaida.',
      "From Penpot's libraries and templates hub: https://penpot.app/penpothub/libraries-templates/lucide-icons",
      `${LICENCE_UNSTATED}: https://penpot.app/penpothub/libraries-templates/lucide-icons`,
      "Converted to Drawpane from https://penpot.github.io/penpot-files/Lucide-icons.penpot on 2026-11-15. Some parts may differ from the original.",
    ]);
    const lines = creditLines(readKit(hosted) as Kit, day);
    expect(lines[0]).toBe(hosted.attribution);
    expect(lines[2]).toBe(
      "Licence: Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/)",
    );
  });
});

describe("kit files", () => {
  const bytes = new TextEncoder().encode("PK\u0003\u0004 a penpot file");

  it("hashes like git does", async () => {
    // `git hash-object` of the same bytes.
    const expected = createHash("sha1")
      .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), Buffer.from(bytes)]))
      .digest("hex");
    expect(await gitBlobSha1(bytes)).toBe(expected);
    expect(await gitBlobSha1(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });

  it("accepts the listed file and refuses another", async () => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = {
      url: "x",
      format: "penpot",
      bytes: bytes.byteLength,
      sha256,
      gitSha1: null,
      container: "zip",
      importable: true,
    } as const;
    await expect(verifyKitFile(bytes, file)).resolves.toBeUndefined();
    await expect(verifyKitFile(bytes, { ...file, sha256: "b".repeat(64) })).rejects.toThrow(
      /isn't the one the store lists/,
    );
    await expect(verifyKitFile(bytes, { ...file, bytes: 3 })).rejects.toThrow(/isn't the one/);
    const gitSha1 = await gitBlobSha1(bytes);
    await expect(verifyKitFile(bytes, { ...file, sha256: null, gitSha1 })).resolves.toBeUndefined();
    await expect(
      verifyKitFile(bytes, { ...file, sha256: null, gitSha1: "c".repeat(40) }),
    ).rejects.toThrow(/isn't the one/);
    // Nothing to check against: taken as it comes (the importer still reads it as untrusted).
    await expect(
      verifyKitFile(bytes, { ...file, bytes: null, sha256: null }),
    ).resolves.toBeUndefined();
  });

  it("explains a Git LFS pointer instead of a file", async () => {
    const pointer = new TextEncoder().encode(
      "version https://git-lfs.github.com/spec/v1\noid sha256:04\nsize 156366965\n",
    );
    expect(isLfsPointer(pointer)).toBe(true);
    expect(isLfsPointer(bytes)).toBe(false);
    await expect(
      verifyKitFile(pointer, {
        url: "x",
        format: "penpot",
        bytes: null,
        sha256: null,
        gitSha1: null,
        container: null,
        importable: true,
      }),
    ).rejects.toThrow(/Git LFS/);
  });

  it("resolves a file against the index's URL, and knows what it can't import", () => {
    const base = "https://kits.example.com/registry/index.json";
    const relative = readKit(
      { ...hosted, file: { ...hosted.file, url: "kits/material-3/kit.penpot" } },
      base,
    );
    expect(relative?.file?.url).toBe(
      "https://kits.example.com/registry/kits/material-3/kit.penpot",
    );
    expect(readKit({ ...penpot, file: { ...penpot.file, url: "javascript:x" } }, base)).toBeNull();
    const old = readKit({ ...penpot, file: { ...penpot.file, container: "binfile-v1" } });
    expect(old?.file?.importable).toBe(false);
    const lfs = readKit({ ...penpot, file: { ...penpot.file, container: "lfs-pointer" } });
    expect(lfs?.file?.importable).toBe(false);
    expect(
      readKit({ ...penpot, file: { ...penpot.file, container: "zip" } })?.file?.importable,
    ).toBe(true);
    // Not known: try it.
    expect(readKit(penpot)?.file?.importable).toBe(true);
  });
});

describe("kit search", () => {
  it("matches every word over name, author and categories", () => {
    const kits = parseIndex({ kits: [penpot, hosted] }).kits;
    expect(searchKits(kits, "icon kemie").map((k) => k.id)).toEqual(["penpot-lucide-icons"]);
    expect(searchKits(kits, "design SYSTEM").map((k) => k.id)).toEqual(["material-3"]);
    expect(searchKits(kits, "  ")).toHaveLength(2);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(250_541)).toBe("245 KB");
    expect(formatBytes(1_886_654)).toBe("1.8 MB");
    expect(formatBytes(82_367_913)).toBe("79 MB");
  });
});
