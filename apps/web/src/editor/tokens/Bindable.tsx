import { BINDING_TARGETS } from "@drawpane/editor";
import { type BindingKey, getProp, type NodeRecord } from "@drawpane/model";
import { Icon } from "@drawpane/ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useEditor } from "../hooks";
import { TokenPicker } from "./TokenPicker";

/** The variable every node binds `key` to, or undefined when none or they differ. */
export function commonBinding(nodes: readonly NodeRecord[], key: BindingKey): string | undefined {
  const first = nodes[0] ? getProp(nodes[0].props, "bindings")[key] : undefined;
  if (!first) return undefined;
  return nodes.every((n) => getProp(n.props, "bindings")[key] === first) ? first : undefined;
}

/**
 * Wraps a property field with variable binding: a token button on hover opens
 * the picker, and a bound field shows its variable as a chip (the child
 * decides how, using `bound` and `open`).
 */
export function Bindable({
  nodes,
  bindKey,
  children,
}: {
  nodes: readonly NodeRecord[];
  bindKey: BindingKey;
  children: (state: { bound: NodeRecord | undefined; open: () => void }) => ReactNode;
}) {
  const editor = useEditor();
  const wrapper = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const boundId = commonBinding(nodes, bindKey);
  const bound = boundId ? editor.doc.get(boundId) : undefined;
  const ids = nodes.map((n) => n.id);
  const open = useCallback(() => setAnchor(wrapper.current), []);
  const close = useCallback(() => setAnchor(null), []);

  return (
    <span ref={wrapper} className="bindable" data-bound={bound ? true : undefined}>
      {children({ bound, open })}
      {editor.canEdit && !bound ? (
        <button
          type="button"
          className="bindable__trigger"
          aria-label="Use a variable"
          title="Use a variable"
          // Out of the Tab order, which runs field to field, like Figma's.
          tabIndex={-1}
          onClick={open}
        >
          <Icon name="token" size={12} />
        </button>
      ) : null}
      {anchor ? (
        <TokenPicker
          anchor={anchor}
          type={BINDING_TARGETS[bindKey].type}
          current={boundId}
          contextId={nodes[0]?.id}
          onPick={(variableId) => editor.bindVariable(ids, bindKey, variableId)}
          onDetach={bound ? () => editor.unbindVariable(ids, bindKey) : undefined}
          onClose={close}
        />
      ) : null}
    </span>
  );
}
