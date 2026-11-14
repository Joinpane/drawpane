import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentPlan,
  AgentStep,
  AgentTag,
  Badge,
  Button,
  ButtonLink,
  CommandBar,
  Icon,
  IconButton,
  iconNames,
  Kbd,
  LayerRow,
  Logo,
  Menu,
  NumberField,
  PresenceStack,
  PromptField,
  PropertyRow,
  PropertySection,
  SegmentedControl,
  SelectionLens,
  Switch,
  TextField,
  TokenChip,
  Tooltip,
} from "../src";

describe("render smoke tests", () => {
  it("Icon renders every glyph, decorative unless labelled", () => {
    const { container } = render(
      <>
        {iconNames.map((name) => (
          <Icon key={name} name={name} />
        ))}
        <Icon name="lock" size={12} label="Locked" />
      </>,
    );
    const svgs = container.querySelectorAll("svg.dp-icon");
    expect(svgs).toHaveLength(iconNames.length + 1);
    for (const svg of svgs) expect(svg.childElementCount).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "Locked" }).getAttribute("width")).toBe("12");
  });

  it("Button", () => {
    render(
      <Button variant="primary" icon="branch" shortcut="⌘ ↵">
        Publish library
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Publish library" });
    expect(button.className).toBe("dp-btn dp-btn--primary dp-btn--md");
    expect(button.getAttribute("type")).toBe("button");
  });

  it("ButtonLink looks like a Button, and opens other sites in a new tab", () => {
    render(
      <>
        <ButtonLink href="https://example.com/notes" variant="ghost" size="sm">
          Release notes
        </ButtonLink>
        <ButtonLink href="/settings">Settings</ButtonLink>
      </>,
    );
    const notes = screen.getByRole("link", { name: "Release notes" });
    expect(notes.className).toBe("dp-btn dp-btn--ghost dp-btn--sm");
    expect(notes.getAttribute("target")).toBe("_blank");
    expect(notes.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("target")).toBeNull();
  });

  it("IconButton", () => {
    render(<IconButton icon="pointer" label="Move" shortcut="V" pressed size="md" />);
    const button = screen.getByRole("button", { name: "Move" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("dp-iconbtn--md");
  });

  it("Kbd", () => {
    const { container } = render(<Kbd keys={["⌘", "K"]} label="Command K" />);
    expect(container.querySelectorAll(".dp-kbd > kbd")).toHaveLength(2);
    expect(screen.getByText("Command K").className).toBe("dp-visually-hidden");
  });

  it("Tooltip without a trigger renders the bubble", () => {
    render(<Tooltip label="Rectangle" shortcut="R" />);
    expect(screen.getByRole("tooltip").textContent).toBe("RectangleR");
  });

  it("Badge adds the status icon", () => {
    const { container } = render(<Badge tone="success">Merged</Badge>);
    expect(container.querySelector(".dp-badge--success svg")).not.toBeNull();
  });

  it("TextField links its label and error", () => {
    render(<TextField label="Invite by email" error="That address is already on this team." />);
    const input = screen.getByLabelText("Invite by email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("textbox", { description: /already on this team/ })).toBe(input);
  });

  it("NumberField", () => {
    render(<NumberField label="W" defaultValue={300} />);
    expect(screen.getByRole("spinbutton", { name: "W" })).toHaveProperty("value", "300");
  });

  it("NumberField bound to a token shows a chip", () => {
    render(<NumberField icon="layout-col" ariaLabel="Gap" token="space/200" />);
    expect(screen.getByRole("group", { name: "Gap" }).textContent).toContain("space/200");
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("TokenChip", () => {
    render(<TokenChip name="radius/md" detached />);
    expect(screen.getByTitle("Detached from radius/md").className).toContain("dp-token--detached");
  });

  it("SegmentedControl", () => {
    render(
      <SegmentedControl
        label="Pane"
        value="design"
        options={[
          { value: "design", label: "Design" },
          { value: "inspect", label: "Inspect" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Pane" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Design" }).getAttribute("aria-checked")).toBe("true");
  });

  it("Switch", () => {
    render(<Switch defaultChecked label="Clip content" />);
    expect(screen.getByRole("switch", { name: "Clip content" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("PropertySection and PropertyRow", () => {
    render(
      <PropertySection title="Frame" actions={<IconButton icon="plus" label="Add fill" />}>
        <PropertyRow columns={3}>
          <NumberField label="X" defaultValue={20} />
        </PropertyRow>
      </PropertySection>,
    );
    const section = screen.getByRole("region", { name: "Frame" });
    expect(section.querySelector(".dp-row.dp-row--3")).not.toBeNull();
  });

  it("LayerRow", () => {
    render(
      <div role="tree" aria-label="Layers">
        <LayerRow
          name="Upcoming"
          kind="frame"
          depth={1}
          hasChildren
          expanded
          selected
          presence={2}
        />
      </div>,
    );
    const row = screen.getByRole("treeitem", { name: /Upcoming/ });
    expect(row.getAttribute("aria-level")).toBe("2");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.style.getPropertyValue("--dp-depth")).toBe("1");
  });

  it("Menu", () => {
    render(
      <Menu
        label="Layer"
        items={[{ label: "Copy", shortcut: "⌘ C" }, { separator: true }, { heading: "Selection" }]}
      />,
    );
    expect(screen.getByRole("menu", { name: "Layer" })).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("CommandBar", () => {
    render(
      <CommandBar groups={[{ title: "Actions", items: [{ label: "Toggle Layout X-ray" }] }]} />,
    );
    expect(screen.getByRole("combobox")).toBe(document.activeElement);
    expect(screen.getByRole("option", { name: "Toggle Layout X-ray" })).toBeTruthy();
  });

  it("SelectionLens", () => {
    render(
      <SelectionLens kind="Frame · Auto layout">
        <NumberField label="W" defaultValue={300} />
      </SelectionLens>,
    );
    expect(screen.getByRole("toolbar", { name: "Selection Lens" }).textContent).toContain(
      "Frame · Auto layout",
    );
    expect(screen.getByRole("button", { name: "Open Inspector" })).toBeTruthy();
  });

  it("PresenceStack collapses past max", () => {
    const people = ["Ana Ruiz", "Lena Park", "Sam Okafor", "Dev Shah", "Mo Chen", "Ida Berg"];
    render(<PresenceStack people={people.map((name) => ({ name }))} />);
    expect(screen.getByRole("group", { name: "6 people in this file" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ana Ruiz" }).textContent).toBe("AR");
    expect(screen.getByRole("img", { name: "2 more" }).textContent).toBe("+2");
  });

  it("AgentTag", () => {
    render(<AgentTag name="Claude" onBehalfOf="Ana" />);
    expect(screen.getByTitle("Claude, for Ana").textContent).toBe("ClaudeWorkingfor Ana");
  });

  it("AgentStep", () => {
    render(
      <AgentPlan aria-label="Plan">
        <AgentStep status="running" label="Adding empty state" ops="insert EmptyState" />
      </AgentPlan>,
    );
    expect(screen.getByRole("list", { name: "Plan" }).className).toBe("dp-plan");
    const step = screen.getByRole("listitem");
    expect(step.getAttribute("aria-current")).toBe("step");
    expect(step.textContent).toContain("Running: Adding empty state");
  });

  it("PromptField", () => {
    render(<PromptField context={[{ label: "Upcoming", icon: "board" }, "Acme"]} running />);
    expect(screen.getByRole("textbox", { name: "Message the agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("Logo", () => {
    render(
      <>
        <Logo />
        <Logo variant="app-icon" label="Drawpane app" />
        <Logo wordmark />
      </>,
    );
    expect(screen.getByRole("img", { name: "Drawpane" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Drawpane app" })).toBeTruthy();
    expect(screen.getByText("Drawpane").className).toBe("dp-logo__wordmark");
  });
});
