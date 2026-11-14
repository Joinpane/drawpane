import { env } from "cloudflare:test";
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { thumbnailKey } from "../src/api/media";
import { signedInUser } from "./helpers";

const roomOf = (fileId: string) => env.FILE_ROOM.get(env.FILE_ROOM.idFromName(fileId));

const content: NodeRecord[] = [
  { id: "P1", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Screens" } },
  {
    id: "F1",
    type: "frame",
    parent: "P1",
    key: "a0",
    props: { name: "Home", width: 390, height: 844 },
  },
  { id: "T1", type: "text", parent: "F1", key: "a0", props: { characters: "Hello" } },
];

async function fileWithContent() {
  const owner = await signedInUser("Ana");
  const { file } = await owner.browser.json<{ file: { id: string } }>(
    `/api/projects/${owner.projectId}/files`,
    { method: "POST", json: { name: "Starter" } },
  );
  await owner.browser.json(`/api/files/${file.id}/import`, {
    method: "POST",
    json: { nodes: content },
  });
  return { ...owner, fileId: file.id };
}

describe("copying files", () => {
  it("makes a copy with the same content and thumbnail", async () => {
    const { browser, projectId, fileId } = await fileWithContent();
    await env.FILES.put(thumbnailKey(fileId), new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    const { file } = await browser.json<{
      file: { id: string; name: string; thumbnailAt: number | null };
    }>(`/api/projects/${projectId}/files`, {
      method: "POST",
      json: { name: "Starter (copy)", from: fileId },
    });
    expect(file.name).toBe("Starter (copy)");
    expect(file.thumbnailAt).not.toBeNull();
    const nodes = await roomOf(file.id).allNodes();
    expect(nodes.map((n) => n.props.name ?? n.props.characters).sort()).toEqual(
      ["Hello", "Home", "Screens"].sort(),
    );
    const thumb = await env.FILES.get(thumbnailKey(file.id));
    expect(new Uint8Array(await (thumb as R2ObjectBody).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    // The original is untouched, and the two are separate from here on.
    expect((await roomOf(fileId).stats()).nodes).toBe(3);
  });

  it("only copies files from the same team", async () => {
    const { fileId } = await fileWithContent();
    const other = await signedInUser("Bo");
    const response = await other.browser.fetch(`/api/projects/${other.projectId}/files`, {
      method: "POST",
      json: { name: "Mine now", from: fileId },
    });
    // Bo can't even see it.
    expect(response.status).toBe(404);
  });
});

describe("templates", () => {
  it("marks a file as a template, lists it for the team, and leaves its edited time", async () => {
    const { browser, teamId, fileId } = await fileWithContent();
    const before = await browser.json<{ file: { updatedAt: number } }>(`/api/files/${fileId}`);
    await browser.json(`/api/files/${fileId}`, { method: "PATCH", json: { isTemplate: true } });
    const { files } = await browser.json<{ files: Array<{ id: string; isTemplate: boolean }> }>(
      `/api/teams/${teamId}/templates`,
    );
    expect(files).toEqual([expect.objectContaining({ id: fileId, isTemplate: true })]);
    const after = await browser.json<{ file: { updatedAt: number } }>(`/api/files/${fileId}`);
    expect(after.file.updatedAt).toBe(before.file.updatedAt);

    await browser.json(`/api/files/${fileId}`, { method: "PATCH", json: { isTemplate: false } });
    const again = await browser.json<{ files: unknown[] }>(`/api/teams/${teamId}/templates`);
    expect(again.files).toEqual([]);
  });

  it("keeps templates to editors", async () => {
    const { teamId, fileId } = await fileWithContent();
    const viewer = await signedInUser("Cy", "viewer", teamId);
    const response = await viewer.browser.fetch(`/api/files/${fileId}`, {
      method: "PATCH",
      json: { isTemplate: true },
    });
    expect(response.status).toBe(403);
  });
});
