import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ColorPicker, DropdownMenu, Popover, PopoverRoomContext, placePopover } from "../src";

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

/** A popover with a dropdown inside it, like an effect's kind. */
function WithDropdown({ onClose, onPick }: { onClose: () => void; onPick: () => void }) {
  const outer = useRef<HTMLButtonElement>(null);
  const kind = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [, rerender] = useState(0);
  return (
    <>
      <button type="button" ref={outer} onClick={() => rerender((n) => n + 1)}>
        Anchor
      </button>
      {outer.current ? (
        <Popover anchor={outer.current} label="Effect" onClose={onClose}>
          <button type="button" ref={kind} onClick={() => setMenu(true)}>
            Kind
          </button>
          {menu && kind.current ? (
            <DropdownMenu
              anchor={kind.current}
              label="Kinds"
              items={[{ label: "Inner shadow", onSelect: onPick }]}
              onClose={() => setMenu(false)}
            />
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

  it("stays open while a dropdown opened inside it is used", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onPick = vi.fn();
    render(<WithDropdown onClose={onClose} onPick={onPick} />);
    await user.click(screen.getByRole("button", { name: "Anchor" }));
    await user.click(screen.getByRole("button", { name: "Kind" }));
    await user.click(screen.getByRole("menuitem", { name: "Inner shadow" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
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

  it("opens a popover from inside another beside that one, not over it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Nested onClose={() => {}} />);
    rerender(<Nested onClose={() => {}} />);
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
    screen.getByRole("dialog", { name: "Effect" }).getBoundingClientRect = () =>
      box(900, 300, 240, 200);
    screen.getByRole("button", { name: "Color" }).getBoundingClientRect = () =>
      box(990, 420, 24, 24);
    await user.click(screen.getByRole("button", { name: "Color" }));
    const picker = screen.getByRole("dialog", { name: "Color picker" });
    // Left of the effect editor (jsdom measures it 0 wide), level with its top.
    expect(picker.style.left).toBe("892px");
    expect(picker.style.top).toBe("292px");
  });

  it("takes its room from the context: bounds, what to avoid, and open and close", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.getBoundingClientRect = () =>
      ({ left: 500, top: 400, right: 524, bottom: 424, width: 24, height: 24 }) as DOMRect;
    const closed = vi.fn();
    let avoid = { left: 100, top: 380, right: 510, bottom: 440 };
    let moved = () => {};
    const room = {
      bounds: () => ({ left: 0, top: 0, right: 520, bottom: 800 }),
      avoid: () => avoid,
      subscribe: (onChange: () => void) => {
        moved = onChange;
        return () => {};
      },
      onOpen: vi.fn(() => closed),
    };
    const { unmount } = render(
      <PopoverRoomContext.Provider value={room}>
        <Popover anchor={button} label="Room" onClose={() => {}}>
          <p>Inside</p>
        </Popover>
      </PopoverRoomContext.Provider>,
    );
    expect(room.onOpen).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog", { name: "Room" });
    // Left of the button would sit on what it avoids: slid up above it instead.
    expect(dialog.style.left).toBe("492px");
    expect(dialog.style.top).toBe("372px");
    // Another layer selected, out of the way: back level with the button.
    avoid = { left: 100, top: 600, right: 510, bottom: 640 };
    await act(async () => moved());
    expect(dialog.style.top).toBe("392px");
    unmount();
    expect(closed).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it("opens beside another element when asked, keeping its anchor for focus", () => {
    const panel = document.createElement("section");
    const button = document.createElement("button");
    panel.append(button);
    document.body.append(panel);
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
    panel.getBoundingClientRect = () => box(700, 200, 260, 300);
    button.getBoundingClientRect = () => box(930, 420, 24, 24);
    const { unmount } = render(
      <Popover anchor={button} beside={panel} label="Settings" onClose={() => {}}>
        <p>Inside</p>
      </Popover>,
    );
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    // Left of the panel, its top level with the panel's (less the margin), not the button's.
    expect(dialog.style.top).toBe("192px");
    expect(Number.parseFloat(dialog.style.left)).toBeLessThan(700);
    unmount();
    panel.remove();
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

  it("keeps inside the bounds it's given, not just the viewport", () => {
    const viewport = { width: 1440, height: 900 };
    const size = { width: 264, height: 400 };
    // A swatch at the inspector's edge: the popover stays over the canvas, left of the pane.
    const swatch = {
      left: 1176,
      top: 520,
      right: 1200,
      bottom: 544,
      width: 24,
      height: 24,
    } as DOMRect;
    const bounds = { left: 0, top: 0, right: 1164, bottom: 900 };
    const placed = placePopover(swatch, size, viewport, "left", 8, { bounds });
    expect(placed.left + size.width).toBeLessThanOrEqual(1164 - 8);
    expect(placed.side).toBe("left");
  });

  it("slides along the side it opens on to keep clear of what it should avoid", () => {
    const viewport = { width: 1440, height: 900 };
    const size = { width: 290, height: 330 };
    // Type settings beside a tall Text section; the text box ends right where it opens.
    const section = {
      left: 1164,
      top: 300,
      right: 1428,
      bottom: 860,
      width: 264,
      height: 560,
    } as DOMRect;
    const text = { left: 564, top: 541, right: 868, bottom: 578 };
    const bounds = { left: 0, top: 0, right: 1164, bottom: 900 };
    const plain = placePopover(section, size, viewport, "left", 8, { bounds });
    expect(plain.left).toBeLessThan(text.right);
    const placed = placePopover(section, size, viewport, "left", 8, { bounds, avoid: text });
    // Same side, moved up until its bottom clears the text by the gap.
    expect(placed).toEqual({ left: 866, top: 541 - 8 - 330, side: "left" });
  });

  it("tries the other axis before flipping onto what it should avoid", () => {
    const viewport = { width: 1440, height: 900 };
    const size = { width: 264, height: 410 };
    // The Lens sits above a rectangle; no room above it for the fill picker.
    const lens = {
      left: 600,
      top: 248,
      right: 980,
      bottom: 280,
      width: 380,
      height: 32,
    } as DOMRect;
    const selection = { left: 640, top: 292, right: 940, bottom: 412 };
    const bounds = { left: 284, top: 60, right: 1156, bottom: 852 };
    // Without anything to avoid it flips below, onto the rectangle.
    expect(placePopover(lens, size, viewport, "top", 8, { bounds }).side).toBe("bottom");
    // Asked to keep clear: right beside the Lens on the other axis, before sliding along below.
    const placed = placePopover(lens, size, viewport, "top", 8, { bounds, avoid: selection });
    expect(placed).toEqual({ left: 600 - 8 - 264, top: 240, side: "left" });
  });

  it("opens out past what it should avoid when nothing beside the anchor clears it", () => {
    const viewport = { width: 1440, height: 900 };
    const size = { width: 264, height: 410 };
    // The Lens's swatch just above a tall rectangle: no room above, below, or beside the swatch.
    const swatch = {
      left: 702,
      top: 440,
      right: 726,
      bottom: 464,
      width: 24,
      height: 24,
    } as DOMRect;
    const selection = { left: 500, top: 480, right: 800, bottom: 780 };
    const bounds = { left: 284, top: 60, right: 1156, bottom: 852 };
    const placed = placePopover(swatch, size, viewport, "top", 8, { bounds, avoid: selection });
    // Right of the rectangle, level with the swatch as far as the bounds allow.
    expect(placed).toEqual({ left: 808, top: 432, side: "right" });
  });

  it("keeps the usual placement when nothing clears what it should avoid", () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 240, height: 400 };
    const anchor = {
      left: 700,
      top: 100,
      right: 800,
      bottom: 124,
      width: 100,
      height: 24,
    } as DOMRect;
    // A selection bigger than the screen.
    const avoid = { left: -100, top: -100, right: 1100, bottom: 900 };
    expect(placePopover(anchor, size, viewport, "left", 8, { avoid })).toEqual(
      placePopover(anchor, size, viewport, "left", 8),
    );
  });

  it("goes to the other axis when neither the side nor its opposite fits", () => {
    const viewport = { width: 600, height: 800 };
    const size = { width: 300, height: 200 };
    const anchor = {
      left: 200,
      top: 300,
      right: 400,
      bottom: 324,
      width: 200,
      height: 24,
    } as DOMRect;
    expect(placePopover(anchor, size, viewport, "left", 8)).toEqual({
      left: 200,
      top: 332,
      side: "bottom",
    });
  });
});
