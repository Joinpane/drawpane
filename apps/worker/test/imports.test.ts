import { env, runInDurableObject } from "cloudflare:test";
import { copyId, keyBetween, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import type { FileRoom } from "../src/rooms/file-room";
import { IMPORT_TABLE } from "../src/rooms/import-stage";
import { type Browser, openSocket, signedInUser } from "./helpers";

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

/** An import begun in parts, and how to send a part and commit it. */
async function inParts(browser: Browser, fileId: string) {
  const { importId } = await browser.json<{ importId: string }>(`/api/files/${fileId}/imports`, {
    method: "POST",
    json: {},
  });
  const part = (nodes: unknown[]) =>
    browser.fetch(`/api/files/${fileId}/imports/${importId}/parts`, {
      method: "POST",
      json: { nodes },
    });
  /** Commits it, saying how its nodes store copies (decision 0029; materialized when not said). */
  const commit = (copies?: "compact") =>
    browser.fetch(`/api/files/${fileId}/imports/${importId}/commit`, {
      method: "POST",
      json: copies ? { copies } : {},
    });
  return { importId, part, commit };
}

/** Lowers the room's import limits, so a test can reach them with a few nodes. */
async function lowerLimits(fileId: string, limits: { nodes: number; bytes: number }) {
  await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
    room.importLimits = limits;
  });
}

