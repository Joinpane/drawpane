import {
  DEFAULT_TRANSITION,
  getProp,
  type Reaction,
  ROOT_ID,
  type Transition,
} from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import {
  addFlow,
  addReaction,
  connectToScreen,
  removeFlow,
  removeReaction,
  updateReaction,
} from "../src/prototype/commands";
import {
  bezierAt,
  easingAt,
  easingCss,
  reverseTransition,
  springSettleMs,
  transitionFrames,
  transitionMs,
} from "../src/prototype/motion";
import { chainAt, hotspotRects, PrototypePlayer } from "../src/prototype/player";
import {
  defaultStart,
  flowScreens,
  liveFlows,
  reactionSentence,
  screenOf,
  screensOf,
} from "../src/prototype/screens";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

/**
 * Three screens side by side (Home, Detail, Sheet) and a loose rectangle on the
 * page. Home has a card and a tab bar with a button inside.
 */
function setup() {
  const editor = new Editor({ measurer, clientId: "test" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p");
  const screen = (name: string, x: number) =>
    editor.createLayer("frame", { x, y: 0, width: 390, height: 844 }, "p", { name }) as string;
  const home = screen("Home", 0);
  const detail = screen("Detail", 500);
  const sheet = screen("Sheet", 1000);
  const card = editor.createLayer("rect", { x: 20, y: 100, width: 350, height: 80 }, home, {
    name: "Card",
  }) as string;
  const tabs = editor.createLayer("frame", { x: 0, y: 780, width: 390, height: 64 }, home, {
    name: "Tabs",
  }) as string;
  const tab = editor.createLayer("rect", { x: 10, y: 790, width: 40, height: 40 }, tabs, {
    name: "Tab",
  }) as string;
  const loose = editor.createLayer("rect", { x: -300, y: 0, width: 50, height: 50 }, "p") as string;
  return { editor, home, detail, sheet, card, tabs, tab, loose };
}

const reaction = (action: Reaction["action"], extra: Partial<Reaction> = {}): Reaction => ({
  id: Math.random().toString(36).slice(2, 10),
  trigger: { type: "tap" },
  action,
  transition: DEFAULT_TRANSITION,
  ...extra,
});

describe("prototype screens and flows", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("finds screens in layer order and the screen a layer belongs to", () => {
    expect(screensOf(s.editor.doc, "p")).toEqual([s.sheet, s.detail, s.home]);
    expect(screenOf(s.editor.doc, s.tab)).toBe(s.home);
    expect(screenOf(s.editor.doc, s.home)).toBe(s.home);
    expect(screenOf(s.editor.doc, s.loose)).toBeNull();
  });

  it("connects a layer to a screen, and the first connection starts a flow", () => {
    expect(connectToScreen(s.editor, s.card, s.detail)).toBe(true);
    const reactions = getProp(s.editor.doc.get(s.card)?.props ?? {}, "reactions");
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.action).toEqual({ type: "navigate", to: s.detail });
    expect(liveFlows(s.editor.doc, "p").map((f) => [f.name, f.start])).toEqual([
      ["Flow 1", s.home],
    ]);

    // Dragging again re-targets instead of stacking a second interaction.
    expect(connectToScreen(s.editor, s.card, s.sheet)).toBe(true);
    const after = getProp(s.editor.doc.get(s.card)?.props ?? {}, "reactions");
    expect(after).toHaveLength(1);
    expect(after[0]?.action).toEqual({ type: "navigate", to: s.sheet });
    expect(liveFlows(s.editor.doc, "p")).toHaveLength(1);

    // A connection to a layer's own screen, or to something that isn't a screen, does nothing.
    expect(connectToScreen(s.editor, s.card, s.home)).toBe(false);
    expect(connectToScreen(s.editor, s.card, s.tab)).toBe(false);

    // One undo step each.
    s.editor.undo();
    expect(getProp(s.editor.doc.get(s.card)?.props ?? {}, "reactions")[0]?.action).toEqual({
      type: "navigate",
      to: s.detail,
    });
  });

  it("adds, updates and removes interactions as single undo steps", () => {
    const id = addReaction(s.editor, s.card) as string;
    const list = () => getProp(s.editor.doc.get(s.card)?.props ?? {}, "reactions");
    // A new interaction goes to the next screen after its own.
    expect(list()[0]?.action).toEqual({ type: "navigate", to: s.detail });
    updateReaction(s.editor, s.card, { ...(list()[0] as Reaction), trigger: { type: "hover" } });
    expect(list()[0]?.trigger.type).toBe("hover");
    removeReaction(s.editor, s.card, id);
    expect(list()).toHaveLength(0);
    s.editor.undo();
    expect(list()[0]?.trigger.type).toBe("hover");
  });

  it("orders a flow's screens the way a person meets them, ignoring deleted destinations", () => {
    s.editor.commit([
      {
        op: "set",
        id: s.card,
        prop: "reactions",
        value: [reaction({ type: "navigate", to: s.detail })],
      },
      {
        op: "set",
        id: s.detail,
        prop: "reactions",
        value: [
          reaction(
            { type: "overlay", to: s.sheet, position: "bottom", closeOnOutside: true, dim: 0.4 },
            { trigger: { type: "delay", ms: 500 } },
          ),
          reaction({ type: "navigate", to: "gone" }),
        ],
      },
    ]);
    expect(flowScreens(s.editor.doc, s.home)).toEqual([s.home, s.detail, s.sheet]);
    expect(flowScreens(s.editor.doc, s.detail)).toEqual([s.detail, s.sheet]);
    expect(flowScreens(s.editor.doc, s.card)).toEqual([]);
  });

  it("keeps flows whose start was deleted but leaves them out until it comes back", () => {
    const flow = addFlow(s.editor, s.detail, "  Checkout  ") as string;
    expect(liveFlows(s.editor.doc, "p")[0]?.name).toBe("Checkout");
    expect(defaultStart(s.editor.doc, "p")).toBe(s.detail);
    s.editor.select([s.detail]);
    s.editor.deleteSelection();
    expect(liveFlows(s.editor.doc, "p")).toEqual([]);
    expect(defaultStart(s.editor.doc, "p")).toBe(s.sheet);
    s.editor.undo();
    expect(liveFlows(s.editor.doc, "p")).toHaveLength(1);
    removeFlow(s.editor, "p", flow);
    expect(liveFlows(s.editor.doc, "p")).toEqual([]);
  });

  it("describes interactions as sentences", () => {
    const doc = s.editor.doc;
    expect(reactionSentence(doc, reaction({ type: "navigate", to: s.detail }))).toBe(
      "On tap → Navigate to Detail · Dissolve · 240 ms",
    );
    expect(
      reactionSentence(
        doc,
        reaction(
          { type: "overlay", to: s.sheet, position: "bottom", closeOnOutside: true, dim: 0.4 },
          {
            trigger: { type: "key", key: "k", shift: true, alt: false, mod: true },
            transition: {
              type: "move-in",
              direction: "up",
              duration: 300,
              easing: { type: "spring", mass: 1, stiffness: 320, damping: 24 },
            },
          },
        ),
      ),
    ).toBe("On ⌘⇧K → Open overlay Sheet · Move in ↑ · Spring");
    expect(reactionSentence(doc, reaction({ type: "back" }))).toBe("On tap → Back");
    expect(
      reactionSentence(doc, reaction({ type: "url", url: "https://drawpane.dev/", newTab: true })),
    ).toBe("On tap → Open drawpane.dev");
    expect(reactionSentence(doc, reaction({ type: "navigate", to: "gone" }))).toContain(
      "a deleted screen",
    );
  });
});

