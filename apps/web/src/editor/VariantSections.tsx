import { componentSetOf, variantProperties } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { IconButton, PropertySection, SegmentedControl } from "@drawpane/ui";
import { useState } from "react";
import { useEditor } from "./hooks";

/** A component set: its properties, renamable, and buttons to add properties and variants. */
export function ComponentSetSection({ set }: { set: NodeRecord }) {
  const editor = useEditor();
  const properties = variantProperties(editor.doc, set.id);
  const variants = editor.doc.childIds(set.id);
  return (
    <PropertySection
      title="Properties"
      actions={
        <IconButton
          icon="plus"
          label="Add property"
          onClick={() => editor.addVariantProperty(set.id)}
        />
      }
    >
      {properties.map((property) => (
        <div key={property.name} className="variant-prop">
          <span className="variant-prop__kind">Variant</span>
          <InlineEdit
            value={property.name}
            label={`Rename ${property.name}`}
            onCommit={(name) => editor.renameVariantProperty(set.id, property.name, name)}
            className="variant-prop__name"
          />
          <span className="variant-prop__values">{property.values.join(" · ")}</span>
        </div>
      ))}
      <p className="component-hint">
        {variants.length} {variants.length === 1 ? "variant" : "variants"}. Select one to change its
        values or add another like it.
      </p>
    </PropertySection>
  );
}

/** One variant: its value for each property, and adding a sibling variant. */
export function VariantSection({ variant }: { variant: NodeRecord }) {
  const editor = useEditor();
  const set = componentSetOf(editor.doc, variant.id);
  if (!set) return null;
  const values = getProp(variant.props, "variantProps");
  return (
    <PropertySection
      title={`Variant of ${getProp(set.props, "name") || "set"}`}
      actions={
        <IconButton icon="plus" label="Add variant" onClick={() => editor.addVariant(variant.id)} />
      }
    >
      {Object.entries(values).map(([name, value]) => (
        <div key={name} className="mode-row">
          <span className="mode-row__name">{name}</span>
          <InlineInput
            value={value}
            label={name}
            onCommit={(v) => editor.setVariantProp(variant.id, name, v)}
          />
        </div>
      ))}
    </PropertySection>
  );
}

/** An instance of a variant: switch any property, and the instance swaps to the matching variant. */
export function InstanceVariantControls({
  instance,
  main,
}: {
  instance: NodeRecord;
  main: NodeRecord;
}) {
  const editor = useEditor();
  const set = componentSetOf(editor.doc, main.id);
  if (!set) return null;
  const current = getProp(main.props, "variantProps");
  return (
    <div className="variant-controls">
      {variantProperties(editor.doc, set.id).map((property) => (
        <div key={property.name} className="mode-row">
          <span className="mode-row__name">{property.name}</span>
          {property.values.length <= 3 ? (
            <SegmentedControl
              label={property.name}
              options={property.values.map((v) => ({ value: v, label: v }))}
              value={current[property.name] ?? ""}
              onChange={(v) => editor.setInstanceVariant(instance.id, property.name, v)}
            />
          ) : (
            <select
              className="inspector__select"
              aria-label={property.name}
              value={current[property.name] ?? ""}
              onChange={(e) =>
                editor.setInstanceVariant(instance.id, property.name, e.target.value)
              }
            >
              {property.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
    </div>
  );
}

/** Every override in an instance, by layer, each with its own reset. */
export function OverridesList({ instance }: { instance: NodeRecord }) {
  const editor = useEditor();
  const items: Array<{ node: NodeRecord; prop: string }> = [];
  const stack = [instance.id];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const node = editor.doc.get(id);
    if (!node) continue;
    for (const prop of getProp(node.props, "overrides")) items.push({ node, prop });
    if (id !== instance.id && getProp(node.props, "instanceOf") !== null) continue;
    stack.push(...[...editor.doc.childIds(id)].reverse());
  }
  if (items.length === 0) return null;
  return (
    <ul className="overrides" aria-label="Overrides">
      {items.map(({ node, prop }) => (
        <li key={`${node.id}:${prop}`} className="overrides__item">
          <span className="overrides__dot" aria-hidden="true" />
          <span className="overrides__label">
            {node.id === instance.id ? "Instance" : getProp(node.props, "name") || node.type}
            <span className="overrides__prop"> · {PROP_LABEL[prop] ?? prop}</span>
          </span>
          <IconButton
            icon="history"
            label={`Reset ${PROP_LABEL[prop] ?? prop}`}
            onClick={() => editor.resetOverride(node.id, prop)}
          />
        </li>
      ))}
    </ul>
  );
}

const PROP_LABEL: Record<string, string> = {
  characters: "text",
  fills: "fill",
  strokes: "stroke",
  visible: "visibility",
  fontWeight: "weight",
  fontSize: "size",
  cornerRadius: "radius",
  opacity: "opacity",
  width: "width",
  height: "height",
  x: "position",
  y: "position",
};

function InlineEdit({
  value,
  label,
  onCommit,
  className,
}: {
  value: string;
  label: string;
  onCommit: (v: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <InlineInput
        value={value}
        label={label}
        onCommit={(v) => {
          setEditing(false);
          onCommit(v);
        }}
        autoFocus
      />
    );
  return (
    <button
      type="button"
      className={`inline-edit ${className ?? ""}`}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to rename"
    >
      {value}
    </button>
  );
}

function InlineInput({
  value,
  label,
  onCommit,
  autoFocus = false,
}: {
  value: string;
  label: string;
  onCommit: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="inline-input"
      aria-label={label}
      value={draft ?? value}
      // biome-ignore lint/a11y/noAutofocus: only when renaming starts from an explicit double-click
      autoFocus={autoFocus}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        setDraft(null);
        if (e.target.value.trim() && e.target.value.trim() !== value)
          onCommit(e.target.value.trim());
        else if (autoFocus) onCommit(value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
