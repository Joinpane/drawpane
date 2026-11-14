import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandBar,
  type CommandGroup,
  IconButton,
  LayerRow,
  Menu,
  type MenuItem,
  NumberField,
  PromptField,
  SegmentedControl,
  Switch,
} from "../src";

const MENU_ITEMS: MenuItem[] = [
  { label: "Copy", shortcut: "⌘ C" },
  { label: "Paste here", shortcut: "⌘ V" },
  { separator: true },
  { heading: "Selection" },
  { label: "Add auto layout", icon: "layout-col" },
  { label: "Create component", icon: "component", disabled: true },
  { label: "Branch from here", icon: "branch" },
  { label: "Show history", icon: "history", submenu: true },
  { separator: true },
  { label: "Delete", danger: true },
];

const SEGMENT_OPTIONS = [
  { value: "row", icon: "layout-row", title: "Horizontal" },
  { value: "col", icon: "layout-col", title: "Vertical" },
  { value: "grid", icon: "layout-grid", title: "Grid", disabled: true },
  { value: "wrap", label: "Wrap" },
] as const;

const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: "Set property",
    items: [
      { label: "Set gap", from: "8", to: "16", icon: "layout-col" },
      { label: "Bind gap to token", hint: "space/400 = 16px", icon: "token" },
    ],
  },
  { title: "Layers", items: [] },
  { title: "Actions", items: [{ label: "Toggle Layout X-ray", icon: "xray" }] },
];

function ControlledSegments() {
  const [value, setValue] = useState<string>("row");
  return (
    <SegmentedControl
      label="Direction"
      value={value}
      options={SEGMENT_OPTIONS}
      onChange={setValue}
    />
  );
}

function FilteredCommandBar() {
  const [query, setQuery] = useState("");
  const groups = COMMAND_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
  }));
  return <CommandBar groups={groups} query={query} onQueryChange={setQuery} />;
}