describe("prototype player", () => {
  let s: ReturnType<typeof setup>;
  let player: PrototypePlayer;
  const overlayAction = {
    type: "overlay",
    to: "",
    position: "bottom",
    closeOnOutside: true,
    dim: 0.4,
  } as const;

  beforeEach(() => {
    s = setup();
    player = new PrototypePlayer(s.editor.doc, s.home);
  });

  it("finds the reaction on the tapped layer or the nearest ancestor", () => {
    const r = reaction({ type: "navigate", to: s.detail });
    s.editor.commit([{ op: "set", id: s.tabs, prop: "reactions", value: [r] }]);
    expect(player.find([s.tab, s.tabs, s.home], "tap")).toEqual({ source: s.tabs, reaction: r });
    expect(player.find([s.tab, s.tabs, s.home], "hover")).toBeNull();
    expect(player.find([s.card, s.home], "tap")).toBeNull();
  });

  it("navigates, goes back with the reversed transition and never stacks the same screen", () => {
    const push: Transition = { ...DEFAULT_TRANSITION, type: "push", direction: "left" };
    const step = player.run({
      source: s.card,
      reaction: reaction({ type: "navigate", to: s.detail }, { transition: push }),
    });
    expect(step).toMatchObject({ type: "navigate", from: s.home, to: s.detail, back: false });
    expect(player.state.screen).toBe(s.detail);
    expect(
      player.run({ source: s.card, reaction: reaction({ type: "navigate", to: s.detail }) }),
    ).toBeNull();
    const back = player.back();
    expect(back).toMatchObject({ type: "navigate", to: s.home, back: true });
    expect(back?.type === "navigate" && back.transition.direction).toBe("right");
    expect(player.back()).toBeNull();
  });

  it("opens, swaps and closes overlays, and navigating closes them all", () => {
    const open = player.run({
      source: s.card,
      reaction: reaction({ ...overlayAction, to: s.sheet }),
    });
    expect(open?.type).toBe("open-overlay");
    expect(player.roots()).toEqual([s.sheet, s.home]);
    // Opening the same overlay again does nothing.
    expect(
      player.run({ source: s.card, reaction: reaction({ ...overlayAction, to: s.sheet }) }),
    ).toBeNull();

    const swap = player.run({
      source: s.sheet,
      reaction: reaction({ type: "swap-overlay", to: s.detail }),
    });
    expect(swap).toMatchObject({
      type: "swap-overlay",
      to: { screen: s.detail, position: "bottom" },
    });
    expect(player.roots()).toEqual([s.detail, s.home]);

    // Back closes the overlay before leaving the screen.
    expect(player.back()?.type).toBe("close-overlay");
    expect(player.state.overlays).toEqual([]);

    player.run({ source: s.card, reaction: reaction({ ...overlayAction, to: s.sheet }) });
    const nav = player.run({
      source: s.sheet,
      reaction: reaction({ type: "navigate", to: s.detail }),
    });
    expect(nav?.type === "navigate" && nav.closed.map((o) => o.screen)).toEqual([s.sheet]);
    expect(player.state).toMatchObject({ screen: s.detail, overlays: [] });
  });

  it("reverts what a hover did when the pointer leaves", () => {
    const step = player.run({
      source: s.card,
      reaction: reaction({ ...overlayAction, to: s.sheet }),
    });
    expect(step && player.revert(step)?.type).toBe("close-overlay");
    expect(player.state.overlays).toEqual([]);
    const nav = player.run({
      source: s.card,
      reaction: reaction({ type: "navigate", to: s.detail }),
    });
    expect(nav && player.revert(nav)).toMatchObject({ type: "navigate", to: s.home, back: true });
  });

  it("skips deleted destinations and opens only safe links", () => {
    expect(
      player.run({ source: s.card, reaction: reaction({ type: "navigate", to: "gone" }) }),
    ).toBeNull();
    expect(
      player.run({ source: s.card, reaction: reaction({ type: "navigate", to: s.loose }) }),
    ).toBeNull();
    expect(
      player.run({
        source: s.card,
        reaction: reaction({ type: "url", url: "https://drawpane.dev", newTab: true }),
      }),
    ).toEqual({ type: "open-url", url: "https://drawpane.dev", newTab: true });
  });

  it("matches key triggers in the topmost layer first, with exact modifiers", () => {
    const key = { type: "key", key: "ArrowRight", shift: false, alt: false, mod: false } as const;
    const onHome = reaction({ type: "navigate", to: s.detail }, { trigger: key });
    const onSheet = reaction({ type: "close-overlay" }, { trigger: key });
    s.editor.commit([
      { op: "set", id: s.home, prop: "reactions", value: [onHome] },
      { op: "set", id: s.sheet, prop: "reactions", value: [onSheet] },
    ]);
    const press = { key: "ArrowRight", shift: false, alt: false, mod: false };
    expect(player.findKey(press)?.reaction.id).toBe(onHome.id);
    expect(player.findKey({ ...press, shift: true })).toBeNull();
    player.run({ source: s.card, reaction: reaction({ ...overlayAction, to: s.sheet }) });
    expect(player.findKey(press)?.reaction.id).toBe(onSheet.id);
  });

  it("restarts and jumps between screens", () => {
    player.goTo(s.sheet);
    expect(player.state.screen).toBe(s.sheet);
    expect(player.goTo(s.card)).toBeNull();
    player.restart();
    expect(player.state).toEqual({ screen: s.home, overlays: [], history: [] });
    player.restart(s.detail);
    expect(player.start).toBe(s.detail);
  });

  it("hit-tests the layers under a point, deepest first, and reports hotspots", () => {
    expect(chainAt(s.editor.scene, s.home, { x: 30, y: 790 })).toEqual([s.tab, s.tabs, s.home]);
    expect(chainAt(s.editor.scene, s.home, { x: 300, y: 300 })).toEqual([s.home]);
    expect(chainAt(s.editor.scene, s.home, { x: 600, y: 300 })).toEqual([]);
    s.editor.commit([
      {
        op: "set",
        id: s.card,
        prop: "reactions",
        value: [reaction({ type: "navigate", to: s.detail })],
      },
    ]);
    expect(hotspotRects(s.editor.scene, s.home)).toEqual([
      { x: 20, y: 100, width: 350, height: 80 },
    ]);
  });
});

