/**
 * The keyboard shortcuts sheet (⌘/): every action with a shortcut, plus the
 * keys you hold and the pointer gestures. Search by name, filter by group,
 * or press a shortcut in the search field to find what it does.
 */
import { Kbd, SegmentedControl } from "@drawpane/ui";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Dialog } from "../app/Dialog";
import { isMac } from "../app/format";
import { ACTIONS, type Action, matches, type Shortcut, shortcutCaps, shortcutOf } from "./actions";

interface Row {
  readonly id: string;
  readonly label: string;
  readonly group: Group;
  readonly caps: readonly string[];
  readonly shortcut?: Shortcut;
  /** Other keys that do the same (see `Action.also`). */
  readonly also?: readonly Shortcut[];
}

type Group = "Tools" | "Edit" | "Arrange" | "Layer" | "View";
const GROUPS: readonly Group[] = ["Tools", "Edit", "Arrange", "Layer", "View"];

/** Shortcuts that aren't actions: held keys and gestures the canvas handles itself. */
function gestures(): Row[] {
  const mod = isMac() ? "⌘" : "Ctrl";
  const alt = isMac() ? "⌥" : "Alt";
  const shift = isMac() ? "⇧" : "Shift";
  const control = isMac() ? "⌃" : "Ctrl";
  const row = (id: string, label: string, group: Group, caps: string[]): Row => ({
    id,
    label,
    group,
    caps,
  });
  return [
    row("hold.space", "Pan (hold)", "Tools", ["Space"]),
    row("hold.alt", "Layout X-ray and measure (hold)", "View", [alt]),
    row("nudge", "Nudge 1px", "Arrange", ["←", "↑", "→", "↓"]),
    row("nudge.big", "Nudge 10px", "Arrange", [shift, "↑"]),
    row("enter", "Select children, edit text", "Layer", ["↵"]),
    row("escape.parent", "Select parent", "Layer", ["Esc"]),
    row("deep", "Select inside groups (click)", "Layer", [mod]),
    row("duplicate.drag", "Duplicate while dragging", "Edit", [alt]),
    row("proportions", "Keep proportions while resizing", "Edit", [shift]),
    row("no.snap", "Ignore snapping (hold while dragging)", "Edit", [control]),
    row(
      "ignore.constraints",
      // Off a Mac, Ctrl is both: the frame's children stay put, and nothing snaps.
      isMac()
        ? "Resize a frame without its constraints"
        : "Resize a frame without its constraints or snapping",
      "Edit",
      [mod],
    ),
    row("rename.f2", "Rename in the layers panel", "Layer", ["F2"]),
  ];
}

function groupOf(action: Action): Group {
  if (action.group === "File" || action.group === "Help") return "View";
  return action.group;
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Group | "All">("All");
  const [pressed, setPressed] = useState<KeyboardEvent | null>(null);

  const rows = useMemo<Row[]>(
    () => [
      ...ACTIONS.filter((a) => shortcutOf(a)).map((a) => ({
        id: a.id,
        label: a.label,
        group: groupOf(a),
        caps: shortcutCaps(shortcutOf(a) as Shortcut),
        shortcut: shortcutOf(a) as Shortcut,
        also: a.also ?? [],
      })),
      ...gestures(),
    ],
    [],
  );

  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (pressed)
      return [r.shortcut, ...(r.also ?? [])].some(
        (shortcut) => shortcut !== undefined && matches(shortcut, pressed),
      );
    if (group !== "All" && r.group !== group) return false;
    return !q || r.label.toLowerCase().includes(q) || r.caps.join(" ").toLowerCase().includes(q);
  });

  return (
    <Dialog open={open} title="Keyboard shortcuts" size="lg" onClose={onClose}>
      <div className="shortcuts">
        <input
          className="shortcuts__search"
          type="search"
          aria-label="Search shortcuts"
          placeholder={`Search ${rows.length} shortcuts, or press one`}
          value={pressed ? shortcutCaps(eventShortcut(pressed)).join(" ") : query}
          onChange={(e) => {
            setPressed(null);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            // A combination with a modifier is a lookup, not text.
            const native = e.nativeEvent;
            if ((e.metaKey || e.ctrlKey || e.altKey) && e.key.length === 1) {
              e.preventDefault();
              setPressed(native);
              return;
            }
            if (e.key === "Escape" && (pressed || query)) {
              e.preventDefault();
              setPressed(null);
              setQuery("");
            }
          }}
        />
        <SegmentedControl
          label="Group"
          options={[{ value: "All", label: "All" }, ...GROUPS.map((g) => ({ value: g, label: g }))]}
          value={group}
          onChange={(g) => {
            setPressed(null);
            setGroup(g as Group | "All");
          }}
        />
        <ul className="shortcuts__list" aria-label="Shortcuts">
          {shown.length === 0 ? (
            <li className="shortcuts__empty">
              {pressed ? "Nothing uses that shortcut." : `No shortcuts match “${query}”.`}
            </li>
          ) : (
            // Grouped under headings when showing everything; a flat list when filtered.
            (group === "All" && !q && !pressed
              ? GROUPS.map((g) => ({ g, rows: shown.filter((r) => r.group === g) }))
              : [{ g: null, rows: shown }]
            ).map(({ g, rows: groupRows }) => [
              g ? (
                <li key={`h-${g}`} className="shortcuts__heading" aria-hidden="true">
                  {g}
                </li>
              ) : null,
              ...groupRows.map((r) => (
                <li key={r.id} className="shortcuts__row">
                  <span>{r.label}</span>
                  <Kbd keys={r.caps} />
                </li>
              )),
            ])
          )}
        </ul>
        <p className="shortcuts__customize">
          <Link to="/settings/shortcuts" onClick={onClose}>
            Change any shortcut
          </Link>{" "}
          in Settings: changes follow your account to every browser.
        </p>
      </div>
    </Dialog>
  );
}

/** The shortcut a key event spells, for showing what was pressed. */
function eventShortcut(e: KeyboardEvent): Shortcut {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  return { key, mod, shift: e.shiftKey, alt: e.altKey };
}
