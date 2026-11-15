/**
 * A kit registry served locally for the kit store's specs and tour: an
 * index.json with a few entries in the registry's shapes (Penpot's hub, a
 * kit hosted in the registry), their covers, and a real .penpot export as
 * the kit file. The test Worker is pointed at it (E2E_KIT_REGISTRY), so
 * nothing reaches GitHub or Penpot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const showcase = readFileSync(
  resolve(import.meta.dirname, "../../../packages/penpot/test/fixtures/showcase.penpot"),
);
const gitSha1 = (bytes: Buffer) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest("hex");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A PNG of horizontal bands, `width` × `height`, for a cover. */
function bands(width: number, height: number, colors: readonly [number, number, number][]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const [r, g, b] = colors[Math.floor((y / height) * colors.length)] ?? [255, 255, 255];
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(bytes: Buffer): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

export const KIT_LICENCE_TEXT =
  "The MIT License (MIT)\n\nCopyright (c) 2026 Studio Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.";

/** The fixture's index, as the registry's generator writes it. */
export function kitIndex() {
  const penpot = (id: string, extra: Record<string, unknown>) => ({
    id,
    provider: "penpot",
    categories: [],
    description: null,
    author: null,
    source: {
      name: "Penpot's libraries and templates hub",
      page: `https://penpot.app/penpothub/libraries-templates/${id}`,
      repository: null,
    },
    licence: null,
    cover: null,
    published: "2025-02-13",
    updated: "2025-06-06",
    ...extra,
  });
  return {
    format: 1,
    kits: [
      penpot("penpot-showcase", {
        name: "Showcase Kit",
        kind: "ui-kit",
        categories: ["Design system", "Libraries", "UI kits"],
        description: "Cards, buttons and a colour palette, built with flex layout and components.",
        author: { name: "Ana Example" },
        cover: "covers/showcase.png",
        file: {
          url: "files/showcase.penpot",
          format: "penpot",
          bytes: showcase.byteLength,
          gitSha1: gitSha1(showcase),
        },
      }),
      penpot("penpot-icons", {
        name: "Example Icons",
        kind: "icons",
        categories: ["Icon set", "Libraries"],
        description: "A small icon set.",
        author: { name: "Studio Example" },
        cover: "covers/icons.png",
        licence: { text: KIT_LICENCE_TEXT, url: "https://github.com/example/icons.LICENSE" },
        file: {
          url: "files/showcase.penpot",
          format: "penpot",
          bytes: showcase.byteLength,
          gitSha1: gitSha1(showcase),
        },
      }),
      penpot("penpot-changed", {
        name: "Changed Since Listed",
        kind: "template",
        categories: ["Templates"],
        author: { name: "Someone" },
        file: {
          url: "files/showcase.penpot",
          format: "penpot",
          bytes: 99,
          gitSha1: "0".repeat(40),
        },
      }),
      penpot("penpot-old-format", {
        name: "Older Format Icons",
        kind: "icons",
        categories: ["Icon set"],
        file: {
          url: "files/old.penpot",
          format: "penpot",
          bytes: 143229,
          gitSha1: "1".repeat(40),
          container: "binfile-v1",
        },
      }),
      penpot("penpot-pull-request", {
        name: "Waiting For Its File",
        kind: "template",
        categories: ["Templates"],
        file: null,
      }),
      {
        id: "starter-system",
        name: "Starter System",
        provider: "drawpane",
        kind: "library",
        categories: ["Design system"],
        description: "A starter design system, converted for Drawpane.",
        author: { name: "Drawpane", url: "https://example.com/drawpane" },
        source: { name: "Drawpane", page: "https://example.com/starter", repository: null },
        licence: {
          spdx: "CC-BY-4.0",
          url: "https://creativecommons.org/licenses/by/4.0/",
          text: null,
        },
        attribution:
          '"Starter System" by Drawpane, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Converted to Drawpane from the original.',
        modified: true,
        file: {
          url: "files/showcase.penpot",
          format: "penpot",
          bytes: showcase.byteLength,
          sha256: sha256(showcase),
        },
        cover: "covers/starter.png",
        published: "2026-11-15",
        updated: "2026-11-15",
      },
    ],
  };
}

const COVERS: Record<string, [number, number, number][]> = {
  "covers/showcase.png": [
    [251, 250, 248],
    [232, 89, 12],
    [253, 232, 220],
    [28, 27, 26],
  ],
  "covers/icons.png": [
    [15, 118, 110],
    [204, 251, 241],
    [15, 118, 110],
  ],
  "covers/starter.png": [
    [30, 64, 175],
    [219, 234, 254],
    [251, 250, 248],
  ],
};

export interface KitRegistry {
  readonly url: string;
  /** Paths asked for, in order. */
  readonly asked: string[];
  stop(): Promise<void>;
}

/** Serves the fixture registry on a free port. */
export async function serveKitRegistry(): Promise<KitRegistry> {
  const asked: string[] = [];
  const covers = new Map(Object.entries(COVERS).map(([path, c]) => [path, bands(278, 145, c)]));
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\//, "").split("?")[0] ?? "";
    asked.push(path);
    if (path === "index.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(kitIndex()));
    } else if (path === "files/showcase.penpot") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": showcase.byteLength,
      });
      res.end(showcase);
    } else if (covers.has(path)) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(covers.get(path));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/index.json`,
    asked,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
