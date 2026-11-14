/**
 * Text styles in the Text section: which style the selected text follows,
 * a picker to apply one (grouped by the "/" in their names, each shown in
 * its own type), and making, editing and deleting styles. Editing a style
 * updates every layer that follows it.
 */
import { describeTextStyle, type Editor, textStyles, textStyleUsers } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Button, Icon, IconButton, Popover } from "@drawpane/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { uiFor, useUi } from "../ui-state";
import { TypographyFields } from "./TypographyFields";

/** The style's own type, for its "Ag" sample (capped so big headings fit a row). */
function sample(style: NodeRecord): React.CSSProperties {
  return {
    fontFamily: `"${getProp(style.props, "fontFamily")}", var(--font-ui)`,
    fontWeight: getProp(style.props, "fontWeight"),
    fontStyle: getProp(style.props, "fontStyle"),
    fontSize: Math.min(20, Math.max(11, getProp(style.props, "fontSize"))),
  };
}

const nameOf = (style: NodeRecord) => getProp(style.props, "name") || "Text style";
/** "heading/xl" → ["heading", "xl"]. */
const pathOf = (style: NodeRecord) => {
  const parts = nameOf(style)
    .split("/")
    .map((p) => p.trim());
  return { group: parts.slice(0, -1).join(" / "), leaf: parts.at(-1) ?? "" };
};

