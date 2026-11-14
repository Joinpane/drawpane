import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MenuButton, placeDropdown } from "../src";

const viewport = { width: 800, height: 600 };
const size = { width: 180, height: 120 };

describe("placeDropdown", () => {
  it("opens below the button, lined up with its end edge", () => {
    const anchor = { left: 400, right: 424, top: 100, bottom: 124 };
    expect(placeDropdown(anchor, size, viewport)).toEqual({ left: 244, top: 128, side: "bottom" });
    expect(placeDropdown(anchor, size, viewport, "start").left).toBe(400);
  });

  it("opens above when there's no room below, like a menu over a reply box", () => {
    const anchor = { left: 400, right: 424, top: 520, bottom: 544 };
    expect(placeDropdown(anchor, size, viewport)).toEqual({ left: 244, top: 396, side: "top" });
  });

  it("stays inside the window at its edges", () => {
    const anchor = { left: 4, right: 28, top: 100, bottom: 124 };
    expect(placeDropdown(anchor, size, viewport).left).toBe(8);
  });
});

describe("MenuButton", () => {
  function setup() {
    const edit = vi.fn();
    render(
      <div>
        <p>Outside</p>
        <MenuButton
          label="Options for Ana's comment"
          items={[
            { label: "Edit", onSelect: edit },
            { label: "Delete", danger: true },
          ]}
        />
      </div>,
    );
    return { edit, button: screen.getByRole("button", { name: "Options for Ana's comment" }) };
  }

  it("opens its menu in a portal, outside anything that could clip it", async () => {
    const user = userEvent.setup();
    const { button, edit } = setup();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await user.click(button);
    const menu = screen.getByRole("menu", { name: "Options for Ana's comment" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.parentElement?.contains(menu)).toBe(false);
    expect(menu.closest(".dp-dropdown")?.parentElement).toBe(document.body);
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape, giving focus back to the button, and on a click outside", async () => {
    const user = userEvent.setup();
    const { button } = setup();
    await user.click(button);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("toggles from its button without the outside click reopening it", async () => {
    const user = userEvent.setup();
    const { button } = setup();
    await user.click(button);
    await user.click(button);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
