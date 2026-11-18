import {
  componentSetOf,
  instanceProperties,
  layerName,
  type OverrideGroup,
  overrideGroups,
  type InstanceProperties as Properties,
  type PropertyRow as Row,
  shownFields,
  swapTargets,
} from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import {
  DropdownMenu,
  Icon,
  IconButton,
  type MenuItem,
  PropertyRow,
  SegmentedControl,
  Switch,
} from "@drawpane/ui";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "./hooks";

/**
 * An instance's component properties (decision 0035), as Figma shows them:
 * a row per property, in its main's order, then the exposed nested
 * instances' under their names. Then what else changed, in words.
 */
export function InstancePropertiesPanel({ instance }: { instance: NodeRecord }) {
  const editor = useEditor();
  const properties = instanceProperties(editor.doc, instance.id);
  const groups = overrideGroups(editor.doc, instance.id, shownFields(properties));
  return (
    <>
      {properties && (properties.rows.length > 0 || properties.nested.length > 0) ? (
        <div className="instance-props">
          <PropertyRows properties={properties} />
          {properties.nested.map((nested) => (
            <NestedProperties key={nested.instanceId} properties={nested} />
          ))}
        </div>
      ) : null}
      <OverridesList instance={instance} groups={groups} />
    </>
  );
}

function NestedProperties({ properties }: { properties: Properties }) {
  return (
    <section className="instance-props__nested" aria-label={properties.name}>
      <h4 className="instance-props__heading">
        <Icon name="instance" size={12} />
        <span>{properties.name}</span>
      </h4>
      <PropertyRows properties={properties} />
      {properties.nested.map((nested) => (
        <NestedProperties key={nested.instanceId} properties={nested} />
      ))}
    </section>
  );
}

function PropertyRows({ properties }: { properties: Properties }) {
  return (
    <>
      {properties.rows.map((row) => (
        <PropertyRow key={row.id} columns="label" className="instance-prop">
          <span className="instance-prop__name" title={row.description || row.name}>
            {row.changed ? <span className="overrides__dot" aria-hidden="true" /> : null}
            <span className="instance-prop__label">{row.name}</span>
          </span>
          <span className="instance-prop__control">
            <PropertyControl instanceId={properties.instanceId} row={row} />
            {row.changed ? <ResetProperty instanceId={properties.instanceId} row={row} /> : null}
          </span>
        </PropertyRow>
      ))}
    </>
  );
}

function ResetProperty({ instanceId, row }: { instanceId: string; row: Row }) {
  const editor = useEditor();
  if (!editor.canEdit) return null;
  return (
    <IconButton
      icon="history"
      label={`Reset ${row.name}`}
      onClick={() => editor.resetInstanceProperty(instanceId, row.id)}
    />
  );
}

/** Variant values that read as a yes or no: Figma shows those as a switch. */
function booleanOptions(options: readonly string[]): { on: string; off: string } | null {
  if (options.length !== 2) return null;
  const on = options.find((o) => /^(true|yes|on)$/i.test(o));
  const off = options.find((o) => /^(false|no|off)$/i.test(o));
  return on && off ? { on, off } : null;
}

