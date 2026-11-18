/**
 * Rooms storing compact copies (decision 0029, phase 4b): a file stored
 * materialized converts when its room loads, in steps, after saving a
 * version to undo it with; clients learn the form at hello; comment pins and
 * ids layers hold follow the copies they name; versions, branches,
 * libraries, imports and the MCP tools work on the compact form.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { generateKit } from "@drawpane/corpus";
import { Doc } from "@drawpane/editor";
import {
  compactByInstance,
  copyId,
  DEFAULT_TRANSITION,
  firstDifference,
  keyBetween,
  libraryAssets,
  type NodeRecord,
  newId,
  nodeReader,
  type Op,
  parseSnapshot,
  ROOT_ID,
  renameIds,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import type { Env as WorkerEnv } from "../src/env";
import type { FileRoom } from "../src/rooms/file-room";
import { SyncEngine as OldSyncEngine } from "./fixtures/sync-v1";
import { type Browser, openSocket, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
const BOTH = ["materialized", "compact"];

async function newFile(name = "Kit") {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name } },
  );
  // The room learns its file id when someone opens it.
  const socket = await openSocket(owner.browser, file.id);
  socket.send({ t: "hello", protocol: 3, clientId: `c-${file.id}`, revn: null, copies: BOTH });
  await socket.next("welcome");
  socket.ws.close();
  return { ...owner, fileId: file.id };
}

/** A file from before compact copies: the kit's nodes, stored materialized. */
async function materializedFile(nodes: readonly NodeRecord[]) {
  const made = await newFile();
  await roomOf(made.fileId).storeMaterialized(nodes);
  return made;
}

/** The file's nodes as its room stores them. */
const stored = async (fileId: string) => (await roomOf(fileId).allNodes()) as NodeRecord[];

/** Runs the room's alarm until the conversion is applied (or `limit` alarms). */
async function convert(fileId: string, limit = 500): Promise<number> {
  for (let i = 1; i <= limit; i++) {
    await runDurableObjectAlarm(roomOf(fileId));
    if ((await roomOf(fileId).copiesFormat()).copies === "compact") return i;
  }
  throw new Error("the conversion didn't finish");
}

/** The file as stored, read by a client: welcome and the snapshot. */
async function open(browser: Browser, fileId: string, reads = BOTH) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 3,
    clientId: `o-${crypto.randomUUID()}`,
    revn: null,
    copies: reads,
  });
  const welcome = await socket.next<{ copies: "materialized" | "compact"; revn: number }>(
    "welcome",
  );
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  return { socket, welcome, nodes };
}

/** What a client shows of what it was sent: every layer, copies built. */
function presented(nodes: readonly NodeRecord[], copies: "materialized" | "compact"): NodeRecord[] {
  const doc = new Doc();
  doc.resetStored(nodes, copies);
  return [...doc.nodes()];
}

const kit = generateKit({ layers: 3_000, seed: 3 });
const kitById = new Map(kit.nodes.map((n) => [n.id, n]));

/** The kit's page a layer is on: where a comment pinned to it is (the page it's posted with). */
function kitPageOf(id: string): NodeRecord {
  let at = kitById.get(id);
  while (at && at.type !== "page") at = kitById.get(at.parent);
  return at as NodeRecord;
}

describe("converting a file stored materialized", { timeout: 120_000 }, () => {
  it("converts when the room loads, after a version to undo it with, and opens as it was", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    await convert(fileId);
    const format = await roomOf(fileId).copiesFormat();
    expect(format).toMatchObject({
      copies: "compact",
      converting: false,
      failed: null,
      detached: [],
    });

    // Stored exactly as converting the file in one go stores it.
    const expected = compactByInstance(kit.nodes);
    const storedNodes = await stored(fileId);
    expect(firstDifference(expected.nodes, storedNodes)).toBeNull();
    expect(storedNodes.length).toBeLessThan(kit.nodes.length * 0.4);

    // Opened by a client: the same document as before, copies' ids renamed.
    const { welcome, nodes } = await open(browser, fileId);
    expect(welcome.copies).toBe("compact");
    expect(
      firstDifference(renameIds(kit.nodes, expected.ids), presented(nodes, "compact")),
    ).toBeNull();

    // The version saved first holds the file as it was, materialized.
    const { versions } = await browser.json<{
      versions: Array<{ id: string; name: string | null }>;
    }>(`/api/files/${fileId}/versions`);
    const backup = versions.find((v) => v.name === "Before compact copies");
    expect(backup?.id).toBe(format.backup);
    const text = await (
      await browser.fetch(`/api/files/${fileId}/versions/${backup?.id}/snapshot`)
    ).text();
    const snapshot = parseSnapshot(text);
    expect(snapshot?.header.copies).toBeUndefined();
    expect(firstDifference(kit.nodes, snapshot?.nodes ?? [])).toBeNull();
  });

  it("goes on in steps while people edit, converting again what their edits change", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.convertStepWork = 0;
    });
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 3, clientId: "editor", revn: null, copies: BOTH });
    expect((await socket.next<{ copies: string }>("welcome")).copies).toBe("materialized");
    // A few steps in, someone edits a main and its copies, as a materialized editor does.
    for (let i = 0; i < 5; i++) await runDurableObjectAlarm(roomOf(fileId));
    expect((await roomOf(fileId).copiesFormat()).converting).toBe(true);
    const main = kit.nodes.find((n) => n.type === "frame" && n.props.isComponent) as NodeRecord;
    const fill = [{ type: "solid", color: "#123456" }];
    const ops = [main, ...kit.nodes.filter((n) => n.props.mirrors === main.id)]
      .filter((n) => !(n.props.overrides ?? []).includes("fills"))
      .map((n) => ({ op: "set", id: n.id, prop: "fills", value: fill }) as Op);
    socket.send({ t: "txn", seq: 1, ops });
    await socket.next("ack");
    const edited = await stored(fileId);
    await convert(fileId);
    // It's the edited file converted, and the editor who was in it is asked to load it again.
    expect(firstDifference(compactByInstance(edited).nodes, await stored(fileId))).toBeNull();
    await socket.next("resync");
    // An edit still in the old form is refused, and the client told to load the file again.
    socket.send({
      t: "txn",
      seq: 2,
      ops: [{ op: "set", id: main.id, prop: "name", value: "Late" }],
    });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("format");
  });

  it("detaches an instance whose layers aren't its main's, keeping its look, and says why", async () => {
    // An instance with a layer its main doesn't have.
    const root = kit.nodes.find(
      (n) => n.type === "frame" && n.props.instanceOf && n.parent !== ROOT_ID,
    ) as NodeRecord;
    const stray: NodeRecord = {
      id: "Stray1",
      type: "rect",
      parent: root.id,
      key: "zz",
      props: { width: 3, mirrors: "Nowhere1" },
    };
    const nodes = [...kit.nodes, stray];
    const { browser, fileId } = await materializedFile(nodes);
    await convert(fileId);
    const { detached } = await roomOf(fileId).copiesFormat();
    expect(detached.map((d) => d.root)).toContain(root.id);
    expect(detached.find((d) => d.root === root.id)?.why).toBeTruthy();
    // It still looks as it did: every layer there, with its values.
    const { nodes: opened } = await open(browser, fileId);
    const shown = presented(opened, "compact");
    const strayShown = shown.find((n) => n.id === "Stray1");
    expect(strayShown?.props.width).toBe(3);
    expect(shown.find((n) => n.id === root.id)?.props.instanceOf).toBeUndefined();
  });

  it("leaves a file as it is when conversion is turned off, and a version undoes it when it was on", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    await runDurableObjectAlarm(roomOf(fileId));
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    // A client from before compact copies would edit it with operations it can't read since keyed
    // sets (protocol 3, decision 0035): it's told to reload.
    const old = await openSocket(browser, fileId);
    old.send({ t: "hello", protocol: 1, clientId: "old", revn: null });
    expect((await old.next<{ code: string }>("error")).code).toBe("reload");

    // Turned on, it converts; turned off again, restoring the version saved before puts the
    // file back as it was stored, materialized.
    // (A deploy that turns it on again restarts the room, which schedules its alarm.)
    await runInDurableObject(roomOf(fileId), async (room: FileRoom, state) => {
      room.compactCopiesOff = false;
      await state.storage.setAlarm(Date.now());
    });
    await convert(fileId);
    // The old client can't read compact copies: it's sent the file as presented, to view.
    const again = await openSocket(browser, fileId);
    again.send({ t: "hello", protocol: 1, clientId: "old2", revn: null });
    expect((await again.next<{ role: string; copies: string }>("welcome")).role).toBe("viewer");

    const { backup } = await roomOf(fileId).copiesFormat();
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    const restored = await browser.fetch(`/api/files/${fileId}/versions/${backup}/restore`, {
      method: "POST",
      json: {},
    });
    expect(restored.status).toBe(200);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    expect(firstDifference(kit.nodes, await stored(fileId))).toBeNull();
  });

  it("restores a version saved before converting, converting it as it's read", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await convert(fileId);
    const { backup } = await roomOf(fileId).copiesFormat();
    // Change something, then restore the version from before conversion.
    const { socket, nodes } = await open(browser, fileId);
    const page = nodes.find((n) => n.type === "page") as NodeRecord;
    socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: page.id, prop: "name", value: "Renamed" }],
    });
    await socket.next("ack");
    const response = await browser.fetch(`/api/files/${fileId}/versions/${backup}/restore`, {
      method: "POST",
      json: {},
    });
    expect(response.status).toBe(200);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("compact");
    expect(firstDifference(compactByInstance(kit.nodes).nodes, await stored(fileId))).toBeNull();
    // Versions saved now say how they store copies.
    const saved = await browser.json<{ version: { id: string } }>(`/api/files/${fileId}/versions`, {
      method: "POST",
      json: { name: "After" },
    });
    const text = await (
      await browser.fetch(`/api/files/${fileId}/versions/${saved.version.id}/snapshot`)
    ).text();
    expect(parseSnapshot(text)?.header.copies).toBe("compact");
  });
});

