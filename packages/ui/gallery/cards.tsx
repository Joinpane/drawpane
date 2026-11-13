// The component previews from design-system/components/<Name>/preview.html, rebuilt with
// @drawpane/ui. Same groups, order, card heights and sample content.

import type { ReactNode } from "react";
import {
  AgentPlan,
  AgentStep,
  AgentTag,
  Badge,
  Button,
  CommandBar,
  Icon,
  IconButton,
  iconNames,
  Kbd,
  LayerRow,
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

export interface Card {
  name: string;
  group: string;
  height: number;
  /** Preview sits on the canvas color instead of a pane surface. */
  canvas?: boolean;
  render: () => ReactNode;
}

const DIRECTION = [
  { value: "row", icon: "layout-row", title: "Horizontal" },
  { value: "col", icon: "layout-col", title: "Vertical" },
  { value: "grid", icon: "layout-grid", title: "Grid" },
] as const;

export const CARDS: Card[] = [
  {
    name: "Icon",
    group: "Foundations",
    height: 272,
    render: () => (
      <div className="g-stage" style={{ gap: "14px 4px" }}>
        {iconNames.map((name) => (
          <figure key={name} className="g-icon">
            <Icon name={name} />
            <figcaption>{name}</figcaption>
          </figure>
        ))}
      </div>
    ),
  },
  {
    name: "Button",
    group: "Actions",
    height: 132,
    render: () => (
      <div className="g-stack">
        <div className="g-stage">
          <Button variant="primary" shortcut="⌘ ↵">
            Publish library
          </Button>
          <Button>Duplicate</Button>
          <Button variant="ghost" icon="branch">
            New branch
          </Button>
          <Button variant="danger">Delete file</Button>
          <Button disabled>Merge</Button>
        </div>
        <div className="g-stage">
          <Button variant="primary" size="lg">
            Create file
          </Button>
          <Button size="lg">Import .penpot</Button>
          <Button size="sm" icon="plus">
            Add
          </Button>
          <Button size="sm" variant="ghost">
            Detach
          </Button>
        </div>
      </div>
    ),
  },
  {
    name: "IconButton",
    group: "Actions",
    height: 88,
    render: () => (
      <div className="g-stage">
        <IconButton icon="pointer" label="Move" shortcut="V" pressed size="md" />
        <IconButton icon="board" label="Board" shortcut="B" pressed={false} size="md" />
        <IconButton icon="rectangle" label="Rectangle" shortcut="R" pressed={false} size="md" />
        <IconButton icon="pen" label="Pen" shortcut="P" pressed={false} size="md" />
        <IconButton icon="text" label="Text" shortcut="T" pressed={false} size="md" />
        <span style={{ width: 1, height: 16, background: "var(--line-strong)" }} />
        <IconButton icon="xray" label="Layout X-ray" shortcut="Alt" pressed />
        <IconButton icon="plus" label="Add fill" />
        <IconButton icon="more" label="More options" />
      </div>
    ),
  },
  {
    name: "Kbd",
    group: "Actions",
    height: 72,
    render: () => (
      <div className="g-stage">
        <Kbd keys={["⌘", "K"]} />
        <Kbd keys={["⇧", "A"]} />
        <Kbd keys={["Alt"]} />
        <Kbd keys={["⌘", "."]} />
        <Kbd keys={["tab"]} />
      </div>
    ),
  },
  {
    name: "Badge",
    group: "Status",
    height: 72,
    render: () => (
      <div className="g-stage">
        <Badge>Draft</Badge>
        <Badge tone="signal">3 changes</Badge>
        <Badge tone="component" icon="component">
          Main
        </Badge>
        <Badge tone="info">feature/onboarding</Badge>
        <Badge tone="success">Merged</Badge>
        <Badge tone="warning">Missing font</Badge>
        <Badge tone="danger">Conflict</Badge>
      </div>
    ),
  },
  {
    name: "TextField",
    group: "Inputs",
    height: 132,
    render: () => (
      <div className="g-stage" style={{ alignItems: "flex-start" }}>
        <TextField
          label="File name"
          defaultValue="Checkout flow"
          hint="Shown on the dashboard and in share links."
        />
        <TextField
          label="Invite by email"
          placeholder="name@company.com"
          error="That address is already on this team."
        />
      </div>
    ),
  },
  {
    name: "NumberField",
    group: "Inputs",
    height: 88,
    render: () => (
      <div className="g-stage">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 96px)", gap: 8 }}>
          <NumberField label="W" defaultValue={300} />
          <NumberField label="H" defaultValue={196} unit="hug" />
          <NumberField icon="layout-row" ariaLabel="Gap" token="space/200" />
          <NumberField label="°" ariaLabel="Rotation" defaultValue={48} />
        </div>
      </div>
    ),
  },
  {
    name: "TokenChip",
    group: "Inputs",
    height: 72,
    render: () => (
      <div className="g-stage">
        <TokenChip name="brand/500" swatch="var(--signal)" />
        <TokenChip name="surface/raised" swatch="var(--surface-raised)" />
        <TokenChip name="space/300" />
        <TokenChip name="radius/md" detached />
      </div>
    ),
  },
  {
    name: "SegmentedControl",
    group: "Inputs",
    height: 72,
    render: () => (
      <div className="g-stage">
        <SegmentedControl
          label="Pane"
          defaultValue="design"
          options={[
            { value: "design", label: "Design" },
            { value: "prototype", label: "Prototype" },
            { value: "inspect", label: "Inspect" },
          ]}
        />
        <SegmentedControl label="Direction" defaultValue="col" options={DIRECTION} />
      </div>
    ),
  },
  {
    name: "Switch",
    group: "Inputs",
    height: 72,
    render: () => (
      <div className="g-stage">
        <Switch defaultChecked label="Clip content" />
        <Switch label="Show in prototype" />
        <Switch label="Disabled" disabled />
      </div>
    ),
  },
  {
    name: "PropertySection",
    group: "Inspector",
    height: 344,
    canvas: true,
    render: () => (
      <div className="g-stage">
        <div className="g-pane" style={{ width: 264 }}>
          <PropertySection title="Frame">
            <PropertyRow>
              <NumberField label="X" defaultValue={20} />
              <NumberField label="Y" defaultValue={200} />
            </PropertyRow>
            <PropertyRow>
              <NumberField label="W" defaultValue={300} />
              <NumberField label="H" defaultValue={196} unit="hug" />
            </PropertyRow>
          </PropertySection>
          <PropertySection
            title="Auto layout"
            actions={
              <>
                <IconButton icon="xray" label="Layout X-ray" pressed />
                <IconButton icon="minus" label="Remove auto layout" />
              </>
            }
          >
            <SegmentedControl label="Direction" defaultValue="col" options={DIRECTION} />
            <PropertyRow>
              <NumberField icon="layout-col" ariaLabel="Gap" token="space/200" />
              <NumberField label="▢" ariaLabel="Padding" defaultValue={12} />
            </PropertyRow>
          </PropertySection>
          <PropertySection title="Fill" actions={<IconButton icon="plus" label="Add fill" />}>
            <PropertyRow style={{ gridTemplateColumns: "1fr 72px" }}>
              <NumberField
                icon="rectangle"
                ariaLabel="Fill"
                token="surface/raised"
                swatch="var(--surface-raised)"
              />
              <NumberField label="%" ariaLabel="Opacity" defaultValue={100} />
            </PropertyRow>
          </PropertySection>
        </div>
      </div>
    ),
  },
  {
    name: "LayerRow",
    group: "Layers",
    height: 344,
    canvas: true,
    render: () => (
      <div className="g-stage">
        <div role="tree" aria-label="Layers" className="g-pane" style={{ width: 248, padding: 4 }}>
          <LayerRow name="Home — iOS" kind="board" hasChildren expanded tabIndex={0} />
          <LayerRow name="Status bar" kind="instance" depth={1} />
          <LayerRow name="Greeting" kind="text" depth={1} />
          <LayerRow name="Hero card" kind="instance" depth={1} presence={2} />
          <LayerRow name="Upcoming" kind="frame" depth={1} hasChildren expanded selected />
          <LayerRow name="Event row" kind="instance" depth={2} />
          <LayerRow name="Event row" kind="instance" depth={2} />
          <LayerRow name="Tab bar" kind="instance" depth={1} locked />
          <LayerRow name="Onboarding" kind="board" hasChildren hidden />
          <LayerRow name="Event row" kind="component" hasChildren />
        </div>
      </div>
    ),
  },
  {
    name: "Menu",
    group: "Overlays",
    height: 312,
    canvas: true,
    render: () => (
      <div className="g-stage" style={{ alignItems: "flex-start" }}>
        <Menu
          label="Layer"
          items={[
            { label: "Copy", shortcut: "⌘ C" },
            { label: "Paste here", shortcut: "⌘ V", active: true },
            { separator: true },
            { heading: "Selection" },
            { label: "Add auto layout", shortcut: "⇧ A", icon: "layout-col" },
            { label: "Create component", shortcut: "⌥ ⌘ K", icon: "component" },
            { label: "Branch from here", icon: "branch" },
            { label: "Show history", icon: "history", submenu: true },
            { separator: true },
            { label: "Delete", shortcut: "⌫", danger: true },
          ]}
        />
      </div>
    ),
  },
  {
    name: "CommandBar",
    group: "Overlays",
    height: 420,
    canvas: true,
    render: () => (
      <div className="g-stage" style={{ justifyContent: "center" }}>
        <CommandBar
          defaultQuery="gap 16"
          readOnly
          autoFocus={false}
          scope="3 layers selected"
          groups={[
            {
              title: "Set property",
              items: [
                { label: "Set gap", from: "8", to: "16", icon: "layout-col", shortcut: "↵" },
                { label: "Bind gap to token", hint: "space/400 = 16px", icon: "token" },
              ],
            },
            {
              title: "Layers",
              items: [
                { label: "Gallery grid", hint: "Home — iOS", icon: "board" },
                {
                  label: "Event row",
                  hint: "Main component",
                  icon: "component",
                  kind: "component",
                },
              ],
            },
            {
              title: "Actions",
              items: [{ label: "Toggle Layout X-ray", icon: "xray", shortcut: "Alt" }],
            },
          ]}
        />
      </div>
    ),
  },
  {
    name: "SelectionLens",
    group: "Overlays",
    height: 88,
    canvas: true,
    render: () => (
      <div className="g-stage" style={{ justifyContent: "center" }}>
        <SelectionLens kind="Frame · Auto layout" kindIcon="board">
          <NumberField label="W" defaultValue={300} />
          <NumberField label="H" defaultValue={196} unit="hug" />
          <NumberField icon="layout-col" ariaLabel="Gap" token="space/200" />
          <NumberField label="▢" ariaLabel="Padding" defaultValue={12} />
        </SelectionLens>
      </div>
    ),
  },
  {
    name: "Tooltip",
    group: "Actions",
    height: 72,
    render: () => (
      <div className="g-stage">
        <Tooltip label="Rectangle" shortcut="R" />
        <Tooltip label="Layout X-ray" shortcut="Hold Alt" />
        <Tooltip label="Lena is editing this board" />
      </div>
    ),
  },
  {
    name: "PresenceStack",
    group: "Status",
    height: 72,
    render: () => (
      <div className="g-stage">
        <PresenceStack
          people={[
            { name: "Ana Ruiz", color: 1, where: "Home — iOS" },
            { name: "Lena Park", color: 2 },
            { name: "Sam Okafor", color: 3 },
            { name: "Dev Shah", color: 4 },
            { name: "Mo Chen", color: 5 },
            { name: "Ida Berg", color: 6 },
          ]}
        />
        <PresenceStack
          people={[
            { name: "Lena Park", color: 2 },
            { name: "Sam Okafor", color: 3 },
          ]}
        />
      </div>
    ),
  },
  {
    name: "AgentTag",
    group: "Agents",
    height: 88,
    render: () => (
      <div className="g-stage">
        <AgentTag name="Claude" status="working" onBehalfOf="Ana" />
        <AgentTag name="Audit bot" status="waiting" />
        <AgentTag name="Cursor" status="idle" />
      </div>
    ),
  },
  {
    name: "AgentStep",
    group: "Agents",
    height: 232,
    render: () => (
      <div className="g-stage">
        <AgentPlan aria-label="Plan" style={{ width: 360 }}>
          <AgentStep status="done" label="Read Home — iOS and the Acme library" meta="2 s" />
          <AgentStep status="done" label="Created branch agent/empty-states" meta="1 s" />
          <AgentStep
            status="running"
            label="Adding empty state to Upcoming"
            detail="Using EmptyState component, 0 detached values"
            ops="insert EmptyState variant=list in Upcoming"
          />
          <AgentStep status="queued" label="Render and check contrast" />
          <AgentStep status="review" label="Request review from Ana" />
        </AgentPlan>
      </div>
    ),
  },
  {
    name: "PromptField",
    group: "Agents",
    height: 168,
    render: () => (
      <div className="g-stage">
        <div style={{ width: 380 }}>
          <PromptField
            model="Claude Opus 5.5 · your key"
            context={[
              { label: "Upcoming", icon: "board" },
              { label: "Acme design system", icon: "component" },
            ]}
            defaultValue="Add empty and error states for this list, using our components"
          />
        </div>
      </div>
    ),
  },
];
