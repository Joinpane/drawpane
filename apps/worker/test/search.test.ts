import { describe, expect, it } from "vitest";
import { escapeLike, fileSearch } from "../src/api/search";
import { signedInUser } from "./helpers";

describe("file search", () => {
  it("finds every file on the team whose name has every word, best matches first", async () => {
    const ana = await signedInUser("Ana Lima");
    const { project } = await ana.browser.json<{ project: { id: string } }>(
      `/api/teams/${ana.teamId}/projects`,
      { method: "POST", json: { name: "Marketing" } },
    );
    const make = (projectId: string, name: string) =>
      ana.browser.json(`/api/projects/${projectId}/files`, { method: "POST", json: { name } });
    // Oldest first: within a rank, the most recently edited wins.
    await make(ana.projectId, "Checkout flow");
    await make(project.id, "Onboarding");
    await make(ana.projectId, "Onboarding flow v2");
    await make(project.id, "Flow onboarding notes");
    await make(ana.projectId, "Settings");
    await make(project.id, "Reflow tests");
    const search = (q: string) =>
      ana.browser
        .json<{ files: { name: string }[] }>(
          `/api/teams/${ana.teamId}/files?q=${encodeURIComponent(q)}`,
        )
        .then((r) => r.files.map((f) => f.name));

    // Across projects; whole name, then prefix, then a word's start, then anywhere.
    expect(await search("onboarding")).toEqual([
      "Onboarding",
      "Onboarding flow v2",
      "Flow onboarding notes",
    ]);
    expect(await search("flow")).toEqual([
      "Flow onboarding notes",
      "Onboarding flow v2",
      "Checkout flow",
      "Reflow tests",
    ]);
    // Every word, in any order and case.
    expect(await search("FLOW onboard")).toEqual(["Flow onboarding notes", "Onboarding flow v2"]);
    expect(await search("  ")).toHaveLength(6);
  });

  it("matches % and _ as themselves, and keeps to the team and out of the trash", async () => {
    const ana = await signedInUser("Ana Lima");
    const other = await signedInUser("Other");
    const make = (name: string) =>
      ana.browser.json<{ file: { id: string } }>(`/api/projects/${ana.projectId}/files`, {
        method: "POST",
        json: { name },
      });
    await make("Growth 100% plan");
    await make("Growth 1000 plan");
    await make("snake_case");
    await make("snakeXcase");
    const { file } = await make("Old snake_case");
    await ana.browser.json(`/api/files/${file.id}`, { method: "DELETE" });
    await other.browser.json(`/api/projects/${other.projectId}/files`, {
      method: "POST",
      json: { name: "snake_case elsewhere" },
    });
    const search = (q: string, trash = false) =>
      ana.browser
        .json<{ files: { name: string }[] }>(
          `/api/teams/${ana.teamId}/files?q=${encodeURIComponent(q)}${trash ? "&view=trash" : ""}`,
        )
        .then((r) => r.files.map((f) => f.name));
    expect(await search("100%")).toEqual(["Growth 100% plan"]);
    expect(await search("snake_case")).toEqual(["snake_case"]);
    expect(await search("snake_case", true)).toEqual(["Old snake_case"]);
  });

  it("builds patterns with the user's text escaped", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(fileSearch("   ")).toBeNull();
    expect(fileSearch(" Hero  Card ")?.binds).toEqual([
      "%hero%",
      "%card%",
      "hero card",
      "hero card%",
      "% hero card%",
    ]);
  });
});
