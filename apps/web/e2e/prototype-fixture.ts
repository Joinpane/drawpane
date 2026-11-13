/**
 * A small mobile prototype built through the editor's debug handle: a Home
 * screen with a list, a Detail screen and a bottom sheet overlay, wired
 * together with interactions and a flow. Shared by the prototype test and tour.
 */
import type { Page } from "@playwright/test";

export interface MobileApp {
  home: string;
  detail: string;
  sheet: string;
  /** The first event row on Home: taps go to Detail. */
  row: string;
  /** "Mark done" on Detail: opens the sheet. */
  done: string;
  /** "‹ Today" on Detail: goes back. */
  back: string;
  /** "Undo" in the sheet: closes it. */
  undo: string;
}

export function buildMobileApp(page: Page): Promise<MobileApp> {
  return page.evaluate(() => {
    type Props = Record<string, unknown>;
    interface E {
      s: { pageId: string };
      createLayer(
        type: string,
        rect: { x: number; y: number; width: number; height: number },
        parent: string,
        props?: Props,
      ): string | null;
      updateText(id: string, text: string): void;
      commit(ops: unknown[], label?: string): boolean;
      select(ids: string[]): void;
    }
    const e = (window as unknown as { drawpane: E }).drawpane;
    const p = e.s.pageId;
    const solid = (color: string) => [{ type: "solid", color }];
    const box = (
      parent: string,
      type: string,
      x: number,
      y: number,
      width: number,
      height: number,
      props: Props = {},
    ) => e.createLayer(type, { x, y, width, height }, parent, props) as string;
    const text = (
      parent: string,
      x: number,
      y: number,
      characters: string,
      size: number,
      color: string,
      weight = 400,
      name?: string,
    ) => {
      const id = box(parent, "text", x, y, 0, 0, {
        fontSize: size,
        fontWeight: weight,
        fills: solid(color),
        ...(name ? { name } : {}),
      });
      e.updateText(id, characters);
      return id;
    };
    const button = (
      parent: string,
      x: number,
      y: number,
      w: number,
      label: string,
      fill: string,
      ink: string,
    ) => {
      const id = box(parent, "frame", x, y, w, 52, {
        name: label,
        fills: solid(fill),
        cornerRadius: 12,
        layoutMode: "row",
        justifyContent: "center",
        alignItems: "center",
        sizingH: "fixed",
        sizingV: "fixed",
      });
      text(id, x + 20, y + 16, label, 16, ink, 600);
      return id;
    };

    // Home
    const home = box(p, "frame", 0, 0, 390, 844, { name: "Home", fills: solid("#ffffff") });
    text(home, 20, 64, "Good morning, Ana", 28, "#18181b", 600, "Greeting");
    text(home, 20, 104, "Three things on today", 15, "#6b6a66");
    const hero = box(home, "frame", 20, 140, 350, 72, {
      name: "Hero card",
      fills: solid("#18181b"),
      cornerRadius: 14,
    });
    text(hero, 36, 154, "Design review at 2:00", 16, "#ffffff", 600);
    text(hero, 36, 178, "Checkout flow · 4 people", 13, "#a1a1aa");
    const list = box(home, "frame", 20, 232, 350, 214, {
      name: "Upcoming",
      fills: solid("#f4f4f5"),
      cornerRadius: 16,
    });
    const rows: string[] = [];
    for (const [i, [title, due]] of [
      ["Ship onboarding v2", "Due today"],
      ["Token audit", "Tomorrow"],
      ["Lena: icon review", "Friday"],
    ].entries()) {
      const y = 244 + i * 66;
      const row = box(list, "frame", 32, y, 326, 58, {
        name: "Event row",
        fills: solid("#ffffff"),
        cornerRadius: 12,
      });
      box(row, "rect", 44, y + 12, 34, 34, { fills: solid("#e4e4e7"), cornerRadius: 8 });
      text(row, 90, y + 12, title as string, 15, "#18181b", 500);
      text(row, 90, y + 33, due as string, 12, "#71717a");
      rows.push(row);
    }
    const tabs = box(home, "frame", 0, 780, 390, 64, {
      name: "Tab bar",
      fills: solid("#ffffff"),
      strokes: solid("#e4e4e7"),
      strokeAlign: "inside",
    });
    for (const [i, x] of [55, 138, 221, 304].entries())
      box(tabs, "rect", x, 800, 24, 24, {
        fills: solid(i === 0 ? "#18181b" : "#d4d4d8"),
        cornerRadius: 7,
      });

    // Detail
    const detail = box(p, "frame", 490, 0, 390, 844, {
      name: "Event detail",
      fills: solid("#ffffff"),
    });
    const back = text(detail, 510, 64, "‹ Today", 15, "#2f54eb", 500, "Back");
    box(detail, "rect", 510, 100, 48, 48, { fills: solid("#e4e4e7"), cornerRadius: 12 });
    text(detail, 510, 164, "Ship onboarding v2", 26, "#18181b", 600);
    text(detail, 510, 200, "Due today · Mobile squad", 15, "#6b6a66");
    box(detail, "rect", 510, 236, 350, 1, { fills: solid("#e4e4e7") });
    for (const [i, w] of [276, 234, 252].entries())
      box(detail, "rect", 510, 260 + i * 22, w, 10, { fills: solid("#ececee"), cornerRadius: 5 });
    const done = button(detail, 510, 740, 350, "Mark done", "#2f54eb", "#ffffff");

    // Sheet
    const sheet = box(p, "frame", 980, 0, 390, 300, {
      name: "Done sheet",
      fills: solid("#ffffff"),
      cornerRadii: [24, 24, 0, 0],
    });
    box(sheet, "rect", 1155, 12, 40, 4, { fills: solid("#d4d4d8"), cornerRadius: 2 });
    box(sheet, "ellipse", 1147, 44, 56, 56, { fills: solid("#dcfce7") });
    text(sheet, 1093, 120, "Marked as done", 20, "#18181b", 600);
    text(sheet, 1048, 152, "Nice work. It's off your list for today.", 14, "#6b6a66");
    const undo = button(sheet, 1000, 216, 350, "Undo", "#f4f4f5", "#18181b");

    const t = (type: string, direction: string, easing: unknown, duration = 300) => ({
      type,
      direction,
      duration,
      easing,
    });
    const ops = [
      {
        op: "set",
        id: rows[0],
        prop: "reactions",
        value: [
          {
            id: "rowTap",
            trigger: { type: "tap" },
            action: { type: "navigate", to: detail },
            transition: t("slide-in", "left", { type: "ease-out" }, 320),
          },
        ],
      },
      {
        op: "set",
        id: hero,
        prop: "reactions",
        value: [
          {
            id: "heroTap",
            trigger: { type: "tap" },
            action: { type: "navigate", to: detail },
            transition: t("dissolve", "left", { type: "ease-out" }, 240),
          },
        ],
      },
      {
        op: "set",
        id: back,
        prop: "reactions",
        value: [
          {
            id: "backTap",
            trigger: { type: "tap" },
            action: { type: "back" },
            transition: t("instant", "left", { type: "linear" }, 0),
          },
        ],
      },
      {
        op: "set",
        id: done,
        prop: "reactions",
        value: [
          {
            id: "doneTap",
            trigger: { type: "tap" },
            action: {
              type: "overlay",
              to: sheet,
              position: "bottom",
              closeOnOutside: true,
              dim: 0.4,
            },
            transition: t("move-in", "up", {
              type: "spring",
              mass: 1,
              stiffness: 320,
              damping: 24,
            }),
          },
        ],
      },
      {
        op: "set",
        id: undo,
        prop: "reactions",
        value: [
          {
            id: "undoTap",
            trigger: { type: "tap" },
            action: { type: "close-overlay" },
            transition: t("dissolve", "left", { type: "ease-out" }, 200),
          },
        ],
      },
      {
        op: "set",
        id: p,
        prop: "flows",
        value: [{ id: "flowToday", name: "Today", start: home, description: "" }],
      },
      { op: "set", id: p, prop: "prototypeDevice", value: "iphone-16" },
    ];
    e.commit(ops, "Build prototype");
    e.select([]);
    return { home, detail, sheet, row: rows[0] as string, done, back, undo };
  });
}
