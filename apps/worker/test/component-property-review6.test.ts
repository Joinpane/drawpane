/**
 * Every instance keeps a record (decision 0035, item 3), in a real room
 * (review 6 of #187, A): a file from before records migrates when its room
 * loads (a version first, a step at a time, logged so connected clients
 * follow, once); an edit reaching an instance not migrated yet has it folded
 * first; content coming in whole (an import, a restored version) comes in
 * folded; and an edit that would leave an instance without one is refused,
 * saying so.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { Doc } from "@drawpane/editor";
import { compactByInstance, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { BEFORE_RECORDS } from "../src/rooms/file-room";
import { type Browser, openSocket, signedInUser } from "./helpers";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: NodeRecord["props"],
): NodeRecord => ({ id, type, parent, key, props });

/** A Leaf with a text and a boolean; a main holding one, and an instance of that main. */
function fixture(): NodeRecord[] {
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("leaf", "frame", "p", "a0", {
      isComponent: true,
      width: 100,
      height: 30,
      componentProps: [
        { id: "label", name: "Label", type: "text" },
        { id: "show", name: "Show", type: "boolean" },
      ],
    }),
    node("t", "text", "leaf", "a0", { characters: "Base", propRefs: { characters: "label" } }),
    node("v", "rect", "leaf", "a1", { width: 10, height: 10, propRefs: { visible: "show" } }),
    node("main", "frame", "p", "a1", { isComponent: true, width: 100, height: 30 }),
    node("n", "frame", "main", "a0", { instanceOf: "leaf", width: 100, height: 30 }),
    node("nt", "text", "n", "a0", {
      mirrors: "t",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("nv", "rect", "n", "a1", {
      mirrors: "v",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
    node("i", "frame", "p", "a2", { instanceOf: "main", width: 100, height: 30 }),
    node("ni", "frame", "i", "a0", { mirrors: "n", instanceOf: "leaf", width: 100, height: 30 }),
    node("nit", "text", "ni", "a0", {
      mirrors: "nt",
      characters: "Base",
      propRefs: { characters: "label" },
    }),
    node("niv", "rect", "ni", "a1", {
      mirrors: "nv",
      width: 10,
      height: 10,
      propRefs: { visible: "show" },
    }),
  ];
}

async function join(browser: Browser, fileId: string, clientId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 3,
    clientId,
    revn: null,
    copies: ["materialized", "compact"],
  });
  const welcome = await socket.next<{ role: string }>("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  return { ...socket, welcome, nodes };
}

async function setup(form: "compact" | "materialized" = "compact") {
  const owner = await signedInUser("Component properties");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Properties" } },
  );
  const seed = await join(owner.browser, file.id, "seed");
  seed.ws.close();
  const room = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(file.id));
  if (form === "materialized") {
    await room.storeMaterialized(fixture());
    return { ...owner, fileId: file.id, room, converted: { nodes: fixture(), ids: new Map() } };
  }
  const converted = compactByInstance(fixture());
  const imported = await room.importNodes(
    { userId: owner.userId, name: "Properties" },
    converted.nodes,
    file.id,
    "compact",
  );
  expect(imported.ok).toBe(true);
  return { ...owner, fileId: file.id, room, converted };
}

/** `fixture` from before records: no record, the nested label's value on its layer. */
const legacy = () =>
  fixture().map((n) =>
    n.id === "nit"
      ? { ...n, props: { ...n.props, characters: "Legacy", overrides: ["characters"] } }
      : n,
  );

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
const stored = async (fileId: string) => (await roomOf(fileId).allNodes()) as NodeRecord[];

/** Runs the room's alarm until its migration to records is done. */
async function migrate(fileId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const done = await runInDurableObject(roomOf(fileId), (_room, state) =>
      state.storage.sql.exec("SELECT v FROM meta WHERE k = 'records'").toArray(),
    );
    if (done.length > 0) return;
    await runDurableObjectAlarm(roomOf(fileId));
  }
  throw new Error("the migration to records didn't finish");
}

