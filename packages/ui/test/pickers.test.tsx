import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ColorPicker, Popover, placePopover } from "../src";

beforeAll(() => {
  // jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function Picker({ initial = "#2b4fd6", onChange = (_: string) => {} }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ColorPicker
        label="Fill"
        value={value}
        onChange={(hex) => {
          setValue(hex);
          onChange(hex);
        }}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const value = () => screen.getByTestId("value").textContent;

describe("ColorPicker", () => {
  it("takes any CSS color typed into the hex field and keeps alpha for plain hex", async () => {
    const user = userEvent.setup();
    render(<Picker initial="#00000080" />);
    const hex = screen.getByLabelText("Fill hex");
    expect((hex as HTMLInputElement).value).toBe("000000");
    await user.clear(hex);
    await user.type(hex, "ff5a1f{Enter}");
    expect(value()).toBe("#ff5a1f80");
    await user.clear(hex);
    await user.type(hex, "rgb(0, 128, 0){Enter}");
    expect(value()).toBe("#008000");
  });

  it("moves hue, saturation, brightness and opacity with the keyboard", () => {
    render(<Picker initial="#ff0000" />);
    const area = screen.getByRole("slider", { name: "Fill saturation and brightness" });
    fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
    expect(value()).toBe("#e60000");
    const hue = screen.getByRole("slider", { name: "Fill hue" });
    fireEvent.keyDown(hue, { key: "End" });
    expect(hue.getAttribute("aria-valuenow")).toBe("360");
    const opacity = screen.getByRole("slider", { name: "Fill opacity" });
    fireEvent.keyDown(opacity, { key: "Home" });
    expect(value()).toMatch(/#e600000{2}$/);
  });

  it("keeps the hue of a grey while you change its brightness", () => {
    render(<Picker initial="#ff0000" />);
    const area = screen.getByRole("slider", { name: "Fill saturation and brightness" });
    // All the way to grey, then back to full saturation: still red.
    for (let i = 0; i < 10; i++) fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    expect(value()).toBe("#ffffff");
    for (let i = 0; i < 10; i++) fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
    expect(value()).toBe("#ff0000");
  });

  it("switches formats and edits channels", async () => {
    const user = userEvent.setup();
    render(<Picker initial="#000000" />);
    await user.selectOptions(screen.getByLabelText("Color format"), "rgb");
    const red = screen.getByLabelText("Fill red");
    await user.clear(red);
    await user.type(red, "255{Enter}");
    expect(value()).toBe("#ff0000");
  });
});

function Nested({ onClose }: { onClose: () => void }) {
  const outer = useRef<HTMLButtonElement>(null);
  const inner = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <>
      <button type="button" ref={outer}>
        Anchor
      </button>
      <button type="button">Elsewhere</button>
      {open && outer.current ? (
        <Popover
          anchor={outer.current}
          label="Effect"
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <button type="button" ref={inner} onClick={() => setInnerOpen(true)}>
            Color
          </button>
          {innerOpen && inner.current ? (
            <Popover
              anchor={inner.current}
              label="Color picker"
              onClose={() => setInnerOpen(false)}
            >
              <button type="button">Inside the picker</button>
            </Popover>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

describe("Popover", () => {
  it("stays open while a nested popover is used, and closes from outside", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<Nested onClose={onClose} />);
    rerender(<Nested onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Color" }));
    await user.click(screen.getByRole("button", { name: "Inside the picker" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Effect" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without letting it reach the page", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onPageKey = vi.fn();
    document.addEventListener("keydown", onPageKey);
    const { rerender } = render(<Nested onClose={onClose} />);
    rerender(<Nested onClose={onClose} />);
    screen.getByRole("button", { name: "Color" }).focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPageKey).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onPageKey);
  });

  it("flips to the other side and stays inside the viewport", () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 240, height: 400 };
    const rect = (left: number, top: number) =>
      ({ left, top, right: left + 100, bottom: top + 24, width: 100, height: 24 }) as DOMRect;
    expect(placePopover(rect(700, 100), size, viewport, "left", 8)).toEqual({
      left: 452,
      top: 92,
      side: "left",
    });
    // No room on the left: open on the right.
    expect(placePopover(rect(100, 100), size, viewport, "left", 8).side).toBe("right");
    // Near the bottom: pulled up to fit.
    expect(placePopover(rect(700, 700), size, viewport, "left", 8).top).toBe(392);
  });
});