export function TextStyleRow({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const request = useUi(editor, (ui) => ui.textStyles);
  // ⌥⌘T opens the picker for the selected text.
  const [seen, setSeen] = useState(request);
  if (request !== seen) {
    setSeen(request);
    setOpen(true);
  }
  const ids = new Set(nodes.map((n) => getProp(n.props, "textStyle")));
  const mixed = ids.size > 1;
  const styleId = mixed ? null : ([...ids][0] ?? null);
  const style = styleId ? editor.doc.get(styleId) : undefined;

  return (
    <div className="text-style-row">
      <button
        ref={trigger}
        type="button"
        className="text-style-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Text style: ${style ? nameOf(style) : mixed ? "Mixed" : "None"}`}
        onClick={() => setOpen((o) => !o)}
      >
        {style ? (
          <>
            <span className="text-style__ag" style={sample(style)} aria-hidden="true">
              Ag
            </span>
            <span className="text-style-trigger__name">{nameOf(style)}</span>
          </>
        ) : (
          <>
            <Icon name="text" size={16} />
            <span className="text-style-trigger__name text-style-trigger__name--none">
              {mixed ? "Mixed styles" : "No text style"}
            </span>
          </>
        )}
        <Icon name="chevron-down" size={12} />
      </button>
      {style ? (
        <IconButton
          icon="detach"
          label="Detach style"
          onClick={() =>
            editor.applyTextStyle(
              nodes.map((n) => n.id),
              null,
            )
          }
        />
      ) : null}
      {open && trigger.current ? (
        <Popover
          anchor={trigger.current}
          label="Text styles"
          className="text-styles dp-root"
          onClose={() => setOpen(false)}
        >
          <TextStylePanel
            editor={editor}
            nodes={nodes}
            current={styleId}
            onDone={() => setOpen(false)}
          />
        </Popover>
      ) : null}
    </div>
  );
}

type View = { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string };

function TextStylePanel({
  editor,
  nodes,
  current,
  onDone,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  current: string | null;
  onDone: () => void;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  if (view.kind === "create")
    return (
      <CreateStyle
        editor={editor}
        nodes={nodes}
        onBack={() => setView({ kind: "list" })}
        onDone={onDone}
      />
    );
  if (view.kind === "edit") {
    const style = editor.doc.get(view.id);
    if (style?.type === "textStyle")
      return (
        <EditStyle
          editor={editor}
          style={style}
          from={nodes[0]}
          onBack={() => setView({ kind: "list" })}
        />
      );
  }
  return (
    <StyleList
      editor={editor}
      nodes={nodes}
      current={current}
      onCreate={() => setView({ kind: "create" })}
      onEdit={(id) => setView({ kind: "edit", id })}
      onDone={onDone}
    />
  );
}

function StyleList({
  editor,
  nodes,
  current,
  onCreate,
  onEdit,
  onDone,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  current: string | null;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const all = textStyles(editor.doc);
  const q = query.trim().toLowerCase();
  const found = q ? all.filter((s) => nameOf(s).toLowerCase().includes(q)) : all;
  const groups = useMemo(() => {
    const map = new Map<string, NodeRecord[]>();
    for (const style of found) {
      const { group } = pathOf(style);
      map.set(group, [...(map.get(group) ?? []), style]);
    }
    return [...map];
  }, [found]);
  const uses = (id: string) => textStyleUsers(editor.doc, id).length;
  const apply = (id: string) => {
    editor.applyTextStyle(
      nodes.map((n) => n.id),
      id,
    );
    onDone();
  };

  return (
    <div className="text-styles__body">
      <div className="text-styles__search">
        <Icon name="search" size={12} />
        <input
          // biome-ignore lint/a11y/noAutofocus: the picker opens to type into
          autoFocus
          type="search"
          aria-label="Search text styles"
          aria-controls={listId}
          placeholder="Search text styles"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // preventDefault: closing moves focus to the trigger, and the rest of
            // this Enter would otherwise "click" it open again.
            if (e.key === "Enter" && found[0]) {
              e.preventDefault();
              apply(found[0].id);
            }
          }}
        />
      </div>
      {all.length === 0 ? (
        <div className="text-styles__empty">
          <p>
            <strong>No text styles yet.</strong> Make one from this text, and every layer using it
            changes when you edit the style.
          </p>
        </div>
      ) : found.length === 0 ? (
        <p className="text-styles__empty">No styles match “{query}”.</p>
      ) : (
        <div id={listId} className="text-styles__list" role="listbox" aria-label="Text styles">
          {groups.map(([group, styles]) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of options in a listbox
            <div key={group || "_"} role="group" aria-label={group || "Styles"}>
              {group ? <div className="text-styles__group">{group}</div> : null}
              {styles.map((style) => {
                const n = uses(style.id);
                return (
                  <div
                    key={style.id}
                    role="option"
                    tabIndex={0}
                    aria-selected={style.id === current}
                    className="text-styles__row"
                    onClick={() => apply(style.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        apply(style.id);
                      }
                    }}
                  >
                    <span className="text-style__ag" style={sample(style)} aria-hidden="true">
                      Ag
                    </span>
                    <span className="text-styles__name">
                      <strong>{pathOf(style).leaf}</strong>
                      <span>{describeTextStyle(style)}</span>
                    </span>
                    <span className="text-styles__uses">{n === 1 ? "1 use" : `${n} uses`}</span>
                    {style.id === current ? (
                      <Icon name="check" size={16} className="text-styles__check" />
                    ) : null}
                    <IconButton
                      icon="rename"
                      size="sm"
                      label={`Edit ${nameOf(style)}`}
                      className="text-styles__edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(style.id);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <footer className="text-styles__foot">
        <Button size="sm" icon="plus" onClick={onCreate}>
          Create style
        </Button>
        <span>Styles are shared: edit once, update everywhere.</span>
      </footer>
    </div>
  );
}

/** A suggested name from the text's size: "Text 16", "Text 32"… */
function suggestedName(nodes: NodeRecord[]): string {
  const size = nodes[0] ? getProp(nodes[0].props, "fontSize") : 16;
  return `Text ${Math.round(size)}`;
}

function CreateStyle({
  editor,
  nodes,
  onBack,
  onDone,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  onBack: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(() => suggestedName(nodes));
  const create = () => {
    if (!name.trim()) return;
    editor.createTextStyle(name, nodes[0]?.id);
    onDone();
  };
  return (
    <div className="text-styles__body">
      <header className="text-styles__head">
        <IconButton icon="arrow-left" size="sm" label="Back to styles" onClick={onBack} />
        <strong>New text style</strong>
      </header>
      <div className="text-styles__form">
        <label className="text-styles__label" htmlFor="text-style-name">
          Name
        </label>
        <input
          id="text-style-name"
          className="text-styles__input"
          // biome-ignore lint/a11y/noAutofocus: naming is the next thing to do
          autoFocus
          value={name}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
            if (e.key === "Escape") onBack();
          }}
        />
        <p className="text-styles__hint">
          Use “/” to group styles, like <code>heading/xl</code>. It takes this text's typography,
          and the selected text follows it.
        </p>
      </div>
      <footer className="text-styles__foot text-styles__foot--end">
        <Button size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!name.trim()} onClick={create}>
          Create style
        </Button>
      </footer>
    </div>
  );
}

function EditStyle({
  editor,
  style,
  from,
  onBack,
}: {
  editor: Editor;
  style: NodeRecord;
  from: NodeRecord | undefined;
  onBack: () => void;
}) {
  const [name, setName] = useState(nameOf(style));
  useEffect(() => setName(nameOf(style)), [style]);
  const users = textStyleUsers(editor.doc, style.id).length;
  const rename = () => {
    if (name.trim() && name.trim() !== nameOf(style)) editor.rename(style.id, name);
  };
  return (
    <div className="text-styles__body">
      <header className="text-styles__head">
        <IconButton icon="arrow-left" size="sm" label="Back to styles" onClick={onBack} />
        <strong>Edit text style</strong>
        <span className="text-styles__uses">{users === 1 ? "1 use" : `${users} uses`}</span>
      </header>
      <div className="text-styles__form">
        <label className="text-styles__label" htmlFor="text-style-rename">
          Name
        </label>
        <input
          id="text-style-rename"
          className="text-styles__input"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              rename();
            }
          }}
        />
        <div className="text-styles__fields">
          <TypographyFields editor={editor} nodes={[style]} />
        </div>
        {from && getProp(from.props, "textStyle") !== style.id ? (
          <button
            type="button"
            className="text-styles__link"
            onClick={() => editor.updateTextStyle(style.id, from.id)}
          >
            Update from the selected text
          </button>
        ) : null}
      </div>
      <footer className="text-styles__foot">
        <Button
          size="sm"
          variant="danger"
          icon="trash"
          onClick={() => {
            editor.deleteTextStyle(style.id);
            editor.notify(
              `Deleted ${nameOf(style)}. ${users === 1 ? "Its layer keeps" : "Its layers keep"} the look.`,
            );
            onBack();
          }}
        >
          Delete style
        </Button>
      </footer>
    </div>
  );
}

/** Opens the text styles picker for the selected text (⌥⌘T). */
export function openTextStyles(editor: Editor): void {
  const ui = uiFor(editor);
  ui.set({ textStyles: ui.get().textStyles + 1 });
}