/** `legacy`, with a second instance of the same main from before records. */
const legacyTwo = () => [
  ...legacy(),
  node("i2", "frame", "p", "a3", { instanceOf: "main", width: 100, height: 30 }),
  node("ni2", "frame", "i2", "a0", { mirrors: "n", instanceOf: "leaf", width: 100, height: 30 }),
  node("nit2", "text", "ni2", "a0", {
    mirrors: "nt",
    characters: "Legacy two",
    propRefs: { characters: "label" },
    overrides: ["characters"],
  }),
  node("niv2", "rect", "ni2", "a1", {
    mirrors: "nv",
    width: 10,
    height: 10,
    propRefs: { visible: "show" },
  }),
];

const recordsMarked = async (fileId: string) =>
  (
    await runInDurableObject(roomOf(fileId), (_room, state) =>
      state.storage.sql.exec("SELECT v FROM meta WHERE k = 'records'").toArray(),
    )
  ).length > 0;

describe("records in the room (review 6 of #187, A)", () => {
  it("migrates a file from before records when it loads: a version first, logged, once", async () => {
    const { browser, fileId, room } = await setup("materialized");
    await room.storeMaterialized(legacy());
    const client = await join(browser, fileId, "watching");
    await migrate(fileId);
    const after = await stored(fileId);
    expect(after.find((n) => n.id === "i")?.props.propValues).toEqual({ "n/label": "Legacy" });
    expect(
      after.filter((n) => n.props.instanceOf && !n.props.mirrors && !n.props.propValues),
    ).toEqual([]);
    // A connected client hears it as an edit, as it follows any.
    const heard = (await client.next<{ ops: Op[] }>("txn")).ops;
    expect(heard).toContainEqual({
      op: "set",
      id: "i",
      prop: "propValues",
      value: { "n/label": "Legacy" },
    });
    // Once: a version to undo it with, saved before it, and no second.
    await runDurableObjectAlarm(room);
    const versions = (
      await browser.json<{ versions: Array<{ name: string | null }> }>(
        `/api/files/${fileId}/versions`,
      )
    ).versions.filter((v) => v.name === BEFORE_RECORDS);
    expect(versions).toHaveLength(1);
    client.ws.close();
  });

  it("restores the version from before records with every instance folded again", async () => {
    const { browser, fileId, room } = await setup("materialized");
    await room.storeMaterialized(legacy());
    await migrate(fileId);
    const version = (
      await browser.json<{ versions: Array<{ id: string; name: string | null }> }>(
        `/api/files/${fileId}/versions`,
      )
    ).versions.find((v) => v.name === BEFORE_RECORDS) as { id: string };
    const restored = await browser.fetch(`/api/files/${fileId}/versions/${version.id}/restore`, {
      method: "POST",
      json: {},
    });
    expect(restored.status).toBe(200);
    const after = await stored(fileId);
    expect(after.find((n) => n.id === "i")?.props.propValues).toEqual({ "n/label": "Legacy" });
  });

  it("folds an instance an edit reaches before the migration does, so the edit lands on its record", async () => {
    const { browser, fileId, room } = await setup("materialized");
    await room.storeMaterialized(legacy());
    const client = await join(browser, fileId, "early");
    client.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "i", prop: "propValues", key: "show", value: false }],
    });
    await client.next("ack");
    const after = await stored(fileId);
    expect(after.find((n) => n.id === "i")?.props.propValues).toEqual({
      "n/label": "Legacy",
      show: false,
    });
    client.ws.close();
  });

  it("imports a file from before records with every instance keeping a record", async () => {
    const owner = await signedInUser("Records import");
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      { method: "POST", json: { name: "Imported" } },
    );
    const seed = await join(owner.browser, file.id, "seed");
    seed.ws.close();
    const imported = await roomOf(file.id).importNodes(
      { userId: owner.userId, name: "Records import" },
      legacy(),
      file.id,
      "materialized",
    );
    expect(imported.ok).toBe(true);
    const after = await stored(file.id);
    expect(
      after.filter((n) => n.props.instanceOf && !n.props.mirrors && !n.props.propValues),
    ).toEqual([]);
    const root = after.find(
      (n) => n.id === "i" || (n.props.instanceOf === "main" && !n.props.mirrors),
    );
    expect(root?.props.propValues).toEqual({ "n/label": "Legacy" });
  });

  for (const form of ["compact", "materialized"] as const)
    it(`refuses, saying so, an edit that would leave an instance without a record (${form})`, async () => {
      const { browser, fileId } = await setup(form);
      const client = await join(browser, fileId, "maker");
      const make = (props: Record<string, unknown>): Op => ({
        op: "create",
        id: "madeInstance01",
        type: "frame",
        parent: "p",
        key: "a5",
        props: { instanceOf: "main", ...props } as never,
      });
      client.send({ t: "txn", seq: 1, ops: [make({})] });
      const refusal = await client.next<{ message: string }>("reject");
      expect(refusal.message).toMatch(/keeps a record/);
      expect(refusal.message).toMatch(/Reload/);
      client.send({
        t: "txn",
        seq: 2,
        ops: [{ op: "set", id: "i", prop: "propValues", value: null }],
      });
      expect((await client.next<{ message: string }>("reject")).message).toMatch(/keeps a record/);
      client.send({ t: "txn", seq: 3, ops: [make({ propValues: {} })] });
      await client.next("ack");
      client.ws.close();
    });

  it("migrates in bounded, resumable steps, the marker written with the last of them, the version once", async () => {
    const { browser, fileId, room } = await setup("materialized");
    await runInDurableObject(room, (instance: { recordsStep: number }) => {
      instance.recordsStep = 1;
    });
    await room.storeMaterialized(legacyTwo());
    const recordless = async () =>
      (await stored(fileId)).filter(
        (n) => n.props.instanceOf && !n.props.mirrors && !n.props.propValues,
      );
    // The version first, then one instance a step (the two, and the nested one in the main): until
    // the last, the marker isn't written; with the last, it is.
    await runDurableObjectAlarm(room);
    let left = (await recordless()).length;
    expect(left).toBe(3);
    while (left > 0) {
      expect(await recordsMarked(fileId)).toBe(false);
      await runDurableObjectAlarm(room);
      const now = (await recordless()).length;
      expect(now).toBe(left - 1);
      left = now;
    }
    expect(await recordsMarked(fileId)).toBe(true);
    const after = await stored(fileId);
    expect(after.find((n) => n.id === "i2")?.props.propValues).toEqual({ "n/label": "Legacy two" });
    // Done: more alarms change nothing, and save no second version.
    const revn = (await join(browser, fileId, "after")).welcome;
    await runDurableObjectAlarm(room);
    const versions = (
      await browser.json<{ versions: Array<{ name: string | null }> }>(
        `/api/files/${fileId}/versions`,
      )
    ).versions.filter((v) => v.name === BEFORE_RECORDS);
    expect(versions).toHaveLength(1);
    expect(revn).toBeDefined();
  });

  it("lets a client from before the migration catch up across it, holding what the room holds", async () => {
    const { browser, fileId, room } = await setup("materialized");
    await room.storeMaterialized(legacy());
    const before = await join(browser, fileId, "before");
    const at = (before.welcome as unknown as { revn: number }).revn;
    before.ws.close();
    await migrate(fileId);
    const back = await openSocket(browser, fileId);
    back.send({
      t: "hello",
      protocol: 3,
      clientId: "before",
      revn: at,
      copies: ["materialized", "compact"],
    });
    const welcome = await back.next<{ mode: string; revn: number }>("welcome");
    expect(welcome.mode).toBe("catchup");
    // The migration is in the log as the edits it made: replayed on the file as it had it.
    const doc = new Doc({ compactCopies: false });
    doc.resetStored(before.nodes, "materialized");
    for (;;) {
      const txn = await back.next<{ revn: number; ops: Op[] }>("txn");
      doc.applyStored(txn.ops, { held: true });
      if (txn.revn >= welcome.revn) break;
    }
    const room6 = await stored(fileId);
    const byId = (a: NodeRecord, b: NodeRecord) => (a.id < b.id ? -1 : 1);
    expect(doc.stored().sort(byId)).toEqual(room6.sort(byId));
    back.ws.close();
  });

  it("duplicates a file not migrated yet with every instance keeping a record", async () => {
    const { browser, fileId, room, projectId } = await setup("materialized");
    await room.storeMaterialized(legacy());
    const { file } = await browser.json<{ file: { id: string } }>(
      `/api/projects/${projectId}/files`,
      {
        method: "POST",
        json: { name: "Copy", from: fileId },
      },
    );
    const copy = await stored(file.id);
    expect(
      copy.filter((n) => n.props.instanceOf && !n.props.mirrors && !n.props.propValues),
    ).toEqual([]);
    expect(copy.find((n) => n.id === "i")?.props.propValues).toEqual({ "n/label": "Legacy" });
  });
});