describe("prototype motion", () => {
  it("evaluates béziers like CSS", () => {
    expect(bezierAt([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 4);
    expect(bezierAt([0.2, 0.8, 0.2, 1], 0.5)).toBeGreaterThan(0.85);
    expect(easingAt({ type: "ease-in" }, 0.5)).toBeLessThan(0.5);
    expect(easingCss({ type: "ease-out" })).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
  });

  it("settles springs and writes them as CSS linear() curves", () => {
    const snappy = { type: "spring", mass: 1, stiffness: 320, damping: 24 } as const;
    const bouncy = { type: "spring", mass: 1, stiffness: 260, damping: 8 } as const;
    const ms = springSettleMs(snappy);
    expect(ms).toBeGreaterThan(200);
    expect(ms).toBeLessThan(1200);
    expect(springSettleMs(bouncy)).toBeGreaterThan(ms);
    // An underdamped spring overshoots.
    expect(
      Math.max(...Array.from({ length: 50 }, (_, i) => easingAt(bouncy, i / 50))),
    ).toBeGreaterThan(1.05);
    const css = easingCss(snappy);
    expect(css.startsWith("linear(0, ")).toBe(true);
    expect(css.endsWith(", 1)")).toBe(true);
    expect(transitionMs({ ...DEFAULT_TRANSITION, easing: snappy })).toBe(ms);
    expect(transitionMs({ ...DEFAULT_TRANSITION, type: "instant" })).toBe(0);
  });

  it("moves screens the way the direction says, and reverses for back", () => {
    const size = { width: 390, height: 844 };
    const moveLeft: Transition = { ...DEFAULT_TRANSITION, type: "move-in", direction: "left" };
    const frames = transitionFrames(moveLeft, size);
    // Moving left means arriving from the right edge.
    expect(frames.incoming?.[0]).toEqual({ transform: "translate(390px, 0px)" });
    expect(frames.outgoing).toBeNull();
    expect(frames.top).toBe("incoming");
    const back = reverseTransition(moveLeft);
    expect(back).toMatchObject({ type: "move-out", direction: "right" });
    expect(transitionFrames(back, size).outgoing?.[1]).toEqual({
      transform: "translate(390px, 0px)",
    });
    const push = transitionFrames({ ...moveLeft, type: "push", direction: "up" }, size);
    expect(push.incoming?.[0]).toEqual({ transform: "translate(0px, 844px)" });
    expect(push.outgoing?.[1]).toEqual({ transform: "translate(0px, -844px)" });
    expect(transitionFrames({ ...moveLeft, type: "dissolve" }, size).incoming).toEqual([
      { opacity: 0 },
      { opacity: 1 },
    ]);
  });
});
