/**
 * Opening a file larger than one snapshot chunk in a real browser: the room
 * gives a ticket, and the file is downloaded over HTTP (gzip, read as it
 * arrives) instead of sent through the socket, which once ran a room out of
 * memory on a 500,000-layer kit and left the editor empty. Runs on its own
 * throwaway instance.
 */
import { INLINE_SNAPSHOT_NODES, keyBetween } from "@drawpane/model";
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

const LAYERS = INLINE_SNAPSHOT_NODES + 500;
const KEYS: string[] = [];
for (let i = 0; i < LAYERS; i++) KEYS.push(keyBetween(KEYS.at(-1) ?? null, null));

test.describe("A large file", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 9041, inspectorPort: 9581 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("opens downloaded, with every layer, and opens again after an edit", async () => {
    test.setTimeout(180_000);
    const page = instance.page;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    // A file of a page and LAYERS rectangles, imported as the browser imports one.
    const fileId = await page.evaluate(async (keys) => {
      const json = async (path: string, body?: unknown) => {
        const response = await fetch(path, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
        return response.json();
      };
      const { teams } = await json("/api/teams");
      const { projects } = await json(`/api/teams/${teams[0].id}/projects`);
      const { file } = await json(`/api/projects/${projects[0].id}/files`, { name: "Big kit" });
      const nodes: unknown[] = [
        { id: "BigPage", type: "page", parent: "root", key: "a0", props: { name: "Big page" } },
      ];
      for (let i = 0; i < keys.length; i++)
        nodes.push({
          id: `Rect${i}`,
          type: "rect",
          parent: "BigPage",
          key: keys[i],
          props: {
            name: `Rect ${i}`,
            x: (i % 50) * 20,
            y: Math.floor(i / 50) * 20,
            width: 16,
            height: 16,
          },
        });
      const { importId } = await json(`/api/files/${file.id}/imports`, {});
      await json(`/api/files/${file.id}/imports/${importId}/parts`, { nodes });
      await json(`/api/files/${file.id}/imports/${importId}/commit`, {});
      return file.id as string;
    }, KEYS);

    const downloads: number[] = [];
    page.on("response", (response) => {
      if (/\/api\/files\/[^/]+\/document\?/.test(response.url())) downloads.push(response.status());
    });
    await page.goto(`/f/${fileId}`);
    await expect(page.getByRole("status").filter({ hasText: "Saved · revision" })).toBeVisible({
      timeout: 60_000,
    });
    expect(downloads).toEqual([200]);
    const count = () =>
      page.evaluate(
        () =>
          [
            ...(
              window as unknown as { drawpane: { doc: { nodes(): Iterable<{ type: string }> } } }
            ).drawpane.doc.nodes(),
          ].filter((n) => n.type === "rect").length,
      );
    expect(await count()).toBe(LAYERS);
    await expect(page.getByText("Big page").first()).toBeVisible();

    // An edit, then opened again: downloaded again, edit and all.
    await page.evaluate(() =>
      (window as unknown as { drawpane: { commit(ops: unknown[]): boolean } }).drawpane.commit([
        { op: "set", id: "Rect0", prop: "name", value: "Renamed" },
      ]),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { drawpane: { sync: { pendingCount: number } } }).drawpane.sync
              .pendingCount,
        ),
      )
      .toBe(0);
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "Saved · revision" })).toBeVisible({
      timeout: 60_000,
    });
    expect(downloads).toEqual([200, 200]);
    expect(await count()).toBe(LAYERS);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              drawpane: { doc: { get(id: string): { props: { name?: string } } | undefined } };
            }
          ).drawpane.doc.get("Rect0")?.props.name,
      ),
    ).toBe("Renamed");
  });
});
