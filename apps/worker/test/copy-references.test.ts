/**
 * The room fixes copy references a transaction leaves stale as a change of
 * its own (review 8 of #209): logged as the next revision, sent to every
 * client, the one that made the change included, so tabs on older code, a
 * catch-up from the log and a snapshot all hold the same references.
 */
import { env, runInDurableObject } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import type { FileRoom } from "../src/rooms/file-room";
import { openSocket, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): NodeRecord => ({ id, type, parent, key, props: props as NodeRecord["props"] });

/**
 * Leaf (a text); main A holding an instance of Leaf; a frame that was an
 * instance of A, detached, its nested Leaf instance now one on its own,
 * whose text a delayed rebuild is about to make (stored materialized).
 */
const detached = () => [
  node("p", "page", ROOT_ID, "a0", { name: "Page 1" }),
  node("leaf", "frame", "p", "a0", { isComponent: true, width: 10, height: 10 }),
  node("t", "text", "leaf", "a0", { characters: "Base" }),
  node("a", "frame", "p", "a1", { isComponent: true, width: 10, height: 10 }),
  node("na", "frame", "a", "a0", { instanceOf: "leaf", width: 10, height: 10 }),
  node("nat", "text", "na", "a0", { mirrors: "t", characters: "Base" }),
  node("i", "frame", "p", "a2", { width: 10, height: 10 }),
  node("ni", "frame", "i", "a0", { instanceOf: "leaf", width: 10, height: 10 }),
];

/** The rebuild a client made before it saw the detach: the text copies A's layer. */
const rebuild: Op[] = [
  {
    op: "create",
    id: "nit",
    type: "text",
    parent: "ni",
    key: "a0",
    props: { mirrors: "nat", characters: "Accepted" },
  },
];

async function materializedFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "References" } },
  );
  await runInDurableObject(roomOf(file.id), (room: FileRoom) => {
    room.compactCopiesOff = true;
  });
  await roomOf(file.id).storeMaterialized(detached());
  return { ...owner, fileId: file.id };
}

async function join(browser: Parameters<typeof openSocket>[0], fileId: string, clientId: string) {
  const socket = await openSocket(browser, fileId);
  socket.send({
    t: "hello",
    protocol: 2,
    clientId,
    revn: null,
    copies: ["materialized", "compact"],
  });
  const welcome = await socket.next<{ revn: number; mode: string }>("welcome");
  if (welcome.mode === "snapshot")
    for (;;) {
      const chunk = await socket.next<{ done: boolean }>("snapshot");
      if (chunk.done) break;
    }
  return { ...socket, welcome };
}

type Txn = { revn: number; ops: Op[]; author: { userId: string; sessionId: string } };

describe("copy references the room fixes", () => {
  it("logs the fix as its own revision and sends it to everyone, the author included", async () => {
    const { browser, fileId, teamId } = await materializedFile();
    const a = await join(browser, fileId, "clientA");
    const teammate = await signedInUser("Bo", "editor", teamId);
    const b = await join(teammate.browser, fileId, "clientB");
    const base = a.welcome.revn;

    a.send({ t: "txn", seq: 1, ops: rebuild });
    const ack = await a.next<{ seq: number; revn: number }>("ack");
    expect(ack.revn).toBe(base + 1);
    const fixForAuthor = await a.next<Txn>("txn");
    const fix: Op[] = [{ op: "set", id: "nit", prop: "mirrors", value: "t" }];
    expect(fixForAuthor).toMatchObject({ revn: base + 2, ops: fix, author: { userId: "system" } });
    // The teammate gets the change as it was sent, then the room's fix.
    expect(await b.next<Txn>("txn")).toMatchObject({ revn: base + 1, ops: rebuild });
    expect(await b.next<Txn>("txn")).toMatchObject({ revn: base + 2, ops: fix });

    // The file holds it, and so does the log a client catching up reads.
    const stored = (await roomOf(fileId).allNodes()) as NodeRecord[];
    expect(stored.find((n) => n.id === "nit")?.props.mirrors).toBe("t");
    const late = await openSocket(browser, fileId);
    late.send({
      t: "hello",
      protocol: 2,
      clientId: "clientLate",
      revn: base,
      copies: ["materialized", "compact"],
    });
    const welcome = await late.next<{ revn: number; mode: string }>("welcome");
    expect(welcome).toMatchObject({ mode: "catchup", revn: base + 2 });
    expect(await late.next<Txn>("txn")).toMatchObject({ revn: base + 1, ops: rebuild });
    expect(await late.next<Txn>("txn")).toMatchObject({ revn: base + 2, ops: fix });
  });

  it("sends nothing more when the change leaves every reference as it should be", async () => {
    const { browser, fileId } = await materializedFile();
    const a = await join(browser, fileId, "clientA");
    const base = a.welcome.revn;
    a.send({
      t: "txn",
      seq: 1,
      ops: [{ ...rebuild[0], props: { mirrors: "t", characters: "Fine" } } as Op],
    });
    expect((await a.next<{ revn: number }>("ack")).revn).toBe(base + 1);
    a.send({ t: "txn", seq: 2, ops: [{ op: "set", id: "nit", prop: "characters", value: "x" }] });
    // The next thing it hears is the ack of its next change: no fix came between.
    const next = await a.next<{ t: string; revn: number }>("ack");
    expect(next.revn).toBe(base + 2);
    expect(a.inbox.filter((m) => m.t === "txn")).toEqual([]);
  });
});