describe("references to copy layers", { timeout: 120_000 }, () => {
  it("move comment pins, reading orders and prototype links to the copies' new ids", async () => {
    // A copy layer someone pinned a comment to, ordered for reading and linked to.
    const root = kit.nodes.find(
      (n) => n.type === "frame" && n.props.instanceOf && kit.nodes.some((c) => c.parent === n.id),
    ) as NodeRecord;
    const layers = kit.nodes.filter((n) => n.parent === root.id);
    const target = layers[0] as NodeRecord;
    const page = kit.nodes.find((n) => n.type === "page") as NodeRecord;
    const order = layers.map((n) => n.id).reverse();
    const nodes = kit.nodes.map((n) =>
      n.id === root.id
        ? {
            ...n,
            props: {
              ...n.props,
              readingOrder: order,
              overrides: [...(n.props.overrides ?? []), "readingOrder"],
            },
          }
        : n,
    );
    const link: NodeRecord = {
      id: "Link1",
      type: "rect",
      parent: page.id,
      key: "zzz",
      props: {
        width: 10,
        reactions: [
          {
            id: "r1",
            trigger: { type: "tap" },
            action: { type: "navigate", to: target.id },
            transition: { type: "instant" },
          },
        ],
      } as NodeRecord["props"],
    };
    nodes.push(link);
    const { browser, fileId } = await materializedFile(nodes);
    const pin = await browser.json<{ thread: { id: string } }>(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: {
        pageId: page.id,
        x: 1,
        y: 2,
        nodeId: target.id,
        offset: { x: 0, y: 0 },
        body: "Here",
      },
    });
    await convert(fileId);
    const derived = compactByInstance(nodes).ids.get(target.id) as string;
    expect(derived).toBe(copyId(root.id, [target.props.mirrors as string]));
    // The comment pin follows its layer.
    const row = await env.DB.prepare("SELECT node_id FROM comment_threads WHERE id = ?")
      .bind(pin.thread.id)
      .first<{ node_id: string }>();
    expect(row?.node_id).toBe(derived);
    // So do the reading order and the prototype link.
    const { nodes: opened } = await open(browser, fileId);
    const shown = presented(opened, "compact");
    const rootShown = shown.find((n) => n.id === root.id) as NodeRecord;
    expect(rootShown.props.readingOrder?.[order.length - 1]).toBe(derived);
    const linkShown = shown.find((n) => n.id === "Link1") as NodeRecord;
    expect(JSON.stringify(linkShown.props.reactions)).toContain(derived);
  });
});

describe("a file stored compact", { timeout: 120_000 }, () => {
  it("is what new files are, and an import of materialized copies is stored compact", async () => {
    const { browser, fileId } = await newFile();
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("compact");
    const empty = await newFile();
    const result = await empty.browser.fetch(`/api/files/${empty.fileId}/imports`, {
      method: "POST",
      json: {},
    });
    const begun = (await result.json()) as { importId: string; copies: string };
    expect(begun.copies).toBe("compact");
    const parts = `/api/files/${empty.fileId}/imports/${begun.importId}`;
    for (let i = 0; i < kit.nodes.length; i += 1_000)
      await empty.browser.json(`${parts}/parts`, {
        method: "POST",
        json: { nodes: kit.nodes.slice(i, i + 1_000) },
      });
    await empty.browser.json(`${parts}/commit`, { method: "POST", json: {} });
    const expected = compactByInstance(kit.nodes);
    expect(firstDifference(expected.nodes, await stored(empty.fileId))).toBeNull();
    expect(browser).toBeTruthy();
  });

  it("takes an import the browser converted as it is: instances equal to their main stay instances", async () => {
    const { browser, fileId } = await newFile();
    const converted = compactByInstance(kit.nodes);
    // Most instances here equal their main: neither layers nor records under them.
    const { importId } = await browser.json<{ importId: string }>(`/api/files/${fileId}/imports`, {
      method: "POST",
      json: {},
    });
    const parts = `/api/files/${fileId}/imports/${importId}`;
    for (let i = 0; i < converted.nodes.length; i += 1_000)
      await browser.json(`${parts}/parts`, {
        method: "POST",
        json: { nodes: converted.nodes.slice(i, i + 1_000) },
      });
    await browser.json(`${parts}/commit`, { method: "POST", json: { copies: "compact" } });
    expect(firstDifference(converted.nodes, await stored(fileId))).toBeNull();
  });

  it("copies a compact file to a branch as it is", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await convert(fileId);
    const made = await browser.json<{ branch: { id: string } }>(`/api/files/${fileId}/branches`, {
      method: "POST",
      json: { name: "After" },
    });
    expect(firstDifference(await stored(fileId), await stored(made.branch.id))).toBeNull();
  });

  it("publishes a library whose hashes are those of the copies as presented", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await convert(fileId);
    const published = await browser.json<{
      publish: { assets: Array<{ id: string; hash: string }> };
    }>(`/api/files/${fileId}/library/publish`, { method: "POST", json: {} });
    const expected = compactByInstance(kit.nodes);
    const asPresented = libraryAssets(nodeReader(presented(expected.nodes, "compact")));
    expect(published.publish.assets).toEqual(asPresented);
    // Unchanged content hashes alike when published again.
    const again = await browser.json<{ publish: { assets: Array<{ id: string; hash: string }> } }>(
      `/api/files/${fileId}/library/publish`,
      { method: "POST", json: { description: "again" } },
    );
    expect(again.publish.assets).toEqual(published.publish.assets);
  });

  it("branches compact, and merges a branch made before its main converted", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    // A branch made while main was materialized: its base is too.
    const made = await browser.json<{ branch: { id: string } }>(`/api/files/${fileId}/branches`, {
      method: "POST",
      json: { name: "Before" },
    });
    const branchId = made.branch.id;
    expect((await roomOf(branchId).copiesFormat()).copies).toBe("compact");
    // Main converts; the branch renames a page.
    await convert(fileId);
    const { socket, nodes } = await open(browser, branchId);
    const page = nodes.find((n) => n.type === "page") as NodeRecord;
    socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: page.id, prop: "name", value: "Branched" }],
    });
    await socket.next("ack");
    const merged = await browser.fetch(`/api/files/${branchId}/branch/merge`, {
      method: "POST",
      json: {},
    });
    expect(merged.status).toBe(200);
    const after = await stored(fileId);
    expect(after.find((n) => n.id === page.id)?.props.name).toBe("Branched");
    // Nothing else changed: the base was converted as it was read, ids derived alike.
    const expected = compactByInstance(kit.nodes).nodes.map((n) =>
      n.id === page.id ? { ...n, props: { ...n.props, name: "Branched" } } : n,
    );
    expect(firstDifference(expected, after)).toBeNull();
  });

  it("answers the MCP tools' reads with copies as people see them", async () => {
    const { fileId } = await materializedFile(kit.nodes);
    await convert(fileId);
    const expected = compactByInstance(kit.nodes);
    const shown = presented(expected.nodes, "compact");
    const copy = shown.find(
      (n) => n.props.mirrors && !expected.nodes.some((s) => s.id === n.id),
    ) as NodeRecord;
    const answer = (await roomOf(fileId).readDocument(fileId, {
      kind: "node",
      nodeId: copy.id,
    })) as {
      node?: { id: string };
      error?: string;
    };
    expect(answer.error).toBeUndefined();
    expect(JSON.stringify(answer)).toContain(copy.id);
    const found = (await roomOf(fileId).readDocument(fileId, {
      kind: "find",
      query: String(copy.props.name ?? ""),
      limit: 10_000,
    })) as { matches?: Array<{ id: string }> };
    expect(JSON.stringify(found)).toContain(copy.id);
  });

  it("refuses an edit that would leave layers stored inside an instance", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await convert(fileId);
    const { socket } = await open(browser, fileId);
    const root = (await stored(fileId)).find(
      (n) => n.type === "frame" && n.props.instanceOf,
    ) as NodeRecord;
    socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "create", id: "Inside1", type: "rect", parent: root.id, key: "a0", props: {} }],
    });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("invalid_parent");
  });
});

/** Instance roots of a live main that still store layers: a compact file must never have one. */
const strays = (nodes: readonly NodeRecord[]) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((r) => {
      const of = r.type === "frame" ? r.props.instanceOf : undefined;
      if (!of || !byId.get(of)?.props.isComponent) return false;
      return nodes.some((c) => c.parent === r.id && c.type !== "override");
    })
    .map((r) => r.id);
};

/** Runs the room's alarm, from inside it (in a test pause), until the file stores copies compactly. */
async function convertInside(room: FileRoom) {
  for (let i = 0; i < 500; i++) {
    await room.alarm();
    if ((await room.copiesFormat()).copies === "compact") return;
  }
  throw new Error("the conversion didn't finish");
}

