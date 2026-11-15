/**
 * The kit store's server side (decision 0022): the registry's index, covers
 * and files fetched through this origin, only for kits the index lists; the
 * file streamed and never cached; and which kits a team added.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KIT_REGISTRY, forgetKitIndex, registryUrl, resolveListed } from "../src/api/kits";
import { signedInUser } from "./helpers";

const INDEX = {
  format: 1,
  kits: [
    {
      id: "penpot-lucide-icons",
      name: "Lucide Icons",
      cover: "https://covers.example.com/lucide.webp",
      file: { url: "https://files.example.com/Lucide-icons.penpot" },
    },
    {
      id: "ours",
      name: "Ours",
      cover: "kits/ours/cover.png",
      file: { url: "kits/ours/kit.penpot" },
    },
    { id: "no-file", name: "No file", cover: null, file: null },
  ],
};
const BASE = DEFAULT_KIT_REGISTRY.replace(/index\.json$/, "");

/** The registry and the hosts it names, answering from memory; every URL asked is noted. */
function stubRegistry() {
  const asked: { url: string; cache?: string }[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const answer = (body: BodyInit, type: string) => {
      asked.push({ url, ...(init?.cache ? { cache: init.cache } : {}) });
      return new Response(body, { headers: { "content-type": type } });
    };
    if (url === DEFAULT_KIT_REGISTRY) return answer(JSON.stringify(INDEX), "application/json");
    if (url === "https://covers.example.com/lucide.webp") return answer("webp!", "image/webp");
    if (url === `${BASE}kits/ours/cover.png`) return answer("png!", "image/png");
    if (url === "https://files.example.com/Lucide-icons.penpot")
      return answer(new Uint8Array([80, 75, 3, 4]), "application/octet-stream");
    if (url === `${BASE}kits/ours/kit.penpot`) return answer("ours", "application/octet-stream");
    if (url.startsWith("https://")) throw new Error(`unexpected fetch ${url}`);
    return real(input, init);
  });
  return asked;
}

beforeEach(() => forgetKitIndex());
afterEach(() => vi.restoreAllMocks());

describe("kit registry", () => {
  it("is the default index unless configured, and off when told", () => {
    expect(registryUrl({})?.href).toBe(DEFAULT_KIT_REGISTRY);
    expect(registryUrl({ KIT_REGISTRY: "https://kits.example.com/i.json" })?.href).toBe(
      "https://kits.example.com/i.json",
    );
    expect(registryUrl({ KIT_REGISTRY: "off" })).toBeNull();
    expect(registryUrl({ KIT_REGISTRY: "file:///etc/passwd" })).toBeNull();
  });

  it("resolves an index's relative URLs against the index, and refuses other schemes", () => {
    const registry = new URL("https://kits.example.com/reg/index.json");
    expect(resolveListed(registry, "kits/a/cover.png")?.href).toBe(
      "https://kits.example.com/reg/kits/a/cover.png",
    );
    expect(resolveListed(registry, "data:text/plain,hi")).toBeNull();
    expect(resolveListed(registry, "javascript:alert(1)")).toBeNull();
  });

  it("serves the index to people who are signed in", async () => {
    stubRegistry();
    const { browser } = await signedInUser();
    const body = await browser.json<{ enabled: boolean; registry: string; index: typeof INDEX }>(
      "/api/kits",
    );
    expect(body.enabled).toBe(true);
    expect(body.registry).toBe(DEFAULT_KIT_REGISTRY);
    expect(body.index.kits.map((k) => k.id)).toEqual(["penpot-lucide-icons", "ours", "no-file"]);
  });

  it("says the store is off when the server turned it off", async () => {
    const asked = stubRegistry();
    const { browser } = await signedInUser();
    const configurable = env as { KIT_REGISTRY?: string };
    configurable.KIT_REGISTRY = "off";
    try {
      expect(await browser.json("/api/kits")).toEqual({ enabled: false });
      expect((await browser.fetch("/api/kits/ours/file")).status).toBe(404);
    } finally {
      delete configurable.KIT_REGISTRY;
    }
    expect(asked).toEqual([]);
  });

  it("fetches covers and files only for kits the index lists", async () => {
    const asked = stubRegistry();
    const { browser } = await signedInUser();
    const cover = await browser.fetch("/api/kits/penpot-lucide-icons/cover");
    expect(cover.headers.get("content-type")).toBe("image/webp");
    expect(new TextDecoder().decode(await cover.arrayBuffer())).toBe("webp!");
    const ours = await browser.fetch("/api/kits/ours/cover");
    expect(new TextDecoder().decode(await ours.arrayBuffer())).toBe("png!");

    const file = await browser.fetch("/api/kits/penpot-lucide-icons/file");
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
    // Straight from where it's hosted, past any cache.
    expect(asked.find((a) => a.url.endsWith("Lucide-icons.penpot"))?.cache).toBe("no-store");

    expect((await browser.fetch("/api/kits/not-listed/file")).status).toBe(404);
    expect((await browser.fetch("/api/kits/no-file/file")).status).toBe(404);
    expect((await browser.fetch("/api/kits/no-file/cover")).status).toBe(404);
  });

  it("refuses people who aren't signed in", async () => {
    stubRegistry();
    const { Browser } = await import("./helpers");
    const stranger = new Browser();
    expect((await stranger.fetch("/api/kits")).status).toBe(401);
    expect((await stranger.fetch("/api/kits/ours/file")).status).toBe(401);
  });
});

