import { listComponents } from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { CommandBar, type CommandGroup, type CommandItem, type IconName } from "@drawpane/ui";
import { useMemo, useState } from "react";
import { ACTIONS, type ActionContext, formatShortcut } from "./actions";
import { useEditor } from "./hooks";
import { parsePropertyCommand } from "./property-syntax";

/**
 * ⌘K: one bar that runs actions, jumps to layers, and sets properties with a
 * short syntax (`w 320`, `gap 16`, `fill #ff5a1f`), previewing the change as
 * a from → to diff before anything runs.
 */
export function CommandPalette({ ctx, onClose }: { ctx: ActionContext; onClose: () => void }) {
  const editor = useEditor();
  const [query, setQuery] = useState("");
  const selection = editor.s.selection;

  const groups = useMemo<CommandGroup[]>(() => {
    const q = query.trim().toLowerCase();
    const out: CommandGroup[] = [];

    const property = parsePropertyCommand(query);
    if (property && selection.length > 0 && editor.canEdit) {
      const first = editor.doc.get(selection[0] as string);
      const current = first && property.sets[0] ? first.props[property.sets[0].prop] : undefined;
      const from =
        current === undefined && first && property.sets[0]
          ? JSON.stringify(getProp(first.props, property.sets[0].prop))
          : JSON.stringify(current ?? "");
      out.push({
        id: "set",
        title: `Set on ${selection.length === 1 ? "selection" : `${selection.length} layers`}`,
        items: [
          {
            id: "set",
            label: property.label,
            from: prettify(from),
            to: property.display,
            icon: "bolt",
          },
        ],
      });
    }

    const actions = ACTIONS.filter((a) => (a.enabled ? a.enabled(editor) : true)).filter(
      (a) =>
        !q ||
        a.label.toLowerCase().includes(q) ||
        a.keywords?.includes(q) ||
        a.group.toLowerCase().startsWith(q),
    );
    if (actions.length > 0) {
      out.push({
        id: "actions",
        title: "Actions",
        items: actions.slice(0, q ? 12 : 8).map((a) => ({
          id: a.id,
          label: a.label,
          ...(a.icon ? { icon: a.icon as IconName } : {}),
          ...(a.shortcut ? { shortcut: formatShortcut(a.shortcut) } : {}),
          hint: a.group,
        })),
      });
    }

    if (q && !property && editor.canEdit) {
      const components = listComponents(editor.doc)
        .filter((c) => getProp(c.props, "name").toLowerCase().includes(q))
        .slice(0, 6)
        .map(
          (c): CommandItem => ({
            id: `insert:${c.id}`,
            label: `Insert ${getProp(c.props, "name") || "component"}`,
            icon: "component",
            kind: "component",
            hint: getProp(c.props, "componentDescription") || "Component",
          }),
        );
      if (components.length > 0)
        out.push({ id: "components", title: "Components", items: components });
    }

    if (q && !property) {
      const layers: CommandItem[] = [];
      const pageId = editor.s.pageId;
      for (const node of editor.doc.nodes()) {
        if (node.type === "page") continue;
        const name = getProp(node.props, "name");
        if (!name.toLowerCase().includes(q)) continue;
        const page = editor.doc.pageOf(node.id);
        layers.push({
          id: `layer:${node.id}`,
          label: name,
          icon: (node.type === "frame"
            ? "board"
            : node.type === "group"
              ? "group"
              : node.type === "text"
                ? "text"
                : node.type === "ellipse"
                  ? "ellipse"
                  : "rectangle") as IconName,
          hint: page && page.id !== pageId ? getProp(page.props, "name") : node.type,
        });
        if (layers.length >= 8) break;
      }
      if (layers.length > 0) out.push({ id: "layers", title: "Layers", items: layers });
    }
    return out;
  }, [query, editor, selection]);

  const run = (item: CommandItem) => {
    onClose();
    if (item.id === "set") {
      const property = parsePropertyCommand(query);
      if (!property) return;
      editor.beginGesture(property.label);
      for (const { prop, value } of property.sets)
        editor.setProp(editor.s.selection, prop, value, property.label);
      editor.endGesture();
      return;
    }
    if (item.id?.startsWith("insert:")) {
      editor.insertInstance(item.id.slice(7));
      return;
    }
    if (item.id?.startsWith("layer:")) {
      const id = item.id.slice(6);
      const page = editor.doc.pageOf(id);
      if (page && page.id !== editor.s.pageId) editor.setPage(page.id);
      editor.select([id]);
      editor.revealSelection();
      return;
    }
    ACTIONS.find((a) => a.id === item.id)?.run(ctx);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking outside closes the bar; keyboard users press Escape inside it
    <div
      className="command-overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <CommandBar
        className="command-overlay__bar"
        groups={groups}
        query={query}
        onQueryChange={setQuery}
        placeholder={
          selection.length > 0
            ? "Search, or set a value: w 320, gap 16, fill #ff5a1f"
            : "Search actions and layers"
        }
        onRun={run}
        onClose={onClose}
        autoFocus
        label="Command bar"
        emptyLabel="No matching actions. Try a property like w 320."
        {...(selection.length > 0
          ? {
              scope:
                selection.length === 1
                  ? getProp(editor.doc.get(selection[0] as string)?.props ?? {}, "name") ||
                    "Selection"
                  : `${selection.length} layers`,
            }
          : {})}
      />
    </div>
  );
}

function prettify(json: string): string {
  try {
    const value = JSON.parse(json) as unknown;
    if (Array.isArray(value)) {
      const first = value[0] as { color?: string } | undefined;
      return first?.color ?? (value.length === 0 ? "none" : `${value.length}`);
    }
    if (typeof value === "number") return String(Math.round(value * 100) / 100);
    return String(value);
  } catch {
    return json;
  }
}
