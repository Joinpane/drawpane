/**
 * The layers panel in a real browser, on a throwaway instance: finding
 * layers with ⌘F and filters, selecting what was found, folding the tree
 * with ⌥-click and ⌥L, locking from a row, duplicating with ⌥-drag, and
 * dragging a layer out of its groups to the level the pointer is at (even
 * the last layer in a frame, over its own row), and into the empty space
 * below the list. A tree too deep for the panel scrolls sideways with its
 * toggles kept in view, and follows a layer selected on the canvas.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  s: { pageId: string; selection: string[] };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  doc: {
    get(id: string): { parent: string; props: Record<string, unknown> } | undefined;
    childIds(id: string): string[];
  };
};
type W = { drawpane: Debug };

const tree = (page: Page) => page.getByRole("tree", { name: "Layers" });
const row = (page: Page, name: string | RegExp) =>
  tree(page).getByRole("treeitem", {
    name: typeof name === "string" ? new RegExp(`^${name}`) : name,
  });
const selection = (page: Page) =>
  page.evaluate(() => (window as unknown as W).drawpane.s.selection);

test.describe
  .serial("Layers panel", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let ids: {
      home: string;
      list: string;
      rowA: string;
      rowB: string;
      title: string;
      other: string;
      /** Made by the "last layer in a frame" test. */
      label?: string;
    };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8805, inspectorPort: 9345 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      ids = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const p = e.s.pageId;
        const home = e.createLayer("frame", { x: 0, y: 0, width: 400, height: 600 }, p, {
          name: "Home",
        }) as string;
        const list = e.createLayer("frame", { x: 20, y: 100, width: 360, height: 300 }, home, {
          name: "Event list",
        }) as string;
        const rowA = e.createLayer("text", { x: 40, y: 120, width: 100, height: 20 }, list, {
          name: "Event row",
          characters: "Standup",
        }) as string;
        const rowB = e.createLayer("text", { x: 40, y: 160, width: 100, height: 20 }, list, {
          name: "Event row",
          characters: "Review",
        }) as string;
        const title = e.createLayer("text", { x: 20, y: 20, width: 200, height: 40 }, home, {
          name: "Title",
          characters: "Today",
        }) as string;
        const other = e.createLayer("frame", { x: 500, y: 0, width: 400, height: 600 }, p, {
          name: "Settings",
        }) as string;
        e.select([]);
        return { home, list, rowA, rowB, title, other };
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("⌘F finds layers by name, inside folded frames, and selects them all", async () => {
      // Fold the tree first: results still show, under their frames.
      await page.locator(".canvas__overlay").click({ position: { x: 700, y: 760 } });
      await page.keyboard.press("Alt+l");
      await expect(row(page, "Event row")).toHaveCount(0);

      await page.keyboard.press("ControlOrMeta+f");
      const field = page.getByRole("searchbox", { name: "Find layers" });
      await expect(field).toBeFocused();
      await field.fill("event row");
      await expect(page.getByText("2 found")).toBeVisible();
      await expect(row(page, "Event row")).toHaveCount(2);
      // The frames above them stay, muted, to show where they are.
      await expect(row(page, "Home")).toHaveClass(/is-context/);
      await expect(row(page, "Settings")).toHaveCount(0);
      await expect(row(page, "Event row").first().locator("mark")).toHaveText("Event row");

      await field.press("Enter");
      expect((await selection(page)).sort()).toEqual([ids.rowA, ids.rowB].sort());
    });

    test("filters by kind, and Esc puts the tree back", async () => {
      const field = page.getByRole("searchbox", { name: "Find layers" });
      await field.fill("");
      await page.getByRole("radio", { name: "Text" }).click();
      await expect(page.getByText("3 found")).toBeVisible();
      await page.getByRole("radio", { name: "Frames" }).click();
      await expect(page.getByText("3 found")).toBeVisible();
      await expect(field).toBeFocused();
      await field.press("Escape");
      await expect(field).toBeHidden();
      await expect(row(page, "Settings")).toBeVisible();
    });

    test("⌥-click on a caret opens everything inside", async () => {
      await page.keyboard.press("Alt+l");
      await expect(row(page, "Event list")).toHaveCount(0);
      await row(page, "Home")
        .locator(".dp-layer__caret")
        .click({ modifiers: ["Alt"] });
      await expect(row(page, "Event list")).toBeVisible();
      await expect(row(page, "Event row")).toHaveCount(2);
    });

    test("locks a layer from its row, and unlocks it again", async () => {
      const title = row(page, "Title");
      const lock = title.getByRole("button", { name: "Lock" });
      // Unlocked: a faint open padlock, only on hover.
      await expect(lock).toHaveAttribute("aria-pressed", "false");
      await expect(lock).toHaveCSS("opacity", "0");
      await title.hover();
      await expect(lock).toHaveCSS("opacity", "1");
      await lock.click();
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as W).drawpane.doc.get(id)?.props.locked,
            ids.title,
          ),
        )
        .toBe(true);
      // Locked: pressed, and a solid closed padlock that stays when the pointer leaves.
      await expect(lock).toHaveAttribute("aria-pressed", "true");
      await expect(lock).toHaveAttribute("title", "Unlock");
      await expect(lock.locator("rect")).toHaveAttribute("fill", "currentColor");
      await page.mouse.move(700, 760);
      await expect(lock).toHaveCSS("opacity", "1");
      await expect(row(page, "Event list").getByRole("button", { name: "Lock" })).toHaveCSS(
        "opacity",
        "0",
      );
      await lock.click();
      await expect
        .poll(() =>
          page.evaluate(
            (id) => (window as unknown as W).drawpane.doc.get(id)?.props.locked ?? false,
            ids.title,
          ),
        )
        .toBe(false);
    });

    test("moves focus with the selection from the keyboard", async () => {
      const rows = tree(page).getByRole("treeitem");
      await rows.first().click();
      const where = () =>
        page.evaluate((all) => {
          const doc = (window as unknown as W).drawpane.doc;
          return all.map((id) => [doc.get(id)?.props.x, doc.get(id)?.props.y]);
        }, Object.values(ids));
      const before = await where();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-layer-id"),
      );
      const selected = await selection(page);
      expect(focused).toBe(selected[0]);
      // The arrows walk the list; they don't also nudge layers on the canvas.
      expect(await where()).toEqual(before);
      // And End lands focus on the last row.
      await page.keyboard.press("End");
      await expect(rows.last()).toBeFocused();
    });

    test("drags a layer into another frame, saying where it goes", async () => {
      const source = row(page, "Title");
      const target = row(page, "Settings");
      // Native drag and drop: press on the source, then move over the target twice.
      await source.hover();
      await page.mouse.down();
      await target.hover();
      await target.hover();
      await expect(
        page.getByRole("status").filter({ hasText: "moving into Settings" }),
      ).toBeVisible();
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, ids.title),
        )
        .toBe(ids.other);
    });

    test("drags a layer out below the last row, to the level the pointer is at", async () => {
      const source = row(page, "Title");
      // The last row in the panel: the bottom Event row, two levels into Home.
      const last = row(page, "Event row").last();
      const box = await last.boundingBox();
      if (!box) throw new Error("no row");
      const below = box.y + box.height * 0.85;
      await source.hover();
      await page.mouse.down();
      // One level in: below Event list, still inside Home.
      await page.mouse.move(box.x + 4 + 12 + 8, below, { steps: 4 });
      await page.mouse.move(box.x + 4 + 12 + 9, below);
      await expect(
        page.getByRole("status").filter({ hasText: "moving below Event list in Home" }),
      ).toBeVisible();
      // All the way left: below Home, on the page.
      await page.mouse.move(box.x + 2, below, { steps: 4 });
      await page.mouse.move(box.x + 3, below);
      await expect(page.getByRole("status").filter({ hasText: "moving below Home" })).toBeVisible();
      await expect(last).toHaveClass(/layers__row--drop-line-after/);
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, ids.title),
        )
        .toBe(await page.evaluate(() => (window as unknown as W).drawpane.s.pageId));
      // Below Home in the list: under it in the page's stack.
      const order = await page.evaluate(
        (p) => (window as unknown as W).drawpane.doc.childIds(p),
        await page.evaluate(() => (window as unknown as W).drawpane.s.pageId),
      );
      expect(order.indexOf(ids.title)).toBe(order.indexOf(ids.home) - 1);
    });
    test("drags the last layer in a frame out of it, over its own row", async () => {
      // A phone screen holding an auto layout row whose last layer is a screenshot.
      const made = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const phone = e.createLayer(
          "frame",
          { x: 600, y: 0, width: 402, height: 874 },
          e.s.pageId,
          {
            name: "Phone",
          },
        ) as string;
        const strip = e.createLayer("frame", { x: 620, y: 40, width: 300, height: 80 }, phone, {
          name: "Strip",
          layoutMode: "row",
        }) as string;
        const shot = e.createLayer("rect", { x: 0, y: 0, width: 60, height: 60 }, strip, {
          name: "Shot",
        }) as string;
        const label = e.createLayer("text", { x: 0, y: 0, width: 60, height: 20 }, strip, {
          name: "Label",
          characters: "Label",
        }) as string;
        return { phone, strip, shot, label };
      });
      ids.label = made.label;
      // Label isn't last (Shot is below it): over its own row it has nowhere to go.
      const label = row(page, "Label");
      const labelBox = await label.boundingBox();
      if (!labelBox) throw new Error("no row");
      await label.hover();
      await page.mouse.down();
      await page.mouse.move(labelBox.x + 6, labelBox.y + labelBox.height / 2, { steps: 4 });
      await page.mouse.move(labelBox.x + 5, labelBox.y + labelBox.height / 2);
      await expect(page.getByRole("status").filter({ hasText: /moving/ })).toHaveCount(0);
      await page.mouse.up();

      const shot = row(page, "Shot");
      const box = await shot.boundingBox();
      if (!box) throw new Error("no row");
      await shot.hover();
      await page.mouse.down();
      // Left by one level, still over its own row: below Strip, in Phone.
      await page.mouse.move(box.x + 4 + 12 + 8, box.y + box.height / 2, { steps: 4 });
      await page.mouse.move(box.x + 4 + 12 + 9, box.y + box.height / 2);
      await expect(
        page.getByRole("status").filter({ hasText: "moving below Strip in Phone" }),
      ).toBeVisible();
      await expect(shot).toHaveClass(/layers__row--drop-line-after/);
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, made.shot),
        )
        .toBe(made.phone);
      const order = await page.evaluate(
        (id) => (window as unknown as W).drawpane.doc.childIds(id),
        made.phone,
      );
      // Below Strip in the list: under it in Phone's stack.
      expect(order).toEqual([made.shot, made.strip]);
    });

    test("drops into the empty space below the list, at the level the pointer is at", async () => {
      const label = row(page, "Label");
      const scroll = await tree(page).boundingBox();
      const lastBox = await tree(page).getByRole("treeitem").last().boundingBox();
      if (!scroll || !lastBox) throw new Error("no tree");
      const empty = lastBox.y + lastBox.height + 40;
      expect(empty).toBeLessThan(scroll.y + scroll.height);
      await label.hover();
      await page.mouse.down();
      await page.mouse.move(lastBox.x + 3, empty, { steps: 4 });
      await page.mouse.move(lastBox.x + 2, empty);
      await expect(page.getByRole("status").filter({ hasText: /moving below/ })).toBeVisible();
      await page.mouse.up();
      const pageId = await page.evaluate(() => (window as unknown as W).drawpane.s.pageId);
      const labelId = ids.label as string;
      await expect
        .poll(() =>
          page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id)?.parent, labelId),
        )
        .toBe(pageId);
      // At the very bottom of the page's stack.
      const order = await page.evaluate(
        (p) => (window as unknown as W).drawpane.doc.childIds(p),
        pageId,
      );
      expect(order[0]).toBe(labelId);
    });

    test.describe("a tree deeper than the panel", () => {
      const DEPTH = 14;
      let deep: { chain: string[]; leaf: string; locked: string };

      test.beforeAll(async () => {
        deep = await page.evaluate((depth) => {
          const e = (window as unknown as W).drawpane;
          // Frames in frames, each a little inside the last, far from the other layers.
          const chain: string[] = [];
          let parent = e.s.pageId;
          for (let i = 0; i < depth; i++) {
            parent = e.createLayer(
              "frame",
              { x: 3000 + i * 4, y: i * 4, width: 400 - i * 8, height: 400 - i * 8 },
              parent,
              { name: `Level ${i + 1}` },
            ) as string;
            chain.push(parent);
          }
          const locked = e.createLayer("rect", { x: 3060, y: 60, width: 20, height: 20 }, parent, {
            name: "Pinned bolt",
            locked: true,
          }) as string;
          const leaf = e.createLayer("rect", { x: 3100, y: 100, width: 160, height: 160 }, parent, {
            name: "Deepest layer",
          }) as string;
          // Enough layers above it that its row starts out of view, below the fold.
          for (let i = 0; i < 30; i++)
            e.createLayer("rect", { x: 2000, y: i * 30, width: 20, height: 20 }, e.s.pageId, {
              name: `Filler ${i + 1}`,
            });
          e.select([]);
          return { chain, leaf, locked };
        }, DEPTH);
      });

      const scroller = (p: Page) => p.locator(".layers__scroll");
      const scrollTo = (p: Page, left: number, top: number) =>
        scroller(p).evaluate(
          (el, [l, t]) => {
            el.scrollLeft = l as number;
            el.scrollTop = t as number;
          },
          [left, top],
        );
      const scrollLeft = (p: Page) => scroller(p).evaluate((el) => el.scrollLeft);
      /** Whether `box` lies across inside the tree's visible area. */
      const inView = async (p: Page, name: string, part: string) => {
        const area = await scroller(p).boundingBox();
        const box = await row(p, name).locator(part).first().boundingBox();
        if (!area || !box) return false;
        return box.x >= area.x - 0.5 && box.x + box.width <= area.x + area.width + 0.5;
      };

      test("scrolls sideways, keeping its lock and eye in view at the panel's edge", async () => {
        await scrollTo(page, 0, 0);
        await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), deep.locked);
        const locked = row(page, "Pinned bolt");
        await expect(locked).toBeVisible();
        await page.evaluate(() => (window as unknown as W).drawpane.select([]));
        const wide = await scroller(page).evaluate((el) => ({
          scroll: el.scrollWidth,
          client: el.clientWidth,
        }));
        expect(wide.scroll).toBeGreaterThan(wide.client);
        await expect(scroller(page)).toHaveClass(/is-wide/);

        // At either end of the scroll, the locked row's padlock sits inside the panel,
        // pressed and shown, lined up with a shallow row's toggles.
        const lock = locked.getByRole("button", { name: "Lock" });
        for (const left of [0, wide.scroll]) {
          await scroller(page).evaluate((el, l) => {
            el.scrollLeft = l;
          }, left);
          expect(await inView(page, "Pinned bolt", ".dp-layer__actions")).toBe(true);
          await expect(lock).toHaveAttribute("aria-pressed", "true");
          await expect(lock).toHaveCSS("opacity", "1");
          const shallow = await row(page, /^Level 1(?!\d)/)
            .getByRole("button", { name: "Lock" })
            .boundingBox();
          const deepBox = await lock.boundingBox();
          expect(Math.abs((shallow?.x ?? 0) - (deepBox?.x ?? -99))).toBeLessThan(1);
        }
        // A name deep down keeps its room: it isn't squeezed to an ellipsis.
        const name = locked.locator(".dp-layer__name");
        const fits = await name.evaluate((el) => el.scrollWidth <= el.clientWidth);
        expect(fits).toBe(true);
      });

      test("scrolls sideways with Shift and the wheel, or a sideways swipe", async () => {
        await scrollTo(page, 0, 0);
        const area = await scroller(page).boundingBox();
        if (!area) throw new Error("no tree");
        await page.mouse.move(area.x + area.width / 2, area.y + 100);
        await page.keyboard.down("Shift");
        await page.mouse.wheel(0, 60);
        await page.keyboard.up("Shift");
        await expect.poll(() => scrollLeft(page)).toBeGreaterThan(0);
        await scrollTo(page, 0, 0);
        await page.mouse.wheel(60, 0);
        await expect.poll(() => scrollLeft(page)).toBeGreaterThan(0);
      });

      test("brings a deep layer's row into view when it's selected on the canvas", async () => {
        await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), deep.leaf);
        await page.keyboard.press("Shift+2");
        await page.waitForFunction(
          () =>
            !(window as unknown as { drawpane: { cameraAnimating?: boolean } }).drawpane
              .cameraAnimating,
        );
        await page.evaluate(() => (window as unknown as W).drawpane.select([]));
        await scrollTo(page, 0, 0);
        await expect(row(page, "Deepest layer")).toHaveCount(0);

        // ⌘-click (Ctrl-click) picks the deepest layer under the pointer, as in Figma.
        const canvas = await page.locator(".canvas__overlay").boundingBox();
        if (!canvas) throw new Error("no canvas");
        await page.locator(".canvas__overlay").click({
          position: { x: canvas.width / 2, y: canvas.height / 2 },
          modifiers: ["ControlOrMeta"],
        });
        await expect.poll(() => selection(page)).toEqual([deep.leaf]);
        const leaf = row(page, "Deepest layer");
        await expect(leaf).toBeInViewport();
        expect(await inView(page, "Deepest layer", ".dp-layer__name")).toBe(true);
        expect(await inView(page, "Deepest layer", ".dp-layer__caret")).toBe(true);
        expect(await scrollLeft(page)).toBeGreaterThan(0);
        // And back to a top-level layer: the tree scrolls back to its start.
        await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), ids.home);
        await expect.poll(() => scrollLeft(page)).toBe(0);
      });

      test("follows the keyboard, and Tab reaches the focused row's toggles", async () => {
        await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), deep.locked);
        const bolt = row(page, "Pinned bolt");
        await bolt.click();
        await expect(bolt).toBeFocused();
        // Up to its parent frame's row, whose name comes into view, then back.
        await page.keyboard.press("ArrowLeft");
        expect(await inView(page, `Level ${DEPTH}`, ".dp-layer__name")).toBe(true);
        // Down past Deepest layer (the frame's topmost) to the bolt again.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(bolt).toBeFocused();
        // Tab goes to its lock (pressed: it's locked), then its eye; Enter unlocks.
        await page.keyboard.press("Tab");
        const lock = bolt.getByRole("button", { name: "Lock" });
        await expect(lock).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(lock).toHaveAttribute("aria-pressed", "false");
        await expect
          .poll(() =>
            page.evaluate(
              (id) => (window as unknown as W).drawpane.doc.get(id)?.props.locked ?? false,
              deep.locked,
            ),
          )
          .toBe(false);
        // Pressing Enter on the toggle did nothing else: the selection stayed put.
        expect(await selection(page)).toEqual([deep.locked]);
        await page.keyboard.press("Tab");
        await expect(bolt.getByRole("button", { name: "Hide" })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(lock).toBeFocused();
      });

      test("drags by the pointer's level while scrolled sideways", async () => {
        await page.evaluate((id) => (window as unknown as W).drawpane.select([id]), deep.leaf);
        expect(await scrollLeft(page)).toBeGreaterThan(0);
        // The last layer in the deepest frame.
        const bolt = row(page, "Pinned bolt");
        const box = await bolt.boundingBox();
        if (!box) throw new Error("no row");
        await bolt.hover();
        await page.mouse.down();
        // Over its own row, a level further left than its own: out of its frame.
        const levelX = box.x + 4 + (DEPTH - 1) * 12;
        await page.mouse.move(levelX + 8, box.y + box.height * 0.85, { steps: 4 });
        await page.mouse.move(levelX + 9, box.y + box.height * 0.85);
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: `moving below Level ${DEPTH} in Level ${DEPTH - 1}` }),
        ).toBeVisible();
        await page.mouse.up();
        await expect
          .poll(() =>
            page.evaluate(
              (id) => (window as unknown as W).drawpane.doc.get(id)?.parent,
              deep.locked,
            ),
          )
          .toBe(deep.chain[DEPTH - 2]);
      });
    });
  });
