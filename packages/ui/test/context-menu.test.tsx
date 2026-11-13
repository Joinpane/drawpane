import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuEntry, placeMenu } from "../src";

afterEach(() => vi.useRealTimers());

function setup(onClose = vi.fn()) {
  const copy = vi.fn();
  const union = vi.fn();
  const items: ContextMenuEntry[] = [
    { label: "Copy", shortcut: "⌘C", onSelect: copy },
    { separator: true },
    {
      label: "Boolean",
      items: [
        { label: "Union", onSelect: union },
        { label: "Subtract", disabled: true },
      ],
    },
    { label: "Delete", danger: true },
  ];
  render(<ContextMenu at={{ x: 100, y: 100 }} items={items} label="Layer" onClose={onClose} />);
  return { copy, union, onClose };
}

describe("ContextMenu", () => {
  it("holds focus on the menu until ↓ moves in, then runs an item with Enter", async () => {
    const user = userEvent.setup();
    const { copy, onClose } = setup();
    expect(document.activeElement?.getAttribute("role")).toBe("menu");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("Copy");
    await user.keyboard("{Enter}");
    expect(copy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a submenu with → and comes back with ←", async () => {
    const user = userEvent.setup();
    const { union, onClose } = setup();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(screen.getByRole("menu", { name: "Boolean" })).toBeTruthy();
    expect(document.activeElement?.textContent).toContain("Union");
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("menu", { name: "Boolean" })).toBeNull();
    expect(document.activeElement?.textContent).toContain("Boolean");
    await user.keyboard("{Enter}{Enter}");
    expect(union).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a submenu on hover without taking focus", () => {
    vi.useFakeTimers();
    setup();
    const boolean = screen.getByRole("menuitem", { name: /Boolean/ });
    fireEvent.pointerMove(boolean);
    act(() => vi.advanceTimersByTime(200));
    const submenu = screen.getByRole("menu", { name: "Boolean" });
    // Hovering doesn't move focus into the submenu.
    expect(submenu.contains(document.activeElement)).toBe(false);
  });

  it("closes on Escape and on a click outside", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays inside the window, flipping submenus to the left", () => {
    const viewport = { width: 800, height: 600 };
    expect(placeMenu({ x: 700, y: 500 }, { width: 200, height: 300 }, viewport)).toEqual({
      left: 592,
      top: 292,
    });
    expect(placeMenu({ x: 700, y: 10 }, { width: 200, height: 100 }, viewport, 500)).toEqual({
      left: 300,
      top: 10,
    });
  });
});
