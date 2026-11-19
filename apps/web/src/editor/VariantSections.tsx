import { componentSetOf, isComponentSet, variantProperties } from "@drawpane/editor";
import { type ComponentPropDef, getProp, type NodeRecord } from "@drawpane/model";
import { IconButton, PropertySection } from "@drawpane/ui";
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
      <ComponentPropertiesList owner={set} />
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

const TYPE_LABEL: Record<string, string> = {
  boolean: "Boolean",
  text: "Text",
  instance: "Swap",
  slot: "Slot",
};

/**
 * A main's or set's boolean, text and swap properties (decision 0035), each
 * renamable: layers name a property by its id, so they keep it.
 */
export function ComponentPropertiesList({ owner }: { owner: NodeRecord }) {
  const editor = useEditor();
  const defs = getProp(owner.props, "componentProps").filter((d) => d.type !== "variant");
  if (defs.length === 0) return null;
  const body = defs.map((def) => (
    <div key={def.id} className="variant-prop">
      <span className="variant-prop__kind">{TYPE_LABEL[def.type] ?? def.type}</span>
      <InlineEdit
        value={def.name}
        label={`Rename ${def.name}`}
        onCommit={(name) => editor.renameComponentProperty(owner.id, def.id, name)}
        className="variant-prop__name"
      />
      <span className="variant-prop__values">{defaultLabel(editor.doc, def)}</span>
    </div>
  ));
  if (isComponentSet(owner)) return body;
  return <PropertySection title="Properties">{body}</PropertySection>;
}

function defaultLabel(doc: ReturnType<typeof useEditor>["doc"], def: ComponentPropDef): string {
  if (def.type === "boolean") return def.default === false ? "Off" : "On";
  if (def.type === "instance") {
    const node = typeof def.default === "string" ? doc.get(def.default) : undefined;
    return node ? getProp(node.props, "name") : "";
  }
  return typeof def.default === "string" ? def.default : "";
}

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
