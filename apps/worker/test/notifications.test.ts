import { env } from "cloudflare:test";
import type { CommentThread } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { type Browser, signedInUser } from "./helpers";

interface Item {
  id: string;
  createdAt: number;
  kind: "mention" | "reply" | "resolved";
  readAt: number | null;
  file: { id: string; name: string };
  threadId: string;
  resolved: boolean;
  actor: { id: string; name: string } | null;
  excerpt: string;
}
interface Inbox {
  items: Item[];
  before: string | null;
  unread: number;
}

/** Ana owns a file; Bo and Cy are on her team. */
async function team() {
  const ana = await signedInUser("Ana Ruiz");
  const bo = await signedInUser("Bo Chen", "editor", ana.teamId);
  const cy = await signedInUser("Cy Park", "viewer", ana.teamId);
  const { file } = await ana.browser.json<{ file: { id: string } }>(
    `/api/projects/${ana.projectId}/files`,
    { method: "POST", json: { name: "Onboarding" } },
  );
  return { ana, bo, cy, fileId: file.id };
}

const inbox = (browser: Browser, query = "") => browser.json<Inbox>(`/api/notifications${query}`);

const start = (browser: Browser, fileId: string, body: string, mentions: string[] = []) =>
  browser
    .json<{ thread: CommentThread }>(`/api/files/${fileId}/comments`, {
      method: "POST",
      json: { pageId: "page1", x: 0, y: 0, body, mentions },
    })
    .then((r) => r.thread);

const reply = (
  browser: Browser,
  fileId: string,
  threadId: string,
  body: string,
  mentions: string[] = [],
) =>
  browser
    .json<{ thread: CommentThread }>(`/api/files/${fileId}/comments/${threadId}/replies`, {
      method: "POST",
      json: { body, mentions },
    })
    .then((r) => r.thread);

