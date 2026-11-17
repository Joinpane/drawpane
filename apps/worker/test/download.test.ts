/**
 * Opening a file too large to send through its room's socket: a client that
 * says it can download is given a ticket instead, and downloads the file
 * over HTTP (a socket has no backpressure, so a room sending a large file
 * at once holds all of it; a room has 128 MB). Read from the latest saved
 * version with the transactions after it, or the file as it is.
 */
import { env, runInDurableObject } from "cloudflare:test";
import {
  INLINE_SNAPSHOT_NODES,
  keyBetween,
  type NodeRecord,
  type Op,
  parseSnapshot,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it, vi } from "vitest";
import { base64UrlToBytes, signPayload } from "../src/lib/crypto";
import type { DocumentTicket, FileRoom } from "../src/rooms/file-room";
import { PAGE_CHARS, tablePages, tempTables } from "../src/rooms/node-tables";
import { snapshotKey } from "../src/rooms/snapshots";
import { Browser, openSocket, openSocketAt, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
type Socket = Awaited<ReturnType<typeof openSocket>>;

/**
 * A file of a page and `layers` rectangles (or text layers of `characters`
 * characters each), imported as the browser imports one.
 */
async function fileOf(layers: number, characters = 0) {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Kit" } },
  );
  const nodes: NodeRecord[] = [
    { id: "Page1", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
  ];
  for (let i = 0, key: string | null = null; i < layers; i++) {
    key = keyBetween(key, null);
    nodes.push(
      characters > 0
        ? {
            id: `Rect${i}`,
            type: "text",
            parent: "Page1",
            key,
            props: { name: `Text ${i}`, characters: "x".repeat(characters) },
          }
        : {
            id: `Rect${i}`,
            type: "rect",
            parent: "Page1",
            key,
            props: { name: `Rect ${i}`, x: i, y: 0, width: 10, height: 10 },
          },
    );
  }
  const { importId } = await owner.browser.json<{ importId: string }>(
    `/api/files/${file.id}/imports`,
    { method: "POST", json: {} },
  );
  const part = await owner.browser.fetch(`/api/files/${file.id}/imports/${importId}/parts`, {
    method: "POST",
    json: { nodes },
  });
  expect(part.status).toBe(200);
  const commit = await owner.browser.fetch(`/api/files/${file.id}/imports/${importId}/commit`, {
    method: "POST",
    json: {},
  });
  expect(commit.status).toBe(200);
  return { ...owner, fileId: file.id };
}

interface Welcome {
  mode: string;
  revn: number;
  ticket?: string;
}

async function hello(socket: Socket, clientId: string, download: boolean): Promise<Welcome> {
  socket.send({
    t: "hello",
    protocol: 1,
    clientId,
    revn: null,
    ...(download ? { download: true } : {}),
  });
  return socket.next<Welcome>("welcome", 10_000);
}

const ticketOf = (ticket: string) =>
  JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(ticket.slice(0, ticket.indexOf(".")))),
  ) as DocumentTicket;

async function download(browser: Browser, fileId: string, ticket: string) {
  const response = await browser.fetch(
    `/api/files/${fileId}/document?ticket=${encodeURIComponent(ticket)}`,
  );
  expect(response.status).toBe(200);
  const snapshot = parseSnapshot(await response.text());
  if (!snapshot) throw new Error("not a snapshot");
  return snapshot;
}

/** A socket caught up to the room, for edits. */
async function editor(browser: Browser, fileId: string) {
  const socket = await openSocket(browser, fileId);
  const { revn } = await roomOf(fileId).stats();
  socket.send({ t: "hello", protocol: 1, clientId: "editor1", revn });
  await socket.next("welcome", 10_000);
  let seq = 0;
  return async (ops: Op[]) => {
    socket.send({ t: "txn", seq: ++seq, ops });
    return (await socket.next<{ revn: number }>("ack", 10_000)).revn;
  };
}

