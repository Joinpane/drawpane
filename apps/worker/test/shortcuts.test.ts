import { describe, expect, it } from "vitest";
import { signedInUser } from "./helpers";

describe("keyboard shortcuts on the account", () => {
  it("start with none changed, and keep what's saved, per person", async () => {
    const ana = await signedInUser("Ana");
    const bo = await signedInUser("Bo");
    expect(await ana.browser.json("/api/account/shortcuts")).toEqual({ shortcuts: {} });
    const shortcuts = {
      "view.command": { key: "p", mod: true },
      "tool.rect": null,
    };
    await ana.browser.json("/api/account/shortcuts", { method: "PUT", json: { shortcuts } });
    expect(await ana.browser.json("/api/account/shortcuts")).toEqual({ shortcuts });
    // Someone else's are their own.
    expect(await bo.browser.json("/api/account/shortcuts")).toEqual({ shortcuts: {} });
  });

  it("refuses what isn't a shortcut map", async () => {
    const ana = await signedInUser("Ana");
    const put = (body: unknown) =>
      ana.browser.fetch("/api/account/shortcuts", { method: "PUT", json: body });
    expect((await put({ shortcuts: { "view.command": { key: "" } } })).status).toBe(400);
    expect((await put({ shortcuts: { "<script>": { key: "k" } } })).status).toBe(400);
    expect((await put({ shortcuts: [] })).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`a${i}`, null]));
    expect((await put({ shortcuts: many })).status).toBe(400);
  });

  it("is only for someone signed in", async () => {
    const { browser } = await signedInUser("Ana");
    await browser.json("/api/auth/logout", { method: "POST" });
    expect((await browser.fetch("/api/account/shortcuts")).status).toBe(401);
  });
});
