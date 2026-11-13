import { describe, expect, it } from "vitest";
import { signedInUser } from "./helpers";

describe("files API", () => {
  it("creates, renames, trashes and restores files", async () => {
    const { browser, projectId, teamId } = await signedInUser();
    const { file } = await browser.json<{ file: { id: string; name: string } }>(
      `/api/projects/${projectId}/files`,
      {
        method: "POST",
        json: { name: "Checkout flow" },
      },
    );
    expect(file.name).toBe("Checkout flow");

    await browser.json(`/api/files/${file.id}`, { method: "PATCH", json: { name: "Checkout v2" } });
    const meta = await browser.json<{ file: { name: string }; role: string }>(
      `/api/files/${file.id}`,
    );
    expect(meta).toMatchObject({ file: { name: "Checkout v2" }, role: "owner" });

    await browser.json(`/api/files/${file.id}`, { method: "DELETE" });
    let list = await browser.json<{ files: unknown[] }>(`/api/teams/${teamId}/files`);
    expect(list.files).toHaveLength(0);
    list = await browser.json<{ files: unknown[] }>(`/api/teams/${teamId}/files?view=trash`);
    expect(list.files).toHaveLength(1);

    await browser.json(`/api/files/${file.id}/restore`, { method: "POST" });
    list = await browser.json<{ files: unknown[] }>(`/api/projects/${projectId}/files`);
    expect(list.files).toHaveLength(1);
  });

  it("hides other teams' files and enforces roles", async () => {
    const owner = await signedInUser("Owner");
    const outsider = await signedInUser("Outsider");
    const viewer = await signedInUser("Viewer", "viewer", owner.teamId);
    const { file } = await owner.browser.json<{ file: { id: string } }>(
      `/api/projects/${owner.projectId}/files`,
      {
        method: "POST",
        json: {},
      },
    );

    expect((await outsider.browser.fetch(`/api/files/${file.id}`)).status).toBe(404);
    expect((await viewer.browser.fetch(`/api/files/${file.id}`)).status).toBe(200);
    const rename = await viewer.browser.fetch(`/api/files/${file.id}`, {
      method: "PATCH",
      json: { name: "x" },
    });
    expect(rename.status).toBe(403);
    const create = await viewer.browser.fetch(`/api/projects/${owner.projectId}/files`, {
      method: "POST",
      json: {},
    });
    expect(create.status).toBe(403);
  });

  it("deletes a trashed file for good, including its room", async () => {
    const { browser, projectId } = await signedInUser();
    const { file } = await browser.json<{ file: { id: string } }>(
      `/api/projects/${projectId}/files`,
      {
        method: "POST",
        json: {},
      },
    );
    const early = await browser.fetch(`/api/files/${file.id}?permanent=1`, { method: "DELETE" });
    expect(early.status).toBe(409);
    await browser.json(`/api/files/${file.id}`, { method: "DELETE" });
    await browser.json(`/api/files/${file.id}?permanent=1`, { method: "DELETE" });
    expect((await browser.fetch(`/api/files/${file.id}`)).status).toBe(404);
  });

  it("keeps a team owner", async () => {
    const { browser, teamId, userId } = await signedInUser();
    const response = await browser.fetch(`/api/teams/${teamId}/members/${userId}`, {
      method: "PATCH",
      json: { role: "editor" },
    });
    expect(response.status).toBe(409);
  });
});
