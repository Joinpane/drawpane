/**
 * Opening a file that stores compact copies (decision 0029) by download
 * (decision 0026, item 9): whether the file comes through the socket, as a
 * saved version from R2 with the changes after it, or as the file is, the
 * client ends up with the same document, in the form the room stores.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { generateKit } from "@drawpane/corpus";
import { Doc, SyncEngine } from "@drawpane/editor";
import {
  type CopiesFormat,
  firstDifference,
  INLINE_SNAPSHOT_NODES,
  type NodeRecord,
  type Op,
  parseSnapshot,
  type ServerMessage,
  snapshotCopies,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "../src/lib/crypto";
import type { DocumentTicket, FileRoom } from "../src/rooms/file-room";
import { type Browser, openSocket, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
const BOTH = ["materialized", "compact"];

/** Large enough that, compact, it still takes more than one snapshot chunk. */
const kit = generateKit({ layers: 12_000, seed: 5 });

/** A file from before compact copies (the kit, stored materialized), converted. */
async function convertedFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Kit" } },
  );
  // The room learns its file id when someone opens it.
  const socket = await openSocket(owner.browser, file.id);
  socket.send({ t: "hello", protocol: 4, clientId: `c-${file.id}`, revn: null, copies: BOTH });
  await socket.next("welcome", 10_000);
  socket.ws.close();
  await roomOf(file.id).storeMaterialized(kit.nodes);
  for (let i = 0; ; i++) {
    if (i > 500) throw new Error("the conversion didn't finish");
    await runDurableObjectAlarm(roomOf(file.id));
    if ((await roomOf(file.id).copiesFormat()).copies === "compact") break;
  }
  const stored = (await roomOf(file.id).allNodes()) as NodeRecord[];
  expect(stored.length).toBeGreaterThan(INLINE_SNAPSHOT_NODES);
  return { ...owner, fileId: file.id, stored };
}

const ticketOf = (ticket: string) =>
  JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(ticket.slice(0, ticket.indexOf(".")))),
  ) as DocumentTicket;

/**
 * The editor's sync engine on a socket to the file, until it's live: with
 * `download`, it downloads a large file as the browser does (the route, its
 * snapshot's header), else the room sends it through the socket.
 */
