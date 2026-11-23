/**
 * PR 286's option 1: an edit that comes to hold nothing of a copy layer's own clears the fields of
 * its override record, and never deletes the record. So a relayout worked out before a
 * collaborator's recolour arrived (its record held only laid-out heights then) no longer takes the
 * recolour with it, in the room as in every client. An empty record (`{ path }`) means nothing, as
 * an absent one: the room takes one in an import and in an edit, and a later edit fills it again.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Editor, layoutOps } from "@drawpane/editor";
import {
  type CopiesFormat,
  copyId,
  getProp,
  type NodeRecord,
  type Op,
  PROTOCOL_VERSION,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { openSocket, signedInUser } from "./helpers";

const roomOf = (id: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(id));
const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });
const FILL = [{ type: "solid" as const, color: "#ff0000" }];

/** The re-checks' row: two fixed rects a stretched instance makes 93 tall, in the given form. */
function stretchedFile(copies: CopiesFormat) {
  const editor = new Editor({ clientId: "setup", measurer: { width: () => 5 } });
  editor.doc.resetStored(
    [
      n("p", "page", ROOT_ID),
      n("main", "frame", "p", {
        isComponent: true,
        width: 160,
        height: 80,
        layoutMode: "row",
        paddingTop: 7,
        paddingLeft: 13,
        gap: 5,
      }),
      n("r", "rect", "main", { width: 60, height: 20, constraintH: "stretch" }),
      n("s", "rect", "main", { width: 12, height: 10 }, "a1"),
    ],
    copies,
  );
  editor.state.set({ role: "editor" });
  editor.setPage("p");
  editor.commit(layoutOps(editor.doc, ["main"]));
  const instance = editor.insertInstance("main", { x: 500, y: 500 }) as string;
  editor.resize([instance], "width", 120);
  editor.resize([instance], "height", 100);
  editor.setProp([instance], "alignItems", "stretch");
  editor.sync.takeUnsent();
  return { nodes: editor.doc.stored(), instance, copy: editor.doc.childIds(instance)[0] as string };
}

async function fileWith(copies: CopiesFormat, nodes: readonly NodeRecord[]) {
  const owner = await signedInUser("Reviewer");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "empty records" } },
  );
  const room = roomOf(file.id);
  // The room settles how it stores copies when it first loads.
  const seed = await openSocket(owner.browser, file.id);
  seed.send({
    t: "hello",
    protocol: PROTOCOL_VERSION,
    clientId: "seed",
    revn: null,
    copies: ["materialized", "compact"],
  });
  await seed.next("welcome");
  await seed.next("snapshot");
  if (copies === "materialized") {
    await runInDurableObject(room, (instance) => {
      instance.compactCopiesOff = true;
    });
    await room.storeMaterialized(nodes);
  } else await room.storeNodes(nodes);
  seed.ws.close(1000);
  expect((await room.copiesFormat()).copies).toBe(copies);
  return { ...owner, fileId: file.id, room };
}