describe("notifications", () => {
  it("tells people they were mentioned, and everyone in a thread about replies", async () => {
    const { ana, bo, cy, fileId } = await team();
    const thread = await start(ana.browser, fileId, "@Bo Chen can you check the spacing?", [
      bo.userId,
    ]);
    // Mentioned: Bo hears it; Ana doesn't hear about her own comment; Cy isn't in it.
    const forBo = await inbox(bo.browser);
    expect(forBo.unread).toBe(1);
    expect(forBo.items).toMatchObject([
      {
        kind: "mention",
        file: { id: fileId, name: "Onboarding" },
        team: { id: ana.teamId, name: "Team" },
        threadId: thread.id,
        actor: { id: ana.userId, name: "Ana Ruiz" },
        excerpt: "@Bo Chen can you check the spacing?",
        readAt: null,
      },
    ]);
    expect((await inbox(ana.browser)).unread).toBe(0);
    expect((await inbox(cy.browser)).unread).toBe(0);

    // Bo replies and mentions Cy: Ana (in the thread) hears a reply, Cy a mention, Bo nothing.
    await reply(bo.browser, fileId, thread.id, "Looks right. @Cy Park?", [cy.userId]);
    expect((await inbox(ana.browser)).items.map((i) => i.kind)).toEqual(["reply"]);
    expect((await inbox(cy.browser)).items.map((i) => i.kind)).toEqual(["mention"]);
    expect((await inbox(bo.browser)).items.map((i) => i.kind)).toEqual(["mention"]);

    // Cy replies: Ana and Bo, both in the thread now, hear a reply.
    await reply(cy.browser, fileId, thread.id, "Yes, 16 is right.");
    expect((await inbox(ana.browser)).items.map((i) => i.kind)).toEqual(["reply", "reply"]);
    expect((await inbox(bo.browser)).items.map((i) => i.kind)).toEqual(["reply", "mention"]);
  });

  it("tells whoever started a thread that it was resolved, and takes it back on reopen", async () => {
    const { ana, bo, fileId } = await team();
    const thread = await start(ana.browser, fileId, "Is the logo too small?");
    const resolve = (resolved: boolean) =>
      bo.browser.json(`/api/files/${fileId}/comments/${thread.id}`, {
        method: "PATCH",
        json: { resolved },
      });
    await resolve(true);
    const resolved = await inbox(ana.browser);
    expect(resolved.items).toMatchObject([
      {
        kind: "resolved",
        actor: { name: "Bo Chen" },
        resolved: true,
        excerpt: "Is the logo too small?",
      },
    ]);
    await resolve(false);
    expect((await inbox(ana.browser)).items).toEqual([]);
    // Resolving your own thread tells nobody.
    await ana.browser.json(`/api/files/${fileId}/comments/${thread.id}`, {
      method: "PATCH",
      json: { resolved: true },
    });
    expect((await inbox(ana.browser)).items).toEqual([]);
  });

  it("notifies a mention added by an edit once, and takes back one edited out", async () => {
    const { ana, bo, cy, fileId } = await team();
    const thread = await start(ana.browser, fileId, "Spacing?", [bo.userId]);
    const commentId = thread.messages[0]?.id as string;
    const edit = (body: string, mentions: string[]) =>
      ana.browser.json(`/api/files/${fileId}/comments/${thread.id}/messages/${commentId}`, {
        method: "PATCH",
        json: { body, mentions },
      });
    await edit("Spacing? @Bo Chen @Cy Park", [bo.userId, cy.userId]);
    expect((await inbox(bo.browser)).items).toHaveLength(1);
    expect((await inbox(cy.browser)).items).toHaveLength(1);
    await edit("Spacing? @Cy Park", [cy.userId]);
    expect((await inbox(bo.browser)).items).toHaveLength(0);
    expect((await inbox(cy.browser)).items).toMatchObject([{ excerpt: "Spacing? @Cy Park" }]);
  });

  it("marks read by item, by thread, or all, and lists only what's unread when asked", async () => {
    const { ana, bo, fileId } = await team();
    const first = await start(ana.browser, fileId, "One @Bo Chen", [bo.userId]);
    await start(ana.browser, fileId, "Two @Bo Chen", [bo.userId]);
    await start(ana.browser, fileId, "Three @Bo Chen", [bo.userId]);
    const all = await inbox(bo.browser);
    expect(all.unread).toBe(3);
    const read = (json: unknown) =>
      bo.browser.json<{ unread: number }>("/api/notifications/read", { method: "POST", json });
    expect(await read({ ids: [all.items[0]?.id] })).toEqual({ unread: 2 });
    expect(await read({ threadId: first.id })).toEqual({ unread: 1 });
    expect((await inbox(bo.browser, "?filter=unread")).items.map((i) => i.excerpt)).toEqual([
      "Two @Bo Chen",
    ]);
    expect(await read({ all: true })).toEqual({ unread: 0 });
    expect(await bo.browser.json("/api/notifications/unread")).toEqual({ unread: 0 });
    // Someone else's notifications can't be marked: nothing changes for Ana.
    const bad = await bo.browser.fetch("/api/notifications/read", { method: "POST", json: {} });
    expect(bad.status).toBe(400);
  });

  it("hides files someone can no longer open, and pages through the rest", async () => {
    const { ana, bo, fileId } = await team();
    for (let i = 0; i < 32; i++)
      await start(ana.browser, fileId, `Note ${i} @Bo Chen`, [bo.userId]);
    const first = await inbox(bo.browser);
    expect(first.items).toHaveLength(30);
    expect(first.before).not.toBeNull();
    const second = await inbox(bo.browser, `?before=${first.before}`);
    expect(second.items).toHaveLength(2);
    expect(second.before).toBeNull();
    // Every note exactly once across the pages, however many share a millisecond.
    const seen = [...first.items, ...second.items].map((i) => i.excerpt);
    expect(new Set(seen).size).toBe(32);
    expect(seen.sort()).toEqual(Array.from({ length: 32 }, (_, i) => `Note ${i} @Bo Chen`).sort());

    // Trashed: gone from the inbox and the count.
    await ana.browser.json(`/api/files/${fileId}`, { method: "DELETE" });
    expect(await inbox(bo.browser)).toMatchObject({ items: [], unread: 0 });
  });

  it("takes back an unread 'resolved' when a reply reopens the thread, and notifies once per resolve", async () => {
    const { ana, bo, fileId } = await team();
    const thread = await start(ana.browser, fileId, "Is the logo too small?");
    const resolve = () =>
      bo.browser.json(`/api/files/${fileId}/comments/${thread.id}`, {
        method: "PATCH",
        json: { resolved: true },
      });
    await resolve();
    // Resolving again (a stale screen) doesn't say it twice.
    await ana.browser.json("/api/notifications/read", { method: "POST", json: { all: true } });
    await resolve();
    expect((await inbox(ana.browser)).unread).toBe(0);
    // Unresolved by a reply: the 'resolved' that's still unread goes.
    await bo.browser.json(`/api/files/${fileId}/comments/${thread.id}`, {
      method: "PATCH",
      json: { resolved: false },
    });
    await resolve();
    await reply(bo.browser, fileId, thread.id, "Actually, one more thing.");
    expect((await inbox(ana.browser)).items.map((i) => i.kind)).toEqual(["reply", "resolved"]);
    expect((await inbox(ana.browser, "?filter=unread")).items.map((i) => i.kind)).toEqual([
      "reply",
    ]);
  });

  it("turns a mention edited out of a reply back into a reply notification", async () => {
    const { ana, bo, fileId } = await team();
    const thread = await start(ana.browser, fileId, "Spacing?");
    const message = await reply(bo.browser, fileId, thread.id, "@Ana Ruiz look", [ana.userId]);
    const commentId = message.messages.at(-1)?.id as string;
    expect((await inbox(ana.browser)).items.map((i) => i.kind)).toEqual(["mention"]);
    await bo.browser.json(`/api/files/${fileId}/comments/${thread.id}/messages/${commentId}`, {
      method: "PATCH",
      json: { body: "look", mentions: [] },
    });
    // She started the thread: she still hears about the reply.
    expect((await inbox(ana.browser)).items).toMatchObject([{ kind: "reply", excerpt: "look" }]);
  });

  it("doesn't notify people who've left the team", async () => {
    const { ana, bo, cy, fileId } = await team();
    const thread = await start(ana.browser, fileId, "Spacing?");
    await reply(cy.browser, fileId, thread.id, "Looks fine");
    await ana.browser.json(`/api/teams/${ana.teamId}/members/${cy.userId}`, { method: "DELETE" });
    await reply(bo.browser, fileId, thread.id, "Said while Cy was away");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?")
      .bind(cy.userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("marks all read only up to what was shown", async () => {
    const { ana, bo, fileId } = await team();
    await start(ana.browser, fileId, "One @Bo Chen", [bo.userId]);
    const shown = await inbox(bo.browser);
    const newest = shown.items[0]?.createdAt as number;
    // Arrives after the list was loaded.
    await new Promise((r) => setTimeout(r, 5));
    await start(ana.browser, fileId, "Two @Bo Chen", [bo.userId]);
    const result = await bo.browser.json<{ unread: number }>("/api/notifications/read", {
      method: "POST",
      json: { all: true, upTo: newest },
    });
    expect(result.unread).toBe(1);
  });
});
