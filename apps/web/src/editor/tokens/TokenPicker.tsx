import { listCollections, resolveVariable, type VariableType, variablesIn } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Icon } from "@drawpane/ui";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useEditor } from "../hooks";

export interface TokenPickerProps {
  /** The element the picker opens beside. */
  readonly anchor: HTMLElement;
  readonly type: VariableType;
  /** The variable currently bound, if any. */
  readonly current?: string | undefined;
  /** A node to preview values in (its mode context). */
  readonly contextId?: string | undefined;
  readonly onPick: (variableId: string) => void;
  readonly onDetach?: (() => void) | undefined;
  readonly onClose: () => void;
}

/**
 * Chooses a variable for a property: search, keyboard navigation, live values
 * in the layer's own mode, and detach. Opens beside its anchor in a portal so
 * pane overflow never clips it.
 */
export function TokenPicker({
  anchor,
  type,
  current,
  contextId,
  onPick,
  onDetach,
  onClose,
}: TokenPickerProps) {
  const editor = useEditor();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listCollections(editor.doc)
      .map((collection) => ({
        collection,
        variables: variablesIn(editor.doc, collection.id).filter(
          (v) =>
            getProp(v.props, "variableType") === type &&
            (!q || getProp(v.props, "name").toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.variables.length > 0);
  }, [editor, type, query]);
  const flat = groups.flatMap((g) => g.variables);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = 260;
    const height = Math.min(360, ref.current?.offsetHeight ?? 360);
    // Prefer the left of the anchor (the inspector sits on the right edge).
    let left = rect.left - width - 8;
    if (left < 8) left = Math.min(window.innerWidth - width - 8, rect.right + 8);
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.top - 8));
    setPosition({ left, top });
  }, [anchor]);

  useEffect(() => {
    input.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [anchor, onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      anchor.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const variable = flat[active];
      if (variable) {
        onPick(variable.id);
        onClose();
      }
    }
  };

  const preview = (variable: NodeRecord) => resolveVariable(editor.doc, variable.id, contextId);

  return createPortal(
    <div
      ref={ref}
      className="token-picker dp-root"
      role="dialog"
      aria-label={`Choose a ${type} variable`}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
    >
      <label className="token-picker__search">
        <Icon name="search" size={12} />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat[active] ? `${listId}-${flat[active].id}` : undefined}
          placeholder={`Search ${type} variables`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      </label>
      <div className="token-picker__list" id={listId} role="listbox" aria-label="Variables">
        {flat.length === 0 ? (
          <p className="token-picker__empty">
            {query
              ? `No ${type} variables match “${query}”.`
              : `No ${type} variables yet. Create them in Tokens.`}
          </p>
        ) : (
          groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: the ARIA listbox pattern groups options with role="group"
            <div
              key={group.collection.id}
              role="group"
              aria-label={getProp(group.collection.props, "name")}
            >
              <div className="token-picker__group">
                {getProp(group.collection.props, "name") || "Collection"}
              </div>
              {group.variables.map((variable) => {
                const index = flat.indexOf(variable);
                const value = preview(variable);
                return (
                  <div
                    key={variable.id}
                    id={`${listId}-${variable.id}`}
                    role="option"
                    aria-selected={index === active}
                    tabIndex={-1}
                    className="token-picker__option"
                    data-current={variable.id === current || undefined}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      onPick(variable.id);
                      onClose();
                    }}
                    onKeyDown={() => undefined}
                  >
                    {type === "color" ? (
                      <span
                        className="token-picker__swatch"
                        style={{ background: typeof value === "string" ? value : "transparent" }}
                      />
                    ) : null}
                    <span className="token-picker__name">{getProp(variable.props, "name")}</span>
                    {type !== "color" && value !== undefined ? (
                      <span className="token-picker__value">{String(value)}</span>
                    ) : null}
                    {variable.id === current ? <Icon name="check" size={12} /> : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {onDetach ? (
        <button
          type="button"
          className="token-picker__detach"
          onClick={() => {
            onDetach();
            onClose();
          }}
        >
          Detach variable
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
