import type { ComponentPropsWithRef, CSSProperties, KeyboardEvent, MouseEvent } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { useControllableState } from "../lib/use-controllable-state";
import { type PresenceSlot, presenceColor } from "../tokens";
import { Icon } from "./Icon";

export type LayerKind =
  | "frame"
  | "board"
  | "group"
  | "rect"
  | "ellipse"
  | "polygon"
  | "star"
  | "line"
  | "arrow"
  | "text"
  | "path"
  | "image"
  | "component"
  | "instance"
  /** Frames with auto layout: the direction or grid shows in the glyph. */
  | "frame-row"
  | "frame-column"
  | "frame-grid";

const KIND_ICONS: Record<LayerKind, IconName> = {
  frame: "board",
  board: "board",
  group: "group",
  rect: "rectangle",
  ellipse: "ellipse",
  polygon: "polygon",
  star: "star",
  line: "minus",
  arrow: "arrow",
  text: "text",
  path: "pen",
  image: "image",
  component: "component",
  instance: "instance",
  "frame-row": "layout-row",
  "frame-column": "layout-col",
  "frame-grid": "layout-grid",
};

export interface LayerRowProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  name: string;
  /** Sets the glyph. Default "rect". */
  kind?: LayerKind;
  /** Nesting level from 0; each level indents 12px. */
  depth?: number;
  selected?: boolean;
  hidden?: boolean;
  /** Inside a hidden layer: shown dimmed, with its own eye left alone. */
  hiddenByParent?: boolean;
  locked?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  /** A collaborator has this layer selected. */
  presence?: PresenceSlot;
  /** Who has it selected, for the presence dot's accessible name. */
  presenceLabel?: string;
  /**
   * Makes the caret clickable. Arrow keys are the tree's job. `deep` is true
   * for an Alt-click, which opens or closes everything inside too.
   */
  onToggleExpanded?: (deep: boolean) => void;
  /** Makes the eye a button. */
  onToggleHidden?: () => void;
  /** Makes the lock a button: it unlocks while locked, and offers to lock on hover. */
  onToggleLocked?: () => void;
  /** Marks where the name matches a search, case-insensitively. */
  highlight?: string;
  /** Shown only for context, like the ancestors of search results: muted. */
  context?: boolean;
  /** Enables renaming in place: double-click the row or press F2, then Enter or Escape. */
  onRename?: (name: string) => void;
  /** A short muted tag after the name, such as "mask" or "clipped". */
  note?: string;
  /** Controls renaming from outside (a menu's Rename, ⌘R). Leave unset to let the row own it. */
  renaming?: boolean;
  /** Renaming started or ended, from inside the row. */
  onRenamingChange?: (renaming: boolean) => void;
}

/** The name with the first match of `query` wrapped in a mark. */
function highlighted(name: string, query: string | undefined) {
  const q = query?.trim();
  if (!q) return name;
  const at = name.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark className="dp-layer__match">{name.slice(at, at + q.length)}</mark>
      {name.slice(at + q.length)}
    </>
  );
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

/**
 * One row in the Layers tree (role treeitem). The tree owns selection and keyboard navigation;
 * pass `tabIndex={0}` to the row that holds the tree's roving focus.
 */
export function LayerRow({
  name,
  kind = "rect",
  depth = 0,
  selected = false,
  hidden = false,
  hiddenByParent = false,
  locked = false,
  hasChildren = false,
  expanded = false,
  presence,
  presenceLabel = "Selected by a collaborator",
  onToggleExpanded,
  onToggleHidden,
  onToggleLocked,
  onRename,
  note,
  highlight,
  context = false,
  renaming: renamingProp,
  onRenamingChange,
  className,
  style,
  onKeyDown,
  onDoubleClick,
  ...rest
}: LayerRowProps) {
  const [renaming, setRenaming] = useControllableState(renamingProp, false, onRenamingChange);
  const component = kind === "component" || kind === "instance";
  const rowStyle: CSSProperties & Record<"--dp-depth", number> = { ...style, "--dp-depth": depth };

  const finishRename = (input: HTMLInputElement, commit: boolean) => {
    setRenaming(false);
    const next = input.value.trim();
    if (commit && next && next !== name) onRename?.(next);
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (!event.defaultPrevented && event.key === "F2" && onRename && !renaming) {
      event.preventDefault();
      setRenaming(true);
    }
  };

  const caret = hasChildren && (
    <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
  );
  const eye = (
    <Icon
      name={hidden ? "eye-off" : "eye"}
      size={12}
      label={onToggleHidden ? undefined : hidden ? "Hidden" : "Visible"}
    />
  );
  const lock = <Icon name="lock" size={12} label={onToggleLocked ? undefined : "Locked"} />;

  return (
    <div
      tabIndex={-1}
      {...rest}
      role="treeitem"
      aria-selected={selected}
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      className={cx(
        "dp-layer",
        selected && "is-selected",
        (hidden || hiddenByParent) && "is-hidden",
        component && "is-component",
        context && "is-context",
        className,
      )}
      style={rowStyle}
      onKeyDown={handleRowKeyDown}
      onDoubleClick={(event) => {
        onDoubleClick?.(event);
        if (!event.defaultPrevented && onRename) setRenaming(true);
      }}
    >
      {hasChildren && onToggleExpanded ? (
        <button
          type="button"
          className="dp-layer__caret dp-layer__toggle"
          tabIndex={-1}
          aria-hidden="true"
          onDoubleClick={stop}
          onClick={(event) => {
            stop(event);
            onToggleExpanded(event.altKey);
          }}
        >
          {caret}
        </button>
      ) : (
        <span className="dp-layer__caret">{caret}</span>
      )}
      <span className="dp-layer__icon">
        <Icon name={KIND_ICONS[kind]} />
      </span>
      {renaming ? (
        <input
          className="dp-layer__rename"
          aria-label="Layer name"
          defaultValue={name}
          // biome-ignore lint/a11y/noAutofocus: renaming starts from an explicit user action
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={stop}
          onDoubleClick={stop}
          onBlur={(event) => finishRename(event.currentTarget, true)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") finishRename(event.currentTarget, true);
            if (event.key === "Escape") finishRename(event.currentTarget, false);
          }}
        />
      ) : (
        <span className="dp-layer__name" title={name}>
          {highlighted(name, highlight)}
        </span>
      )}
      {note && !renaming ? <span className="dp-layer__note">{note}</span> : null}
      {presence !== undefined && (
        <span
          className="dp-layer__presence"
          role="img"
          aria-label={presenceLabel}
          title={presenceLabel}
          style={{ background: presenceColor(presence) }}
        />
      )}
      <span className={cx("dp-layer__actions", (hidden || locked) && "is-pinned")}>
        {onToggleLocked ? (
          <button
            type="button"
            className={cx("dp-layer__toggle", !locked && "is-offer")}
            tabIndex={-1}
            aria-label={locked ? "Unlock layer" : "Lock layer"}
            onDoubleClick={stop}
            onClick={(event) => {
              stop(event);
              onToggleLocked();
            }}
          >
            {locked ? lock : <Icon name="unlock" size={12} />}
          </button>
        ) : (
          locked && lock
        )}
        {onToggleHidden ? (
          <button
            type="button"
            className="dp-layer__toggle"
            tabIndex={-1}
            aria-label={hidden ? "Show layer" : "Hide layer"}
            onDoubleClick={stop}
            onClick={(event) => {
              stop(event);
              onToggleHidden();
            }}
          >
            {eye}
          </button>
        ) : (
          eye
        )}
      </span>
    </div>
  );
}