/** An editor on the room's file through a real socket; what arrives waits until `pump`. */
async function client(
  browser: Awaited<ReturnType<typeof signedInUser>>["browser"],
  fileId: string,
  name: string,
) {
  const editor = new Editor({ clientId: name, measurer: { width: () => 5 } });
  editor.state.set({ role: "editor" });
  const socket = await openSocket(browser, fileId);
  editor.sync.connected((message) => socket.send(message));
  const arrive = async (pred: (m: Record<string, unknown>) => boolean, count = 1) => {
    const deadline = Date.now() + 10_000;
    while (socket.inbox.filter(pred).length < count) {
      if (Date.now() > deadline) throw new Error(`${name}: nothing arrived`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /** Feeds the editor everything that arrived, in order. */
  const pump = () => {
    for (const message of socket.inbox.splice(0)) {
      editor.sync.receive(message as never);
      if (message.t === "snapshot") editor.setPage("p");
    }
  };
  await arrive((m) => m.t === "snapshot" && m.done === true);
  pump();
  return { editor, socket, arrive, pump };
}

describe("a collaborator's recolour through a relayout made before it (the design memo's probe)", {
  timeout: 60_000,
}, () => {
  for (const copies of ["materialized", "compact"] as const)
    for (const edit of ["column", "start"] as const)
      for (const timing of ["sent", "unsent"] as const)
        it(`keeps it: ${copies}, ${edit === "column" ? "row to column" : "Stretch to Start"}, ${timing}`, async () => {
          const { nodes, instance, copy } = stretchedFile(copies);
          const f = await fileWith(copies, nodes);
          const a = await client(f.browser, f.fileId, "a");
          const b = await client(f.browser, f.fileId, "b");
          const c = await client(f.browser, f.fileId, "c");
          // C's recolour reaches the room first; A hasn't taken it in yet.
          c.editor.setProp([copy], "fills", FILL);
          c.editor.sync.flush();
          await c.arrive((m) => m.t === "ack");
          await a.arrive((m) => m.t === "txn");
          // A's edit, worked out without the recolour: sent before A takes it in, or taken in
          // while still unsent (no wait between, so nothing flushes it meanwhile).
          if (edit === "column") a.editor.setLayoutMode(["main"], "column");
          else a.editor.setProp([instance], "alignItems", "start");
          if (timing === "sent") a.editor.sync.flush();
          a.pump();
          a.editor.sync.flush();
          await a.arrive((m) => m.t === "ack");
          await b.arrive((m) => m.t === "txn", 2);
          await c.arrive((m) => m.t === "txn");
          for (const x of [a, b, c]) x.pump();
          expect(a.editor.sync.pendingCount).toBe(0);
          const stored = (await f.room.allNodes()) as unknown as NodeRecord[];
          const sorted = (records: readonly NodeRecord[]) =>
            [...records].sort((x, y) => x.id.localeCompare(y.id));
          for (const e of [a.editor, b.editor, c.editor]) {
            expect(getProp(e.doc.get(copy)?.props ?? {}, "fills")).toEqual(FILL);
            expect(getProp(e.doc.get(copy)?.props ?? {}, "overrides")).toEqual(["fills"]);
            expect(sorted(e.doc.stored())).toEqual(sorted(stored));
          }
          // No override record went: the room holds the copy's record (compact), with the fill.
          if (copies === "compact")
            expect(stored.find((r) => r.id === copy)?.props.fills).toEqual(FILL);
        });
});

describe("empty override records", { timeout: 60_000 }, () => {
  it("are taken in an import, stored as they are, and present as absent ones do", async () => {
    const { nodes, instance, copy } = stretchedFile("compact");
    // An empty record for the second copy, as an edit that came to hold nothing leaves one.
    const second = copyId(instance, ["s"]);
    const withEmpty = [
      ...nodes.filter((r) => r.id !== second),
      n(second, "override", instance, { path: ["s"] }, "a0"),
    ];
    const owner = await signedInUser("Reviewer");
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      { method: "POST", json: { name: "imported" } },
    );
    await owner.browser.json(`/api/files/${file.id}/import`, {
      method: "POST",
      json: { nodes: withEmpty, copies: "compact" },
    });
    const stored = await roomOf(file.id).allNodes();
    expect(stored.find((r) => r.id === second)?.props).toEqual({ path: ["s"] });
    // A client reading it presents the second copy as its main layer, as with no record.
    const c = await client(owner.browser, file.id, "reader");
    const props = c.editor.doc.get(second)?.props ?? {};
    expect(getProp(props, "height")).toBe(10);
    expect(getProp(props, "overrides")).toEqual([]);
    expect(c.editor.doc.get(copy)).toBeDefined();
  });

  it("are left by an edit that comes to hold nothing, and filled again by the next", async () => {
    const { nodes, instance, copy } = stretchedFile("compact");
    const f = await fileWith("compact", nodes);
    const a = await client(f.browser, f.fileId, "a");
    const b = await client(f.browser, f.fileId, "b");
    a.editor.setProp([instance], "alignItems", "start");
    a.editor.sync.flush();
    await a.arrive((m) => m.t === "ack");
    let record = (await f.room.allNodes()).find((r) => r.id === copy);
    expect(record?.props).toEqual({ path: ["r"] });
    a.editor.setProp([instance], "alignItems", "stretch");
    a.editor.sync.flush();
    await a.arrive((m) => m.t === "ack");
    const stored = (await f.room.allNodes()) as unknown as NodeRecord[];
    record = stored.find((r) => r.id === copy);
    expect(record?.props).toEqual({ path: ["r"], height: 93 });
    expect(stored.filter((r) => r.id === copy)).toHaveLength(1);
    await b.arrive((m) => m.t === "txn", 2);
    b.pump();
    const sorted = (records: readonly NodeRecord[]) =>
      [...records].sort((x, y) => x.id.localeCompare(y.id));
    expect(sorted(b.editor.doc.stored())).toEqual(sorted(stored));
    expect(getProp(b.editor.doc.get(copy)?.props ?? {}, "height")).toBe(93);
  });

  it("are refused nowhere: a create of one, and clearing one's fields, are acked", async () => {
    const { nodes, instance } = stretchedFile("compact");
    const f = await fileWith("compact", nodes);
    const socket = await openSocket(f.browser, f.fileId);
    socket.send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: "raw",
      revn: null,
      copies: ["compact"],
    });
    await socket.next("welcome");
    await socket.next("snapshot");
    const second = copyId(instance, ["s"]);
    const ops: Op[] = [{ op: "set", id: second, prop: "height", value: null }];
    socket.send({ t: "txn", seq: 1, ops });
    expect(await socket.next("ack")).toMatchObject({ seq: 1 });
    expect((await f.room.allNodes()).find((r) => r.id === second)?.props).toEqual({ path: ["s"] });
  });
});
