/**
 * Templates that ship with Drawpane: a few starting points built the way a
 * designer would set them up (auto layout, colour variables, text styles),
 * so a new file is useful from the first click and shows how the pieces fit.
 * Each builds on a scratch editor; see `scratch.ts`.
 */
import type { Editor } from "@drawpane/editor";
import { kit, solid } from "./kit";

export interface BuiltInTemplate {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  build(editor: Editor, pageId: string): void;
}

const INK = "#1c1b1a";
const MUTED = "#6f6b63";
const LINE = "#e6e3dd";
const PAPER = "#fbfaf8";
const WHITE = "#ffffff";
const SIGNAL = "#e8590c";
const SIGNAL_SOFT = "#fde8dc";
const TEAL = "#0f766e";

const PHONE = { width: 402, height: 874 };

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    id: "mobile-app",
    name: "Mobile app",
    meta: "3 screens · auto layout · text styles",
    build(editor, pageId) {
      const k = kit(editor);
      const primary = k.color("brand/primary", SIGNAL);
      const soft = k.color("brand/soft", SIGNAL_SOFT);
      k.color("text/primary", INK);
      k.color("text/muted", MUTED);

      // Welcome
      const welcome = k.frame(
        pageId,
        { x: 0, y: 0, ...PHONE },
        { name: "Welcome", fills: solid(PAPER) },
      );
      const hero = k.rect(
        welcome,
        { x: 24, y: 88, width: 354, height: 320 },
        { name: "Hero", cornerRadius: 28 },
      );
      k.paint([hero], soft);
      const sun = k.ellipse(welcome, { x: 141, y: 168, width: 120, height: 120 }, { name: "Sun" });
      k.paint([sun], primary);
      k.rect(
        welcome,
        { x: 72, y: 318, width: 258, height: 18 },
        { name: "Horizon", cornerRadius: 9, fills: solid("#f7c5aa") },
      );
      const title = k.text(welcome, "Plan less.\nDo more.", {
        x: 24,
        y: 448,
        name: "Title",
        fontSize: 36,
        fontWeight: 700,
        lineHeight: { unit: "percent", value: 110 },
        fills: solid(INK),
      });
      const lede = k.text(
        welcome,
        "Three things a day, picked with care. Everything else can wait.",
        {
          x: 24,
          y: 552,
          name: "Lede",
          width: 330,
          textAutoResize: "height",
          fontSize: 17,
          lineHeight: { unit: "percent", value: 145 },
          fills: solid(MUTED),
        },
      );
      const button = k.stack(welcome, "row", {
        name: "Button",
        x: 24,
        y: 748,
        width: 354,
        height: 56,
        sizingH: "fixed",
        sizingV: "fixed",
        justifyContent: "center",
        alignItems: "center",
        cornerRadius: 16,
      });
      k.paint([button], primary);
      const label = k.text(button, "Get started", {
        name: "Label",
        fontSize: 17,
        fontWeight: 600,
        fills: solid(WHITE),
      });
      k.text(welcome, "I already have an account", {
        x: 113,
        y: 824,
        name: "Secondary",
        fontSize: 15,
        fontWeight: 500,
        fills: solid(MUTED),
      });

      // Today
      const today = k.frame(
        pageId,
        { x: PHONE.width + 80, y: 0, ...PHONE },
        { name: "Today", fills: solid(PAPER) },
      );
      const heading = k.text(today, "Today", {
        x: 24,
        y: 72,
        name: "Heading",
        fontSize: 32,
        fontWeight: 700,
        fills: solid(INK),
      });
      const date = k.text(today, "Friday, 14 November", {
        x: 24,
        y: 118,
        name: "Date",
        fontSize: 15,
        fills: solid(MUTED),
      });
      const list = k.stack(today, "column", {
        name: "Tasks",
        x: 24,
        y: 168,
        gap: 12,
        width: 354,
        sizingH: "fixed",
        sizingV: "hug",
      });
      const tasks: Array<[string, string, boolean]> = [
        ["Write the launch note", "Focus · 45 min", true],
        ["Review onboarding flow", "Design · 30 min", false],
        ["Call with Ana", "11:30 · 20 min", false],
        ["Plan next week", "Admin · 15 min", false],
      ];
      const taskTitles: string[] = [];
      for (const [name, meta, done] of tasks) {
        const card = k.stack(list, "row", {
          name: "Task",
          gap: 14,
          alignItems: "center",
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16,
          cornerRadius: 16,
          fills: solid(WHITE),
          strokes: solid(LINE),
          sizingH: "fill",
        });
        const check = k.ellipse(
          card,
          { x: 0, y: 0, width: 24, height: 24 },
          {
            name: "Check",
            fills: done ? solid(SIGNAL) : [],
            strokes: solid(done ? SIGNAL : "#c9c5bd"),
            strokeWeight: 2,
          },
        );
        if (done) k.paint([check], primary);
        const copy = k.stack(card, "column", { name: "Copy", gap: 2 });
        taskTitles.push(
          k.text(copy, name, { name: "Title", fontSize: 16, fontWeight: 600, fills: solid(INK) }),
        );
        k.text(copy, meta, { name: "Meta", fontSize: 13, fills: solid(MUTED) });
      }
      const tabs = k.stack(today, "row", {
        name: "Tab bar",
        x: 0,
        y: 790,
        width: PHONE.width,
        height: 84,
        sizingH: "fixed",
        sizingV: "fixed",
        justifyContent: "space-between",
        alignItems: "center",
        paddingLeft: 48,
        paddingRight: 48,
        fills: solid(WHITE),
        strokes: solid(LINE),
      });
      for (let i = 0; i < 4; i++) {
        const tab = k.rect(
          tabs,
          { x: 0, y: 0, width: 24, height: 24 },
          { name: `Tab ${i + 1}`, cornerRadius: 7, fills: solid(i === 0 ? SIGNAL : "#d7d3cc") },
        );
        if (i === 0) k.paint([tab], primary);
      }

      // Profile
      const profile = k.frame(
        pageId,
        { x: (PHONE.width + 80) * 2, y: 0, ...PHONE },
        { name: "Profile", fills: solid(PAPER) },
      );
      const avatar = k.ellipse(
        profile,
        { x: 153, y: 96, width: 96, height: 96 },
        { name: "Avatar" },
      );
      k.paint([avatar], soft);
      k.text(profile, "AL", {
        x: 176,
        y: 126,
        name: "Initials",
        fontSize: 30,
        fontWeight: 700,
        fills: solid(SIGNAL),
      });
      const name = k.text(profile, "Ana Lima", {
        x: 0,
        y: 212,
        name: "Name",
        width: PHONE.width,
        textAutoResize: "height",
        textAlign: "center",
        fontSize: 24,
        fontWeight: 700,
        fills: solid(INK),
      });
      k.text(profile, "Designer · Lisbon", {
        x: 0,
        y: 248,
        name: "Role",
        width: PHONE.width,
        textAutoResize: "height",
        textAlign: "center",
        fontSize: 15,
        fills: solid(MUTED),
      });
      const stats = k.stack(profile, "row", {
        name: "Stats",
        x: 24,
        y: 300,
        width: 354,
        sizingH: "fixed",
        sizingV: "hug",
        justifyContent: "space-between",
        paddingTop: 20,
        paddingBottom: 20,
        paddingLeft: 28,
        paddingRight: 28,
        cornerRadius: 20,
        fills: solid(WHITE),
        strokes: solid(LINE),
      });
      for (const [value, caption] of [
        ["128", "Done"],
        ["12", "Streak"],
        ["4.8", "Focus"],
      ]) {
        const stat = k.stack(stats, "column", { name: caption, gap: 2, alignItems: "center" });
        k.text(stat, value as string, {
          name: "Value",
          fontSize: 22,
          fontWeight: 700,
          fills: solid(INK),
        });
        k.text(stat, caption as string, { name: "Caption", fontSize: 13, fills: solid(MUTED) });
      }
      const settings = k.stack(profile, "column", {
        name: "Settings",
        x: 24,
        y: 420,
        width: 354,
        sizingH: "fixed",
        sizingV: "hug",
        gap: 0,
        cornerRadius: 20,
        fills: solid(WHITE),
        strokes: solid(LINE),
        clipContent: true,
      });
      for (const item of ["Notifications", "Focus sessions", "Appearance", "Privacy"]) {
        const row = k.stack(settings, "row", {
          name: item,
          sizingH: "fill",
          justifyContent: "space-between",
          alignItems: "center",
          paddingTop: 18,
          paddingBottom: 18,
          paddingLeft: 20,
          paddingRight: 20,
          strokes: solid(LINE),
        });
        k.text(row, item, { name: "Label", fontSize: 16, fills: solid(INK) });
        k.text(row, "›", { name: "Chevron", fontSize: 20, fills: solid("#b5b0a7") });
      }

      // Shared type, so a change carries to every screen.
      k.style("heading/xl", heading, [title]);
      k.style("heading/md", name);
      k.style("body/lg", lede);
      k.style("body/md", date);
      k.style("label/md", label);
      k.style("label/task", taskTitles[0] as string, taskTitles.slice(1));
    },
  },
  {
    id: "landing-page",
    name: "Landing page",
    meta: "Desktop · hero and features",
    build(editor, pageId) {
      const k = kit(editor);
      const primary = k.color("brand/primary", SIGNAL);
      const page = k.frame(
        pageId,
        { x: 0, y: 0, width: 1440, height: 1024 },
        { name: "Home", fills: solid(PAPER) },
      );
      const nav = k.stack(page, "row", {
        name: "Nav",
        x: 0,
        y: 0,
        width: 1440,
        height: 80,
        sizingH: "fixed",
        sizingV: "fixed",
        justifyContent: "space-between",
        alignItems: "center",
        paddingLeft: 80,
        paddingRight: 80,
      });
      const brand = k.stack(nav, "row", { name: "Brand", gap: 10, alignItems: "center" });
      const mark = k.rect(
        brand,
        { x: 0, y: 0, width: 28, height: 28 },
        { name: "Mark", cornerRadius: 8 },
      );
      k.paint([mark], primary);
      k.text(brand, "Northwind", {
        name: "Name",
        fontSize: 18,
        fontWeight: 700,
        fills: solid(INK),
      });
      const links = k.stack(nav, "row", { name: "Links", gap: 36, alignItems: "center" });
      for (const link of ["Product", "Pricing", "Customers", "Docs"])
        k.text(links, link, { name: link, fontSize: 15, fontWeight: 500, fills: solid(MUTED) });
      const cta = k.stack(nav, "row", {
        name: "Sign up",
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 18,
        paddingRight: 18,
        cornerRadius: 10,
        fills: solid(INK),
      });
      k.text(cta, "Start free", {
        name: "Label",
        fontSize: 15,
        fontWeight: 600,
        fills: solid(WHITE),
      });

      const hero = k.stack(page, "column", {
        name: "Hero",
        x: 270,
        y: 176,
        width: 900,
        sizingH: "fixed",
        sizingV: "hug",
        gap: 24,
        alignItems: "center",
      });
      const chip = k.stack(hero, "row", {
        name: "Eyebrow",
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
        cornerRadius: 999,
        fills: solid(SIGNAL_SOFT),
      });
      k.text(chip, "New · Shared timelines", {
        name: "Label",
        fontSize: 13,
        fontWeight: 600,
        fills: solid("#a6400a"),
      });
      const headline = k.text(hero, "Ship the plan, not the meeting", {
        name: "Headline",
        width: 900,
        textAutoResize: "height",
        textAlign: "center",
        fontSize: 68,
        fontWeight: 700,
        lineHeight: { unit: "percent", value: 105 },
        letterSpacing: { unit: "percent", value: -2 },
        fills: solid(INK),
      });
      k.text(
        hero,
        "Northwind turns scattered updates into one timeline your whole team can read in a minute.",
        {
          name: "Subhead",
          width: 620,
          textAutoResize: "height",
          textAlign: "center",
          fontSize: 20,
          lineHeight: { unit: "percent", value: 150 },
          fills: solid(MUTED),
        },
      );
      const actions = k.stack(hero, "row", { name: "Actions", gap: 12 });
      const start = k.stack(actions, "row", {
        name: "Primary",
        paddingTop: 16,
        paddingBottom: 16,
        paddingLeft: 26,
        paddingRight: 26,
        cornerRadius: 12,
      });
      k.paint([start], primary);
      k.text(start, "Start for free", {
        name: "Label",
        fontSize: 16,
        fontWeight: 600,
        fills: solid(WHITE),
      });
      const demo = k.stack(actions, "row", {
        name: "Secondary",
        paddingTop: 16,
        paddingBottom: 16,
        paddingLeft: 26,
        paddingRight: 26,
        cornerRadius: 12,
        strokes: solid("#d2cfc8"),
        fills: solid(WHITE),
      });
      k.text(demo, "Watch the demo", {
        name: "Label",
        fontSize: 16,
        fontWeight: 600,
        fills: solid(INK),
      });

      const features = k.stack(page, "row", {
        name: "Features",
        x: 80,
        y: 640,
        width: 1280,
        sizingH: "fixed",
        sizingV: "hug",
        gap: 24,
      });
      const items: Array<[string, string, string]> = [
        ["One timeline", "Every project's milestones on one page, updated as work moves.", SIGNAL],
        [
          "Quiet updates",
          "Weekly notes write themselves from what changed, not from meetings.",
          TEAL,
        ],
        [
          "Clear owners",
          "Each step has a name next to it, so nothing waits on a guess.",
          "#4f46e5",
        ],
      ];
      for (const [title, body, color] of items) {
        const card = k.stack(features, "column", {
          name: title,
          gap: 14,
          sizingH: "fill",
          paddingTop: 28,
          paddingBottom: 28,
          paddingLeft: 28,
          paddingRight: 28,
          cornerRadius: 20,
          fills: solid(WHITE),
          strokes: solid(LINE),
        });
        k.rect(
          card,
          { x: 0, y: 0, width: 40, height: 40 },
          { name: "Icon", cornerRadius: 12, fills: solid(color) },
        );
        k.text(card, title, { name: "Title", fontSize: 20, fontWeight: 700, fills: solid(INK) });
        k.text(card, body, {
          name: "Body",
          width: 340,
          textAutoResize: "height",
          sizingH: "fill",
          fontSize: 15,
          lineHeight: { unit: "percent", value: 150 },
          fills: solid(MUTED),
        });
      }
      k.style("display/xl", headline);
    },
  },
  {
    id: "slides",
    name: "Slides",
    meta: "16:9 · title, agenda, big number",
    build(editor, pageId) {
      const k = kit(editor);
      const accent = k.color("slides/accent", SIGNAL);
      const size = { width: 1920, height: 1080 };
      const title = k.frame(
        pageId,
        { x: 0, y: 0, ...size },
        { name: "Title", fills: solid("#161513") },
      );
      const bar = k.rect(
        title,
        { x: 160, y: 360, width: 120, height: 12 },
        { name: "Accent", cornerRadius: 6 },
      );
      k.paint([bar], accent);
      const big = k.text(title, "Q4 product review", {
        x: 160,
        y: 420,
        name: "Title",
        fontSize: 128,
        fontWeight: 700,
        letterSpacing: { unit: "percent", value: -2 },
        fills: solid("#f6f4ef"),
      });
      k.text(title, "What we shipped, what we learned, what's next", {
        x: 160,
        y: 600,
        name: "Subtitle",
        fontSize: 44,
        fills: solid("#a8a39a"),
      });
      k.text(title, "Northwind · November", {
        x: 160,
        y: 920,
        name: "Footer",
        fontSize: 28,
        fontWeight: 500,
        fills: solid("#77736b"),
      });

      const agenda = k.frame(
        pageId,
        { x: 0, y: size.height + 120, ...size },
        { name: "Agenda", fills: solid(PAPER) },
      );
      k.text(agenda, "Agenda", {
        x: 160,
        y: 140,
        name: "Heading",
        fontSize: 88,
        fontWeight: 700,
        fills: solid(INK),
      });
      const items = k.stack(agenda, "column", { name: "Items", x: 160, y: 320, gap: 36 });
      ["Where we started", "What shipped", "What the numbers say", "Next quarter"].forEach(
        (item, i) => {
          const row = k.stack(items, "row", { name: item, gap: 36, alignItems: "center" });
          const n = k.text(row, String(i + 1).padStart(2, "0"), {
            name: "Number",
            fontSize: 44,
            fontWeight: 700,
            fills: solid(SIGNAL),
          });
          k.paint([n], accent);
          k.text(row, item, { name: "Label", fontSize: 52, fontWeight: 500, fills: solid(INK) });
        },
      );

      const number = k.frame(
        pageId,
        { x: 0, y: (size.height + 120) * 2, ...size },
        { name: "Big number", fills: solid(SIGNAL_SOFT) },
      );
      const figure = k.text(number, "3×", {
        x: 160,
        y: 220,
        name: "Figure",
        fontSize: 360,
        fontWeight: 700,
        letterSpacing: { unit: "percent", value: -4 },
        fills: solid(SIGNAL),
      });
      k.paint([figure], accent);
      k.text(number, "more teams finished their plan in the first week.", {
        x: 160,
        y: 700,
        name: "Caption",
        width: 1200,
        textAutoResize: "height",
        fontSize: 60,
        fontWeight: 500,
        lineHeight: { unit: "percent", value: 120 },
        fills: solid(INK),
      });
      k.style("slide/title", big);
    },
  },
  {
    id: "review-board",
    name: "Design review board",
    meta: "Keep, change, questions",
    build(editor, pageId) {
      const k = kit(editor);
      const board = k.frame(
        pageId,
        { x: 0, y: 0, width: 1600, height: 1000 },
        { name: "Review board", fills: solid("#f1efe9") },
      );
      k.text(board, "Design review", {
        x: 64,
        y: 56,
        name: "Title",
        fontSize: 44,
        fontWeight: 700,
        fills: solid(INK),
      });
      k.text(board, "Onboarding flow · round 2", {
        x: 64,
        y: 116,
        name: "Subtitle",
        fontSize: 20,
        fills: solid(MUTED),
      });
      const columns = k.stack(board, "row", {
        name: "Columns",
        x: 64,
        y: 184,
        width: 1472,
        sizingH: "fixed",
        sizingV: "hug",
        gap: 32,
      });
      const lanes: Array<[string, string, string[]]> = [
        [
          "Keep",
          "#dff3e4",
          ["The welcome screen feels calm", "Progress dots are clear", "Copy is short and kind"],
        ],
        [
          "Change",
          "#ffe7d6",
          ["Button sits too low on small phones", "Two fonts on screen 3", "Skip is hard to find"],
        ],
        ["Questions", "#e3e8ff", ["Do we need the email step?", "What happens offline?"]],
      ];
      lanes.forEach(([name, color, notes]) => {
        const lane = k.stack(columns, "column", { name, gap: 16, sizingH: "fill" });
        const header = k.stack(lane, "row", { name: "Header", gap: 10, alignItems: "center" });
        k.ellipse(
          header,
          { x: 0, y: 0, width: 14, height: 14 },
          { name: "Dot", fills: solid(INK) },
        );
        k.text(header, `${name} · ${notes.length}`, {
          name: "Label",
          fontSize: 18,
          fontWeight: 700,
          fills: solid(INK),
        });
        for (const note of notes) {
          const sticky = k.stack(lane, "column", {
            name: "Note",
            sizingH: "fill",
            paddingTop: 22,
            paddingBottom: 22,
            paddingLeft: 22,
            paddingRight: 22,
            cornerRadius: 12,
            fills: solid(color),
            effects: [{ type: "drop-shadow", color: "#0000000f", x: 0, y: 2, blur: 6, spread: 0 }],
          });
          k.text(sticky, note, {
            name: "Text",
            width: 400,
            textAutoResize: "height",
            sizingH: "fill",
            fontSize: 18,
            fontWeight: 500,
            lineHeight: { unit: "percent", value: 140 },
            fills: solid(INK),
          });
        }
      });
    },
  },
];

/** Builds a template into a scratch editor: its first page is `pageId`. */
export function buildTemplate(template: BuiltInTemplate, editor: Editor, pageId: string): void {
  template.build(editor, pageId);
  editor.select([]);
}