describe("what the review of the conversion found", { timeout: 120_000 }, () => {
  it("refuses a merge that deletes a component main used meanwhile", async () => {
    const { browser, fileId } = await newFile("Merge");
    const { socket, nodes } = await open(browser, fileId);
    const page = nodes.find((n) => n.type === "page") as NodeRecord;
    const [main, inner, instance] = [newId(), newId(), newId()];
    socket.send({
      t: "txn",
      seq: 1,
      ops: [
        {
          op: "create",
          id: main,
          type: "frame",
          parent: page.id,
          key: keyBetween(null, null),
          props: { name: "Badge", isComponent: true, width: 40, height: 20 },
        },
        {
          op: "create",
          id: inner,
          type: "rect",
          parent: main,
          key: keyBetween(null, null),
          props: { width: 10, height: 10 },
        },
      ],
    });
    await socket.next("ack");
    const made = await browser.json<{ branch: { id: string } }>(`/api/files/${fileId}/branches`, {
      method: "POST",
      json: { name: "Tidy" },
    });
    // The branch deletes the main; main, meanwhile, places an instance of it.
    const branch = await open(browser, made.branch.id);
    branch.socket.send({ t: "txn", seq: 1, ops: [{ op: "delete", id: main }] });
    await branch.socket.next("ack");
    socket.send({
      t: "txn",
      seq: 2,
      ops: [
        {
          op: "create",
          id: instance,
          type: "frame",
          parent: page.id,
          key: keyBetween(keyBetween(null, null), null),
          props: { name: "Badge", instanceOf: main, width: 40, height: 20, x: 100 },
        },
      ],
    });
    await socket.next("ack");
    const merged = await browser.fetch(`/api/files/${made.branch.id}/branch/merge`, {
      method: "POST",
      json: {},
    });
    expect(merged.status).not.toBe(200);
    // The instance main placed still shows its main's layers.
    const after = await stored(fileId);
    expect(after.some((n) => n.id === main)).toBe(true);
    const shown = presented(after, "compact");
    expect(shown.filter((n) => n.parent === instance)).toHaveLength(1);
  });

  it("commits a restore in the form the file has when it commits", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    const saved = await browser.json<{ version: { id: string } }>(`/api/files/${fileId}/versions`, {
      method: "POST",
      json: { name: "Materialized" },
    });
    // The file converts while the restore saves its restore point.
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = false;
      room.pause = async (at) => {
        if (at === "restore") await convertInside(room);
      };
    });
    const restored = await browser.fetch(
      `/api/files/${fileId}/versions/${saved.version.id}/restore`,
      { method: "POST", json: {} },
    );
    expect(restored.status).toBe(200);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("compact");
    const after = await stored(fileId);
    expect(strays(after)).toEqual([]);
    expect(firstDifference(compactByInstance(kit.nodes).nodes, after)).toBeNull();
  });

  it("never sends compact copies to a client from before them, even when the file converts during its hello", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.pause = async (at) => {
        if (at === "hello") await convertInside(room);
      };
    });
    const old = await openSocket(browser, fileId);
    old.send({ t: "hello", protocol: 1, clientId: "old-race", revn: null });
    const welcome = await old.next<{ copies?: string; role: string }>("welcome", 30_000);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("compact");
    const sent: NodeRecord[] = [];
    for (;;) {
      const chunk = await old.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot", 30_000);
      sent.push(...chunk.nodes);
      if (chunk.done) break;
    }
    // What it's sent is the file as people see it, every copy layer stored, and it can't edit.
    expect(sent.some((n) => n.type === "override")).toBe(false);
    expect(welcome.role).toBe("viewer");
    const expected = compactByInstance(kit.nodes);
    expect(firstDifference(renameIds(kit.nodes, expected.ids), sent)).toBeNull();
  });

  it("serves a tab from before compact copies, running its own sync code, the file to view, and says to reload when it edits", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    await convert(fileId);
    const socket = await openSocket(browser, fileId);
    const doc = new Doc();
    const engine = new OldSyncEngine(doc, {
      clientId: "old-tab",
      flushIntervalMs: 0,
      statsIntervalMs: 3_600_000,
    });
    const rejected: string[] = [];
    engine.on("rejected", (_code, message) => rejected.push(message));
    let closed: number | null = null;
    socket.ws.addEventListener("close", (event) => {
      closed = event.code;
    });
    socket.ws.addEventListener("message", (event) => {
      engine.receive(JSON.parse(event.data as string));
    });
    engine.connected((message) => socket.send(message));
    for (let i = 0; i < 200 && engine.status !== "live" && closed === null; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBeNull();
    expect(engine.status).toBe("live");
    expect(engine.role).toBe("viewer");
    const expected = compactByInstance(kit.nodes);
    expect(firstDifference(renameIds(kit.nodes, expected.ids), [...doc.nodes()])).toBeNull();
    // An edit it had waiting (or makes anyway) is refused, saying why.
    const page = kit.nodes.find((n) => n.type === "page") as NodeRecord;
    engine.commit([{ op: "set", id: page.id, prop: "name", value: "Old tab" }]);
    for (let i = 0; i < 100 && rejected.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejected.join(" ")).toMatch(/[Rr]eload/);
    expect(closed).toBeNull();
  });

  it("takes compact copies through the one-request import when it says so", async () => {
    const { browser, fileId } = await newFile();
    // A copy's text changed: compact, it's an override record.
    const text = kit.nodes.find((n) => n.type === "text" && n.props.mirrors) as NodeRecord;
    const edited = kit.nodes.map((n) =>
      n.id === text.id
        ? { ...n, props: { ...n.props, characters: "Changed", overrides: ["characters"] } }
        : n,
    );
    const converted = compactByInstance(edited);
    expect(converted.nodes.some((n) => n.type === "override")).toBe(true);
    await browser.json(`/api/files/${fileId}/import`, {
      method: "POST",
      json: { nodes: converted.nodes, copies: "compact" },
    });
    expect(firstDifference(converted.nodes, await stored(fileId))).toBeNull();
    // Override records sent without saying so are refused, not converted as materialized.
    const other = await newFile();
    const refused = await other.browser.fetch(`/api/files/${other.fileId}/import`, {
      method: "POST",
      json: { nodes: converted.nodes },
    });
    expect(refused.status).toBe(400);
  });

  it("keeps an edit from a tab that loaded the file before it converted when it touches no copy", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    // A tab of this version (it reads both forms), loaded while the file was materialized.
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 3, clientId: "before", revn: null, copies: BOTH });
    const welcome = await socket.next<{ mode: string; copies: string }>("welcome");
    expect([welcome.mode, welcome.copies]).toEqual(["snapshot", "materialized"]);
    await convert(fileId);
    const page = kit.nodes.find((n) => n.type === "page") as NodeRecord;
    socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: page.id, prop: "name", value: "Renamed before reloading" }],
    });
    await socket.next("ack");
    expect((await stored(fileId)).find((n) => n.id === page.id)?.props.name).toBe(
      "Renamed before reloading",
    );
    // One on a copy layer, by its old id, is refused, saying why.
    const copy = kit.nodes.find((n) => n.props.mirrors) as NodeRecord;
    socket.send({
      t: "txn",
      seq: 2,
      ops: [{ op: "set", id: copy.id, prop: "opacity", value: 0.5 }],
    });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("format");
  });

  it("pins a comment made with a copy's old id to its new one, and restoring the backup puts pins back", async () => {
    const root = kit.nodes.find(
      (n) => n.type === "frame" && n.props.instanceOf && kit.nodes.some((c) => c.parent === n.id),
    ) as NodeRecord;
    const target = kit.nodes.find((n) => n.parent === root.id) as NodeRecord;
    const page = kitPageOf(target.id);
    const { browser, fileId } = await materializedFile(kit.nodes);
    const pin = (nodeId: string) =>
      browser.json<{ thread: { id: string } }>(`/api/files/${fileId}/comments`, {
        method: "POST",
        json: { pageId: page.id, x: 1, y: 2, nodeId, offset: { x: 0, y: 0 }, body: "Here" },
      });
    const before = await pin(target.id);
    await convert(fileId);
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(roomOf(fileId));
    const derived = compactByInstance(kit.nodes).ids.get(target.id) as string;
    const pinned = async (threadId: string) =>
      (
        await env.DB.prepare("SELECT node_id FROM comment_threads WHERE id = ?")
          .bind(threadId)
          .first<{ node_id: string }>()
      )?.node_id;
    expect(await pinned(before.thread.id)).toBe(derived);
    // A tab that hasn't reloaded yet pins a comment to the copy's old id, after the pins moved.
    const late = await pin(target.id);
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(roomOf(fileId));
    expect(await pinned(late.thread.id)).toBe(derived);

    // Undone with conversion off: the pins go back to the layers as they were stored.
    const { backup } = await roomOf(fileId).copiesFormat();
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    const restored = await browser.fetch(`/api/files/${fileId}/versions/${backup}/restore`, {
      method: "POST",
      json: {},
    });
    expect(restored.status).toBe(200);
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(roomOf(fileId));
    expect(await pinned(before.thread.id)).toBe(target.id);
    expect(await pinned(late.thread.id)).toBe(target.id);
  });
});

const RED = [{ type: "solid" as const, color: "#ff0000" }];

/** A compact file with these nodes made on its first page, and a socket on it. */
async function fileWith(make: (page: string) => Op[]) {
  const made = await newFile("Second review");
  const { socket, nodes } = await open(made.browser, made.fileId);
  const page = (nodes.find((n) => n.type === "page") as NodeRecord).id;
  socket.send({ t: "txn", seq: 1, ops: make(page) });
  await socket.next("ack");
  return { ...made, socket, page };
}

const at = (n: number) => {
  let key: string | null = null;
  for (let i = 0; i <= n; i++) key = keyBetween(key, null);
  return key as string;
};

/** An instance as a compact editor places one: its root-local values only. */
const placeInstance = (id: string, page: string, main: string, n = 5): Op => ({
  op: "create",
  id,
  type: "frame",
  parent: page,
  key: at(n),
  props: { instanceOf: main, x: 300 + n * 10, y: 0 },
});

