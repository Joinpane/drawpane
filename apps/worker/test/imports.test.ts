import { env } from "cloudflare:test";
import { keyBetween, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { openSocket, signedInUser } from "./helpers";

async function newFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Imported" } },
  );
  return { ...owner, fileId: file.id };
}

const page = (id: string, name: string, key: string): NodeRecord => ({
  id,
  type: "page",
  parent: ROOT_ID,
  key,
  props: { name },
});
const rect = (id: string, parent: string, key = "a0"): NodeRecord => ({
  id,
  type: "rect",
  parent,
  key,
  props: { x: 10, y: 20, width: 100, height: 50 },
});

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

describe("importing into a new file", () => {
  it("replaces the starting page with the imported nodes", async () => {
    const { browser, fileId } = await newFile();
    // Children listed before their parents still land: the room orders them.
    const nodes = [rect("R1", "P1"), page("P1", "Cover", "a0"), page("P2", "Screens", "a1")];
    const result = await browser.json<{ nodes: number }>(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes },
    });
    expect(result.nodes).toBe(3);
    expect((await roomOf(fileId).stats()).nodes).toBe(3);

    // Someone opening it gets the imported pages, not the starting one.
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 1, clientId: "c1", revn: null });
    await socket.next("welcome");
    const got: NodeRecord[] = [];
    for (;;) {
      const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
      got.push(...chunk.nodes);
      if (chunk.done) break;
    }
    expect(got.filter((n) => n.type === "page").map((n) => n.props.name)).toEqual([
      "Cover",
      "Screens",
    ]);
  });

  it("only fills an empty file", async () => {
    const { browser, fileId } = await newFile();
    const json = { nodes: [page("P1", "Cover", "a0"), rect("R1", "P1")] };
    await browser.json(`/api/files/${fileId}/import`, { method: "POST", json });
    const again = await browser.fetch(`/api/files/${fileId}/import`, { method: "POST", json });
    expect(again.status).toBe(409);
  });

  it("checks everything first, leaving the file as it was when something's wrong", async () => {
    const { browser, fileId } = await newFile();
    const bad = { ...rect("R2", "P1", "a1"), props: { width: -5 } };
    const response = await browser.fetch(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes: [page("P1", "Cover", "a0"), rect("R1", "P1"), bad] },
    });
    expect(response.status).toBe(400);
    // Still just the starting page, so a corrected import can go ahead.
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
  });

  it("is for editors of the file", async () => {
    const { fileId } = await newFile();
    const stranger = await signedInUser("Bo");
    const response = await stranger.browser.fetch(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes: [page("P1", "Cover", "a0")] },
    });
    expect(response.status).toBe(404);
  });

  it("commits a large import in chunks", async () => {
    const { browser, fileId } = await newFile();
    const nodes: NodeRecord[] = [page("P1", "Big", "a0")];
    // About 3 MB of nodes (long path data): more than one log row can hold.
    const blob = `M0 0${" L1 1".repeat(200)}`;
    let key: string | null = null;
    for (let i = 0; i < 3000; i++) {
      key = keyBetween(key, null);
      nodes.push({
        id: `N${i}`,
        type: "path",
        parent: "P1",
        key,
        props: { x: i, width: 1, height: 1, pathData: blob },
      });
    }
    await browser.json(`/api/files/${fileId}/import`, { method: "POST", json: { nodes } });
    const stats = await roomOf(fileId).stats();
    expect(stats.nodes).toBe(3001);
    expect(stats.revn).toBeGreaterThan(2);
  });
});
