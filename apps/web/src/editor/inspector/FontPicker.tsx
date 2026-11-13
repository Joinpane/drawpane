/**
 * The font picker: search every family the editor can use (built in,
 * system, Google, this computer), each shown in its own face, with the
 * families this file uses one tab away. ↑ and ↓ preview a font on the
 * selected text right on the canvas; Enter keeps it, Esc goes back.
 */
import type { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Badge, type BadgeTone, Icon, Popover, SegmentedControl } from "@drawpane/ui";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { describeFamily, type FontFamily, fonts, nearestWeight } from "../../fonts/fonts";

type Tab = "all" | "file" | "google" | "local";

const ROW = 44;
const VISIBLE_ROWS = 8;
const OVERSCAN = 4;

/** A family the file uses that no source provides. */
const missing = (family: string): FontFamily => ({
  family,
  source: "system",
  category: null,
  weights: [],
  italics: [],
  variable: false,
});

/** Subscribes to the registry: the catalog and local fonts arrive later. */
export function useFonts(): number {
  return useSyncExternalStore(fonts.subscribe, () => fonts.version);
}

/** Whether a family resolves to something that renders (false once we know it's missing). */
export function useFontStatus(family: string | null): "ok" | "missing" | "unknown" {
  useFonts();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!family || fonts.get(family) || family in checked) return;
    let live = true;
    void fonts.resolve(family).then((f) => {
      if (live) setChecked((c) => ({ ...c, [family]: f !== null }));
    });
    return () => {
      live = false;
    };
  }, [family, checked]);
  if (!family) return "unknown";
  if (fonts.get(family)) return "ok";
  return family in checked ? (checked[family] ? "ok" : "missing") : "unknown";
}

/** Ranks a family against a query: exact, prefix, word prefix, then anywhere. -1 if no match. */
export function matchRank(name: string, query: string): number {
  if (!query) return 0;
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/\s+/).some((word) => word.startsWith(q))) return 2;
  return n.includes(q) ? 3 : -1;
}

/**
 * Sets a family on layers, moving each to the weight nearest its original
 * one that the family has (`weights`: each layer's weight when the picker
 * opened, so previewing many fonts never drifts). The caller groups it.
 */
function setFamily(editor: Editor, weights: ReadonlyMap<string, number>, f: FontFamily): void {
  editor.setProp([...weights.keys()], "fontFamily", f.family);
  for (const [id, weight] of weights) {
    const next = f.weights.length > 0 && !f.variable ? nearestWeight(f.weights, weight) : weight;
    editor.setProp([id], "fontWeight", next === 400 ? null : next);
  }
}

export function FontPicker({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const families = new Set(nodes.map((n) => getProp(n.props, "fontFamily")));
  const family = families.size === 1 ? ([...families][0] ?? null) : null;
  const status = useFontStatus(family);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="font-trigger"
        aria-label={`Font: ${family ?? "Mixed"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-trigger__name">{family ?? "Mixed"}</span>
        {status === "missing" ? (
          <span
            className="font-trigger__missing"
            title={`${family} isn't available here, so it shows in a fallback font.`}
          >
            <Icon name="warning" size={12} />
          </span>
        ) : null}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && ref.current ? (
        <Popover
          anchor={ref.current}
          label="Fonts"
          className="font-picker dp-root"
          onClose={() => setOpen(false)}
        >
          <FontList editor={editor} nodes={nodes} current={family} onDone={() => setOpen(false)} />
        </Popover>
      ) : null}
    </>
  );
}