describe("what the second review of the conversion found", { timeout: 120_000 }, () => {
  /** An empty main that's red, and a main that's an instance of another (presenting its rect). */
  const mains = (page: string): Op[] => [
    {
      op: "create",
      id: "RedMain",
      type: "frame",
      parent: page,
      key: at(0),
      props: { name: "Red", isComponent: true, width: 40, height: 20, fills: RED },
    },
    {
      op: "create",
      id: "BaseMain",
      type: "frame",
      parent: page,
      key: at(1),
      props: { name: "Base", isComponent: true, width: 40, height: 20 },
    },
    {
      op: "create",
      id: "BaseRect",
      type: "rect",
      parent: "BaseMain",
      key: at(0),
      props: { width: 10, height: 10, fills: RED },
    },
    {
      op: "create",
      id: "WrapMain",
      type: "frame",
      parent: page,
      key: at(2),
      props: { instanceOf: "BaseMain", isComponent: true, x: 100 },
    },
  ];

  /** What `id` shows in the file as stored now: its own values and its layers. */
  async function shows(fileId: string, id: string) {
    const all = presented(await stored(fileId), "compact");
    const node = all.find((n) => n.id === id);
    return { node, layers: all.filter((n) => n.parent === id) };
  }

  for (const [what, main] of [
    ["an empty main", "RedMain"],
    ["a main that is itself an instance", "WrapMain"],
  ] as const)
    it(`refuses a merge that deletes ${what} an instance placed meanwhile shows`, async () => {
      const { browser, fileId, socket, page } = await fileWith(mains);
      const made = await browser.json<{ branch: { id: string } }>(`/api/files/${fileId}/branches`, {
        method: "POST",
        json: { name: "Tidy" },
      });
      const branch = await open(browser, made.branch.id);
      branch.socket.send({ t: "txn", seq: 1, ops: [{ op: "delete", id: main }] });
      await branch.socket.next("ack");
      socket.send({ t: "txn", seq: 2, ops: [placeInstance("Placed", page, main)] });
      await socket.next("ack");
      const before = await shows(fileId, "Placed");
      expect(before.node?.props.fills ?? before.layers[0]?.props.fills).toEqual(RED);
      const merged = await browser.fetch(`/api/files/${made.branch.id}/branch/merge`, {
        method: "POST",
        json: {},
      });
      expect(merged.status).not.toBe(200);
      expect(await merged.text()).toMatch(/instance/);
      const after = await shows(fileId, "Placed");
      expect(after.node?.props).toEqual(before.node?.props);
      expect(after.layers).toEqual(before.layers);
    });

  it("refuses an update from main that deletes a main the branch placed an instance of", async () => {
    const { browser, fileId, socket } = await fileWith(mains);
    const made = await browser.json<{ branch: { id: string } }>(`/api/files/${fileId}/branches`, {
      method: "POST",
      json: { name: "Use it" },
    });
    const branch = await open(browser, made.branch.id);
    const page = (branch.nodes.find((n) => n.type === "page") as NodeRecord).id;
    branch.socket.send({ t: "txn", seq: 1, ops: [placeInstance("Placed", page, "RedMain")] });
    await branch.socket.next("ack");
    socket.send({ t: "txn", seq: 2, ops: [{ op: "delete", id: "RedMain" }] });
    await socket.next("ack");
    const updated = await browser.fetch(`/api/files/${made.branch.id}/branch/update`, {
      method: "POST",
      json: {},
    });
    expect(updated.status).not.toBe(200);
    expect((await shows(made.branch.id, "Placed")).node?.props.fills).toEqual(RED);
  });

  for (const [what, op] of [
    ["deletes", { op: "delete", id: "RedMain" }],
    ["unmakes", { op: "set", id: "RedMain", prop: "isComponent", value: false }],
  ] as const)
    it(`refuses an edit that ${what} an empty main an instance takes its look from`, async () => {
      const { fileId, socket, page } = await fileWith((page) => [
        ...mains(page),
        placeInstance("Placed", page, "RedMain"),
      ]);
      socket.send({ t: "txn", seq: 2, ops: [op as Op] });
      expect((await socket.next<{ code: string }>("reject")).code).toBe("conflict");
      expect((await shows(fileId, "Placed")).node?.props.fills).toEqual(RED);
      // As the editor removes a main, its instance stored first as it shows: kept.
      const shown = (await shows(fileId, "Placed")).node as NodeRecord;
      const keep = Object.entries(shown.props)
        .filter(([prop]) => prop !== "instanceOf" && prop !== "x" && prop !== "y")
        .map(([prop, value]) => ({ op: "set", id: "Placed", prop, value }) as Op);
      socket.send({ t: "txn", seq: 3, ops: [...keep, op as Op] });
      await socket.next("ack");
      expect((await shows(fileId, "Placed")).node?.props.fills).toEqual(RED);
      void page;
    });

  for (const main of ["RedMain", "WrapMain"])
    it(`takes the editor's own deletion of ${main}, its instance kept as it showed`, async () => {
      const { fileId, socket, page } = await fileWith((page) => [
        ...mains(page),
        placeInstance("Placed", page, main),
      ]);
      const before = await shows(fileId, "Placed");
      const doc = new Doc();
      doc.resetStored(await stored(fileId), "compact");
      doc.apply([{ op: "delete", id: main }]);
      socket.send({ t: "txn", seq: 2, ops: [...doc.lastStoredOps] });
      await socket.next("ack");
      const after = await shows(fileId, "Placed");
      expect(after.node?.props).toEqual(before.node?.props);
      expect(after.layers.map((n) => [n.id, n.type, n.props])).toEqual(
        before.layers.map((n) => [n.id, n.type, n.props]),
      );
      void page;
    });

  it("refuses deleting a main that's an instance while an instance of it stores no layers", async () => {
    const { fileId, socket, page } = await fileWith((page) => [
      ...mains(page),
      placeInstance("Placed", page, "WrapMain"),
    ]);
    expect((await shows(fileId, "Placed")).layers).toHaveLength(1);
    socket.send({ t: "txn", seq: 2, ops: [{ op: "delete", id: "WrapMain" }] });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("conflict");
    expect((await shows(fileId, "Placed")).layers).toHaveLength(1);
    void page;
  });

  describe("ids held in values, from a tab that loaded the file before it converted", () => {
    const plainChain = (n: NodeRecord | undefined): boolean => {
      for (let at = n; at; at = kitById.get(at.parent))
        if (at.props.instanceOf || at.props.mirrors || at.props.isComponent) return false;
      return true;
    };
    // An ordinary frame on a screen, and a copy layer (inside an instance on a screen).
    const frame = kit.nodes.find(
      (n) => n.type === "frame" && n.parent !== ROOT_ID && plainChain(n),
    ) as NodeRecord;
    const page = kit.nodes.find((n) => n.type === "page") as NodeRecord;
    const copy = kit.nodes.find(
      (n) =>
        n.props.mirrors &&
        plainChain(kitById.get((kitById.get(n.parent) as NodeRecord).parent)) &&
        kitById.get(n.parent)?.props.instanceOf,
    ) as NodeRecord;
    const derived = compactByInstance(kit.nodes).ids.get(copy.id) as string;
    const reaction = (type: "navigate" | "overlay" | "swap-overlay", to: string) => ({
      id: "r1",
      trigger: { type: "tap" },
      action:
        type === "overlay"
          ? { type, to, position: "center", closeOnOutside: true, dim: 0.4 }
          : { type, to },
      transition: DEFAULT_TRANSITION,
    });

    /** A tab on the file from before it converted; the file converted since. */
    async function oldTab() {
      const { browser, fileId } = await materializedFile(kit.nodes);
      const tab = await open(browser, fileId);
      expect(tab.welcome.copies).toBe("materialized");
      await convert(fileId);
      expect(derived).not.toBe(copy.id);
      return { fileId, socket: tab.socket };
    }

    for (const [what, op, read] of [
      [
        "a reading order",
        { op: "set", id: frame.id, prop: "readingOrder", value: [copy.id] },
        (n: NodeRecord[]) => n.find((x) => x.id === frame.id)?.props.readingOrder,
      ],
      ...(["navigate", "overlay", "swap-overlay"] as const).map(
        (type) =>
          [
            `a prototype link (${type})`,
            { op: "set", id: frame.id, prop: "reactions", value: [reaction(type, copy.id)] },
            (n: NodeRecord[]) =>
              (
                n.find((x) => x.id === frame.id)?.props.reactions as Array<{
                  action: { to: string };
                }>
              )?.map((r) => [r.action.to]),
          ] as const,
      ),
      [
        "a flow's start",
        {
          op: "set",
          id: page.id,
          prop: "flows",
          value: [{ id: "f1", name: "Flow", start: copy.id, description: "" }],
        },
        (n: NodeRecord[]) =>
          (n.find((x) => x.id === page.id)?.props.flows as Array<{ start: string }>)?.map((f) => [
            f.start,
          ]),
      ],
      [
        "a new layer's prototype link",
        {
          op: "create",
          id: "NewLink",
          type: "rect",
          parent: frame.id,
          key: at(40),
          props: { width: 4, height: 4, reactions: [reaction("navigate", copy.id)] },
        },
        (n: NodeRecord[]) =>
          (
            n.find((x) => x.id === "NewLink")?.props.reactions as Array<{
              action: { to: string };
            }>
          )?.map((r) => [r.action.to]),
      ],
    ] as const)
      it(`names the copy by its new id when ${what} names it by its old one`, async () => {
        const { fileId, socket } = await oldTab();
        socket.send({ t: "txn", seq: 1, ops: [op] });
        await socket.next("ack");
        const after = await stored(fileId);
        const held = JSON.stringify(read(after));
        expect(held).toContain(derived);
        expect(held).not.toContain(copy.id);
      });

    for (const [what, ops] of [
      [
        "a text style",
        [
          {
            op: "create",
            id: "NewText",
            type: "text",
            parent: frame.id,
            key: at(40),
            props: { characters: "Hi", textStyle: copy.id },
          },
        ],
      ],
      [
        "a variable binding",
        [{ op: "set", id: frame.id, prop: "bindings", value: { fill: copy.id } }],
      ],
      [
        "a frame's variable modes",
        [{ op: "set", id: frame.id, prop: "variableModes", value: { [copy.id]: "m1" } }],
      ],
      [
        "a variable's alias",
        [
          {
            op: "create",
            id: "Coll",
            type: "collection",
            parent: ROOT_ID,
            key: at(40),
            props: { name: "Tokens" },
          },
          {
            op: "create",
            id: "Var",
            type: "variable",
            parent: "Coll",
            key: at(0),
            props: { name: "Brand", values: { m1: { alias: copy.id } } },
          },
        ],
      ],
    ] as const)
      it(`refuses ${what} naming a copy by its old id`, async () => {
        const { fileId, socket } = await oldTab();
        socket.send({ t: "txn", seq: 1, ops: ops as unknown as Op[] });
        expect((await socket.next<{ code: string }>("reject")).code).toBe("format");
        expect(JSON.stringify(await stored(fileId))).not.toContain(copy.id);
      });

    it("refuses a layer id it can't translate once the room let the map go", async () => {
      const { fileId, socket } = await oldTab();
      await runInDurableObject(roomOf(fileId), (_room, state) => {
        state.storage.sql.exec("DROP TABLE IF EXISTS pin_map");
      });
      socket.send({
        t: "txn",
        seq: 1,
        ops: [{ op: "set", id: frame.id, prop: "readingOrder", value: [copy.id] }],
      });
      expect((await socket.next<{ code: string }>("reject")).code).toBe("format");
      expect(JSON.stringify(await stored(fileId))).not.toContain(copy.id);
    });
  });

  it("never sends compact changes to a tab from before them that was open when the file converted", async () => {
    const { browser, fileId } = await materializedFile(kit.nodes);
    // Since keyed sets (protocol 3) a tab from before compact copies doesn't edit a materialized
    // file: it's told to reload. One that was let in before is checked as such below.
    const refused = await openSocket(browser, fileId);
    refused.send({ t: "hello", protocol: 1, clientId: "old-refused", revn: null });
    expect((await refused.next<{ code: string }>("error")).code).toBe("reload");
    const old = await openSocket(browser, fileId);
    old.send({ t: "hello", protocol: 3, clientId: "old-across", revn: null });
    expect((await old.next<{ copies?: string }>("welcome")).copies).toBe("materialized");
    for (;;) if ((await old.next<{ done: boolean }>("snapshot")).done) break;
    await convert(fileId);
    // Someone with a new tab edits the file, now compact: an instance root and a copy layer.
    const now = await open(browser, fileId);
    const root = now.nodes.find(
      (n) => n.type === "frame" && n.props.instanceOf && !now.nodes.some((c) => c.parent === n.id),
    ) as NodeRecord;
    const page = now.nodes.find((n) => n.type === "page") as NodeRecord;
    old.inbox.length = 0;
    now.socket.send({
      t: "txn",
      seq: 1,
      ops: [
        { op: "set", id: root.id, prop: "opacity", value: 0.5 },
        { op: "set", id: page.id, prop: "name", value: "Edited after converting" },
      ],
    });
    await now.socket.next("ack");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(old.inbox.filter((m) => m.t === "txn" || m.t === "snapshot")).toEqual([]);
    // Its own edit is refused, telling it to reload; then it's sent the file to view.
    old.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: page.id, prop: "name", value: "From the old tab" }],
    });
    expect((await old.next<{ message: string }>("reject")).message).toMatch(/[Rr]eload/);
    expect((await stored(fileId)).find((n) => n.id === page.id)?.props.name).toBe(
      "Edited after converting",
    );
  });

  it("puts pins back when a restore lands while a sweep moving them forward awaits", async () => {
    const root = kit.nodes.find(
      (n) => n.type === "frame" && n.props.instanceOf && kit.nodes.some((c) => c.parent === n.id),
    ) as NodeRecord;
    const target = kit.nodes.find((n) => n.parent === root.id) as NodeRecord;
    const page = kitPageOf(target.id);
    const { browser, fileId } = await materializedFile(kit.nodes);
    const { thread } = await browser.json<{ thread: { id: string } }>(
      `/api/files/${fileId}/comments`,
      {
        method: "POST",
        json: {
          pageId: page.id,
          x: 1,
          y: 2,
          nodeId: target.id,
          offset: { x: 0, y: 0 },
          body: "Hi",
        },
      },
    );
    const pinned = async () =>
      (
        await env.DB.prepare("SELECT node_id FROM comment_threads WHERE id = ?")
          .bind(thread.id)
          .first<{ node_id: string }>()
      )?.node_id;
    // The sweep after converting has read the pins and is about to move them; meanwhile the
    // backup is restored with conversion off, materialized again.
    let restored = 0;
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.pause = async (at) => {
        if (at !== "sweep" || restored !== 0) return;
        room.compactCopiesOff = true;
        const { backup } = await room.copiesFormat();
        restored = (
          await browser.fetch(`/api/files/${fileId}/versions/${backup}/restore`, {
            method: "POST",
            json: {},
          })
        ).status;
      };
    });
    // Converts, then sweeps (and the restore lands at that sweep).
    for (let i = 0; i < 500 && restored === 0; i++) await runDurableObjectAlarm(roomOf(fileId));
    expect(restored).toBe(200);
    for (let i = 0; i < 4; i++) await runDurableObjectAlarm(roomOf(fileId));
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    expect(await pinned()).toBe(target.id);
  });
});

