/** Shared pieces of the inspector: reading a value across the selection, and numeric fields. */
import type { Editor } from "@drawpane/editor";
import { BINDING_TARGETS } from "@drawpane/editor";
import {
  type BindingKey,
  getProp,
  type NodeRecord,
  type PropName,
  type PropValues,
} from "@drawpane/model";
import { type IconName, NumberField } from "@drawpane/ui";
import { useState } from "react";
import { Bindable } from "../tokens/Bindable";

/**
 * Open state for a trigger and its popover that also tells the host when it
 * opens and closes (the Selection Lens stays put while one of its popovers is
 * open).
 */
export function useDisclosure(
  onOpenChange?: (open: boolean) => void,
): [open: boolean, setOpen: (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  return [
    open,
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
  ];
}

/** The value every node shares, or null when they differ (shown as "Mixed"). */
export function common<K extends PropName>(
  nodes: readonly NodeRecord[],
  prop: K,
): PropValues[K] | null {
  const first = nodes[0];
  if (!first) return null;
  const value = getProp(first.props, prop);
  const json = JSON.stringify(value);
  return nodes.every((n) => JSON.stringify(getProp(n.props, prop)) === json) ? value : null;
}

/** Number properties a variable can drive (their binding key is the property name). */
const NUMBER_BINDINGS: ReadonlySet<string> = new Set(
  (Object.entries(BINDING_TARGETS) as Array<[BindingKey, { prop: string; type: string }]>)
    .filter(([key, t]) => t.type === "number" && t.prop === key)
    .map(([key]) => key),
);

export interface NumProps {
  editor: Editor;
  nodes: readonly NodeRecord[];
  prop: PropName;
  label?: string;
  icon?: IconName;
  ariaLabel: string;
  min?: number;
  max?: number;
  unit?: string;
  /** Shown value = stored × scale (opacity shows as percent). */
  scale?: number;
  /** Writes the value instead of setting `prop` on every node (sizes keep aspect locks). */
  commit?: (value: number) => void;
}

/** Wires a NumberField to the editor: commits on change, groups scrubs into one undo step. */
export function Num({
  editor,
  nodes,
  prop,
  label,
  icon,
  ariaLabel,
  min,
  max,
  unit,
  scale = 1,
  commit,
}: NumProps) {
  const value = common(nodes, prop) as number | null;
  const bindKey = NUMBER_BINDINGS.has(prop) ? (prop as BindingKey) : undefined;
  const field = (token?: { name: string; open: () => void }) => (
    <NumberField
      {...(token ? { token: token.name, onTokenClick: token.open } : {})}
      {...(label ? { label } : {})}
      {...(icon ? { icon } : {})}
      ariaLabel={ariaLabel}
      {...(unit ? { unit } : {})}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      value={value === null ? null : Math.round(value * scale * 100) / 100}
      placeholder="Mixed"
      onChange={(v) => {
        const stored = Math.round((v / scale) * 10000) / 10000;
        if (commit) commit(stored);
        else
          editor.setProp(
            nodes.map((n) => n.id),
            prop,
            stored,
            ariaLabel,
          );
      }}
      onScrubStart={() => editor.beginGesture(ariaLabel)}
      onScrubEnd={() => editor.endGesture()}
    />
  );
  if (!bindKey) return field();
  return (
    <Bindable nodes={nodes} bindKey={bindKey}>
      {({ bound, open }) => field(bound ? { name: getProp(bound.props, "name"), open } : undefined)}
    </Bindable>
  );
}

/** A compact native select styled like the inspector's fields. */
export function Select<V extends string | number>({
  label,
  value,
  options,
  onChange,
  mixed = false,
  className,
}: {
  label: string;
  value: V | null;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  mixed?: boolean;
  className?: string;
}) {
  return (
    <select
      className={className ? `inspector__select ${className}` : "inspector__select"}
      aria-label={label}
      value={value === null ? "" : String(value)}
      onChange={(e) => {
        const option = options.find((o) => String(o.value) === e.target.value);
        if (option) onChange(option.value);
      }}
    >
      {value === null || mixed ? <option value="">Mixed</option> : null}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
