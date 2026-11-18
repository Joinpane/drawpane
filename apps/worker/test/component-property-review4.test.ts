/**
 * The fourth review of #187 in a real room: two people's first changes to
 * one copy layer, made from files without each other's, both stay (P1 #1);
 * and a tab from before compact copies still only views a compact file, its
 * snapshot showing property values, never operations (the review's control).
 */
import { env } from "cloudflare:test";
import { Doc, Editor } from "@drawpane/editor";
import { compactByInstance, copyId, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { expect, it } from "vitest";
import { type Browser, openSocket, signedInUser } from "./helpers";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: NodeRecord["props"],
): NodeRecord => ({ id, type, parent, key, props });

function fixture(): NodeRecord[] {
  return [
    node("p", "page", ROOT_ID, "a0", {}),
    node("main", "frame", "p", "a0", { isComponent: true }),
    node("t", "rect", "main", "a0", { width: 10, height: 10, opacity: 0.4, rotation: 20 }),
    node("i", "frame", "p", "a1", { instanceOf: "main" }),
    node("it", "rect", "i", "a0", {
      mirrors: "t",
      width: 10,
      height: 10,
      opacity: 0.4,
      rotation: 20,
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

async function setup() {
  const owner = await signedInUser("Component properties");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Properties" } },
  );
  const seed = await join(owner.browser, file.id, "seed");
  seed.ws.close();
  const room = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(file.id));
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

const editorOn = (nodes: NodeRecord[]) => {
  const editor = new Editor({ measurer: { width: (_font, text) => text.length * 7 } });
  editor.state.set({ role: "editor" });
  editor.doc.resetStored(nodes, "compact");
  editor.setPage("p");
  return editor;
};

it("keeps both of two people's explicit clears, each the first change to the layer", async () => {
  const { browser, fileId, room, converted } = await setup();
  const a = await join(browser, fileId, "a");
  const b = await join(browser, fileId, "b");
  const ea = editorOn(a.nodes);
  const eb = editorOn(b.nodes);
  const id = converted.ids.get("it") as string;
  ea.commit([{ op: "set", id, prop: "opacity", value: null }]);
  eb.commit([{ op: "set", id, prop: "rotation", value: null }]);
  a.send({ t: "txn", seq: 1, ops: ea.sync.takeUnsent() });
  await a.next("ack");
  b.send({ t: "txn", seq: 1, ops: eb.sync.takeUnsent() });
  await b.next("ack");
  const doc = new Doc();
  doc.resetStored((await room.allNodes()) as NodeRecord[], "compact");
  expect(getProp(doc.get(id)?.props ?? {}, "opacity")).toBe(1);
  expect(getProp(doc.get(id)?.props ?? {}, "rotation")).toBe(0);
  a.ws.close();
  b.ws.close();
});

it("sends a protocol 1 tab in a compact file a snapshot with property values, never operations", async () => {
  const { browser, fileId } = await setup();
  const modern = await join(browser, fileId, "modern");
  modern.send({
    t: "txn",
    seq: 1,
    ops: [
      {
        op: "set",
        id: "main",
        prop: "componentProps",
        value: [{ id: "label", name: "Label", type: "boolean" }],
      },
      { op: "set", id: "t", prop: "propRefs", value: { visible: "label" } },
      { op: "set", id: "i", prop: "propValues", key: "label", value: false },
    ],
  });
  await modern.next("ack");
  const old = await openSocket(browser, fileId);
  old.send({ t: "hello", protocol: 1, clientId: "old", revn: 0 });
  const welcome = await old.next<{ role: string; mode: string }>("welcome");
  expect(welcome).toMatchObject({ role: "viewer", mode: "snapshot" });
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await old.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  expect(nodes.find((n) => n.id === copyId("i", ["t"]))?.props.visible).toBe(false);
  expect(old.inbox.filter((m) => m.t === "txn")).toEqual([]);
  old.send({ t: "txn", seq: 1, ops: [{ op: "set", id: "p", prop: "name", value: "unsafe" }] });
  expect((await old.next<{ code: string }>("reject")).code).toBe("format");
  old.ws.close();
  modern.ws.close();
});