describe("what the third review of the conversion found", { timeout: 120_000 }, () => {
  const BLUE = [{ type: "solid" as const, color: "#0000ff" }];
  /** A card main of one rectangle, red, and an instance of it placed on the page. */
  const card = (page: string): Op[] => [
    {
      op: "create",
      id: "CardMain",
      type: "frame",
      parent: page,
      key: at(0),
      props: { name: "Card", isComponent: true, width: 40, height: 40 },
    },
    {
      op: "create",
      id: "CardRect",
      type: "rect",
      parent: "CardMain",
      key: at(0),
      props: { name: "Fill", width: 10, height: 10, fills: RED },
    },
    placeInstance("Placed", page, "CardMain"),
  ];

  /** What `id` shows, layer by layer, without ids or link values: its look. */
  async function looks(fileId: string, id: string) {
    const doc = new Doc();
    doc.resetStored(await stored(fileId), "compact");
    const out: unknown[] = [];
    const walk = (at: string, depth: number) => {
      const node = doc.get(at) as NodeRecord;
      const props = { ...(node.props as Record<string, unknown>) };
      for (const prop of ["mirrors", "overrides", "unset", "instanceOf"]) delete props[prop];
      out.push([depth, node.type, props]);
      for (const child of doc.childIds(at)) walk(child, depth + 1);
    };
    walk(id, 0);
    return out;
  }

  for (const [what, change, shows] of [
    [
      "added a layer to the main",
      (): Op[] => [
        {
          op: "create",
          id: "CardRect2",
          type: "rect",
          parent: "CardMain",
          key: at(1),
          props: { name: "Second", width: 5, height: 5 },
        },
      ],
      (look: unknown[]) => expect(look).toHaveLength(3),
    ],
    [
      "changed the main's fill",
      (): Op[] => [{ op: "set", id: "CardRect", prop: "fills", value: BLUE }],
      (look: unknown[]) => expect(JSON.stringify(look)).toContain("#0000ff"),
    ],
  ] as const)
    it(`refuses deleting a main from a view from before another tab ${what}, then takes it made again`, async () => {
      const { browser, fileId, socket } = await fileWith(card);
      // A tab that loaded the file now, and deletes the main after someone else's change.
      const stale = new Doc();
      stale.resetStored(await stored(fileId), "compact");
      socket.send({ t: "txn", seq: 2, ops: change() });
      await socket.next("ack");
      const before = await looks(fileId, "Placed");
      shows(before);
      stale.apply([{ op: "delete", id: "CardMain" }]);
      const old = await open(browser, fileId);
      old.socket.send({ t: "txn", seq: 1, ops: [...stale.lastStoredOps] });
      const refused = await old.socket.next<{ code: string; message: string }>("reject");
      expect(refused.code).toBe("conflict");
      expect(refused.message).toBe(
        "Removing the component “Card” would change how its instance “Card” looks, so nothing was changed. If someone just changed that instance or the component, try again; otherwise detach the instance first.",
      );
      expect(await looks(fileId, "Placed")).toEqual(before);
      // Caught up, the same deletion stores the instance as it shows now: taken.
      const fresh = new Doc();
      fresh.resetStored(await stored(fileId), "compact");
      fresh.apply([{ op: "delete", id: "CardMain" }]);
      old.socket.send({ t: "txn", seq: 2, ops: [...fresh.lastStoredOps] });
      await old.socket.next("ack");
      expect((await stored(fileId)).some((n) => n.id === "CardMain")).toBe(false);
      expect(await looks(fileId, "Placed")).toEqual(before);
    });

  it("takes the editor's deletion of a main whose instance stores a default (unset fills)", async () => {
    const { fileId, socket } = await fileWith(card);
    // The instance shows no fill where its main's root is red: it stores `unset`.
    socket.send({
      t: "txn",
      seq: 2,
      ops: [
        { op: "set", id: "CardMain", prop: "fills", value: RED },
        { op: "set", id: "Placed", prop: "unset", value: ["fills"] },
      ],
    });
    await socket.next("ack");
    const before = await looks(fileId, "Placed");
    expect(JSON.stringify(before[0])).not.toContain("#ff0000");
    const doc = new Doc();
    doc.resetStored(await stored(fileId), "compact");
    doc.apply([{ op: "delete", id: "CardMain" }]);
    // The editor drops `unset` and leaves the fills absent: the same look.
    expect(doc.lastStoredOps).toContainEqual({
      op: "set",
      id: "Placed",
      prop: "unset",
      value: null,
    });
    socket.send({ t: "txn", seq: 3, ops: [...doc.lastStoredOps] });
    await socket.next("ack");
    expect(await looks(fileId, "Placed")).toEqual(before);
  });

  /** A button main holding an icon instance; an instance of the button; a card main holding one. */
  const nested = (page: string): Op[] => [
    {
      op: "create",
      id: "Icon",
      type: "frame",
      parent: page,
      key: at(0),
      props: { name: "Icon", isComponent: true, width: 10, height: 10 },
    },
    {
      op: "create",
      id: "IconPath",
      type: "rect",
      parent: "Icon",
      key: at(0),
      props: { name: "Glyph", width: 5, height: 5, fills: RED },
    },
    {
      op: "create",
      id: "Btn",
      type: "frame",
      parent: page,
      key: at(1),
      props: { name: "Button", isComponent: true, width: 40, height: 20 },
    },
    {
      op: "create",
      id: "BtnIcon",
      type: "frame",
      parent: "Btn",
      key: at(0),
      props: { instanceOf: "Icon" },
    },
    placeInstance("PlacedBtn", page, "Btn", 3),
    {
      op: "create",
      id: "CardOfBtn",
      type: "frame",
      parent: page,
      key: at(4),
      props: { name: "Card", isComponent: true, width: 80, height: 40 },
    },
    {
      op: "create",
      id: "CardBtn",
      type: "frame",
      parent: "CardOfBtn",
      key: at(0),
      props: { instanceOf: "Btn" },
    },
    placeInstance("PlacedCard", page, "CardOfBtn", 6),
  ];

  it("takes the editor's deletion of a main holding a nested instance, its instances kept as they showed", async () => {
    const { fileId, socket } = await fileWith(nested);
    const before = [await looks(fileId, "PlacedBtn"), await looks(fileId, "PlacedCard")];
    const doc = new Doc();
    doc.resetStored(await stored(fileId), "compact");
    doc.apply([{ op: "delete", id: "Btn" }]);
    socket.send({ t: "txn", seq: 2, ops: [...doc.lastStoredOps] });
    await socket.next("ack");
    expect([await looks(fileId, "PlacedBtn"), await looks(fileId, "PlacedCard")]).toEqual(before);
  });

  it("refuses the editor's deletion that would lose an override inside an instance of a main holding one", async () => {
    const { browser, fileId, socket } = await fileWith(nested);
    // The card's instance overrides the glyph inside its button's icon: a record under that id.
    const doc = new Doc();
    doc.resetStored(await stored(fileId), "compact");
    const glyph = (() => {
      const walk = (at: string): string | null => {
        if (doc.get(at)?.type === "rect") return at;
        for (const child of doc.childIds(at)) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk("PlacedCard") as string;
    })();
    doc.apply([{ op: "set", id: glyph, prop: "fills", value: BLUE }]);
    socket.send({ t: "txn", seq: 2, ops: [...doc.lastStoredOps] });
    await socket.next("ack");
    const before = await looks(fileId, "PlacedCard");
    expect(JSON.stringify(before)).toContain("#0000ff");
    // Storing the button's nested icon gives its layers other ids, which the record doesn't name.
    doc.apply([{ op: "delete", id: "Btn" }]);
    socket.send({ t: "txn", seq: 3, ops: [...doc.lastStoredOps] });
    const refused = await socket.next<{ code: string; message: string }>("reject");
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(
      /Removing the component “Button” would change how its instance “Card” looks/,
    );
    expect(await looks(fileId, "PlacedCard")).toEqual(before);
    // As it says: detached first, the card's instance keeps its look, and the button goes.
    const fresh = new Doc();
    fresh.resetStored(await stored(fileId), "compact");
    const again = await open(browser, fileId);
    fresh.apply([{ op: "set", id: "PlacedCard", prop: "instanceOf", value: null }]);
    again.socket.send({ t: "txn", seq: 1, ops: [...fresh.lastStoredOps] });
    await again.socket.next("ack");
    fresh.apply([{ op: "delete", id: "Btn" }]);
    again.socket.send({ t: "txn", seq: 2, ops: [...fresh.lastStoredOps] });
    await again.socket.next("ack");
    expect(JSON.stringify(await looks(fileId, "PlacedCard"))).toContain("#0000ff");
  });

  it("refuses a merge whose branch deleted a main main placed an instance of since, and takes it once that's gone", async () => {
    const { browser, fileId, socket, page } = await fileWith(card);
    const made = await browser.json<{ branch: { id: string } }>(`/api/files/${fileId}/branches`, {
      method: "POST",
      json: { name: "Tidy" },
    });
    // On the branch, the editor deletes the main, storing its instance as it shows there.
    const branchDoc = new Doc();
    branchDoc.resetStored(await stored(made.branch.id), "compact");
    branchDoc.apply([{ op: "delete", id: "CardMain" }]);
    const branch = await open(browser, made.branch.id);
    branch.socket.send({ t: "txn", seq: 1, ops: [...branchDoc.lastStoredOps] });
    await branch.socket.next("ack");
    // On main meanwhile, another instance of it.
    socket.send({ t: "txn", seq: 2, ops: [placeInstance("Later", page, "CardMain", 9)] });
    await socket.next("ack");
    const before = await looks(fileId, "Later");
    const merge = () =>
      browser.fetch(`/api/files/${made.branch.id}/branch/merge`, { method: "POST", json: {} });
    const refused = await merge();
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(
      "These changes can't be merged as they are. Removing the component “Card” would change how its instance “Card” looks, so nothing was changed.",
    );
    expect(await looks(fileId, "Later")).toEqual(before);
    // That instance deleted on main, the same merge goes in, the first instance looking as it did.
    const placed = await looks(fileId, "Placed");
    socket.send({ t: "txn", seq: 3, ops: [{ op: "delete", id: "Later" }] });
    await socket.next("ack");
    expect((await merge()).status).toBe(200);
    expect((await stored(fileId)).some((n) => n.id === "CardMain")).toBe(false);
    expect(await looks(fileId, "Placed")).toEqual(placed);
  });

  it("refuses removing a main whose instance is too large to check, saying so", async () => {
    const { fileId, socket } = await fileWith(card);
    // Over MAX_INSTANCE_BUILT layers in the main, a few thousand a transaction.
    let key = at(0);
    for (let batch = 0; batch < 6; batch++) {
      const ops: Op[] = [];
      for (let i = 0; i < 2_000; i++) {
        key = keyBetween(key, null);
        ops.push({
          op: "create",
          id: `Cell${batch}x${i}`,
          type: "rect",
          parent: "CardMain",
          key,
          props: {},
        });
      }
      socket.send({ t: "txn", seq: 2 + batch, ops });
      await socket.next("ack", 30_000);
    }
    socket.send({
      t: "txn",
      seq: 20,
      ops: [{ op: "set", id: "CardMain", prop: "isComponent", value: false }],
    });
    const refused = await socket.next<{ code: string; message: string }>("reject", 30_000);
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(/too large to check \(12,001 layers shown, more than 10,000\)/);
    // Nothing changed: still a component.
    expect((await stored(fileId)).find((n) => n.id === "CardMain")?.props.isComponent).toBe(true);
  });

  describe("comment pins once the room let the map go", () => {
    const root = kit.nodes.find(
      (n) => n.type === "frame" && n.props.instanceOf && kit.nodes.some((c) => c.parent === n.id),
    ) as NodeRecord;
    const target = kit.nodes.find((n) => n.parent === root.id) as NodeRecord;
    const page = kitPageOf(root.id);
    const derived = compactByInstance(kit.nodes).ids.get(target.id) as string;

    /** A kit converted a week ago: its pins moved, its map saved to R2 and let go. */
    async function expired() {
      const made = await materializedFile(kit.nodes);
      await convert(made.fileId);
      for (let i = 0; i < 3; i++) await runDurableObjectAlarm(roomOf(made.fileId));
      await runInDurableObject(roomOf(made.fileId), (_room, state) => {
        state.storage.sql.exec("UPDATE meta SET v = '0' WHERE k = 'pins_until'");
      });
      for (let i = 0; i < 3; i++) await runDurableObjectAlarm(roomOf(made.fileId));
      const kept = await runInDurableObject(roomOf(made.fileId), (_room, state) => ({
        map: state.storage.sql
          .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pin_map'")
          .toArray().length,
        key: state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'pins_key'").one()
          .v,
      }));
      expect(kept.map).toBe(0);
      return { ...made, key: kept.key };
    }
    const pinAt = (browser: Browser, fileId: string, nodeId: string) =>
      browser.fetch(`/api/files/${fileId}/comments`, {
        method: "POST",
        json: { pageId: page.id, x: 1, y: 2, nodeId, offset: { x: 3, y: 4 }, body: "Here" },
      });
    const anchorOf = async (response: Response) => {
      expect(response.status).toBe(201);
      return ((await response.json()) as { thread: { anchor: Record<string, unknown> } }).thread
        .anchor;
    };

    it("translates a copy's old id through the map kept in R2", async () => {
      const { browser, fileId } = await expired();
      expect(await anchorOf(await pinAt(browser, fileId, target.id))).toEqual({
        x: 1,
        y: 2,
        nodeId: derived,
        offset: { x: 3, y: 4 },
      });
    });

    it("pins to the page, not to a layer the file doesn't have", async () => {
      const { browser, fileId, key } = await expired();
      expect(await anchorOf(await pinAt(browser, fileId, "NoSuchLayer0000"))).toEqual({
        x: 1,
        y: 2,
        nodeId: null,
        offset: null,
      });
      // With the copy in R2 gone too, an old id is one the file doesn't have.
      await env.FILES.delete(key);
      expect((await anchorOf(await pinAt(browser, fileId, target.id))).nodeId).toBeNull();
      // Moving a pin onto it, the same.
      const { thread } = await browser.json<{ thread: { id: string } }>(
        `/api/files/${fileId}/comments`,
        { method: "POST", json: { pageId: page.id, x: 0, y: 0, body: "Unpinned" } },
      );
      const moved = await browser.json<{ thread: { anchor: Record<string, unknown> } }>(
        `/api/files/${fileId}/comments/${thread.id}`,
        {
          method: "PATCH",
          json: { anchor: { x: 5, y: 6, nodeId: target.id, offset: { x: 1, y: 1 } } },
        },
      );
      expect(moved.thread.anchor).toEqual({ x: 5, y: 6, nodeId: null, offset: null });
    });

    it("keeps a copy layer's own id, record or none, and a stored layer's", async () => {
      const { browser, fileId } = await expired();
      // A copy layer with no record: found on the comment's page.
      expect((await anchorOf(await pinAt(browser, fileId, derived))).nodeId).toBe(derived);
      expect((await anchorOf(await pinAt(browser, fileId, root.id))).nodeId).toBe(root.id);
      // And one with a record (its own opacity), as the editor stores it.
      const doc = new Doc();
      doc.resetStored(await stored(fileId), "compact");
      doc.apply([{ op: "set", id: derived, prop: "opacity", value: 0.5 }]);
      const tab = await open(browser, fileId);
      tab.socket.send({ t: "txn", seq: 1, ops: [...doc.lastStoredOps] });
      await tab.socket.next("ack");
      expect((await stored(fileId)).find((n) => n.id === derived)?.type).toBe("override");
      expect((await anchorOf(await pinAt(browser, fileId, derived))).nodeId).toBe(derived);
    });

    it("pins to the page when the map in R2 can't be read, never to the old id", async () => {
      const { browser, fileId } = await expired();
      // R2 failing: every read of the bucket throws, in the room that translates.
      await runInDurableObject(roomOf(fileId), (room) => {
        const real = (room as unknown as { env: WorkerEnv }).env;
        const failing = new Proxy(real.FILES, {
          get(target, prop, receiver) {
            if (prop === "get") return () => Promise.reject(new Error("R2 is unavailable"));
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        (room as unknown as { env: WorkerEnv }).env = { ...real, FILES: failing };
      });
      expect(await anchorOf(await pinAt(browser, fileId, target.id))).toEqual({
        x: 1,
        y: 2,
        nodeId: null,
        offset: null,
      });
      // Moving a pin onto the old id, the same.
      const { thread } = await browser.json<{ thread: { id: string } }>(
        `/api/files/${fileId}/comments`,
        { method: "POST", json: { pageId: page.id, x: 0, y: 0, body: "Unpinned" } },
      );
      const moved = await browser.json<{ thread: { anchor: Record<string, unknown> } }>(
        `/api/files/${fileId}/comments/${thread.id}`,
        {
          method: "PATCH",
          json: { anchor: { x: 5, y: 6, nodeId: target.id, offset: { x: 1, y: 1 } } },
        },
      );
      expect(moved.thread.anchor).toEqual({ x: 5, y: 6, nodeId: null, offset: null });
      // A layer the file has still pins to it.
      expect((await anchorOf(await pinAt(browser, fileId, root.id))).nodeId).toBe(root.id);
    });

    it("pins to the page when the map in R2 is damaged (a gzip read error)", async () => {
      const { browser, fileId, key } = await expired();
      await env.FILES.put(key, new TextEncoder().encode("not gzip at all, just text"));
      expect(await anchorOf(await pinAt(browser, fileId, target.id))).toEqual({
        x: 1,
        y: 2,
        nodeId: null,
        offset: null,
      });
    });
  });
});

describe("a main containing an instance of itself (the fourth review)", {
  timeout: 120_000,
}, () => {
  const page: NodeRecord = { id: "CyPage", type: "page", parent: "root", key: "a0", props: {} };
  const main = (id: string, key: string): NodeRecord => ({
    id,
    type: "frame",
    parent: page.id,
    key,
    props: { isComponent: true, name: id },
  });
  const instance = (id: string, parent: string, of: string, key: string): NodeRecord => ({
    id,
    type: "frame",
    parent,
    key,
    props: { instanceOf: of },
  });

  it("is refused by the room, whoever sends it", async () => {
    const { browser, fileId } = await materializedFile([
      page,
      main("CyA", "a0"),
      { id: "CyRect", type: "rect", parent: "CyA", key: "a0", props: {} },
      main("CyB", "a1"),
      instance("CyIA", "CyB", "CyA", "a0"),
      { id: "CyRectCopy", type: "rect", parent: "CyIA", key: "a0", props: { mirrors: "CyRect" } },
    ]);
    await convert(fileId);
    const { socket } = await open(browser, fileId);
    // B holds an instance of A: an instance of B inside A would hold itself.
    socket.send({
      t: "txn",
      seq: 1,
      ops: [
        {
          op: "create",
          id: "CyLoop",
          type: "frame",
          parent: "CyA",
          key: "a5",
          props: { instanceOf: "CyB" },
        },
      ],
    });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("cycle");
    // Directly, too, and by relinking.
    socket.send({
      t: "txn",
      seq: 2,
      ops: [{ op: "set", id: "CyIA", prop: "instanceOf", value: "CyB" }],
    });
    expect((await socket.next<{ code: string }>("reject")).code).toBe("cycle");
    expect((await stored(fileId)).find((n) => n.id === "CyIA")?.props.instanceOf).toBe("CyA");
  });

  it("converts a file that holds one: those instances are detached, keeping what they show", async () => {
    // Written before the model refused it: a main holding fourteen instances of itself (built
    // as instances, it would present millions of layers), and an instance of it on the page.
    const nodes: NodeRecord[] = [page, main("CyM", "a0")];
    for (let i = 0; i < 14; i++)
      nodes.push(instance(`CyS${i}`, "CyM", "CyM", `a${String.fromCharCode(65 + i)}`));
    nodes.push(instance("CyInst", page.id, "CyM", "a1"));
    // And an ordinary component beside it, which converts as ever.
    nodes.push(main("CyOk", "a2"));
    nodes.push({ id: "CyOkRect", type: "rect", parent: "CyOk", key: "a0", props: { name: "R" } });
    nodes.push(instance("CyOkInst", page.id, "CyOk", "a3"));
    nodes.push({
      id: "CyOkCopy",
      type: "rect",
      parent: "CyOkInst",
      key: "a0",
      props: { name: "R", mirrors: "CyOkRect" },
    });
    const { fileId } = await materializedFile(nodes);
    await convert(fileId);
    const format = await roomOf(fileId).copiesFormat();
    expect(format.failed).toBeNull();
    expect(format.copies).toBe("compact");
    const detached = new Set(format.detached.map((d) => d.root));
    for (let i = 0; i < 14; i++) expect(detached.has(`CyS${i}`)).toBe(true);
    expect(detached.has("CyOkInst")).toBe(false);
    // What it shows is what it stored: every layer, the loop's instances unlinked.
    const shown = presented(await stored(fileId), "compact");
    const ids = new Set(shown.map((n) => n.id));
    for (const node of nodes) if (node.id !== "CyOkCopy") expect(ids.has(node.id)).toBe(true);
    expect(shown.find((n) => n.id === "CyS0")?.props.instanceOf).toBeUndefined();
    expect(shown.filter((n) => n.parent === "CyOkInst")).toHaveLength(1);
  });
});

describe("what the fifth review found", { timeout: 120_000 }, () => {
  const frame = (id: string, parent: string, key: string, props: NodeRecord["props"]): Op => ({
    op: "create",
    id,
    type: "frame",
    parent,
    key,
    props,
  });

  it("restores a version whose components hold each other the other way round", async () => {
    // The version: B holds an instance of A. The file now: A holds an instance of B, and B
    // nothing. A restore creates the version's IA before it deletes the file's IB.
    const { browser, fileId, socket, page } = await fileWith((page) => [
      frame("FvA", page, "a0", { isComponent: true, name: "A" }),
      { op: "create", id: "FvRect", type: "rect", parent: "FvA", key: "a0", props: {} },
      frame("FvB", page, "a1", { isComponent: true, name: "B" }),
      frame("FvIA", "FvB", "a0", { instanceOf: "FvA" }),
    ]);
    void page;
    const saved = await browser.json<{ version: { id: string } }>(`/api/files/${fileId}/versions`, {
      method: "POST",
      json: { name: "B holds A" },
    });
    socket.send({
      t: "txn",
      seq: 2,
      ops: [{ op: "delete", id: "FvIA" }, frame("FvIB", "FvA", "a5", { instanceOf: "FvB" })],
    });
    await socket.next("ack");
    const restored = await browser.fetch(
      `/api/files/${fileId}/versions/${saved.version.id}/restore`,
      { method: "POST", json: {} },
    );
    expect(restored.status).toBe(200);
    const after = await stored(fileId);
    expect(after.find((n) => n.id === "FvIA")?.parent).toBe("FvB");
    expect(after.find((n) => n.id === "FvIB")).toBeUndefined();
  });

  it("refuses a compact import holding a component that contains its own instance", async () => {
    const { browser, fileId } = await newFile();
    const before = await stored(fileId);
    const nodes: NodeRecord[] = [
      { id: "LpPage", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
      { id: "LpA", type: "frame", parent: "LpPage", key: "a0", props: { isComponent: true } },
      { id: "LpRect", type: "rect", parent: "LpA", key: "a0", props: {} },
      { id: "LpSelf", type: "frame", parent: "LpA", key: "a1", props: { instanceOf: "LpA" } },
      { id: "LpI", type: "frame", parent: "LpPage", key: "a1", props: { instanceOf: "LpA" } },
    ];
    const { importId } = await browser.json<{ importId: string }>(`/api/files/${fileId}/imports`, {
      method: "POST",
      json: {},
    });
    const parts = `/api/files/${fileId}/imports/${importId}`;
    await browser.json(`${parts}/parts`, { method: "POST", json: { nodes } });
    const commit = await browser.fetch(`${parts}/commit`, {
      method: "POST",
      json: { copies: "compact" },
    });
    expect(commit.status).toBe(400);
    expect(await commit.text()).toMatch(/LpA contains an instance of itself/);
    expect(firstDifference(before, await stored(fileId))).toBeNull();
  });

  it("saves a fresh backup when a file converts again after a rollback", async () => {
    const nodes: NodeRecord[] = [
      { id: "BkPage", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page" } },
      { id: "BkMain", type: "frame", parent: "BkPage", key: "a0", props: { isComponent: true } },
      { id: "BkRect", type: "rect", parent: "BkMain", key: "a0", props: { name: "R" } },
      { id: "BkInst", type: "frame", parent: "BkPage", key: "a1", props: { instanceOf: "BkMain" } },
      {
        id: "BkCopy",
        type: "rect",
        parent: "BkInst",
        key: "a0",
        props: { name: "R", mirrors: "BkRect" },
      },
    ];
    const { browser, fileId } = await materializedFile(nodes);
    await convert(fileId);
    const first = (await roomOf(fileId).copiesFormat()).backup;
    expect(first).not.toBeNull();
    // Compact copies turned off: the backup is restored, the file materialized again.
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    const restored = await browser.fetch(`/api/files/${fileId}/versions/${first}/restore`, {
      method: "POST",
      json: {},
    });
    expect(restored.status).toBe(200);
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    // An acknowledged edit, then compact copies on again before any autosave.
    const { socket } = await open(browser, fileId);
    socket.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "BkPage", prop: "name", value: "Edited after rollback" }],
    });
    await socket.next("ack");
    socket.ws.close();
    await runInDurableObject(roomOf(fileId), async (room: FileRoom, state) => {
      room.compactCopiesOff = false;
      await state.storage.setAlarm(Date.now());
    });
    await convert(fileId);
    const second = (await roomOf(fileId).copiesFormat()).backup;
    expect(second).not.toBe(first);
    // The backup a second rollback restores holds the edit.
    const text = await (
      await browser.fetch(`/api/files/${fileId}/versions/${second}/snapshot`)
    ).text();
    const page = parseSnapshot(text)?.nodes.find((n) => n.id === "BkPage");
    expect(page?.props.name).toBe("Edited after rollback");
  });
});

describe("what the sixth review found", { timeout: 120_000 }, () => {
  /** What a tab from before compact copies (protocol 1) is sent of a file, every chunk. */
  async function oldClientSees(browser: Browser, fileId: string): Promise<NodeRecord[]> {
    const old = await openSocket(browser, fileId);
    old.send({ t: "hello", protocol: 1, clientId: `old-${newId()}`, revn: null });
    await old.next("welcome");
    const received: NodeRecord[] = [];
    for (;;) {
      const chunk = await old.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
      received.push(...chunk.nodes);
      if (chunk.done) break;
    }
    old.ws.close();
    return received;
  }

  it("sends a tab from before compact copies the document's styles and variables, not only its pages", async () => {
    const { browser, projectId } = await signedInUser("Sixth review");
    const { file } = await browser.json<{ file: { id: string } }>(
      `/api/projects/${projectId}/files`,
      { method: "POST", json: { name: "Assets" } },
    );
    const nodes: NodeRecord[] = [
      { id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} },
      { id: "Style", parent: ROOT_ID, key: "a1", type: "textStyle", props: { fontSize: 40 } },
      { id: "Tokens", parent: ROOT_ID, key: "a2", type: "collection", props: {} },
      {
        id: "Token",
        parent: "Tokens",
        key: "a0",
        type: "variable",
        props: { variableType: "number", values: { m1: 42 } },
      },
      {
        id: "Text",
        parent: "P",
        key: "a0",
        type: "text",
        props: { characters: "Hello", textStyle: "Style", fontSize: 40 },
      },
    ];
    const imported = await roomOf(file.id).importNodes(
      { userId: "system", name: "Review" },
      nodes,
      file.id,
      "compact",
    );
    expect(imported.ok).toBe(true);
    const ids = (await oldClientSees(browser, file.id)).map((n) => n.id).sort();
    expect(ids).toEqual(["P", "Style", "Text", "Token", "Tokens"]);
  });

  it("sends a tab from before compact copies a page saying to reload when the file is too large to send it", async () => {
    const { browser, projectId } = await signedInUser("Sixth review large");
    const { file } = await browser.json<{ file: { id: string } }>(
      `/api/projects/${projectId}/files`,
      { method: "POST", json: { name: "Large" } },
    );
    // 45 texts of 200,000 characters: past the 8 MB a socket is sent.
    const nodes: NodeRecord[] = [{ id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} }];
    for (let i = 0; i < 45; i++)
      nodes.push({
        id: `T${i}`,
        parent: "P",
        key: "a0",
        type: "text",
        props: { characters: "x".repeat(200_000) },
      });
    const imported = await roomOf(file.id).importNodes(
      { userId: "system", name: "Review" },
      nodes,
      file.id,
      "compact",
    );
    expect(imported.ok).toBe(true);
    const seen = await oldClientSees(browser, file.id);
    expect(seen.map((n) => n.id)).toEqual(["drawpane-reload-page", "drawpane-reload-text"]);
    expect(seen[1]?.props.characters).toBe(
      "Drawpane was updated. Reload the page to see this file.",
    );
  });
});