describe("Menu", () => {
  const focused = () => document.activeElement?.textContent;

  it("moves a roving focus with arrows, Home and End, skipping separators", async () => {
    const user = userEvent.setup();
    render(<Menu label="Layer" items={MENU_ITEMS} autoFocus />);
    expect(focused()).toContain("Copy");
    const tabStops = screen.getAllByRole("menuitem").filter((el) => el.tabIndex === 0);
    expect(tabStops).toHaveLength(1);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(focused()).toContain("Add auto layout");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toContain("Create component");
    expect(document.activeElement?.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{End}");
    expect(focused()).toContain("Delete");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toContain("Copy");
    await user.keyboard("{ArrowUp}");
    expect(focused()).toContain("Delete");
    await user.keyboard("{Home}");
    expect(focused()).toContain("Copy");
  });

  it("selects with Enter and Space, but not disabled items", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Menu items={MENU_ITEMS} autoFocus onSelect={onSelect} onClose={onClose} />);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(MENU_ITEMS[1], 1);
    expect(onClose).toHaveBeenLastCalledWith("select");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("opens submenus with ArrowRight and closes on Escape and Tab", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Menu items={MENU_ITEMS} autoFocus onSelect={onSelect} onClose={onClose} />);
    await user.keyboard("s");
    expect(focused()).toContain("Show history");
    await user.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith(MENU_ITEMS[7], 7);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenLastCalledWith("escape");
    await user.keyboard("{Tab}");
    expect(onClose).toHaveBeenLastCalledWith("tab");
  });

  it("jumps by typeahead and cycles on a repeated letter", async () => {
    const user = userEvent.setup();
    render(<Menu items={MENU_ITEMS} autoFocus />);
    await user.keyboard("cr");
    expect(focused()).toContain("Create component");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await user.keyboard("p");
    expect(focused()).toContain("Paste here");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await user.keyboard("cc");
    expect(focused()).toContain("Copy");
  });

  it("labels heading groups and marks checkable items", () => {
    render(
      <Menu
        items={[
          { heading: "View" },
          { label: "Rulers", checked: true },
          { label: "Grid", checked: false },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
    const [rulers, grid] = screen.getAllByRole("menuitemcheckbox");
    expect(rulers?.getAttribute("aria-checked")).toBe("true");
    expect(grid?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("SegmentedControl", () => {
  it("is a radio group with one tab stop and arrow-key selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <button type="button">Before</button>
        <SegmentedControl
          label="Direction"
          defaultValue="col"
          options={SEGMENT_OPTIONS}
          onChange={onChange}
        />
      </>,
    );
    const radio = (name: string) => screen.getByRole("radio", { name });
    expect(radio("Vertical").tabIndex).toBe(0);
    expect(radio("Horizontal").tabIndex).toBe(-1);

    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(document.activeElement).toBe(radio("Vertical"));

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("Wrap"));
    expect(radio("Wrap").getAttribute("aria-checked")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("wrap");

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("Horizontal"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(radio("Wrap"));
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("row");
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("wrap");
  });

  it("follows the value when controlled", async () => {
    const user = userEvent.setup();
    render(<ControlledSegments />);
    await user.click(screen.getByRole("radio", { name: "Vertical" }));
    expect(screen.getByRole("radio", { name: "Vertical" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});

describe("Switch", () => {
  it("toggles with click, Space and Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="Clip content" onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Clip content" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    await user.keyboard(" ");
    expect(control.getAttribute("aria-checked")).toBe("false");
    await user.keyboard("{Enter}");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("stays put when controlled and when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Switch label="Controlled" checked={false} onChange={onChange} />
        <Switch label="Disabled" disabled onChange={onChange} />
      </>,
    );
    await user.click(screen.getByRole("switch", { name: "Controlled" }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch", { name: "Controlled" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await user.click(screen.getByRole("switch", { name: "Disabled" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("NumberField", () => {
  const setup = (props: Partial<Parameters<typeof NumberField>[0]> = {}) => {
    const onChange = vi.fn();
    render(<NumberField label="W" defaultValue={300} onChange={onChange} {...props} />);
    return { onChange, input: screen.getByRole<HTMLInputElement>("spinbutton", { name: "W" }) };
  };

  it("evaluates math and units on Enter", async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup();
    await user.clear(input);
    await user.type(input, "24*2{Enter}");
    expect(input.value).toBe("48");
    expect(onChange).toHaveBeenLastCalledWith(48);
    await user.clear(input);
    await user.type(input, "1.5rem{Enter}");
    expect(input.value).toBe("24");
    expect(input.getAttribute("aria-valuenow")).toBe("24");
  });

  it("commits on blur and keeps the last value for invalid input", async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup();
    await user.clear(input);
    await user.type(input, "(100 - 8) / 2");
    await user.tab();
    expect(input.value).toBe("46");
    await user.clear(input);
    await user.type(input, "wide{Enter}");
    expect(input.value).toBe("46");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reverts on Escape", async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup();
    await user.clear(input);
    await user.type(input, "999{Escape}");
    expect(input.value).toBe("300");
    // And hands the keyboard back, like Figma.
    expect(document.activeElement).not.toBe(input);
    await user.tab();
    expect(input.value).toBe("300");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps with the arrow keys: Shift ×10, Alt ×0.1, clamped", async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup({ min: 0, max: 320 });
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("301");
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(input.value).toBe("291");
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(input.value).toBe("291.1");
    await user.keyboard("{Shift>}{ArrowUp}{ArrowUp}{ArrowUp}{/Shift}");
    expect(input.value).toBe("320");
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      301, 291, 291.1, 301.1, 311.1, 320,
    ]);
  });

  it("steps from a typed expression", async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.clear(input);
    await user.type(input, "10*2{ArrowUp}");
    expect(input.value).toBe("21");
  });

  it("shows Mixed and accepts a new value", async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup({ defaultValue: null });
    expect(input.placeholder).toBe("Mixed");
    expect(input.getAttribute("aria-valuetext")).toBe("Mixed");
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(onChange).not.toHaveBeenCalled();
    await user.type(input, "12{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  it("scrubs when the label is dragged", () => {
    const onScrubStart = vi.fn();
    const onScrubEnd = vi.fn();
    const { input, onChange } = setup({ onScrubStart, onScrubEnd });
    const label = screen.getByText("W");
    fireEvent.pointerDown(label, { pointerId: 1, button: 0, clientX: 100 });
    expect(document.documentElement.classList.contains("dp-scrubbing")).toBe(true);
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 105 });
    expect(input.value).toBe("305");
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 107, shiftKey: true });
    expect(input.value).toBe("325");
    fireEvent.pointerUp(label, { pointerId: 1, clientX: 107 });
    expect(document.documentElement.classList.contains("dp-scrubbing")).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(325);
    expect(onScrubStart).toHaveBeenCalledTimes(1);
    expect(onScrubEnd).toHaveBeenCalledTimes(1);
  });

  it("accepts values typed in its own unit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NumberField label="%" ariaLabel="Opacity" unit="%" defaultValue={100} onChange={onChange} />,
    );
    const input = screen.getByRole("spinbutton", { name: "Opacity" });
    await user.clear(input);
    await user.type(input, "50%{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(50);
  });
});

describe("CommandBar", () => {
  it("is a combobox whose active option follows the arrow keys", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<CommandBar groups={COMMAND_GROUPS} onRun={onRun} />);
    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.queryByText("Layers")).toBeNull();
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);

    const activeOption = () =>
      document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
    expect(activeOption()).toBe(options[0]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(activeOption()?.textContent).toContain("Toggle Layout X-ray");
    await user.keyboard("{ArrowDown}");
    expect(activeOption()).toBe(options[0]);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onRun).toHaveBeenCalledWith(COMMAND_GROUPS[2]?.items[0], COMMAND_GROUPS[2]);
    expect(document.activeElement).toBe(input);
  });

  it("completes with Tab, closes with Escape, and runs on click", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const onClose = vi.fn();
    const onRun = vi.fn();
    render(
      <CommandBar
        groups={COMMAND_GROUPS}
        onComplete={onComplete}
        onClose={onClose}
        onRun={onRun}
      />,
    );
    await user.keyboard("{Tab}");
    expect(onComplete).toHaveBeenCalledWith(COMMAND_GROUPS[0]?.items[0], COMMAND_GROUPS[0]);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("option", { name: /Bind gap to token/ }));
    expect(onRun).toHaveBeenCalledWith(COMMAND_GROUPS[0]?.items[1], COMMAND_GROUPS[0]);
  });

  it("makes the first result active again when the results change", async () => {
    const user = userEvent.setup();
    render(<FilteredCommandBar />);
    const input = screen.getByRole("combobox");
    await user.keyboard("{ArrowDown}");
    await user.type(input, "gap");
    const active = document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
    expect(active?.textContent).toContain("Set gap");
    await user.clear(input);
    await user.type(input, "zzz");
    expect(screen.getByText("No matching commands")).toBeTruthy();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("Tooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows after a hover delay and hides on Escape", () => {
    vi.useFakeTimers();
    // Leave the window in which a tooltip that just closed lets the next one open at once.
    vi.advanceTimersByTime(1000);
    render(<IconButton icon="rectangle" label="Rectangle" shortcut="R" />);
    const button = screen.getByRole("button", { name: "Rectangle" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(document.querySelector(".dp-tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector(".dp-tooltip")?.textContent).toBe("RectangleR");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".dp-tooltip")).toBeNull();
  });

  it("describes its trigger on keyboard focus", async () => {
    const user = userEvent.setup();
    const { Tooltip } = await import("../src");
    render(
      <Tooltip label="Lena is editing this board">
        <button type="button">Hero card</button>
      </Tooltip>,
    );
    await user.tab();
    const tooltip = screen.getByRole("tooltip");
    const button = screen.getByRole("button", { name: "Hero card" });
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("LayerRow", () => {
  it("renames in place with F2 or double-click", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <div role="tree" aria-label="Layers">
        <LayerRow name="Hero card" tabIndex={0} onRename={onRename} />
      </div>,
    );
    await user.tab();
    await user.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Layer name" });
    await user.clear(input);
    await user.type(input, "Hero{Enter}");
    expect(onRename).toHaveBeenCalledWith("Hero");
    await user.dblClick(screen.getByText("Hero card"));
    await user.type(screen.getByRole("textbox", { name: "Layer name" }), "x{Escape}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("toggles visibility without selecting the row", async () => {
    const user = userEvent.setup();
    const onToggleHidden = vi.fn();
    const onClick = vi.fn();
    render(<LayerRow name="Tab bar" hidden onToggleHidden={onToggleHidden} onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Show layer" }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("PromptField", () => {
  it("sends on Enter, adds a line on Shift+Enter, and reports triggers", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onTrigger = vi.fn();
    render(<PromptField onSubmit={onSubmit} onTrigger={onTrigger} />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message the agent" });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    await user.type(input, "Add states{Shift>}{Enter}{/Shift}for /");
    expect(onTrigger).toHaveBeenCalledWith("/");
    expect(input.value).toBe("Add states\nfor /");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Add states\nfor /");
    expect(input.value).toBe("");
  });
});