describe("kits a team added", () => {
  it("remembers a kit added as a file, until the file is trashed", async () => {
    const { browser, teamId, projectId } = await signedInUser();
    const { file } = await browser.json<{ file: { id: string } }>(
      `/api/projects/${projectId}/files`,
      { method: "POST", json: { name: "Lucide Icons" } },
    );
    expect((await browser.json<{ added: unknown[] }>(`/api/teams/${teamId}/kits`)).added).toEqual(
      [],
    );
    const response = await browser.fetch(`/api/teams/${teamId}/kits`, {
      method: "POST",
      json: { kitId: "penpot-lucide-icons", fileId: file.id },
    });
    expect(response.status).toBe(201);
    const { added } = await browser.json<{ added: { kitId: string; fileId: string }[] }>(
      `/api/teams/${teamId}/kits`,
    );
    expect(added).toMatchObject([{ kitId: "penpot-lucide-icons", fileId: file.id }]);

    await browser.json(`/api/files/${file.id}`, { method: "DELETE" });
    expect((await browser.json<{ added: unknown[] }>(`/api/teams/${teamId}/kits`)).added).toEqual(
      [],
    );
  });

  it("takes only the team's own files, and only from editors", async () => {
    const owner = await signedInUser();
    const other = await signedInUser("Bo");
    const { file } = await other.browser.json<{ file: { id: string } }>(
      `/api/projects/${other.projectId}/files`,
      { method: "POST", json: { name: "Theirs" } },
    );
    const wrong = await owner.browser.fetch(`/api/teams/${owner.teamId}/kits`, {
      method: "POST",
      json: { kitId: "k", fileId: file.id },
    });
    expect(wrong.status).toBe(400);

    const viewer = await signedInUser("Vi", "viewer", owner.teamId);
    const refused = await viewer.browser.fetch(`/api/teams/${owner.teamId}/kits`, {
      method: "POST",
      json: { kitId: "k", fileId: file.id },
    });
    expect(refused.status).toBe(403);
    expect((await viewer.browser.fetch(`/api/teams/${owner.teamId}/kits`)).status).toBe(200);
  });

  it("can publish a kit's file as a library straight after it's imported, unopened", async () => {
    const { browser, projectId } = await signedInUser();
    const { file } = await browser.json<{ file: { id: string } }>(
      `/api/projects/${projectId}/files`,
      { method: "POST", json: { name: "Showcase" } },
    );
    await browser.json(`/api/files/${file.id}/import`, {
      method: "POST",
      json: {
        nodes: [
          { id: "P1", type: "page", parent: "root", key: "a0", props: { name: "Kit" } },
          {
            id: "C1",
            type: "frame",
            parent: "P1",
            key: "a0",
            props: { name: "Button", x: 0, y: 0, width: 120, height: 40, isComponent: true },
          },
        ],
      },
    });
    const { publish } = await browser.json<{ publish: { assets: { name: string }[] } }>(
      `/api/files/${file.id}/library/publish`,
      { method: "POST", json: { description: "Added from the kit store: Showcase" } },
    );
    expect(publish.assets.map((a) => a.name)).toEqual(["Button"]);
  });
});