function PropertyControl({ instanceId, row }: { instanceId: string; row: Row }) {
  const editor = useEditor();
  const set = (value: boolean | string) => editor.setInstanceProperty(instanceId, row.id, value);
  const disabled = !editor.canEdit;
  if (row.type === "variant") {
    const options = row.options ?? [];
    const value = typeof row.value === "string" ? row.value : "";
    const toggle = booleanOptions(options);
    if (toggle)
      return (
        <Switch
          aria-label={row.name}
          checked={value === toggle.on}
          disabled={disabled}
          onChange={(on) => set(on ? toggle.on : toggle.off)}
        />
      );
    if (options.length <= 3 && options.every((o) => o.length <= 10))
      return (
        <SegmentedControl
          label={row.name}
          options={options.map((v) => ({ value: v, label: v }))}
          value={value}
          onChange={(v) => set(v)}
        />
      );
    return (
      <select
        className="inspector__select"
        aria-label={row.name}
        value={value}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
      >
        {options.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  if (row.type === "boolean")
    return (
      <Switch
        aria-label={row.name}
        checked={row.value === true}
        disabled={disabled}
        onChange={(on) => set(on)}
      />
    );
  if (row.type === "text")
    return (
      <TextValue
        label={row.name}
        value={typeof row.value === "string" ? row.value : ""}
        disabled={disabled}
        onCommit={set}
      />
    );
  if (row.type === "instance") return <SwapPicker instanceId={instanceId} row={row} />;
  return null;
}

/** A text property: commits on Enter or leaving it; Shift+Enter is a new line; Escape puts it back. */
function TextValue({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Escape cancels: the blur it causes runs before React has the restored draft, so it's told
  // not to commit rather than left to read the state.
  const cancelled = useRef(false);
  const lines = Math.min(4, Math.max(1, draft.split("\n").length, Math.ceil(draft.length / 22)));
  return (
    <textarea
      className="instance-prop__text"
      aria-label={label}
      rows={lines}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        cancelled.current = false;
      }}
      onBlur={(e) => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        if (e.currentTarget.value !== value) onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** An instance swap: its preferred components first, then every component the layer can become. */
function SwapPicker({ instanceId, row }: { instanceId: string; row: Row }) {
  const editor = useEditor();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = typeof row.value === "string" ? editor.doc.get(row.value) : undefined;
  const nameOf = (node: NodeRecord | undefined) => {
    if (!node) return "Missing component";
    const set = componentSetOf(editor.doc, node.id);
    return set
      ? getProp(set.props, "name") || "Component"
      : getProp(node.props, "name") || "Component";
  };
  const target = row.targets[0];
  const items = (): MenuItem[] => {
    const out: MenuItem[] = [];
    const seen = new Set<string>();
    const preferred = (row.preferred ?? [])
      .map((id) => {
        // A preferred set offers its first variant.
        const node = editor.doc.get(id);
        if (node && getProp(node.props, "isComponentSet")) return editor.doc.childIds(id)[0];
        return id;
      })
      .filter((id): id is string => !!id && !!editor.doc.get(id));
    if (preferred.length > 0) {
      out.push({ id: "preferred", heading: "Preferred" });
      for (const id of preferred) {
        seen.add(id);
        out.push({
          id,
          label: nameOf(editor.doc.get(id)),
          checked: id === row.value,
          onSelect: () => editor.setInstanceProperty(instanceId, row.id, id),
        });
      }
    }
    const others = target ? swapTargets(editor.doc, target).filter((t) => !seen.has(t.id)) : [];
    if (others.length > 0) {
      if (out.length > 0) out.push({ id: "all", heading: "All components" });
      for (const t of others.slice(0, 200))
        out.push({
          id: t.id,
          label: t.label,
          onSelect: () => editor.setInstanceProperty(instanceId, row.id, t.id),
        });
    }
    return out;
  };
  return (
    <>
      <button
        ref={setButton}
        type="button"
        className="inspector__select instance-prop__swap"
        aria-label={row.name}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!editor.canEdit}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="instance" size={12} />
        <span>{nameOf(current)}</span>
      </button>
      {open && button ? (
        <DropdownMenu
          anchor={button}
          label={`Swap ${row.name}`}
          align="start"
          items={items()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** What else changed in the instance, by layer, each with its own reset. */
function OverridesList({ instance, groups }: { instance: NodeRecord; groups: OverrideGroup[] }) {
  const editor = useEditor();
  if (groups.length === 0) return null;
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="overrides-block">
      <div className="overrides-block__head">
        <span className="overrides-block__title">{`Overrides · ${count}`}</span>
      </div>
      <ul className="overrides" aria-label="Overrides">
        {groups.map((group) => (
          <li key={group.id} className="overrides__group">
            <span className="overrides__layer">{group.path || layerName(instance)}</span>
            <ul className="overrides__items">
              {group.items.map((item) => (
                <li key={`${item.id}:${item.label}`} className="overrides__item">
                  <span className="overrides__dot" aria-hidden="true" />
                  <span className="overrides__label">{item.label}</span>
                  {editor.canEdit ? (
                    <IconButton
                      icon="history"
                      label={`Reset ${item.label.toLowerCase()} on ${group.path || layerName(instance)}`}
                      onClick={() => editor.resetOverrides([{ id: item.id, props: item.props }])}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
