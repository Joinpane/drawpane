import { describe, expect, it } from "vitest";
import {
  Action,
  applyOp,
  DEFAULT_TRANSITION,
  MemoryStore,
  ModelError,
  type Op,
  PROPS,
  type Reaction,
  ROOT_ID,
  SafeUrl,
} from "../src/index";

const reaction = (id: string, to = "screenB"): Reaction => ({
  id,
  trigger: { type: "tap" },
  action: { type: "navigate", to },
  transition: DEFAULT_TRANSITION,
});

describe("prototype schema", () => {
  it("accepts every action shape", () => {
    const actions = [
      { type: "navigate", to: "a" },
      { type: "overlay", to: "a", position: "bottom", closeOnOutside: true, dim: 0.4 },
      { type: "swap-overlay", to: "a" },
      { type: "close-overlay" },
      { type: "back" },
      { type: "url", url: "https://example.com/a?b=1#c", newTab: true },
    ];
    for (const action of actions) expect(Action.safeParse(action).success).toBe(true);
  });

  it("only allows links that cannot run code", () => {
    for (const url of ["https://drawpane.dev", "http://x.y/z", "mailto:a@b.c", "tel:+1 (555) 010"])
      expect(SafeUrl.safeParse(url).success, url).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>",
      "vbscript:x",
      "//evil.example",
      "https://",
      "https://exa mple.com",
      " https://example.com",
    ])
      expect(SafeUrl.safeParse(url).success, url).toBe(false);
  });

  it("rejects duplicate reaction ids, unknown devices and bad timings", () => {
    expect(PROPS.reactions.schema.safeParse([reaction("r1"), reaction("r1")]).success).toBe(false);
    expect(PROPS.reactions.schema.safeParse([reaction("r1"), reaction("r2")]).success).toBe(true);
    expect(PROPS.prototypeDevice.schema.safeParse("iphone-16").success).toBe(true);
    expect(PROPS.prototypeDevice.schema.safeParse("nokia-3310").success).toBe(false);
    const slow = { ...reaction("r1"), transition: { ...DEFAULT_TRANSITION, duration: 60_000 } };
    expect(PROPS.reactions.schema.safeParse([slow]).success).toBe(false);
    const overshoot = {
      ...reaction("r1"),
      transition: {
        ...DEFAULT_TRANSITION,
        easing: { type: "bezier", x1: 0.3, y1: 1.6, x2: 0.6, y2: -0.4 },
      },
    };
    expect(PROPS.reactions.schema.safeParse([overshoot]).success).toBe(true);
  });

  it("stores reactions on layers and flows on pages through ops", () => {
    const store = new MemoryStore();
    const ops: Op[] = [
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "P" } },
      { op: "create", id: "screenA", type: "frame", parent: "p", key: "a0", props: {} },
      { op: "create", id: "button", type: "rect", parent: "screenA", key: "a0", props: {} },
    ];
    for (const op of ops) applyOp(store, op);
    applyOp(store, { op: "set", id: "button", prop: "reactions", value: [reaction("r1")] });
    applyOp(store, {
      op: "set",
      id: "p",
      prop: "flows",
      value: [{ id: "f1", name: "Onboarding", start: "screenA", description: "" }],
    });
    expect(store.get("button")?.props.reactions).toHaveLength(1);
    expect(store.get("p")?.props.flows?.[0]?.name).toBe("Onboarding");
    expect(() => applyOp(store, { op: "set", id: "p", prop: "reactions", value: [] })).toThrow(
      ModelError,
    );
    expect(() =>
      applyOp(store, {
        op: "set",
        id: "button",
        prop: "reactions",
        value: [{ ...reaction("r2"), action: { type: "url", url: "javascript:x", newTab: false } }],
      }),
    ).toThrow(ModelError);
  });
});