describe("what the seventh review found", { timeout: 120_000 }, () => {
  /** A hello, its welcome, and every chunk of the snapshot after it. */
  async function hello(browser: Browser, fileId: string, message: Record<string, unknown>) {
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", clientId: `c-${newId()}`, revn: null, ...message });
    const welcome = await socket.next<{ role: string; revn: number; mode: string }>("welcome");
    const nodes: NodeRecord[] = [];
    if (welcome.mode === "snapshot")
      for (;;) {
        const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
        nodes.push(...chunk.nodes);
        if (chunk.done) break;
      }
    return { socket, welcome, nodes };
  }

  it("sends a client that can't download a file stored materialized, too large to send it, a page saying to reload", async () => {
    // 45 texts of 200,000 characters, stored materialized with conversion turned off (as after a
    // rollback; a conversion pending or refused leaves it the same): past the socket's 8 MB.
    const nodes: NodeRecord[] = [{ id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} }];
    for (let i = 0; i < 45; i++)
      nodes.push({
        id: `T${i}`,
        parent: "P",
        key: "a0",
        type: "text",
        props: { characters: "x".repeat(200_000) },
      });
    const { browser, fileId } = await materializedFile(nodes);
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    await runDurableObjectAlarm(roomOf(fileId));
    expect((await roomOf(fileId).copiesFormat()).copies).toBe("materialized");
    const placeholder = ["drawpane-reload-page", "drawpane-reload-text"];

    // A tab from before compact copies is told to reload (protocol 3, decision 0035).
    const before = await openSocket(browser, fileId);
    before.send({ t: "hello", protocol: 1, clientId: `c-${newId()}`, revn: null });
    expect((await before.next<{ code: string }>("error")).code).toBe("reload");
    // A client that doesn't say it can download.
    for (const message of [{ protocol: 3, copies: BOTH }]) {
      const { socket, welcome, nodes: seen } = await hello(browser, fileId, message);
      expect(welcome).toMatchObject({ role: "viewer", revn: 0, mode: "snapshot" });
      expect(seen.map((n) => n.id)).toEqual(placeholder);
      // Its edits are refused (the placeholder is never stored), telling it to reload.
      socket.send({
        t: "txn",
        seq: 1,
        ops: [{ op: "set", id: "drawpane-reload-page", prop: "name", value: "Mine" }],
      });
      const reject = await socket.next<{ code: string; message: string }>("reject");
      expect(reject).toMatchObject({ code: "format", message: expect.stringMatching(/Reload/) });
      socket.ws.close();
      // Reconnecting at the revision it was welcomed at, it isn't caught up onto the placeholder.
      const again = await hello(browser, fileId, { ...message, revn: 0 });
      expect(again.welcome).toMatchObject({ role: "viewer", revn: 0, mode: "snapshot" });
      expect(again.nodes.map((n) => n.id)).toEqual(placeholder);
      again.socket.ws.close();
    }
    // A client that can download does.
    const current = await hello(browser, fileId, { protocol: 3, copies: BOTH, download: true });
    expect(current.welcome).toMatchObject({ role: "owner", mode: "download" });
    current.socket.ws.close();
    expect(await stored(fileId)).toHaveLength(46);
  });

  it("tells a tab from before keyed sets to reload, in a file stored either way", async () => {
    const nodes: NodeRecord[] = [
      { id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} },
      { id: "T", parent: "P", key: "a0", type: "text", props: { characters: "Hi" } },
    ];
    for (const off of [true, false]) {
      const { browser, fileId } = await materializedFile(nodes);
      await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
        room.compactCopiesOff = off;
      });
      if (!off) await convert(fileId);
      const socket = await openSocket(browser, fileId);
      socket.send({ t: "hello", protocol: 2, clientId: `c-${newId()}`, revn: null, copies: BOTH });
      expect((await socket.next<{ code: string }>("error")).code).toBe("reload");
    }
  });

  it("tells a small file stored materialized's tab from before compact copies to reload", async () => {
    const nodes: NodeRecord[] = [
      { id: "P", parent: ROOT_ID, key: "a0", type: "page", props: {} },
      { id: "T", parent: "P", key: "a0", type: "text", props: { characters: "Hi" } },
    ];
    const { browser, fileId } = await materializedFile(nodes);
    await runInDurableObject(roomOf(fileId), (room: FileRoom) => {
      room.compactCopiesOff = true;
    });
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 1, clientId: `c-${newId()}`, revn: null });
    expect((await socket.next<{ code: string }>("error")).code).toBe("reload");
    socket.ws.close();
  });
});