describe("opening a file larger than one snapshot chunk", () => {
  it("gives a client that can download a ticket to the file as it is, not the file", async () => {
    const { browser, fileId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const { revn, nodes } = await roomOf(fileId).stats();
    const socket = await openSocket(browser, fileId);
    const welcome = await hello(socket, "reader", true);
    expect(welcome).toMatchObject({ mode: "download", revn });
    // No version since the import (one before it can't lead here: the import isn't logged).
    expect(ticketOf(welcome.ticket as string)).toMatchObject({
      purpose: "document",
      fid: fileId,
      revn: null,
    });

    const file = await download(browser, fileId, welcome.ticket as string);
    expect(file.header.revn).toBe(revn);
    expect(file.nodes).toHaveLength(nodes);
    // Nothing of the file came through the socket.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.inbox.filter((m) => m.t === "snapshot")).toEqual([]);
  });

  it("reads the latest saved version, the changes since sent through the socket", async () => {
    const { browser, fileId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const { version } = await browser.json<{ version: { revn: number } }>(
      `/api/files/${fileId}/versions`,
      { method: "POST", json: { name: "Imported" } },
    );
    const edit = await editor(browser, fileId);
    const first = await edit([{ op: "set", id: "Rect1", prop: "name", value: "Changed" }]);
    const second = await edit([{ op: "delete", id: "Rect2" }]);

    const socket = await openSocket(browser, fileId);
    const welcome = await hello(socket, "reader", true);
    expect(welcome).toMatchObject({ mode: "download", revn: second });
    expect(ticketOf(welcome.ticket as string).revn).toBe(version.revn);
    const after = [
      await socket.next<{ revn: number; ops: Op[] }>("txn"),
      await socket.next<{ revn: number; ops: Op[] }>("txn"),
    ];
    expect(after.map((t) => t.revn)).toEqual([first, second]);
    expect(first).toBe(version.revn + 1);

    const file = await download(browser, fileId, welcome.ticket as string);
    expect(file.header.revn).toBe(version.revn);
    expect(file.nodes.find((n) => n.id === "Rect1")?.props.name).toBe("Rect 1");
    expect(file.nodes.some((n) => n.id === "Rect2")).toBe(true);
  });

  it("downloads the file as it is when the saved version has gone", async () => {
    const { browser, fileId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const { version } = await browser.json<{ version: { revn: number } }>(
      `/api/files/${fileId}/versions`,
      { method: "POST", json: { name: "Imported" } },
    );
    const edit = await editor(browser, fileId);
    const revn = await edit([{ op: "delete", id: "Rect2" }]);
    const socket = await openSocket(browser, fileId);
    const welcome = await hello(socket, "reader", true);
    expect(ticketOf(welcome.ticket as string).revn).toBe(version.revn);
    await env.FILES.delete(snapshotKey(fileId, version.revn));

    const file = await download(browser, fileId, welcome.ticket as string);
    expect(file.header.revn).toBe(revn);
    expect(file.nodes.some((n) => n.id === "Rect2")).toBe(false);
  });

  it("sends the file through the socket to a client that can't download, and a small file to anyone", async () => {
    const large = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const old = await openSocket(large.browser, large.fileId);
    expect(await hello(old, "old", false)).toMatchObject({ mode: "snapshot" });
    expect(await old.next("snapshot", 10_000)).toBeTruthy();

    const small = await fileOf(INLINE_SNAPSHOT_NODES - 10);
    const socket = await openSocket(small.browser, small.fileId);
    const welcome = await hello(socket, "reader", true);
    expect(welcome.mode).toBe("snapshot");
    expect(welcome.ticket).toBeUndefined();
  });

  it("gives a guest the file as it is, never a saved version", async () => {
    const { browser, fileId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    await browser.json(`/api/files/${fileId}/versions`, {
      method: "POST",
      json: { name: "Imported" },
    });
    const { link } = await browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`, {
      method: "POST",
    });
    const guest = new Browser();
    const socket = await openSocketAt(guest, `/ws/share/${new URL(link.url).pathname.slice(3)}`);
    const welcome = await hello(socket, "guest", true);
    expect(welcome.mode).toBe("download");
    expect(ticketOf(welcome.ticket as string).revn).toBeNull();
    // Signed out: the ticket is enough.
    const file = await download(guest, fileId, welcome.ticket as string);
    expect(file.nodes.length).toBe((await roomOf(fileId).stats()).nodes);
  });

  it("takes a ticket only for its own file, unaltered and unexpired", async () => {
    const { browser, fileId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const other = await fileOf(10);
    const socket = await openSocket(browser, fileId);
    const { ticket } = await hello(socket, "reader", true);
    const status = async (id: string, value: string) =>
      (await new Browser().fetch(`/api/files/${id}/document?ticket=${encodeURIComponent(value)}`))
        .status;

    expect(await status(other.fileId, ticket as string)).toBe(403);
    expect(await status(fileId, `${ticket}x`)).toBe(403);
    expect(await status(fileId, "")).toBe(403);
    const sign = (payload: unknown) => signPayload(env.SESSION_SECRET, payload);
    expect(
      await status(
        fileId,
        await sign({ purpose: "document", fid: fileId, revn: null, exp: Date.now() - 1 }),
      ),
    ).toBe(403);
    // Something else this server signs (a room's claim) isn't a ticket.
    expect(
      await status(
        fileId,
        await sign({ uid: "u", name: "U", fid: fileId, role: "owner", exp: Date.now() + 60_000 }),
      ),
    ).toBe(403);
    // A deleted file can't be downloaded.
    expect((await browser.fetch(`/api/files/${fileId}`, { method: "DELETE" })).status).toBeLessThan(
      300,
    );
    expect(await status(fileId, ticket as string)).toBe(404);
  });

  it("downloads a file of few layers holding a lot of text", async () => {
    // 45 text layers of 200,000 characters: few nodes, but 9 MB of them.
    const { browser, fileId } = await fileOf(45, 200_000);
    const socket = await openSocket(browser, fileId);
    expect(await hello(socket, "reader", true)).toMatchObject({ mode: "download" });
  });

  it("reads a table in pages of bounded characters, not only bounded rows", async () => {
    const { fileId } = await fileOf(45, 200_000);
    await runInDurableObject(roomOf(fileId), (_room: FileRoom, state) => {
      let rows = 0;
      for (const page of tablePages(state.storage.sql, "nodes", 1_000, 1 << 20)) {
        let chars = 0;
        for (const row of page) chars += row.props.length;
        // At most one row past the bound.
        expect(chars - (page.at(-1)?.props.length ?? 0)).toBeLessThan(1 << 20);
        rows += page.length;
      }
      expect(rows).toBe(46);
      expect(PAGE_CHARS).toBeGreaterThan(1 << 20);
    });
  });

  it("shares one copy among downloads of one revision, dropped when the last ends", async () => {
    const { fileId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    await runInDurableObject(roomOf(fileId), async (room: FileRoom, state) => {
      const copies = () => tempTables(state.storage.sql).length;
      const first = await room.exportDocument();
      const second = await room.exportDocument();
      expect(copies()).toBe(1);
      await first.cancel();
      expect(copies()).toBe(1);
      const read = await new Response(second).arrayBuffer();
      expect(read.byteLength).toBeGreaterThan(0);
      expect(copies()).toBe(0);
    });
  });

  it("stops a download once whoever it was given to has lost the file", async () => {
    // A member removed from the team.
    const { browser, fileId, userId } = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const socket = await openSocket(browser, fileId);
    const { ticket } = await hello(socket, "reader", true);
    const fetchWith = (value: string) =>
      new Browser().fetch(`/api/files/${fileId}/document?ticket=${encodeURIComponent(value)}`);
    expect((await fetchWith(ticket as string)).status).toBe(200);
    await env.DB.prepare("DELETE FROM team_members WHERE user_id = ?").bind(userId).run();
    expect((await fetchWith(ticket as string)).status).toBe(404);

    // A guest whose prototype link was turned off.
    const other = await fileOf(INLINE_SNAPSHOT_NODES + 500);
    const { link } = await other.browser.json<{ link: { url: string } }>(
      `/api/files/${other.fileId}/share`,
      { method: "POST" },
    );
    const guest = await openSocketAt(
      new Browser(),
      `/ws/share/${new URL(link.url).pathname.slice(3)}`,
    );
    const welcome = await hello(guest, "guest", true);
    const guestFetch = () =>
      new Browser().fetch(
        `/api/files/${other.fileId}/document?ticket=${encodeURIComponent(welcome.ticket as string)}`,
      );
    expect((await guestFetch()).status).toBe(200);
    await other.browser.json(`/api/files/${other.fileId}/share`, { method: "DELETE" });
    expect((await guestFetch()).status).toBe(403);
  });

  it("keeps a role taken away while the download tickets were signed", async () => {
    const owner = await signedInUser();
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      { method: "POST", json: { name: "Race" } },
    );
    await openSocket(owner.browser, file.id);
    await runInDurableObject(roomOf(file.id), async (room: FileRoom, state) => {
      const ws = state.getWebSockets()[0] as WebSocket;
      let began = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      // Signing waits until the role has been changed.
      const spy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
        const result = await sign(...args);
        began();
        await gate;
        return result;
      });
      try {
        const hello = room.webSocketMessage(
          ws,
          JSON.stringify({ t: "hello", protocol: 1, clientId: "race", revn: null, download: true }),
        );
        await started;
        await env.DB.prepare("UPDATE team_members SET role = 'viewer' WHERE user_id = ?")
          .bind(owner.userId)
          .run();
        await room.accessChanged(owner.userId, "viewer", { id: "admin", name: "Admin" });
        release();
        await hello;
        expect((ws.deserializeAttachment() as { role: string }).role).toBe("viewer");
        const before = (await room.stats()).revn;
        await room.webSocketMessage(
          ws,
          JSON.stringify({
            t: "txn",
            seq: 1,
            ops: [
              { op: "create", id: "Late", type: "page", parent: ROOT_ID, key: "a1", props: {} },
            ],
          }),
        );
        expect((await room.stats()).revn).toBe(before);
      } finally {
        release();
        spy.mockRestore();
      }
    });
  });
});
