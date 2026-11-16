import { env } from "cloudflare:test";
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

  it("renames a project, moves files between projects, and deletes a project into the trash", async () => {
    const { browser, projectId: drafts, teamId } = await signedInUser();
    type Project = { id: string; name: string; fileCount: number };
    const projects = async () =>
      (await browser.json<{ projects: Project[] }>(`/api/teams/${teamId}/projects`)).projects;
    const newFile = async (projectId: string, name: string) =>
      (
        await browser.json<{ file: { id: string } }>(`/api/projects/${projectId}/files`, {
          method: "POST",
          json: { name },
        })
      ).file.id;

    // The team's only project can't go: new files need somewhere to land.
    const alone = await browser.fetch(`/api/projects/${drafts}`, { method: "DELETE" });
    expect(alone.status).toBe(409);

    const { project } = await browser.json<{ project: Project }>(`/api/teams/${teamId}/projects`, {
      method: "POST",
      json: { name: "Mobile" },
    });
    await browser.json(`/api/projects/${project.id}`, {
      method: "PATCH",
      json: { name: "Mobile app" },
    });
    const a = await newFile(project.id, "Onboarding");
    const b = await newFile(drafts, "Settings");
    await browser.json(`/api/files/${b}`, { method: "PATCH", json: { projectId: project.id } });
    expect((await projects()).find((p) => p.id === project.id)).toMatchObject({
      name: "Mobile app",
      fileCount: 2,
    });

    const deleted = await browser.json<{ trashed: number }>(`/api/projects/${project.id}`, {
      method: "DELETE",
    });
    expect(deleted.trashed).toBe(2);
    expect((await projects()).map((p) => p.id)).toEqual([drafts]);
    const trash = await browser.json<{ files: { id: string }[] }>(
      `/api/teams/${teamId}/files?view=trash`,
    );
    expect(trash.files.map((f) => f.id).sort()).toEqual([a, b].sort());
    // Gone from view: nothing new goes in, and nothing moves there.
    expect(
      (await browser.fetch(`/api/projects/${project.id}/files`, { method: "POST", json: {} }))
        .status,
    ).toBe(404);
    const c = await newFile(drafts, "Profile");
    expect(
      (
        await browser.fetch(`/api/files/${c}`, {
          method: "PATCH",
          json: { projectId: project.id },
        })
      ).status,
    ).toBe(404);

    // Restoring one of its files brings the project back, with just that file.
    await browser.json(`/api/files/${a}/restore`, { method: "POST" });
    expect((await projects()).find((p) => p.id === project.id)).toMatchObject({
      name: "Mobile app",
      fileCount: 1,
    });
  });

  it("empties the trash for good, and the deleted projects left with nothing", async () => {
    const { browser, projectId: drafts, teamId } = await signedInUser();
    const editor = await signedInUser("Editor", "editor", teamId);
    const { project } = await browser.json<{ project: { id: string } }>(
      `/api/teams/${teamId}/projects`,
      { method: "POST", json: { name: "Old" } },
    );
    const ids: string[] = [];
    for (const [projectId, name] of [
      [project.id, "One"],
      [drafts, "Two"],
      [drafts, "Kept"],
    ] as const) {
      const { file } = await browser.json<{ file: { id: string } }>(
        `/api/projects/${projectId}/files`,
        { method: "POST", json: { name } },
      );
      ids.push(file.id);
    }
    await browser.json(`/api/projects/${project.id}`, { method: "DELETE" });
    await browser.json(`/api/files/${ids[1]}`, { method: "DELETE" });

    // Only an owner deletes for good.
    const refused = await editor.browser.fetch(`/api/teams/${teamId}/trash/empty`, {
      method: "POST",
    });
    expect(refused.status).toBe(403);

    const emptied = await browser.json<{ deleted: number; remaining: number }>(
      `/api/teams/${teamId}/trash/empty`,
      { method: "POST" },
    );
    expect(emptied).toEqual({ deleted: 2, remaining: 0 });
    for (const id of ids.slice(0, 2))
      expect((await browser.fetch(`/api/files/${id}`)).status).toBe(404);
    expect((await browser.fetch(`/api/files/${ids[2]}`)).status).toBe(200);
    const left = await env.DB.prepare("SELECT id FROM projects WHERE team_id = ?")
      .bind(teamId)
      .all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([drafts]);
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
