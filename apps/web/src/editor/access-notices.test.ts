import { describe, expect, it } from "vitest";
import { roleChangeNotice } from "./access-notices";

const change = (
  role: "owner" | "editor" | "viewer",
  previous: "owner" | "editor" | "viewer",
  by = { id: "ana", name: "Ana Lima" },
) => ({ t: "role" as const, role, previous, by });

describe("roleChangeNotice", () => {
  it("says who changed it and what it means for the file", () => {
    expect(roleChangeNotice(change("viewer", "editor"), "bo")).toBe(
      "Ana Lima made you a viewer. You can still view, comment and inspect.",
    );
    expect(roleChangeNotice(change("editor", "viewer"), "bo")).toBe(
      "Ana Lima made you an editor. You can edit this file now.",
    );
    expect(roleChangeNotice(change("owner", "editor"), "bo")).toBe("Ana Lima made you an owner.");
  });

  it("doesn't promise editing to an owner who could already edit, or credit you to yourself", () => {
    // An owner stepping down, seen in their own other tab.
    expect(roleChangeNotice(change("editor", "owner"), "ana")).toBe(
      "You're now an editor of this team. You can still edit, but not manage the team.",
    );
    expect(roleChangeNotice(change("editor", "owner"), "bo")).toBe(
      "Ana Lima made you an editor. You can still edit, but not manage the team.",
    );
  });
});
