import { afterEach, describe, expect, it } from "vitest";
import { ACTIONS, matches, shortcutFor, shortcutOf, triggers } from "./actions";
import { actionUsing, assign, reservedReason, sameShortcut, shortcutFromEvent } from "./keymap";
import { setOverrides } from "./shortcuts-store";

const press = (init: Partial<KeyboardEvent>) =>
  ({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  }) as KeyboardEvent;
const action = (id: string) => {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(id);
  return a;
};

afterEach(() => setOverrides({}));

describe("recording a shortcut", () => {
  it("reads modifiers by platform, and ignores a modifier on its own", () => {
    expect(shortcutFromEvent(press({ key: "k", code: "KeyK", metaKey: true }), true)).toEqual({
      key: "k",
      mod: true,
    });
    expect(
      shortcutFromEvent(press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), false),
    ).toEqual({
      key: "k",
      mod: true,
      shift: true,
    });
    expect(
      shortcutFromEvent(press({ key: "Shift", code: "ShiftLeft", shiftKey: true })),
    ).toBeNull();
  });

  it("refuses keys that can't be shortcuts: Tab, Space, Control on a Mac", () => {
    expect(shortcutFromEvent(press({ key: "Tab", code: "Tab" }))).toBeNull();
    expect(shortcutFromEvent(press({ key: " ", code: "Space" }))).toBeNull();
    expect(shortcutFromEvent(press({ key: "k", code: "KeyK", ctrlKey: true }), true)).toBeNull();
  });

  it("records what the same press will match later, shifted digits and ⌥ letters included", () => {
    const presses = [
      press({ key: "!", code: "Digit1", shiftKey: true, metaKey: true }),
      press({ key: "¨", code: "KeyU", altKey: true, shiftKey: true }),
      press({ key: '"', code: "Quote", shiftKey: true, metaKey: true }),
      press({ key: "Delete", code: "Delete" }),
    ];
    for (const p of presses) {
      const s = shortcutFromEvent(p, true);
      if (!s) throw new Error("not recorded");
      // `matches` reads ⌘ as mod off a Mac only through ctrlKey, so compare on the platform the tests run as.
      const asHere = { ...p, ctrlKey: p.metaKey } as KeyboardEvent;
      expect(matches(s, asHere), JSON.stringify(s)).toBe(true);
    }
  });
});

describe("browser-owned shortcuts", () => {
  it("names the ones pages can't have", () => {
    expect(reservedReason({ key: "w", mod: true })).toMatch(/closes the tab/);
    expect(reservedReason({ key: "t", mod: true, shift: true })).toMatch(/opens a tab/);
    expect(reservedReason({ key: "k", mod: true })).toBeNull();
    expect(reservedReason({ key: "w" })).toBeNull();
  });
});

describe("changing shortcuts", () => {
  it("finds who already has a shortcut, other keys included", () => {
    expect(actionUsing({ key: "v" })?.id).toBe("tool.select");
    expect(actionUsing({ key: "v" }, "tool.select")).toBeNull();
  });

  it("gives an action a shortcut, takes it from whoever had it, and every hint follows", () => {
    const next = assign({}, action("tool.rect"), { key: "v" });
    expect(next).toEqual({ "tool.rect": { key: "v" }, "tool.select": null });
    setOverrides(next);
    expect(shortcutOf(action("tool.rect"))).toEqual({ key: "v" });
    expect(shortcutOf(action("tool.select"))).toBeUndefined();
    expect(shortcutFor("tool.rect")).toBe("V");
    expect(triggers(action("tool.rect"), press({ key: "v", code: "KeyV" }))).toBe(true);
    expect(triggers(action("tool.select"), press({ key: "v", code: "KeyV" }))).toBe(false);
  });

  it("forgets an override that's back to the default, and can remove a shortcut", () => {
    const changed = assign({}, action("tool.rect"), { key: "q" });
    expect(assign(changed, action("tool.rect"), { key: "r" })).toEqual({});
    expect(assign({}, action("tool.rect"), null)).toEqual({ "tool.rect": null });
  });

  it("drops an action's other keys once its shortcut is changed", () => {
    const zoomIn = ACTIONS.find((a) => (a.also ?? []).length > 0);
    if (!zoomIn) throw new Error("no action with other keys");
    const other = (zoomIn.also ?? [])[0];
    if (!other) throw new Error("no other key");
    setOverrides(assign({}, zoomIn, { key: "j", mod: true, alt: true }));
    expect(actionUsing(other)).toBeNull();
    expect(
      sameShortcut(shortcutOf(zoomIn) ?? { key: "" }, { key: "j", mod: true, alt: true }),
    ).toBe(true);
  });
});
