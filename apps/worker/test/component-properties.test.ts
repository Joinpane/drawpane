/**
 * Component property values in a real room (decision 0035): a tab from
 * before keyed sets stays an editor, its edits taken as they mean (review
 * 4 of #187), a keyed set is checked entry by
 * entry and whole on what its transaction leaves, and two people's first
 * values of a nested instance both stay (the outer instance's record holds
 * them, so no record has to be made for the nested one). Review 3 of #187.
 */
import { env } from "cloudflare:test";
import { Doc, Editor, instanceValues } from "@drawpane/editor";
import { compactByInstance, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
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

/**
 * The operations a tab from before records sends for `edit`: an editor
 * holding only what such a tab is sent (no references, records or
 * definitions), so it edits a driven layer as a plain one, as its code did.
 */
function oldTab(form: "compact" | "materialized", loaded: NodeRecord[], edit: Op[]): Op[] {
  const editor = new Editor({ measurer: { width: (_font, text) => text.length * 7 } });
  editor.state.set({ role: "editor" });
  editor.doc.resetStored(structuredClone(loaded), form);
  editor.setPage("p");
  expect(editor.commit(edit)).toBe(true);
  return editor.sync.takeUnsent();
}

describe("component property values in the room", () => {
  for (const form of ["compact", "materialized"] as const)
    it(`keeps a tab from before records an editor: its queued edits all apply (${form})`, async () => {
      // Review 4 of #187, P1 #2: a protocol 2 tab told to reload lost the edits it held unsent.
      const { browser, fileId, room, converted } = await setup(form);
      const text = form === "compact" ? (converted.ids.get("nit") as string) : "nit";
      const older = await openSocket(browser, fileId);
      const hello = { t: "hello", protocol: 2, clientId: "older", copies: [form] };
      older.send({ ...hello, revn: null });
      const welcome = await older.next<{ role: string; revn: number; copies: string }>("welcome");
      expect(welcome).toMatchObject({ role: "owner", copies: form });
      const loaded: NodeRecord[] = [];
      for (;;) {
        const chunk = await older.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
        loaded.push(...chunk.nodes);
        if (chunk.done) break;
      }
      // Sent nothing its model refuses.
      const unknown = ["propRefs", "propValues", "componentProps", "exposeProps"];
      expect(loaded.some((n) => unknown.some((p) => p in n.props))).toBe(false);
      older.ws.close();

      // While it's offline, a newer client sets a value; it queues three edits of its own.
      const newer = await join(browser, fileId, "newer");
      newer.send({
        t: "txn",
        seq: 1,
        ops: [{ op: "set", id: "i", prop: "propValues", key: "show", value: true }],
      });
      await newer.next("ack");
      const queued: Op[][] = [
        [{ op: "set", id: "p", prop: "name", value: "Renamed offline" }],
        // Typing in the nested instance's label, as its tab writes it.
        oldTab(form, loaded, [{ op: "set", id: text, prop: "characters", value: "Typed offline" }]),
        // An ordinary override.
        oldTab(form, loaded, [{ op: "set", id: text, prop: "opacity", value: 0.5 }]),
      ];

      // It comes back: welcomed (its update banner reloads it once these are in), caught up on
      // what it can read, and every edit applies.
      const back = await openSocket(browser, fileId);
      back.send({ ...hello, revn: welcome.revn });
      expect((await back.next<{ mode: string }>("welcome")).mode).toBe("catchup");
      const caughtUp = await back.next<{ ops: Op[] }>("txn");
      expect(caughtUp.ops).toEqual([]);
      for (let i = 0; i < queued.length; i++) {
        back.send({ t: "txn", seq: i + 1, ops: queued[i] });
        expect((await back.next<{ seq: number }>("ack")).seq).toBe(i + 1);
      }
      expect(back.inbox.filter((m) => m.t === "reject")).toEqual([]);
      const doc = new Doc();
      doc.resetStored((await room.allNodes()) as NodeRecord[], form);
      expect(doc.get("p")?.props.name).toBe("Renamed offline");
      const nested = form === "compact" ? (converted.ids.get("ni") as string) : "ni";
      expect(instanceValues(doc, nested)).toEqual({ label: "Typed offline" });
      expect(instanceValues(doc, "i")).toEqual({ show: true });
      expect(doc.get(text)?.props.characters).toBe("Typed offline");
      expect(doc.get(text)?.props.opacity).toBe(0.5);
      // The newer client hears it as a value of the record.
      const heard: Op[] = [];
      for (let i = 0; i < queued.length; i++)
        heard.push(...(await newer.next<{ ops: Op[] }>("txn")).ops);
      expect(heard).toContainEqual(
        expect.objectContaining({ id: "i", prop: "propValues", value: "Typed offline" }),
      );
      back.ws.close();
      newer.ws.close();
    });

  it("leaves out a materialized tab's instance sync of a field its record decides", async () => {
    const { browser, fileId, room } = await setup("materialized");
    const newer = await join(browser, fileId, "newer");
    newer.send({
      t: "txn",
      seq: 1,
      ops: [
        { op: "set", id: "i", prop: "propValues", key: "n/label", value: "Kept" },
        { op: "set", id: "nit", prop: "characters", value: "Kept" },
      ],
    });
    await newer.next("ack");
    const older = await openSocket(browser, fileId);
    older.send({
      t: "hello",
      protocol: 2,
      clientId: "older",
      revn: null,
      copies: ["materialized"],
    });
    await older.next("welcome");
    // Its sync puts back what it thinks the main gives: no mark, so not a person's edit.
    older.send({
      t: "txn",
      seq: 1,
      ops: [{ op: "set", id: "nit", prop: "characters", value: "Base" }],
    });
    await older.next("ack");
    const doc = new Doc();
    doc.resetStored((await room.allNodes()) as NodeRecord[], "materialized");
    expect(instanceValues(doc, "ni")).toEqual({ label: "Kept" });
    expect(doc.get("nit")?.props.characters).toBe("Kept");
    older.ws.close();
    newer.ws.close();
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
    expect(nodes.find((n) => n.id === "i")?.props.propValues).toBeUndefined();
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