async function client(browser: Browser, fileId: string, download: boolean) {
  const socket = await openSocket(browser, fileId);
  const doc = new Doc();
  const engine = new SyncEngine(doc, { clientId: `e-${crypto.randomUUID()}` });
  const welcomes: Array<Extract<ServerMessage, { t: "welcome" }>> = [];
  socket.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    if (message.t === "welcome") welcomes.push(message);
    engine.receive(message);
  });
  const downloads: Array<{ ticket: string; copies: CopiesFormat; revn: number }> = [];
  engine.connected(
    (message) => socket.send(message),
    download
      ? {
          download: async (ticket) => {
            const response = await browser.fetch(
              `/api/files/${fileId}/document?ticket=${encodeURIComponent(ticket)}`,
            );
            expect(response.status).toBe(200);
            const snapshot = parseSnapshot(await response.text());
            if (!snapshot) throw new Error("not a snapshot");
            const copies = snapshotCopies(snapshot.header);
            downloads.push({ ticket, copies, revn: snapshot.header.revn });
            return { revn: snapshot.header.revn, nodes: snapshot.nodes, copies };
          },
        }
      : {},
  );
  const close = () => {
    engine.disconnected();
    socket.ws.close();
  };
  const deadline = Date.now() + 30_000;
  while (engine.status !== "live") {
    if (Date.now() > deadline) {
      close();
      throw new Error(`not live: ${engine.status}, downloads ${JSON.stringify(downloads)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { doc, engine, welcomes, downloads, close };
}

/** Commits edits through a live client and waits for the room to take them. */
async function edit(c: Awaited<ReturnType<typeof client>>, ops: Op[]): Promise<void> {
  c.engine.commit(ops);
  c.engine.flush();
  const deadline = Date.now() + 10_000;
  while (c.engine.pendingCount > 0) {
    if (Date.now() > deadline) throw new Error("the edit wasn't acknowledged");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The same document, both ways round (`firstDifference` reads what `expected` has). */
function same(a: Doc, b: Doc): void {
  expect(a.copies).toBe(b.copies);
  expect(firstDifference(a.nodes(), b.nodes())).toBeNull();
  expect(firstDifference(b.nodes(), a.nodes())).toBeNull();
}

describe("opening a file of compact copies by download", { timeout: 180_000 }, () => {
  it("downloads the file as it is in its stored form, never the version saved before converting", async () => {
    const { browser, fileId } = await convertedFile();
    // The latest saved version is the materialized backup, from before the conversion (the
    // alarm may have saved one since, in the stored form: set aside here).
    const { backup } = await roomOf(fileId).copiesFormat();
    const { versions } = await browser.json<{ versions: Array<{ id: string; revn: number }> }>(
      `/api/files/${fileId}/versions`,
    );
    const backupRevn = versions.find((v) => v.id === backup)?.revn as number;
    expect(backupRevn).toBeGreaterThan(0);
    await runInDurableObject(roomOf(fileId), (_room: FileRoom, state) => {
      state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'snapshot_revn'", String(backupRevn));
    });
    const bySocket = await client(browser, fileId, false);
    expect(bySocket.welcomes.at(-1)).toMatchObject({ mode: "snapshot", copies: "compact" });

    const byDownload = await client(browser, fileId, true);
    const welcome = byDownload.welcomes.at(-1);
    expect(welcome).toMatchObject({ mode: "download", copies: "compact" });
    // The changes since the backup can't be replayed onto it (the conversion isn't logged as
    // operations), so the file comes as it is, never the backup in the other form.
    expect(ticketOf(welcome?.ticket as string).revn).toBeNull();
    expect(byDownload.downloads).toMatchObject([{ copies: "compact", revn: welcome?.revn }]);
    expect(byDownload.doc.copies).toBe("compact");
    same(bySocket.doc, byDownload.doc);
    // Copy layers shown, as the client shows them.
    expect([...byDownload.doc.nodes()].length).toBeGreaterThan(kit.nodes.length * 0.9);
    bySocket.close();
    byDownload.close();
  });

  it("downloads a version saved since, then the changes after it, to the same document", async () => {
    const { browser, fileId, stored } = await convertedFile();
    const { version } = await browser.json<{ version: { revn: number } }>(
      `/api/files/${fileId}/versions`,
      { method: "POST", json: { name: "Compact" } },
    );
    // Edits after it, as the editor makes them: a main (its copies follow) and a copy layer
    // (an override record).
    const editor = await client(browser, fileId, false);
    const main = stored.find((n) => n.type === "frame" && n.props.isComponent) as NodeRecord;
    const storedIds = new Set(stored.map((n) => n.id));
    const copyLayer = [...editor.doc.nodes()].find(
      (n) => !storedIds.has(n.id) && n.type !== "page",
    ) as NodeRecord;
    expect(copyLayer).toBeTruthy();
    await edit(editor, [
      { op: "set", id: main.id, prop: "fills", value: [{ type: "solid", color: "#123456" }] },
    ]);
    await edit(editor, [{ op: "set", id: copyLayer.id, prop: "name", value: "Overridden" }]);
    const revn = editor.engine.revn as number;
    expect(revn).toBeGreaterThan(version.revn);

    const bySocket = await client(browser, fileId, false);
    const byDownload = await client(browser, fileId, true);
    const welcome = byDownload.welcomes.at(-1);
    expect(welcome).toMatchObject({ mode: "download", copies: "compact", revn });
    expect(ticketOf(welcome?.ticket as string).revn).toBe(version.revn);
    expect(byDownload.downloads).toMatchObject([{ copies: "compact", revn: version.revn }]);
    expect(byDownload.engine.revn).toBe(revn);
    same(bySocket.doc, byDownload.doc);
    same(editor.doc, byDownload.doc);
    expect(byDownload.doc.get(copyLayer.id)?.props.name).toBe("Overridden");
    for (const c of [editor, bySocket, byDownload]) c.close();
  });

  it("downloads the file materialized after a rollback (COMPACT_COPIES=off and the backup restored)", async () => {
    const { browser, fileId } = await convertedFile();
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

    const bySocket = await client(browser, fileId, false);
    const byDownload = await client(browser, fileId, true);
    const welcome = byDownload.welcomes.at(-1);
    expect(welcome).toMatchObject({ mode: "download", copies: "materialized" });
    expect(byDownload.downloads).toMatchObject([{ copies: "materialized" }]);
    same(bySocket.doc, byDownload.doc);
    expect(firstDifference(kit.nodes, byDownload.doc.nodes())).toBeNull();
    bySocket.close();
    byDownload.close();
  });
});
