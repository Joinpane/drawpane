/**
 * Opening a file too large to send through its room's socket: a client that
 * says it can download is given a ticket instead, and downloads the file
 * over HTTP (a socket has no backpressure, so a room sending a large file
 * at once holds all of it; a room has 128 MB). Read from the latest saved
 * version with the transactions after it, or the file as it is.
 */
import { env } from "cloudflare:test";
import {
  INLINE_SNAPSHOT_NODES,
  keyBetween,
  type NodeRecord,
  type Op,
  parseSnapshot,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { base64UrlToBytes, signPayload } from "../src/lib/crypto";
import type { DocumentTicket } from "../src/rooms/file-room";
import { snapshotKey } from "../src/rooms/snapshots";
import { Browser, openSocket, openSocketAt, signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
type Socket = Awaited<ReturnType<typeof openSocket>>;

/** A file of a page and `layers` rectangles, imported as the browser imports one. */
async function fileOf(layers: number) {
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
    nodes.push({
      id: `Rect${i}`,
      type: "rect",
      parent: "Page1",
      key,
      props: { name: `Rect ${i}`, x: i, y: 0, width: 10, height: 10 },
    });
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
});