/** Someone with the file open: its nodes, and a way to send an edit and wait for the ack. */
async function editor(browser: Browser, fileId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 3,
    clientId: "c-editor",
    revn: null,
    copies: ["materialized", "compact"],
  });
  await socket.next("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  let seq = 0;
  const edit = async (ops: unknown[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    return (await socket.next<{ revn: number }>("ack")).revn;
  };
  return { socket, nodes, page: nodes.find((n) => n.type === "page") as NodeRecord, edit };
}

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
    socket.send({
      t: "hello",
      protocol: 3,
      clientId: "c1",
      revn: null,
      copies: ["materialized", "compact"],
    });
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

  it("takes override records into a file stored compact, checked as edits are (decision 0029)", async () => {
    const { browser, fileId } = await newFile();
    const main = { id: "M1", type: "frame", parent: "P1", key: "a0", props: { isComponent: true } };
    const inner = { id: "R1", type: "rect", parent: "M1", key: "a0", props: { width: 10 } };
    const copy = {
      id: "I1",
      type: "frame",
      parent: "P1",
      key: "a1",
      props: { propValues: {}, instanceOf: "M1" },
    };
    const wrong = { id: "O1", type: "override", parent: "I1", key: "a0", props: { path: ["R1"] } };
    const record = { ...wrong, id: copyId("I1", ["R1"]), props: { path: ["R1"], width: 20 } };
    // A record whose id isn't the one its path derives is refused.
    const refused = await browser.fetch(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes: [page("P1", "Cover", "a0"), main, inner, copy, wrong], copies: "compact" },
    });
    expect(refused.status).toBe(400);
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
    // One that is comes in as it is.
    await browser.json(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes: [page("P1", "Cover", "a0"), main, inner, copy, record], copies: "compact" },
    });
    expect((await roomOf(fileId).stats()).nodes).toBe(5);

    // Over the socket, a record is checked too.
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 3, clientId: "c1", revn: null, copies: ["compact"] });
    expect((await socket.next<{ copies: string }>("welcome")).copies).toBe("compact");
    socket.send({ t: "txn", seq: 1, ops: [{ op: "create", ...wrong }] });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("invalid_id");
  });

  it("refuses override records into a file stored materialized", async () => {
    const { browser, fileId } = await newFile();
    await roomOf(fileId).storeMaterialized([page("P1", "Cover", "a0")]);
    const copy = {
      id: "I1",
      type: "frame",
      parent: "P1",
      key: "a1",
      props: { propValues: {}, instanceOf: "M1" },
    };
    const record = {
      id: copyId("I1", ["X1"]),
      type: "override",
      parent: "I1",
      key: "a0",
      props: { path: ["X1"] },
    };
    const socket = await openSocket(browser, fileId);
    socket.send({
      t: "hello",
      protocol: 3,
      clientId: "c1",
      revn: null,
      copies: ["materialized", "compact"],
    });
    expect((await socket.next<{ copies: string }>("welcome")).copies).toBe("materialized");
    socket.send({
      t: "txn",
      seq: 1,
      ops: [
        { op: "create", ...copy },
        { op: "create", ...record },
      ],
    });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("unsupported");
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
    socket.send({
      t: "hello",
      protocol: 3,
      clientId: "c1",
      revn: 1,
      copies: ["materialized", "compact"],
    });
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
  it("refuses a commit when the file changed after the import began, keeping that edit", async () => {
    const { browser, fileId } = await newFile();
    const { part, commit } = await inParts(browser, fileId);
    expect((await part([page("P1", "Cover", "a0"), rect("R1", "P1")])).status).toBe(200);
    // Someone renames the starting page and gives it a background while the import is under way.
    const someone = await editor(browser, fileId);
    await someone.edit([{ op: "set", id: someone.page.id, prop: "name", value: "Notes" }]);
    await someone.edit([
      { op: "set", id: someone.page.id, prop: "backgroundColor", value: "#ffeeaa" },
    ]);
    const response = await commit();
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("changed");
    // The edits are still there, and nothing was imported.
    const nodes = (await roomOf(fileId).allNodes()) as NodeRecord[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.props).toMatchObject({ name: "Notes", backgroundColor: "#ffeeaa" });
  });

  it("keeps the log after an import, while clients behind it still load the file", async () => {
    const { browser, fileId } = await newFile();
    const before = await editor(browser, fileId);
    // An edit that leaves the starting page empty: the file can still take an import.
    await before.edit([{ op: "create", ...rect("T1", before.page.id) }]);
    await before.edit([{ op: "delete", id: "T1" }]);
    before.socket.ws.close();
    const { revn } = await roomOf(fileId).stats();
    const { part, commit } = await inParts(browser, fileId);
    await part([page("P1", "Cover", "a0")]);
    expect((await commit()).status).toBe(200);
    const logged = await runInDurableObject(
      roomOf(fileId),
      (_room, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM log").one().n,
    );
    // The starting page and the two edits, still there for who edited what.
    expect(logged).toBe(revn);
    const behind = await openSocket(browser, fileId);
    behind.send({
      t: "hello",
      protocol: 3,
      clientId: "c2",
      revn: revn - 1,
      copies: ["materialized", "compact"],
    });
    expect((await behind.next<{ mode: string }>("welcome")).mode).toBe("snapshot");
  });

  it("holds the whole import to its limits, part by part and at the commit", async () => {
    const { browser, fileId } = await newFile();
    await lowerLimits(fileId, { nodes: 3, bytes: 1_000_000 });
    const first = await inParts(browser, fileId);
    expect((await first.part([page("P1", "Cover", "a0"), rect("R1", "P1")])).status).toBe(200);
    // Past the count: refused, and not kept.
    const over = await first.part([rect("R2", "P1", "a1"), rect("R3", "P1", "a2")]);
    expect(over.status).toBe(400);
    expect(JSON.stringify(await over.json())).toContain("at most 3");
    const done = await first.commit();
    expect(done.status).toBe(200);
    expect(((await done.json()) as { nodes: number }).nodes).toBe(2);

    // Past the bytes, in all though not in any one part.
    const second = await newFile();
    await lowerLimits(second.fileId, { nodes: 1_000, bytes: 250 });
    const bytes = await inParts(second.browser, second.fileId);
    expect((await bytes.part([page("P1", "Cover", "a0"), rect("R1", "P1")])).status).toBe(200);
    const tooMuch = await bytes.part([rect("R2", "P1", "a1"), rect("R3", "P1", "a2")]);
    expect(tooMuch.status).toBe(400);
    expect(JSON.stringify(await tooMuch.json())).toContain("MB");

    // Limits checked again at the commit.
    const third = await newFile();
    const late = await inParts(third.browser, third.fileId);
    expect((await late.part([page("P1", "Cover", "a0"), rect("R1", "P1")])).status).toBe(200);
    await lowerLimits(third.fileId, { nodes: 1, bytes: 1_000_000 });
    const refused = await late.commit();
    expect(refused.status).toBe(400);
    expect((await roomOf(third.fileId).stats()).nodes).toBe(1);
  });

  it("counts an import's bytes as UTF-8: CJK text three each, an emoji four", async () => {
    // A page whose name is 150 CJK characters and 50 emoji: 250 characters (UTF-16 code
    // units) of name, but 650 bytes of it.
    const name = "界".repeat(150) + "😀".repeat(50);
    const line = `{"id":"P1","parent":"root","key":"a0","type":"page","props":${JSON.stringify({ name })}}`;
    expect(line.length).toBeLessThan(400);
    const bytes = new TextEncoder().encode(line).length;
    expect(bytes).toBeGreaterThan(700);

    // Under a limit of 400 bytes: refused, though its characters would fit.
    const { browser, fileId } = await newFile();
    await lowerLimits(fileId, { nodes: 10, bytes: 400 });
    const over = await inParts(browser, fileId);
    const refused = await over.part([page("P1", name, "a0")]);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("MB");

    // Under exactly its bytes: kept, and committed.
    const second = await newFile();
    await lowerLimits(second.fileId, { nodes: 10, bytes });
    const fits = await inParts(second.browser, second.fileId);
    expect((await fits.part([page("P1", name, "a0")])).status).toBe(200);
    const staged = await runInDurableObject(roomOf(second.fileId), (_room, state) =>
      state.storage.sql.exec<{ bytes: number }>(`SELECT bytes FROM ${IMPORT_TABLE}_size`).one(),
    );
    expect(staged.bytes).toBe(bytes);
    expect((await fits.commit()).status).toBe(200);

    // One byte under it by the commit: refused there, counting the same bytes.
    const third = await newFile();
    const late = await inParts(third.browser, third.fileId);
    expect((await late.part([page("P1", name, "a0")])).status).toBe(200);
    await lowerLimits(third.fileId, { nodes: 10, bytes: bytes - 1 });
    expect((await late.commit()).status).toBe(400);
    expect((await roomOf(third.fileId).stats()).nodes).toBe(1);
  });

  it("checks override records in each part and at the commit of an import in parts", async () => {
    const { browser, fileId } = await newFile();
    const copy = {
      id: "I1",
      type: "frame",
      parent: "P1",
      key: "a1",
      props: { propValues: {}, instanceOf: "M1" },
    };
    const record = { id: "O1", type: "override", parent: "I1", key: "a0", props: { path: ["X1"] } };
    const { importId, part, commit } = await inParts(browser, fileId);
    expect((await part([page("P1", "Cover", "a0"), copy])).status).toBe(200);
    // A record comes in a part: the file stores compact copies.
    expect((await part([record])).status).toBe(200);
    // At the commit it's checked as an edit's would be: its id isn't its path's.
    const response = await commit("compact");
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("path names");
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
    expect(importId).toBeTruthy();
  });

  it("refuses override records in parts of an import into a file stored materialized", async () => {
    const { fileId } = await newFile();
    await roomOf(fileId).storeMaterialized([page("P1", "Cover", "a0")]);
    // An empty starting page again, as the import needs.
    const record = { id: "O1", type: "override", parent: "I1", key: "a0", props: { path: ["X1"] } };
    const begun = await roomOf(fileId).beginImport(fileId);
    expect(begun).toMatchObject({ ok: true, copies: "materialized" });
    if (!begun.ok) return;
    const direct = await roomOf(fileId).importPart(fileId, begun.importId, [record as NodeRecord]);
    expect(direct).toMatchObject({ ok: false, reason: "invalid" });
    // A record that got into the staged import some other way is refused at the commit.
    await runInDurableObject(roomOf(fileId), (_room, state) => {
      state.storage.sql.exec(
        `INSERT INTO ${IMPORT_TABLE} (id, parent, key, type, props) VALUES ('O1', 'I1', 'a0', 'override', '{"path":["X1"]}')`,
      );
    });
    const result = await roomOf(fileId).commitImport(
      { userId: "u", name: "U" },
      fileId,
      begun.importId,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect((await roomOf(fileId).stats()).nodes).toBe(1);
  });
});
