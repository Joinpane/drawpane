/**
 * Component property values in a real room (decision 0035): a tab from
 * before keyed sets views the file, only its safe queued edits applying
 * (review 5 of #187), a keyed set is checked entry by
 * entry and whole on what its transaction leaves, and two people's first
 * values of a nested instance both stay (the outer instance's record holds
 * them, so no record has to be made for the nested one). Review 3 of #187.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Doc, Editor, instanceValues } from "@drawpane/editor";
import {
  compactByInstance,
  getProp,
  INLINE_SNAPSHOT_NODES,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
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

describe("component property values in the room", () => {
  for (const form of ["compact", "materialized"] as const)
    it(`welcomes a tab from before records as a viewer; its safe queued edits apply, the rest are refused whole (${form})`, async () => {
      // Review 5 of #187: a protocol 2 tab can't keep what it doesn't see over what it does to an
      // instance, so it's no longer an editor (decision 0035, item 15). The operations are those
      // the actual protocol 2 editor sent in the review's run.
      const { browser, fileId, room, converted } = await setup(form);
      const current = await join(browser, fileId, "current");
      current.send({
        t: "txn",
        seq: 1,
        ops: [{ op: "set", id: "i", prop: "propValues", key: "n/label", value: "Winning" }],
      });
      await current.next("ack");
      const older = await openSocket(browser, fileId);
      older.send({ t: "hello", protocol: 2, clientId: "older", revn: null, copies: [form] });
      expect((await older.next<{ role: string }>("welcome")).role).toBe("viewer");
      const loaded: NodeRecord[] = [];
      for (;;) {
        const chunk = await older.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
        loaded.push(...chunk.nodes);
        if (chunk.done) break;
      }
      const unknown = ["propRefs", "propValues", "componentProps", "exposeProps"];
      expect(loaded.some((n) => unknown.some((p) => p in n.props))).toBe(false);
      const text = form === "compact" ? (converted.ids.get("nit") as string) : "nit";
      const nested = form === "compact" ? (converted.ids.get("ni") as string) : "ni";
      const queued: Array<{ ops: Op[]; applies: boolean }> = [
        { ops: [{ op: "set", id: "p", prop: "name", value: "Renamed offline" }], applies: true },
        {
          ops: [
            {
              op: "create",
              id: "offlineRect0001",
              type: "rect",
              parent: "p",
              key: "a5",
              props: { width: 10, height: 10 },
            },
          ],
          applies: true,
        },
        // Deleting the instance, then its undo (which can't carry the record it doesn't see).
        { ops: [{ op: "delete", id: "i" }], applies: false },
        {
          ops: [
            {
              op: "create",
              id: "i",
              type: "frame",
              parent: "p",
              key: "a2",
              props: { instanceOf: "main" },
            },
          ],
          applies: false,
        },
        // A detach.
        {
          ops: [
            { op: "set", id: "i", prop: "instanceOf", value: null },
            { op: "set", id: nested, prop: "mirrors", value: null },
          ],
          applies: false,
        },
        // Typing in the driven text, and an ordinary override.
        form === "compact"
          ? {
              ops: [
                {
                  op: "create",
                  id: text,
                  type: "override",
                  parent: "i",
                  key: "a0",
                  props: { path: ["n", "t"], characters: "Typed" } as never,
                },
              ],
              applies: false,
            }
          : {
              ops: [
                { op: "set", id: text, prop: "characters", value: "Typed" },
                { op: "set", id: text, prop: "overrides", value: ["characters"] },
              ],
              applies: false,
            },
        // A safe change and an unsafe one together: neither applies.
        {
          ops: [
            { op: "set", id: "p", prop: "name", value: "Half" },
            { op: "set", id: "i", prop: "opacity", value: 0.5 },
          ],
          applies: false,
        },
      ];
      for (let i = 0; i < queued.length; i++) {
        older.send({ t: "txn", seq: i + 1, ops: queued[i]?.ops });
        if (queued[i]?.applies) expect((await older.next<{ seq: number }>("ack")).seq).toBe(i + 1);
        else {
          const refusal = await older.next<{ seq: number; message: string }>("reject");
          expect(refusal.seq).toBe(i + 1);
          // Shown by the tab as it is: not saved, to be made again after reloading.
          expect(refusal.message).toMatch(/wasn't saved/);
          expect(refusal.message).toMatch(/Reload/);
        }
      }
      const doc = new Doc();
      doc.resetStored((await room.allNodes()) as NodeRecord[], form);
      expect(doc.get("p")?.props.name).toBe("Renamed offline");
      expect(doc.get("offlineRect0001")?.type).toBe("rect");
      expect(getProp(doc.get("i")?.props ?? {}, "instanceOf")).toBe("main");
      expect(getProp(doc.get("i")?.props ?? {}, "opacity")).toBe(1);
      expect(instanceValues(doc, nested)).toEqual({ label: "Winning" });
      older.ws.close();
      current.ws.close();
    });

  it("gives a tab from before records that downloads a large file no editing path", async () => {
    // Review 5 of #187, finding 5: the download isn't filtered, and its undo of a delete couldn't
    // restore the fields it holds without knowing them. It's a viewer, and its queued delete of an
    // instance is refused, so there's nothing to undo.
    const { room, browser, fileId } = await setup("materialized");
    const nodes = [
      ...fixture().map((n) =>
        n.id === "i" ? { ...n, props: { ...n.props, propValues: { "n/label": "Winning" } } } : n,
      ),
      ...Array.from({ length: INLINE_SNAPSHOT_NODES + 1 }, (_, i) =>
        node(`large${i}`, "rect", "p", "b0", { width: 1, height: 1 }),
      ),
    ];
    await room.storeMaterialized(nodes);
    const older = await openSocket(browser, fileId);
    older.send({
      t: "hello",
      protocol: 2,
      clientId: "older-download",
      revn: null,
      copies: ["materialized"],
      download: true,
    });
    const welcome = await older.next<{ mode: string; role: string }>("welcome");
    expect(welcome).toMatchObject({ mode: "download", role: "viewer" });
    older.send({ t: "txn", seq: 1, ops: [{ op: "delete", id: "i" }] });
    expect((await older.next<{ message: string }>("reject")).message).toMatch(/wasn't saved/);
    const after = (await room.allNodes()) as NodeRecord[];
    expect(after.find((n) => n.id === "i")?.props.propValues).toEqual({ "n/label": "Winning" });
    older.ws.close();
  }, 30_000);

  for (const form of ["compact", "materialized"] as const)
    it(`treats a socket attached before attachments said their protocol as a tab from before records (${form})`, async () => {
      // Review 6 of #187, finding 5: a socket hibernated on main keeps its attachment, without a
      // protocol, when the room adopts this code; it doesn't say hello again.
      const { browser, fileId, room } = await setup(form);
      const current = await join(browser, fileId, "current");
      current.send({
        t: "txn",
        seq: 1,
        ops: [{ op: "set", id: "i", prop: "propValues", key: "n/label", value: "Winning" }],
      });
      await current.next("ack");
      const old = await join(browser, fileId, "main-era");
      // Its attachment as main wrote it: every field but the protocol.
      await runInDurableObject(room, (_instance, state) => {
        for (const socket of state.getWebSockets()) {
          const me = socket.deserializeAttachment() as Record<string, unknown>;
          if (me.clientId !== "main-era") continue;
          delete me.protocol;
          socket.serializeAttachment(me);
        }
      });
      old.send({ t: "txn", seq: 1, ops: [{ op: "delete", id: "i" }] });
      expect((await old.next<{ message: string }>("reject")).message).toMatch(/wasn't saved/);
      old.send({
        t: "txn",
        seq: 2,
        ops: [
          {
            op: "create",
            id: "i",
            type: "frame",
            parent: "p",
            key: "a2",
            props: { instanceOf: "main" },
          },
        ],
      });
      expect((await old.next<{ message: string }>("reject")).message).toMatch(/wasn't saved/);
      const root = ((await room.allNodes()) as NodeRecord[]).find((n) => n.id === "i");
      expect(root?.props.propValues).toEqual({ "n/label": "Winning" });
      // What it's sent is what a tab from before records can read.
      current.send({
        t: "txn",
        seq: 2,
        ops: [{ op: "set", id: "i", prop: "propValues", key: "n/label", value: "Again" }],
      });
      await current.next("ack");
      expect((await old.next<{ ops: Op[] }>("txn")).ops).toEqual([]);
      old.ws.close();
      current.ws.close();
    });

  it("checks a keyed set's key, property and value, and leaves the record as it was", async () => {
    const { browser, fileId, room } = await setup();
    const client = await join(browser, fileId, "validation");
    const bad = [
      { prop: "propValues", key: "bad key", value: false },
      { prop: "characters", key: "label", value: "x" },
      { prop: "propValues", key: "label", value: 17 },
      // Past the record's bound once the transaction is done.
      { prop: "propValues", key: "a", value: "a".repeat(200_000) },
    ];
    const ops: Op[][] = bad.map((b) => [{ op: "set", id: "i", ...b } as Op]);
    ops[3] = [
      ...(ops[3] as Op[]),
      { op: "set", id: "i", prop: "propValues", key: "b", value: "b".repeat(200_000) },
    ];
    for (let i = 0; i < ops.length; i++) {
      client.send({ t: "txn", seq: i + 1, ops: ops[i] });
      const rejection = await client.next<{ code: string }>("reject");
      expect(["invalid_prop", "invalid_value"]).toContain(rejection.code);
    }
    const nodes = await room.allNodes();
    // Its record as the import made it (every instance keeps one, decision 0035), unchanged.
    expect(nodes.find((n) => n.id === "i")?.props.propValues).toEqual({});
    client.ws.close();
  });

  it("keeps two people's first values of a nested instance, in the outer instance's record", async () => {
    const { browser, fileId, room, converted } = await setup();
    const a = await join(browser, fileId, "a");
    const b = await join(browser, fileId, "b");
    const make = (nodes: NodeRecord[]) => {
      const editor = new Editor({ measurer: { width: (_font, text) => text.length * 7 } });
      editor.state.set({ role: "editor" });
      editor.doc.resetStored(nodes, "compact");
      editor.setPage("p");
      return editor;
    };
    const ea = make(a.nodes);
    const eb = make(b.nodes);
    const nested = converted.ids.get("ni") ?? "ni";
    ea.setInstanceProperty(nested, "label", "Alice");
    eb.setInstanceProperty(nested, "show", false);
    a.send({ t: "txn", seq: 1, ops: ea.sync.takeUnsent() });
    await a.next("ack");
    b.send({ t: "txn", seq: 1, ops: eb.sync.takeUnsent() });
    await b.next("ack");
    const doc = new Doc();
    doc.resetStored((await room.allNodes()) as NodeRecord[], "compact");
    expect(instanceValues(doc, nested)).toEqual({ label: "Alice", show: false });
    a.ws.close();
    b.ws.close();
  });
});
