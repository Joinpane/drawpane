import { env } from "cloudflare:test";
import type { NodeRecord, Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Browser, openSocket, openSocketAt, signedInUser } from "./helpers";

async function sharedFile() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Checkout" } },
  );
  return { ...owner, fileId: file.id };
}

const tokenOf = (url: string) => new URL(url).pathname.replace(/^\/p\//, "");

async function hello(socket: Awaited<ReturnType<typeof openSocketAt>>, clientId: string) {
  socket.send({ t: "hello", protocol: 1, clientId, revn: null });
  const welcome = await socket.next<{ role: string; peers: unknown[]; mode: string }>("welcome");
  const nodes: NodeRecord[] = [];
  for (;;) {
    const chunk = await socket.next<{ nodes: NodeRecord[]; done: boolean }>("snapshot");
    nodes.push(...chunk.nodes);
    if (chunk.done) break;
  }
  return { welcome, nodes };
}

describe("prototype links", () => {
  it("creates one live link per file, shows it to the team and turns it off", async () => {
    const { browser, fileId, teamId } = await sharedFile();
    expect(await browser.json(`/api/files/${fileId}/share`)).toEqual({ link: null });

    const created = await browser.fetch(`/api/files/${fileId}/share`, { method: "POST" });
    expect(created.status).toBe(201);
    const { link } = (await created.json()) as { link: { url: string; createdAt: number } };
    expect(link.url).toMatch(
      /^https:\/\/design\.example\.com\/p\/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/,
    );

    // Asking again returns the same link; a viewer on the team can see it but not change it.
    const again = await browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`, {
      method: "POST",
    });
    expect(again.link.url).toBe(link.url);
    const viewer = await signedInUser("Vi", "viewer", teamId);
    expect(
      (await viewer.browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`)).link.url,
    ).toBe(link.url);
    expect(
      (await viewer.browser.fetch(`/api/files/${fileId}/share`, { method: "POST" })).status,
    ).toBe(403);
    expect(
      (await viewer.browser.fetch(`/api/files/${fileId}/share`, { method: "DELETE" })).status,
    ).toBe(403);

    // Anyone, signed in or not, can resolve it.
    const guest = new Browser();
    expect(await guest.json(`/api/share/${tokenOf(link.url)}`)).toEqual({
      file: { id: fileId, name: "Checkout" },
    });

    // Off means off, and a new link is a new URL.
    await browser.json(`/api/files/${fileId}/share`, { method: "DELETE" });
    expect((await guest.fetch(`/api/share/${tokenOf(link.url)}`)).status).toBe(404);
    expect(await browser.json(`/api/files/${fileId}/share`)).toEqual({ link: null });
    const fresh = await browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`, {
      method: "POST",
    });
    expect(fresh.link.url).not.toBe(link.url);
  });

  it("refuses forged, malformed and other teams' tokens", async () => {
    const { browser, fileId } = await sharedFile();
    const { link } = await browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`, {
      method: "POST",
    });
    const token = tokenOf(link.url);
    const [id, mac] = token.split(".") as [string, string];
    const guest = new Browser();
    const forged = `${id}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    for (const bad of [forged, id, `${id}.`, "x".repeat(39), `${"A".repeat(16)}.${mac}`]) {
      expect((await guest.fetch(`/api/share/${bad}`)).status, bad).toBe(404);
    }
    // The database never holds the token itself.
    const row = await env.DB.prepare("SELECT * FROM share_links WHERE file_id = ?")
      .bind(fileId)
      .first<Record<string, unknown>>();
    expect(Object.values(row ?? {})).not.toContain(token);
    expect(Object.values(row ?? {})).not.toContain(mac);
    // Not team members: the share API itself is still private.
    expect((await guest.fetch(`/api/files/${fileId}/share`)).status).toBe(401);
    const stranger = await signedInUser("Stranger");
    expect((await stranger.browser.fetch(`/api/files/${fileId}/share`)).status).toBe(404);
  });

  it("lets guests watch the document live but never see people, presence or comments", async () => {
    const { browser, fileId } = await sharedFile();
    const { link } = await browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`, {
      method: "POST",
    });
    const owner = await openSocket(browser, fileId);
    const ownerHello = await hello(owner, "owner");
    const page = ownerHello.nodes[0] as NodeRecord;

    const guest = await openSocketAt(new Browser(), `/ws/share/${tokenOf(link.url)}`);
    const { welcome, nodes } = await hello(guest, "guest");
    expect(welcome).toMatchObject({ role: "viewer", peers: [] });
    expect(nodes.map((n) => n.id)).toContain(page.id);

    // The owner isn't told a guest arrived.
    owner.send({
      t: "presence",
      presence: { cursor: { x: 1, y: 2 }, pageId: page.id, selection: [] },
    });
    const op: Op = {
      op: "create",
      id: "r1",
      type: "rect",
      parent: page.id,
      key: "a0",
      props: { width: 10, height: 10 },
    };
    owner.send({ t: "txn", seq: 1, ops: [op] });
    await owner.next("ack");
    const change = await guest.next<{ ops: Op[]; author: { userId: string; sessionId: string } }>(
      "txn",
    );
    expect(change.ops).toEqual([op]);
    expect(change.author).toEqual({ userId: "", sessionId: "" });
    expect(guest.inbox.some((m) => m.t === "presence" || m.t === "peer")).toBe(false);
    expect(owner.inbox.some((m) => m.t === "peer")).toBe(false);

    // Guests can't edit.
    guest.send({ t: "txn", seq: 1, ops: [{ op: "delete", id: "r1" }] });
    await guest.next("reject");

    // Turning the link off disconnects them, and they can't come back.
    const closed = new Promise<number>((resolve) =>
      guest.ws.addEventListener("close", (e) => resolve((e as CloseEvent).code)),
    );
    await browser.json(`/api/files/${fileId}/share`, { method: "DELETE" });
    expect(await closed).toBe(4403);
    const again = await new Browser().fetch(`/ws/share/${tokenOf(link.url)}`, {
      headers: { upgrade: "websocket" },
    });
    expect(again.status).toBe(404);
  });

  it("serves the file team's images through the link, and nothing else", async () => {
    const { browser, fileId, teamId } = await sharedFile();
    const { link } = await browser.json<{ link: { url: string } }>(`/api/files/${fileId}/share`, {
      method: "POST",
    });
    const token = tokenOf(link.url);
    const now = Date.now();
    const ours = "a".repeat(64);
    const theirs = "b".repeat(64);
    const other = await signedInUser("Other team");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO media (sha, team_id, mime, width, height, bytes, created_at) VALUES (?, ?, 'image/png', 1, 1, 3, ?)",
      ).bind(ours, teamId, now),
      env.DB.prepare(
        "INSERT INTO media (sha, team_id, mime, width, height, bytes, created_at) VALUES (?, ?, 'image/png', 1, 1, 3, ?)",
      ).bind(theirs, other.teamId, now),
    ]);
    await env.FILES.put(`media/${ours}`, new Uint8Array([1, 2, 3]));
    await env.FILES.put(`media/${theirs}`, new Uint8Array([4, 5, 6]));
    const guest = new Browser();
    const image = await guest.fetch(`/api/share/${token}/media/${ours}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await guest.fetch(`/api/share/${token}/media/${theirs}`)).status).toBe(404);
    expect((await guest.fetch(`/api/share/${token}/media/nope`)).status).toBe(404);
  });
});
