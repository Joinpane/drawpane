import {
  allVariables,
  cssVariableName,
  exportCss,
  exportDtcg,
  listCollections,
  resolveVariable,
  type VariableType,
  variablesIn,
} from "@drawpane/editor";
import { getProp, type NodeRecord, type VariableValue } from "@drawpane/model";
import { Button, Icon, IconButton, SegmentedControl } from "@drawpane/ui";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useDocVersion, useEditor } from "../hooks";
import { evaluate } from "../property-syntax";

/**
 * The tokens workspace: collections on the left, a table of variables with a
 * column per mode in the middle, and the selected variable's details (values,
 * where it's used, and its code) on the right.
 */
export function TokensWorkspace({ onShowLayer }: { onShowLayer: (id: string) => void }) {
  const editor = useEditor();
  const version = useDocVersion();
  const collections = useMemo(() => {
    void version;
    return listCollections(editor.doc);
  }, [editor, version]);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [variableId, setVariableId] = useState<string | null>(null);
  // A token just added: its name opens for typing, like Figma's.
  const [naming, setNaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const collection = collections.find((c) => c.id === collectionId) ?? collections[0];
  const variables = collection ? variablesIn(editor.doc, collection.id) : [];
  const shown = filter.trim()
    ? variables.filter((v) =>
        getProp(v.props, "name").toLowerCase().includes(filter.trim().toLowerCase()),
      )
    : variables;
  const selected = variables.find((v) => v.id === variableId) ?? null;
  const fileInput = useRef<HTMLInputElement>(null);

  const createCollection = () => {
    const id = editor.createCollection(`Collection ${collections.length + 1}`);
    if (id) setCollectionId(id);
  };

  const importFile = async (file: File) => {
    try {
      const json = JSON.parse(await file.text()) as unknown;
      const id = editor.importTokens(
        json,
        file.name.replace(/\.(tokens\.)?json$/i, "") || "Imported tokens",
      );
      if (id) setCollectionId(id);
    } catch {
      editor.notify(
        "That file isn't valid JSON. Export design tokens as W3C (DTCG) JSON and try again.",
      );
    }
  };

  return (
    <div className="tokens">
      <aside className="tokens__collections pane" aria-label="Collections">
        <div className="pane__head">
          <span className="pane__label">Collections</span>
          {editor.canEdit ? (
            <IconButton icon="plus" label="New collection" onClick={createCollection} />
          ) : null}
        </div>
        <ul className="tokens__collection-list">
          {collections.map((c) => (
            <li key={c.id}>
              <CollectionItem
                node={c}
                active={c.id === collection?.id}
                onSelect={() => {
                  setCollectionId(c.id);
                  setVariableId(null);
                }}
              />
            </li>
          ))}
        </ul>
        <div className="tokens__io">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = "";
            }}
          />
          {editor.canEdit ? (
            <Button size="sm" icon="export" onClick={() => fileInput.current?.click()}>
              Import tokens
            </Button>
          ) : null}
          <div className="tokens__io-row">
            <span className="tokens__io-label">Export as</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => download("tokens.css", exportCss(editor.doc), "text/css")}
            >
              CSS
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                download(
                  "tokens.json",
                  `${JSON.stringify(exportDtcg(editor.doc), null, 2)}\n`,
                  "application/json",
                )
              }
            >
              DTCG JSON
            </Button>
          </div>
        </div>
      </aside>

      <main className="tokens__table pane" aria-label="Variables">
        {collection ? (
          <>
            <header className="tokens__header">
              <div className="tokens__title">
                <EditableText
                  className="tokens__title-text"
                  value={getProp(collection.props, "name") || "Collection"}
                  label="Collection name"
                  onCommit={(name) => editor.rename(collection.id, name)}
                />
                <p className="tokens__subtitle">
                  {variables.length} {variables.length === 1 ? "variable" : "variables"} · each
                  exports as a CSS variable and a DTCG token
                </p>
              </div>
              <label className="tokens__filter">
                <Icon name="search" size={12} />
                <input
                  placeholder="Filter tokens"
                  aria-label="Filter tokens"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
              {editor.canEdit ? (
                <NewVariable
                  collection={collection}
                  onCreated={(id) => {
                    setVariableId(id);
                    setNaming(id);
                  }}
                />
              ) : null}
            </header>
            <VariableTable
              collection={collection}
              variables={shown}
              selected={selected?.id ?? null}
              onSelect={setVariableId}
              naming={naming}
              onNamed={() => setNaming(null)}
            />
          </>
        ) : (
          <div className="tokens__empty">
            <p className="app-display-md">Tokens start here.</p>
            <p className="app-muted">
              A collection holds colors, sizes and text values, with one value per mode (light,
              dark, compact). Bind them to layers, and export them as CSS variables or W3C design
              tokens.
            </p>
            {editor.canEdit ? (
              <div className="tokens__empty-actions">
                <Button variant="primary" icon="plus" onClick={createCollection}>
                  New collection
                </Button>
                <Button icon="export" onClick={() => fileInput.current?.click()}>
                  Import tokens
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </main>

      <aside className="tokens__detail pane" aria-label="Variable details">
        {selected && collection ? (
          <VariableDetail
            key={selected.id}
            variable={selected}
            collection={collection}
            onShowLayer={onShowLayer}
          />
        ) : (
          <p className="tokens__hint">Select a variable to see where it's used and its code.</p>
        )}
      </aside>
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CollectionItem({
  node,
  active,
  onSelect,
}: {
  node: NodeRecord;
  active: boolean;
  onSelect: () => void;
}) {
  const editor = useEditor();
  const count = editor.doc.childIds(node.id).length;
  return (
    <div className="tokens__collection" data-active={active || undefined}>
      <button
        type="button"
        className="tokens__collection-button"
        aria-current={active || undefined}
        onClick={onSelect}
      >
        <Icon name="token" size={12} />
        <span className="tokens__collection-name">
          {getProp(node.props, "name") || "Collection"}
        </span>
        <span className="tokens__count">{count || ""}</span>
      </button>
      {editor.canEdit ? (
        <IconButton
          icon="trash"
          label={`Delete ${getProp(node.props, "name") || "collection"}`}
          className="tokens__collection-delete"
          onClick={() => {
            // Undoable, so no confirmation: say what happened and how to take it back.
            if (editor.commit([{ op: "delete", id: node.id }], "Delete collection")) {
              editor.notify(
                `Deleted ${getProp(node.props, "name") || "the collection"}. Bound layers keep their values. Undo brings it back.`,
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}

function NewVariable({
  collection,
  onCreated,
}: {
  collection: NodeRecord;
  onCreated: (id: string) => void;
}) {
  const editor = useEditor();
  const [type, setType] = useState<VariableType>("color");
  const create = () => {
    const existing = new Set(
      variablesIn(editor.doc, collection.id).map((v) => getProp(v.props, "name")),
    );
    const base = type === "color" ? "color/new" : type === "number" ? "size/new" : "text/new";
    let name = base;
    for (let i = 2; existing.has(name); i++) name = `${base}-${i}`;
    const id = editor.createVariable(
      collection.id,
      name,
      type,
      type === "color" ? "#888888" : type === "number" ? 8 : "Text",
    );
    if (id) onCreated(id);
  };
  return (
    <div className="tokens__new">
      <select
        className="inspector__select tokens__new-type"
        aria-label="Variable type"
        value={type}
        onChange={(e) => setType(e.target.value as VariableType)}
      >
        <option value="color">Color</option>
        <option value="number">Number</option>
        <option value="string">Text</option>
      </select>
      <Button size="md" icon="plus" onClick={create}>
        Token
      </Button>
    </div>
  );
}

function VariableTable({
  collection,
  variables,
  selected,
  onSelect,
  naming,
  onNamed,
}: {
  collection: NodeRecord;
  variables: NodeRecord[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** A token whose name opens for typing (it was just added). */
  naming: string | null;
  onNamed: () => void;
}) {
  const editor = useEditor();
  const modes = getProp(collection.props, "modes");
  const uses = useUseCounts();
  const [newMode, setNewMode] = useState(false);
  return (
    <div className="tokens__scroll">
      <table className="tokens__grid">
        <thead>
          <tr>
            <th scope="col">Name</th>
            {modes.map((mode) => (
              <th key={mode.id} scope="col">
                <span className="tokens__mode">
                  <EditableText
                    value={mode.name}
                    label={`Rename ${mode.name}`}
                    onCommit={(name) => editor.renameMode(collection.id, mode.id, name)}
                  />
                  {modes.length > 1 && editor.canEdit ? (
                    <IconButton
                      icon="close"
                      label={`Remove ${mode.name}`}
                      className="tokens__mode-remove"
                      onClick={() => editor.removeMode(collection.id, mode.id)}
                    />
                  ) : null}
                </span>
              </th>
            ))}
            <th scope="col" className="tokens__uses-col">
              Uses
            </th>
            {editor.canEdit ? (
              <th scope="col" className="tokens__add-col">
                {newMode ? (
                  <input
                    className="tokens__cell-input"
                    placeholder="Mode name"
                    aria-label="New mode name"
                    // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
                    autoFocus
                    onBlur={(e) => {
                      if (e.target.value.trim())
                        editor.addMode(collection.id, e.target.value.trim());
                      setNewMode(false);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setNewMode(false);
                    }}
                  />
                ) : (
                  <IconButton icon="plus" label="Add mode" onClick={() => setNewMode(true)} />
                )}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => (
            <tr
              key={variable.id}
              data-selected={variable.id === selected || undefined}
              onClick={() => onSelect(variable.id)}
            >
              <th scope="row">
                <EditableText
                  className="tokens__name"
                  value={getProp(variable.props, "name")}
                  label="Variable name"
                  onCommit={(name) => editor.rename(variable.id, name)}
                  startEditing={variable.id === naming}
                  onDone={onNamed}
                />
              </th>
              {modes.map((mode) => (
                <td key={mode.id}>
                  <ValueEditor variable={variable} modeId={mode.id} />
                </td>
              ))}
              <td className="tokens__uses">{uses.get(variable.id) ?? 0}</td>
              {editor.canEdit ? <td /> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {variables.length === 0 ? (
        <p className="tokens__hint">No variables here yet. Add one with “Token”.</p>
      ) : null}
    </div>
  );
}

/** How many layers bind each variable. */
function useUseCounts(): Map<string, number> {
  const editor = useEditor();
  const version = useDocVersion();
  return useMemo(() => {
    void version;
    const counts = new Map<string, number>();
    for (const node of editor.doc.nodes()) {
      for (const id of Object.values(node.props.bindings ?? {}))
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [editor, version]);
}

function aliasName(
  editor: ReturnType<typeof useEditor>,
  value: VariableValue | undefined,
): string | null {
  if (typeof value !== "object" || value === null) return null;
  const target = editor.doc.get(value.alias);
  return target ? getProp(target.props, "name") : null;
}

/**
 * One value cell: a color swatch and hex, a number (math allowed), or text.
 * `{name}` makes an alias to another variable of the same type.
 */
function ValueEditor({ variable, modeId }: { variable: NodeRecord; modeId: string }) {
  const editor = useEditor();
  const type = getProp(variable.props, "variableType");
  const value = getProp(variable.props, "values")[modeId];
  const alias = aliasName(editor, value);
  const display = alias
    ? `{${alias}}`
    : value === undefined
      ? ""
      : type === "color"
        ? String(value).toUpperCase()
        : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const resolved = resolveVariable(editor.doc, variable.id);

  const commit = (text: string) => {
    setDraft(null);
    const t = text.trim();
    if (t === display || t === "") return;
    const ref = /^\{(.+)\}$/.exec(t);
    if (ref?.[1]) {
      const target = allVariables(editor.doc).find(
        (v) =>
          getProp(v.props, "name") === ref[1]?.trim() && getProp(v.props, "variableType") === type,
      );
      if (!target) {
        editor.notify(`No ${type} variable is named ${ref[1]}.`);
        return;
      }
      editor.setVariableValue(variable.id, modeId, { alias: target.id });
      return;
    }
    if (type === "color") {
      let c = t.toLowerCase().replace(/^#?/, "#");
      if (/^#[0-9a-f]{3}$/.test(c)) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
      if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(c)) {
        editor.notify("Colors are hex, like #2563eb, or an alias like {brand/500}.");
        return;
      }
      editor.setVariableValue(variable.id, modeId, c);
    } else if (type === "number") {
      const n = evaluate(t);
      if (n === null) {
        editor.notify("Numbers can use math and units, like 8*2 or 1.5rem.");
        return;
      }
      editor.setVariableValue(variable.id, modeId, n);
    } else {
      editor.setVariableValue(variable.id, modeId, t);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      setDraft(null);
      e.currentTarget.blur();
    }
  };

  return (
    <span className="tokens__value" data-alias={alias ? true : undefined}>
      {type === "color" ? (
        <span
          className="tokens__swatch"
          style={{ background: typeof resolved === "string" ? resolved : "transparent" }}
        >
          {!alias && editor.canEdit ? (
            <input
              type="color"
              aria-label="Pick a color"
              value={typeof value === "string" ? value.slice(0, 7) : "#000000"}
              onChange={(e) => editor.setVariableValue(variable.id, modeId, e.target.value)}
            />
          ) : null}
        </span>
      ) : null}
      <input
        className="tokens__cell-input"
        aria-label="Value"
        value={draft ?? display}
        readOnly={!editor.canEdit}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </span>
  );
}

function VariableDetail({
  variable,
  collection,
  onShowLayer,
}: {
  variable: NodeRecord;
  collection: NodeRecord;
  onShowLayer: (id: string) => void;
}) {
  const editor = useEditor();
  const version = useDocVersion();
  const [tab, setTab] = useState<"css" | "dtcg">("css");
  const name = getProp(variable.props, "name");
  const description = getProp(variable.props, "description");
  const [draft, setDraft] = useState(description);
  useEffect(() => setDraft(description), [description]);
  const modes = getProp(collection.props, "modes");
  const usedBy = [...editor.doc.nodes()].filter((n) =>
    Object.values(n.props.bindings ?? {}).includes(variable.id),
  );

  const css = useMemo(() => {
    const lines = exportCss(editor.doc).split("\n");
    const varName = cssVariableName(name);
    const out: string[] = [];
    let selector = "";
    for (const line of lines) {
      if (line.endsWith("{")) selector = line;
      else if (line.trim().startsWith(`${varName}:`)) out.push(selector, line, "}");
    }
    return out.join("\n");
  }, [editor, name, version]);
  const dtcg = useMemo(() => {
    let node: unknown = exportDtcg(editor.doc);
    for (const part of name
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)) {
      node = (node as Record<string, unknown> | undefined)?.[part];
    }
    return JSON.stringify(node ?? {}, null, 2);
  }, [editor, name, version]);

  return (
    <div className="tokens__detail-body">
      <header className="tokens__detail-head">
        <h2 className="tokens__detail-name">{name}</h2>
        <textarea
          className="component-description"
          aria-label="Description"
          placeholder="What it's for"
          rows={2}
          value={draft}
          readOnly={!editor.canEdit}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== description) {
              editor.commit(
                [{ op: "set", id: variable.id, prop: "description", value: draft || null }],
                "Describe variable",
              );
            }
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </header>
      <section className="tokens__section">
        <h3 className="tokens__section-title">Values</h3>
        {modes.map((mode) => (
          <div key={mode.id} className="tokens__detail-row">
            <span className="mode-row__name">{mode.name}</span>
            <ValueEditor variable={variable} modeId={mode.id} />
          </div>
        ))}
      </section>
      <section className="tokens__section">
        <h3 className="tokens__section-title">
          Used by <span className="tokens__count">{usedBy.length}</span>
        </h3>
        {usedBy.length === 0 ? (
          <p className="tokens__hint tokens__hint--flush">
            Not used yet. Bind it from a property field or the command bar.
          </p>
        ) : (
          <ul className="tokens__used">
            {usedBy.slice(0, 50).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="tokens__used-item"
                  onClick={() => onShowLayer(n.id)}
                >
                  <Icon
                    name={n.type === "text" ? "text" : n.type === "frame" ? "board" : "rectangle"}
                    size={12}
                  />
                  <span>{getProp(n.props, "name") || n.type}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="tokens__section">
        <div className="tokens__code-head">
          <h3 className="tokens__section-title">Code</h3>
          <SegmentedControl
            label="Code format"
            options={[
              { value: "css", label: "CSS" },
              { value: "dtcg", label: "DTCG" },
            ]}
            value={tab}
            onChange={(v) => setTab(v as "css" | "dtcg")}
          />
        </div>
        <pre className="tokens__code">
          <code>{tab === "css" ? css : dtcg}</code>
        </pre>
      </section>
    </div>
  );
}

/** Text that turns into an input on double-click (or Enter when focused). */
function EditableText({
  value,
  label,
  onCommit,
  className,
  startEditing = false,
  onDone,
}: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  className?: string;
  /** Open for typing straight away (a token just added). */
  startEditing?: boolean;
  /** Editing ended, committed or not. */
  onDone?: () => void;
}) {
  const editor = useEditor();
  const [editing, setEditingState] = useState(startEditing && editor.canEdit);
  const setEditing = (on: boolean) => {
    setEditingState(on);
    if (!on) onDone?.();
  };
  if (editing) {
    return (
      <input
        className={`tokens__cell-input ${className ?? ""}`}
        defaultValue={value}
        aria-label={label}
        // biome-ignore lint/a11y/noAutofocus: editing starts from an explicit action
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          setEditing(false);
          if (e.target.value.trim() && e.target.value.trim() !== value)
            onCommit(e.target.value.trim());
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <button
      type="button"
      className={`tokens__editable ${className ?? ""}`}
      onDoubleClick={() => editor.canEdit && setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && editor.canEdit) {
          e.preventDefault();
          setEditing(true);
        }
      }}
      title={editor.canEdit ? "Double-click to rename" : undefined}
    >
      {value}
    </button>
  );
}
