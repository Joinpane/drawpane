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
  firstDifference,
  libraryAssets,
  type NodeRecord,
  nodeReader,
  type Op,
  parseSnapshot,
  ROOT_ID,
  renameIds,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import type { FileRoom } from "../src/rooms/file-room";
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
  socket.send({ t: "hello", protocol: 2, clientId: `c-${file.id}`, revn: null, copies: BOTH });
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
    protocol: 2,
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
      room.convertStepMs = 0;
    });
    const socket = await openSocket(browser, fileId);
    socket.send({ t: "hello", protocol: 2, clientId: "editor", revn: null, copies: BOTH });
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
    // A client from before compact copies still opens it.
    const old = await openSocket(browser, fileId);
    old.send({ t: "hello", protocol: 1, clientId: "old", revn: null });
    expect((await old.next<{ mode: string }>("welcome")).mode).toBe("snapshot");

    // Turned on, it converts; turned off again, restoring the version saved before puts the
    // file back as it was stored, materialized.
    // (A deploy that turns it on again restarts the room, which schedules its alarm.)
    await runInDurableObject(roomOf(fileId), async (room: FileRoom, state) => {
      room.compactCopiesOff = false;
      await state.storage.setAlarm(Date.now());
    });
    await convert(fileId);
    // The old client is told to reload: it can't read compact copies.
    const again = await openSocket(browser, fileId);
    again.send({ t: "hello", protocol: 1, clientId: "old2", revn: null });
    expect((await again.next<{ code: string }>("error")).code).toBe("reload");

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
