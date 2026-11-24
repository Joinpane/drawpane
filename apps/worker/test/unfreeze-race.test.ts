/**
 * PR 286's final re-check: a main gaining a flow thaws an instance that set a layout mode of none
 * as its own (no edit makes a frame frozen). Before, a collaborator could give that instance a
 * column, be acked, and then lose it to the thaw in a main's row edit worked out before it. Now
 * the editor refuses giving an instance a flow its component lacks (as Figma does; Shift+A wraps
 * it instead), so no legal edit races the thaw: C's column is refused, the file is unchanged, and
 * A's row applies cleanly, in both formats.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Editor } from "@drawpane/editor";
import {
  type ClientMessage,
  type CopiesFormat,
  getProp,
  type NodeRecord,
  PROTOCOL_VERSION,
  ROOT_ID,
} from "@drawpane/model";
import { expect, it } from "vitest";
import { openSocket, signedInUser } from "./helpers";

const roomOf = (id: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(id));
const n = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  props: NodeRecord["props"] = {},
  key = "a0",
): NodeRecord => ({ id, type, parent, key, props });
const byId = (records: readonly NodeRecord[]) => Object.fromEntries(records.map((r) => [r.id, r]));

async function fileWith(copies: CopiesFormat, nodes: readonly NodeRecord[]) {
  const owner = await signedInUser("Reviewer");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "unfreeze race" } },
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

/** An editor on the room's file; its transactions wait in `outgoing` until the test sends them. */
async function client(
  browser: Awaited<ReturnType<typeof signedInUser>>["browser"],
  fileId: string,
  name: string,
) {
  const editor = new Editor({ clientId: name, measurer: { width: () => 5 } });
  editor.state.set({ role: "editor" });
  const socket = await openSocket(browser, fileId);
  const outgoing: Extract<ClientMessage, { t: "txn" }>[] = [];
  editor.sync.connected((message) =>
    message.t === "txn" ? outgoing.push(message) : socket.send(message),
  );
  const take = () => {
    editor.sync.flush();
    return outgoing.shift();
  };
  const arrive = async (pred: (m: Record<string, unknown>) => boolean, count = 1) => {
    const deadline = Date.now() + 10_000;
    while (socket.inbox.filter(pred).length < count) {
      if (Date.now() > deadline) throw new Error(`${name}: nothing arrived`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const pump = () => {
    for (const message of socket.inbox.splice(0)) {
      editor.sync.receive(message as never);
      if (message.t === "snapshot") editor.setPage("p");
    }
  };
  await arrive((m) => m.t === "snapshot" && m.done === true);
  pump();
  return { editor, socket, arrive, pump, take };
}

for (const copies of ["materialized", "compact"] as const)
  it(`refuses a flow the component lacks, so a main's row thaws its instance cleanly: ${copies}`, async () => {
    const id = "instance";
    // A plain main, and an instance that set a layout mode of none as its own.
    const setup = new Editor({
      clientId: "setup",
      measurer: { width: () => 5 },
    });
    setup.doc.resetStored(
      [
        n("p", "page", ROOT_ID),
        n("main", "frame", "p", { isComponent: true, width: 120, height: 90 }),
        n("r", "rect", "main", { width: 60, height: 20, x: 13, y: 7 }),
        n(
          id,
          "frame",
          "p",
          {
            instanceOf: "main",
            width: 120,
            height: 90,
            x: 220,
            overrides: ["layoutMode"],
            ...(copies === "compact" ? { unset: ["layoutMode"] as const } : {}),
          },
          "a1",
        ),
        ...(copies === "materialized"
          ? [
              n("ir", "rect", id, {
                mirrors: "r",
                width: 60,
                height: 20,
                x: 13,
                y: 7,
              }),
            ]
          : []),
      ],
      copies,
    );
    const f = await fileWith(copies, setup.doc.stored());
    const a = await client(f.browser, f.fileId, "a");
    const b = await client(f.browser, f.fileId, "b");
    const c = await client(f.browser, f.fileId, "c");
    try {
      const before = byId((await f.room.allNodes()) as unknown as NodeRecord[]);
      // A's main row, worked out first and held back.
      a.editor.setLayoutMode(["main"], "row");
      const main = a.take();
      expect(main).toBeDefined();
      // C's column on the instance is refused: nothing is sent, and C's file is as it was.
      expect(c.editor.commit([{ op: "set", id, prop: "layoutMode", value: "column" }])).toBe(false);
      expect(c.take()).toBeUndefined();
      expect(c.editor.sync.pendingCount).toBe(0);
      expect(getProp(c.editor.doc.get(id)?.props ?? {}, "layoutMode")).toBe("none");
      expect(byId(c.editor.doc.stored())).toEqual(before);
      expect(byId((await f.room.allNodes()) as unknown as NodeRecord[])).toEqual(before);
      // A's row applies cleanly: the main has it, and the instance thaws to it.
      a.socket.send(main as Extract<ClientMessage, { t: "txn" }>);
      await a.arrive((m) => m.t === "ack");
      await b.arrive((m) => m.t === "txn");
      await c.arrive((m) => m.t === "txn");
      for (const x of [a, b, c]) x.pump();
      const room = byId((await f.room.allNodes()) as unknown as NodeRecord[]);
      for (const x of [a, b, c]) {
        expect(byId(x.editor.doc.stored())).toEqual(room);
        expect(x.editor.sync.pendingCount).toBe(0);
        expect(getProp(x.editor.doc.get("main")?.props ?? {}, "layoutMode")).toBe("row");
        expect(getProp(x.editor.doc.get(id)?.props ?? {}, "layoutMode")).toBe("row");
      }
      // The thaw wrote the instance's layout mode, and not its overrides list (beside the size
      // its main's new row gave it).
      const props = (main?.ops ?? []).flatMap((op) =>
        op.id === id && op.op === "set" ? [op.prop] : [],
      );
      expect(props).toContain("layoutMode");
      expect(props).not.toContain("overrides");
    } finally {
      for (const x of [a, b, c]) x.socket.ws.close(1000);
    }
  }, 40_000);