function FontList({
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
  useFonts();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewingRef = useRef(false);
  const [weights] = useState(
    () => new Map(nodes.map((n) => [n.id, getProp(n.props, "fontWeight")] as const)),
  );

  useEffect(() => {
    void fonts.loadGoogle();
    // Leaving mid-preview (a click elsewhere) goes back to what was there.
    return () => {
      if (previewingRef.current) editor.cancelGesture();
    };
  }, [editor]);

  // Families this file uses, most used first.
  const inFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of editor.doc.nodes()) {
      if (node.type !== "text") continue;
      const name = getProp(node.props, "fontFamily");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [editor]);

  const google = fonts.google;
  const local = fonts.local;
  const items = useMemo(() => {
    let source: FontFamily[];
    if (tab === "file")
      source = [...inFile]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => fonts.get(name) ?? missing(name));
    else if (tab === "google") source = [...(google ?? [])];
    else if (tab === "local") source = [...(local ?? [])];
    else {
      // Each family once, the first source winning (built in over Google over local).
      const byName = new Map<string, FontFamily>();
      for (const f of [...fonts.builtIn, ...(google ?? []), ...(local ?? [])])
        if (!byName.has(f.family)) byName.set(f.family, f);
      source = [...byName.values()];
    }
    if (!query.trim()) return source;
    return source
      .map((f, i) => ({ f, i, rank: matchRank(f.family, query) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.f);
  }, [tab, query, inFile, google, local]);

  // Start on the current family when it's in the list; otherwise the top.
  useEffect(() => {
    // Searching starts above the results, so ↓ previews the top match and
    // Enter picks it; otherwise start on the current family.
    const at = query
      ? -1
      : Math.max(
          0,
          items.findIndex((f) => f.family === current),
        );
    setActive(at);
    const list = listRef.current;
    if (list) list.scrollTop = Math.max(0, (at - 2) * ROW);
  }, [items]);

  const isMissing = (f: FontFamily) => tab === "file" && !fonts.get(f.family);

  const reveal = (i: number) => {
    const list = listRef.current;
    if (!list) return;
    if (i * ROW < list.scrollTop) list.scrollTop = i * ROW;
    else if ((i + 1) * ROW > list.scrollTop + list.clientHeight)
      list.scrollTop = (i + 1) * ROW - list.clientHeight;
  };

  const preview = (i: number) => {
    const f = items[i];
    if (!f || isMissing(f)) return;
    if (!previewingRef.current) {
      editor.beginGesture("Font");
      previewingRef.current = true;
    }
    setFamily(editor, weights, f);
    setPreviewing(f.family);
  };

  const keep = (f: FontFamily | undefined) => {
    if (!previewingRef.current) editor.beginGesture("Font");
    previewingRef.current = false;
    if (f && !isMissing(f)) setFamily(editor, weights, f);
    editor.endGesture();
    onDone();
  };

  const back = () => {
    if (previewingRef.current) {
      previewingRef.current = false;
      editor.cancelGesture();
    }
    onDone();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step =
      e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowUp"
          ? -1
          : e.key === "PageDown"
            ? VISIBLE_ROWS
            : e.key === "PageUp"
              ? -VISIBLE_ROWS
              : 0;
    if (step !== 0 && items.length > 0) {
      e.preventDefault();
      const next = Math.max(0, Math.min(items.length - 1, active + step));
      setActive(next);
      reveal(next);
      preview(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      keep(items[Math.max(0, active)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + ROW * VISIBLE_ROWS) / ROW) + OVERSCAN);
  const activeId = items[active] ? `${listId}-${active}` : undefined;

  const tabs = [
    { value: "all" as const, label: "All" },
    { value: "file" as const, label: "In this file" },
    ...(fonts.googleEnabled === false ? [] : [{ value: "google" as const, label: "Google" }]),
    ...(fonts.canListLocal ? [{ value: "local" as const, label: "Local" }] : []),
  ];

  return (
    <div className="font-picker__body">
      <div className="font-picker__search">
        <Icon name="search" size={16} />
        <input
          // biome-ignore lint/a11y/noAutofocus: the picker opens to type into
          autoFocus
          ref={inputRef}
          role="combobox"
          aria-label="Search fonts"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          placeholder="Search fonts"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="font-picker__hint" aria-hidden="true">
          ↑↓ to preview
        </span>
      </div>
      <div className="font-picker__tabs">
        <SegmentedControl
          label="Font source"
          options={tabs}
          value={tab}
          onChange={(next) => {
            setTab(next);
            // Typing keeps searching: the tabs never hold focus away from the field.
            inputRef.current?.focus();
          }}
        />
      </div>
      {tab === "local" && !local ? (
        <div className="font-picker__empty">
          <p>Fonts on this computer show only for you; collaborators see a fallback.</p>
          <button
            type="button"
            className="font-picker__cta"
            onClick={() =>
              fonts
                .loadLocal()
                .catch(() => setLocalError("The browser didn't allow listing local fonts."))
            }
          >
            Show fonts on this computer
          </button>
          {localError ? <p className="font-picker__error">{localError}</p> : null}
        </div>
      ) : items.length === 0 ? (
        <div className="font-picker__empty">
          <p>
            {tab === "google" && !google
              ? "Loading Google Fonts…"
              : query
                ? `No fonts match “${query}”.`
                : "No fonts here yet."}
          </p>
        </div>
      ) : (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Fonts"
          className="font-picker__list"
          style={{ height: Math.min(items.length, VISIBLE_ROWS) * ROW }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: items.length * ROW, position: "relative" }}>
            {items.slice(first, last).map((f, k) => {
              const i = first + k;
              return (
                <FontRow
                  key={f.family}
                  id={`${listId}-${i}`}
                  family={f}
                  top={i * ROW}
                  active={i === active}
                  selected={f.family === current}
                  missing={isMissing(f)}
                  uses={tab === "file" ? (inFile.get(f.family) ?? 0) : null}
                  onPick={() => keep(f)}
                  onHover={() => setActive(i)}
                />
              );
            })}
          </div>
        </div>
      )}
      <footer className="font-picker__foot">
        {previewing ? (
          <span>
            Previewing <strong>{previewing}</strong> · <kbd>↵</kbd> to keep, <kbd>Esc</kbd> to go
            back
          </span>
        ) : (
          <span>Google fonts load from this server, never from Google.</span>
        )}
      </footer>
    </div>
  );
}

const CHIPS: Record<FontFamily["source"], { label: string; tone: BadgeTone }> = {
  bundled: { label: "Built in", tone: "neutral" },
  system: { label: "System", tone: "neutral" },
  google: { label: "Google", tone: "neutral" },
  local: { label: "Local", tone: "component" },
};

function FontRow({
  id,
  family: f,
  top,
  active,
  selected,
  missing: isMissing,
  uses,
  onPick,
  onHover,
}: {
  id: string;
  family: FontFamily;
  top: number;
  active: boolean;
  selected: boolean;
  missing: boolean;
  uses: number | null;
  onPick: () => void;
  onHover: () => void;
}) {
  const [face, setFace] = useState<string>(f.source === "google" ? "inherit" : `"${f.family}"`);
  useEffect(() => {
    if (isMissing) return;
    let live = true;
    void fonts.preview(f).then((css) => {
      if (live) setFace(css);
    });
    return () => {
      live = false;
    };
  }, [f, isMissing]);
  const chip = isMissing ? { label: "Missing", tone: "warning" as const } : CHIPS[f.source];
  const meta = isMissing
    ? "Used in this file · not available"
    : uses !== null
      ? `${describeFamily(f)} · ${uses === 1 ? "1 layer" : `${uses} layers`}`
      : describeFamily(f);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the search field drives the list from the keyboard
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={isMissing || undefined}
      data-current={selected || undefined}
      className="font-row"
      style={{ top }}
      onClick={isMissing ? undefined : onPick}
      onPointerMove={onHover}
    >
      <span className="font-row__text">
        <span className="font-row__name" style={{ fontFamily: `${face}, var(--font-ui)` }}>
          {f.family}
        </span>
        <span className="font-row__meta">{meta}</span>
      </span>
      {selected ? (
        <Icon name="check" size={16} className="font-row__check" />
      ) : (
        <Badge tone={chip.tone}>{chip.label}</Badge>
      )}
    </div>
  );
}
