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

  it("refuses compact copies' override records until rooms store them (decision 0029)", async () => {
    const { browser, fileId } = await newFile();
    const main = { id: "M1", type: "frame", parent: "P1", key: "a0", props: { isComponent: true } };
    const copy = { id: "I1", type: "frame", parent: "P1", key: "a1", props: { instanceOf: "M1" } };
    const record = { id: "O1", type: "override", parent: "I1", key: "a0", props: { path: ["X1"] } };
    const response = await browser.fetch(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes: [page("P1", "Cover", "a0"), main, copy, record] },
    });
    expect(response.status).toBe(400);
    expect((await roomOf(fileId).stats()).nodes).toBe(1);

    // Nor through a change sent over the socket.
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 1, clientId: "c1", revn: null });
    await socket.next("welcome");
    socket.send({ t: "txn", seq: 1, ops: [{ op: "create", ...record }] });
    const reject = await socket.next<{ code: string }>("reject");
    expect(reject.code).toBe("unsupported");
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

  it("fills the file as one change, which clients behind it load rather than catch up on", async () => {
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
    // The starting page was revision 1; the import is revision 2, not logged as operations.
    expect(stats.revn).toBe(2);
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 1, clientId: "c1", revn: 1 });
    expect((await socket.next<{ mode: string }>("welcome")).mode).toBe("snapshot");
  });

  it("takes an import in parts, showing none of it until the commit", async () => {
    const { browser, fileId } = await newFile();
    const { importId } = await browser.json<{ importId: string }>(`/api/files/${fileId}/imports`, {
      method: "POST",
      json: {},
    });
    const part = (nodes: NodeRecord[]) =>
      browser.fetch(`/api/files/${fileId}/imports/${importId}/parts`, {
        method: "POST",
        json: { nodes },
      });
    // Children may come before their parents, in any part.
    expect((await part([rect("R1", "P1")])).status).toBe(200);
    expect((await part([page("P1", "Cover", "a0")])).status).toBe(200);
    // A part with a bad value is refused whole; the parts before it stay.
    expect((await part([{ ...rect("R2", "P1", "a1"), props: { width: -5 } }])).status).toBe(400);
    // A node sent twice is refused.
    expect((await part([rect("R1", "P1")])).status).toBe(400);
    // Meanwhile the file is as it was.
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
    const done = await browser.json<{ nodes: number; revn: number }>(
      `/api/files/${fileId}/imports/${importId}/commit`,
      { method: "POST", json: {} },
    );
    expect(done.nodes).toBe(2);
    expect((await roomOf(fileId).stats()).nodes).toBe(2);
    // It's finished: no more parts or commits.
    expect((await part([rect("R3", "P1")])).status).toBe(404);
  });

  it("checks how the parts fit together at the commit, leaving the file as it was", async () => {
    const { browser, fileId } = await newFile();
    const tryImport = async (nodes: NodeRecord[]) => {
      const { importId } = await browser.json<{ importId: string }>(
        `/api/files/${fileId}/imports`,
        { method: "POST", json: {} },
      );
      await browser.json(`/api/files/${fileId}/imports/${importId}/parts`, {
        method: "POST",
        json: { nodes },
      });
      return browser.fetch(`/api/files/${fileId}/imports/${importId}/commit`, {
        method: "POST",
        json: {},
      });
    };
    const cases: Array<[NodeRecord[], string]> = [
      [[page("P1", "Cover", "a0"), rect("R1", "nope")], "Parent nope doesn't exist."],
      [[page("P1", "Cover", "a0"), { ...page("P2", "In", "a0"), parent: "P1" }], "can't contain"],
      [
        [
          page("P1", "Cover", "a0"),
          { id: "G1", type: "group", parent: "G2", key: "a0", props: {} },
          { id: "G2", type: "group", parent: "G1", key: "a0", props: {} },
        ],
        "inside itself",
      ],
      [[rect("R1", "R2"), rect("R2", "R1")], "There's nothing to import."],
    ];
    for (const [nodes, message] of cases) {
      const response = await tryImport(nodes);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(message);
      expect((await roomOf(fileId).stats()).nodes).toBe(1);
    }
    // Too deep: 130 groups, one in another.
    const deep: NodeRecord[] = [page("P1", "Deep", "a0")];
    for (let i = 0; i < 130; i++)
      deep.push({
        id: `D${i}`,
        type: "group",
        parent: i === 0 ? "P1" : `D${i - 1}`,
        key: "a0",
        props: {},
      });
    const response = await tryImport(deep);
    expect(JSON.stringify(await response.json())).toContain("deeper than");
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
  });

  it("throws away an import given up, or begun again", async () => {
    const { browser, fileId } = await newFile();
    const begin = () =>
      browser.json<{ importId: string }>(`/api/files/${fileId}/imports`, {
        method: "POST",
        json: {},
      });
    const first = await begin();
    await browser.json(`/api/files/${fileId}/imports/${first.importId}/parts`, {
      method: "POST",
      json: { nodes: [page("P1", "Cover", "a0")] },
    });
    // Begun again: the first is gone.
    const second = await begin();
    const stale = await browser.fetch(`/api/files/${fileId}/imports/${first.importId}/commit`, {
      method: "POST",
      json: {},
    });
    expect(stale.status).toBe(404);
    await browser.json(`/api/files/${fileId}/imports/${second.importId}`, { method: "DELETE" });
    const gone = await browser.fetch(`/api/files/${fileId}/imports/${second.importId}/commit`, {
      method: "POST",
      json: {},
    });
    expect(gone.status).toBe(404);
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
  });
});
