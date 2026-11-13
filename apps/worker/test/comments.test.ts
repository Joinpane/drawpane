import { env } from "cloudflare:test";
import type { CommentEvent, CommentThread } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type Browser, openSocket, signedInUser } from "./helpers";

async function newFile() {
  const owner = await signedInUser("Ana Ruiz");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Comments" } },
  );
  return { ...owner, fileId: file.id };
}

const startThread = (browser: Browser, fileId: string, json: Record<string, unknown> = {}) =>
  browser.json<{ thread: CommentThread }>(`/api/files/${fileId}/comments`, {
    method: "POST",
    json: {
      pageId: "page1",
      x: 120,
      y: 80,
      body: "Should the hero follow the brand blue?",
      ...json,
    },
  });

describe("comments API", () => {
  it("starts threads, replies, resolves, reopens and lists them", async () => {
    const { browser, fileId, userId } = await newFile();
    const { thread } = await startThread(browser, fileId, {
      nodeId: "hero",
      offset: { x: 12, y: 4 },
    });
    expect(thread).toMatchObject({
      fileId,
      pageId: "page1",
      anchor: { x: 120, y: 80, nodeId: "hero", offset: { x: 12, y: 4 } },
      author: { id: userId, name: "Ana Ruiz" },
      resolvedAt: null,
      messages: [{ body: "Should the hero follow the brand blue?", editedAt: null, mentions: [] }],
    });

    const reply = await browser.json<{ thread: CommentThread }>(
      `/api/files/${fileId}/comments/${thread.id}/replies`,
      { method: "POST", json: { body: "  Tried it, it reads better.  " } },
    );
    expect(reply.thread.messages.map((m) => m.body)).toEqual([
      "Should the hero follow the brand blue?",
      "Tried it, it reads better.",
    ]);
    expect(reply.thread.updatedAt).toBeGreaterThanOrEqual(thread.updatedAt);

    const resolved = await browser.json<{ thread: CommentThread }>(
      `/api/files/${fileId}/comments/${thread.id}`,
      { method: "PATCH", json: { resolved: true } },
    );
    expect(resolved.thread.resolvedAt).toEqual(expect.any(Number));
    expect(resolved.thread.resolvedBy).toEqual({ id: userId, name: "Ana Ruiz" });

    const other = await startThread(browser, fileId, { body: "Rows feel tight." });
    const open = await browser.json<{ threads: CommentThread[] }>(
      `/api/files/${fileId}/comments?status=open`,
    );
    expect(open.threads.map((t) => t.id)).toEqual([other.thread.id]);
    const done = await browser.json<{ threads: CommentThread[] }>(
      `/api/files/${fileId}/comments?status=resolved`,
    );
    expect(done.threads.map((t) => t.id)).toEqual([thread.id]);
    // Most recent activity first.
    const all = await browser.json<{ threads: CommentThread[] }>(`/api/files/${fileId}/comments`);
    expect(all.threads.map((t) => t.id)).toEqual([other.thread.id, thread.id]);

    const reopened = await browser.json<{ thread: CommentThread }>(
      `/api/files/${fileId}/comments/${thread.id}`,
      { method: "PATCH", json: { resolved: false } },
    );
    expect(reopened.thread).toMatchObject({ resolvedAt: null, resolvedBy: null });

    // Replying to a resolved thread reopens it.
    await browser.json(`/api/files/${fileId}/comments/${thread.id}`, {
      method: "PATCH",
      json: { resolved: true },
    });
    const revived = await browser.json<{ thread: CommentThread }>(
      `/api/files/${fileId}/comments/${thread.id}/replies`,
      { method: "POST", json: { body: "One more thing." } },
    );
    expect(revived.thread).toMatchObject({ resolvedAt: null, resolvedBy: null });
  });

  it("rejects bad input with a sentence a person can act on", async () => {
    const { browser, fileId } = await newFile();
    const empty = await browser.fetch(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: { pageId: "page1", x: 0, y: 0, body: "   " },
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      error: { code: "bad_request", message: "Write a comment first." },
    });

    const halfPinned = await browser.fetch(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: { pageId: "page1", x: 0, y: 0, body: "Hi", nodeId: "n1" },
    });
    expect(halfPinned.status).toBe(400);

    const status = await browser.fetch(`/api/files/${fileId}/comments?status=maybe`);
    expect(status.status).toBe(400);

    const missing = await browser.fetch(`/api/files/${fileId}/comments/nope/replies`, {
      method: "POST",
      json: { body: "Hello" },
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe(
      "That thread was deleted. Start a new comment instead.",
    );
  });

  it("stores mentions of teammates and refuses people outside the team", async () => {
    const { browser, fileId, teamId } = await newFile();
    const lena = await signedInUser("Lena Park", "editor", teamId);
    const outsider = await signedInUser("Mo Haddad");

    const { people } = await browser.json<{ people: Array<{ id: string; name: string }> }>(
      `/api/files/${fileId}/mentions`,
    );
    expect(people.map((p) => p.name)).toEqual(["Ana Ruiz", "Lena Park"]);

    const { thread } = await startThread(browser, fileId, {
      body: "Can @Lena Park take a look?",
      mentions: [lena.userId, lena.userId],
    });
    expect(thread.messages[0]?.mentions).toEqual([{ id: lena.userId, name: "Lena Park" }]);
    const rows = await env.DB.prepare(
      "SELECT user_id, file_id FROM comment_mentions WHERE user_id = ?",
    )
      .bind(lena.userId)
      .all();
    expect(rows.results).toEqual([{ user_id: lena.userId, file_id: fileId }]);

    const bad = await browser.fetch(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: { pageId: "page1", x: 0, y: 0, body: "Hi @Mo", mentions: [outsider.userId] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(
      /isn't on this team/,
    );
  });

  it("lets viewers comment, authors edit, and owners delete anything", async () => {
    const { browser: owner, fileId, teamId } = await newFile();
    const viewer = await signedInUser("Vera", "viewer", teamId);
    const editor = await signedInUser("Ed", "editor", teamId);
    const outsider = await signedInUser("Out");

    // Viewers can start threads and reply: commenting is collaboration, not editing.
    const { thread } = await startThread(viewer.browser, fileId, { body: "Viewer here." });
    const withReply = await editor.browser.json<{ thread: CommentThread }>(
      `/api/files/${fileId}/comments/${thread.id}/replies`,
      { method: "POST", json: { body: "Editor reply." } },
    );
    const [first, second] = withReply.thread.messages;
    if (!first || !second) throw new Error("expected two messages");

    // Outsiders can't see the file at all.
    expect((await outsider.browser.fetch(`/api/files/${fileId}/comments`)).status).toBe(404);
    expect(
      (
        await outsider.browser.fetch(`/api/files/${fileId}/comments`, {
          method: "POST",
          json: { pageId: "p", x: 0, y: 0, body: "Hi" },
        })
      ).status,
    ).toBe(404);

    // Only the author edits.
    const messageUrl = (id: string) => `/api/files/${fileId}/comments/${thread.id}/messages/${id}`;
    const ownerEdit = await owner.fetch(messageUrl(first.id), {
      method: "PATCH",
      json: { body: "Owner rewrite" },
    });
    expect(ownerEdit.status).toBe(403);
    expect(((await ownerEdit.json()) as { error: { message: string } }).error.message).toBe(
      "You can only edit your own comments.",
    );
    const edited = await viewer.browser.json<{ thread: CommentThread }>(messageUrl(first.id), {
      method: "PATCH",
      json: { body: "Viewer, edited." },
    });
    expect(edited.thread.messages[0]).toMatchObject({
      body: "Viewer, edited.",
      editedAt: expect.any(Number),
    });

    // Non-owners can't delete other people's messages.
    expect((await viewer.browser.fetch(messageUrl(second.id), { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await editor.browser.fetch(messageUrl(first.id), { method: "DELETE" })).status).toBe(
      403,
    );
    // Authors delete their own replies.
    const afterDelete = await editor.browser.json<{
      threadDeleted: boolean;
      thread: CommentThread;
    }>(messageUrl(second.id), { method: "DELETE" });
    expect(afterDelete.threadDeleted).toBe(false);
    expect(afterDelete.thread.messages).toHaveLength(1);

    // Owners delete anything; deleting the first message deletes the thread.
    const gone = await owner.json<{ threadDeleted: boolean }>(messageUrl(first.id), {
      method: "DELETE",
    });
    expect(gone.threadDeleted).toBe(true);
    const list = await owner.json<{ threads: unknown[] }>(`/api/files/${fileId}/comments`);
    expect(list.threads).toHaveLength(0);

    // Thread deletion: author yes, other non-owners no.
    const next = await startThread(editor.browser, fileId, { body: "Mine." });
    const threadUrl = `/api/files/${fileId}/comments/${next.thread.id}`;
    expect((await viewer.browser.fetch(threadUrl, { method: "DELETE" })).status).toBe(403);
    expect((await editor.browser.fetch(threadUrl, { method: "DELETE" })).status).toBe(200);
  });

  it("refuses new comments on a file in the trash", async () => {
    const { browser, fileId } = await newFile();
    await browser.json(`/api/files/${fileId}`, { method: "DELETE" });
    const response = await browser.fetch(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: { pageId: "page1", x: 0, y: 0, body: "Hi" },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "This file is in the trash. Restore it to comment.",
    );
  });

  it("removes comments when the file is deleted for good", async () => {
    const { browser, fileId } = await newFile();
    await startThread(browser, fileId);
    await browser.json(`/api/files/${fileId}`, { method: "DELETE" });
    await browser.json(`/api/files/${fileId}?permanent=1`, { method: "DELETE" });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM comment_threads WHERE file_id = ?")
      .bind(fileId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("comments in the room", () => {
  it("relays every comment change to everyone in the file", async () => {
    const { browser, fileId, teamId } = await newFile();
    const viewer = await signedInUser("Vera", "viewer", teamId);
    const a = await openSocket(browser, fileId);
    a.send({ t: "hello", protocol: 1, clientId: "clientA", revn: null });
    await a.next("welcome");
    const b = await openSocket(viewer.browser, fileId);
    b.send({ t: "hello", protocol: 1, clientId: "clientB", revn: null });
    await b.next("welcome");

    const { thread } = await startThread(viewer.browser, fileId, { body: "From the viewer." });
    for (const socket of [a, b]) {
      const message = await socket.next<{ event: CommentEvent }>("comments");
      expect(message.event).toEqual({ kind: "thread", thread });
    }

    await browser.json(`/api/files/${fileId}/comments/${thread.id}/replies`, {
      method: "POST",
      json: { body: "Owner reply." },
    });
    const replied = await b.next<{ event: CommentEvent }>("comments");
    expect(replied.event.kind === "thread" && replied.event.thread.messages).toHaveLength(2);

    await browser.json(`/api/files/${fileId}/comments/${thread.id}`, { method: "DELETE" });
    const deleted = await b.next<{ event: CommentEvent }>("comments");
    expect(deleted.event).toEqual({ kind: "deleted", threadId: thread.id });

    a.ws.close();
    b.ws.close();
  });

  it("reports how many sockets a relay reached", async () => {
    const { browser, fileId } = await newFile();
    const room = env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));
    expect(await room.broadcastComments({ kind: "deleted", threadId: "x" })).toBe(0);
    const a = await openSocket(browser, fileId);
    // Sockets that haven't said hello yet don't get room traffic.
    expect(await room.broadcastComments({ kind: "deleted", threadId: "x" })).toBe(0);
    a.send({ t: "hello", protocol: 1, clientId: "clientA", revn: null });
    await a.next("welcome");
    expect(await room.broadcastComments({ kind: "deleted", threadId: "x" })).toBe(1);
    a.ws.close();
  });
});
