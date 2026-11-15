/**
 * Type settings, as in Figma: what text needs now and then, kept out of the
 * Text section until asked for. A button opens a panel of three tabs:
 * Basics (alignment, decoration, case, vertical trim, lists, paragraph
 * spacing, truncation, resizing), Details (OpenType features) and Variable
 * (the font's axes). The button shows when something in it is set.
 *
 * A layer shows every setting; a text style (`scope: "style"`) only what a
 * style carries.
 */
import type { Editor } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Icon, IconButton, Popover, SegmentedControl, Tooltip } from "@drawpane/ui";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { shortcutFor } from "../actions";
import { AxesPanel, axesSummary, canVary } from "./FontAxes";
import { FeaturesPanel, featuresSummary } from "./FontFeatures";
import { common, Num, Select } from "./fields";

export type TypeScope = "layer" | "style";

type Tab = "basics" | "details" | "variable";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "basics", label: "Basics" },
  { id: "details", label: "Details" },
  { id: "variable", label: "Variable" },
];
/** The tab last shown: opening the panel again goes back to it. */
let lastTab: Tab = "basics";

/** At most this many lines, the last ending in "…". */
const TRUNCATE = [
  { value: "off", label: "All lines" },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    value: String(n),
    label: `Max ${n} ${n === 1 ? "line" : "lines"}`,
  })),
];

const DECORATION = { underline: "Underline", strikethrough: "Strikethrough" } as const;
const CASE = { upper: "Uppercase", lower: "Lowercase", title: "Title case" } as const;

/**
 * What's set in the panel, in a few words each ("Underline", "Max 2 lines"),
 * or nothing when it's all as text comes. Alignment and resizing show in the
 * Text section already, so they don't count.
 */
export function typeSettingsSummary(
  editor: Editor,
  nodes: readonly NodeRecord[],
  views: readonly NodeRecord[],
  scope: TypeScope,
): string[] {
  const out: string[] = [];
  const decoration = common(views as NodeRecord[], "textDecoration");
  if (decoration === undefined || decoration === null) out.push("Mixed decoration");
  else if (decoration !== "none") out.push(DECORATION[decoration]);
  const textCase = common(views as NodeRecord[], "textCase");
  if (textCase === undefined || textCase === null) out.push("Mixed case");
  else if (textCase !== "none") out.push(CASE[textCase]);
  if (nodes.some((n) => getProp(n.props, "leadingTrim") === "cap-height"))
    out.push("Cap height trim");
  if (scope === "layer") {
    const { listType } = editor.listState();
    if (listType === null) out.push("Mixed lists");
    else if (listType !== "none")
      out.push(listType === "bullet" ? "Bulleted list" : "Numbered list");
    const lines = nodes.map((n) => getProp(n.props, "maxLines"));
    const kept = lines.find((l) => l !== null);
    if (kept) out.push(`Max ${kept} ${kept === 1 ? "line" : "lines"}`);
  }
  const spacing = nodes.map((n) => getProp(n.props, "paragraphSpacing")).find((s) => s > 0);
  if (spacing) out.push(`Paragraph spacing ${spacing}`);
  const features = featuresSummary(views);
  if (features) out.push(features);
  const axes = axesSummary(views);
  if (axes) out.push(axes);
  return out;
}

/** The button that opens type settings, marked when something in them is set. */
export function TypeSettingsButton({
  editor,
  nodes,
  views = nodes,
  scope = "layer",
}: {
  editor: Editor;
  nodes: NodeRecord[];
  views?: NodeRecord[];
  scope?: TypeScope;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const summary = typeSettingsSummary(editor, nodes, views, scope);
  const name = summary.length > 0 ? `Type settings: ${summary.join(", ")}` : "Type settings";
  return (
    <>
      <Tooltip label={summary.length > 0 ? name : "Type settings"} describe={false}>
        <button
          ref={button}
          type="button"
          className="type-settings-button"
          aria-label={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-set={summary.length > 0 || undefined}
          onClick={() => setOpen(!open)}
        >
          <Icon name="type-settings" size={16} />
        </button>
      </Tooltip>
      {open && button.current ? (
        <Popover
          anchor={button.current}
          // Beside the section (or the popover) it belongs to, clear of the inspector, as in Figma.
          beside={button.current.closest<HTMLElement>(".dp-section, .dp-popover") ?? undefined}
          label="Type settings"
          className="type-settings dp-root"
          onClose={() => setOpen(false)}
        >
          <TypeSettingsPanel
            editor={editor}
            nodes={nodes}
            views={views}
            scope={scope}
            onClose={() => setOpen(false)}
          />
        </Popover>
      ) : null}
    </>
  );
}

function TypeSettingsPanel({
  editor,
  nodes,
  views,
  scope,
  onClose,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  views: NodeRecord[];
  scope: TypeScope;
  onClose: () => void;
}) {
  const variable = canVary(views);
  const [tab, setTabState] = useState<Tab>(
    lastTab === "variable" && !variable ? "basics" : lastTab,
  );
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const id = useId();
  const tabs = useRef(new Map<Tab, HTMLButtonElement>());
  const enabled = TABS.filter((t) => t.id !== "variable" || variable);

  // Tabs as APG has them: arrows move between them and show each, Home and End jump to the ends.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = enabled.findIndex((t) => t.id === tab);
    const to =
      e.key === "ArrowRight"
        ? (at + 1) % enabled.length
        : e.key === "ArrowLeft"
          ? (at - 1 + enabled.length) % enabled.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? enabled.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    const next = enabled[to];
    if (!next) return;
    setTab(next.id);
    tabs.current.get(next.id)?.focus();
  };

  return (
    <div className="type-settings__body">
      <div className="type-settings__head">
        <div className="type-settings__tabs" role="tablist" aria-label="Type settings">
          {TABS.map((t) => {
            const disabled = t.id === "variable" && !variable;
            const button = (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabs.current.set(t.id, el);
                  else tabs.current.delete(t.id);
                }}
                type="button"
                role="tab"
                id={`${id}-${t.id}`}
                className="type-settings__tab"
                aria-selected={tab === t.id}
                aria-controls={`${id}-panel`}
                tabIndex={tab === t.id ? 0 : -1}
                // Opened, the panel takes focus on its tab: keyboard users land in it.
                data-autofocus={tab === t.id || undefined}
                disabled={disabled}
                onClick={() => setTab(t.id)}
                onKeyDown={onKeyDown}
              >
                {t.label}
              </button>
            );
            return disabled ? (
              <Tooltip key={t.id} label="This font has no variable axes">
                <span className="type-settings__tab-wrap">{button}</span>
              </Tooltip>
            ) : (
              button
            );
          })}
        </div>
        <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        className={`type-settings__panel type-settings__panel--${tab}`}
      >
        {tab === "basics" ? (
          <Basics editor={editor} nodes={nodes} views={views} scope={scope} />
        ) : tab === "details" ? (
          <FeaturesPanel editor={editor} nodes={views} />
        ) : (
          <AxesPanel editor={editor} nodes={views} />
        )}
      </div>
    </div>
  );
}

/** A setting's row: its name, then its control. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="type-settings__row">
      <span className="type-settings__label">{label}</span>
      <div className="type-settings__control">{children}</div>
    </div>
  );
}

function Basics({
  editor,
  nodes,
  views,
  scope,
}: {
  editor: Editor;
  nodes: NodeRecord[];
  views: NodeRecord[];
  scope: TypeScope;
}) {
  const ids = nodes.map((n) => n.id);
  const viewIds = views.map((n) => n.id);
  const { listType } = editor.listState();
  const truncation = (() => {
    const lines = nodes.map((n) => getProp(n.props, "maxLines"));
    return lines.every((l) => l === lines[0]) ? lines[0] : undefined;
  })();
  const layer = scope === "layer";
  return (
    <>
      <div className="type-settings__group">
        {layer ? (
          <Row label="Alignment">
            <SegmentedControl
              label="Text alignment"
              options={[
                { value: "left", icon: "align-left", title: "Align left" },
                { value: "center", icon: "align-center", title: "Align center" },
                { value: "right", icon: "align-right", title: "Align right" },
                { value: "justify", icon: "align-justify", title: "Justify" },
              ]}
              value={common(nodes, "textAlign") ?? ""}
              onChange={(v) => editor.setProp(ids, "textAlign", v, "Text alignment")}
            />
          </Row>
        ) : null}
        <Row label="Decoration">
          <SegmentedControl
            label="Decoration"
            options={[
              { value: "none", icon: "minus", title: "No decoration" },
              { value: "underline", icon: "underline", title: "Underline" },
              { value: "strikethrough", icon: "strikethrough", title: "Strikethrough" },
            ]}
            value={common(views, "textDecoration") ?? ""}
            onChange={(v) =>
              editor.setProp(viewIds, "textDecoration", v === "none" ? null : v, "Text decoration")
            }
          />
        </Row>
        <Row label="Case">
          <SegmentedControl
            label="Case"
            className="type-settings__case"
            options={[
              { value: "none", icon: "minus", title: "As typed" },
              { value: "upper", label: "AG", title: "Uppercase" },
              { value: "lower", label: "ag", title: "Lowercase" },
              { value: "title", label: "Ag", title: "Title case" },
            ]}
            value={common(views, "textCase") ?? ""}
            onChange={(v) =>
              editor.setProp(viewIds, "textCase", v === "none" ? null : v, "Text case")
            }
          />
        </Row>
      </div>
      <div className="type-settings__group">
        <Row label="Vertical trim">
          <SegmentedControl
            label="Vertical trim"
            options={[
              { value: "none", icon: "trim-standard", title: "Standard" },
              { value: "cap-height", icon: "trim-cap", title: "Cap height to baseline" },
            ]}
            value={common(nodes, "leadingTrim") ?? ""}
            onChange={(v) =>
              editor.setProp(ids, "leadingTrim", v === "none" ? null : v, "Vertical trim")
            }
          />
        </Row>
        {layer ? (
          <Row label="List style">
            <SegmentedControl
              label="List style"
              options={[
                { value: "none", icon: "minus", title: "No list" },
                {
                  value: "bullet",
                  icon: "list-bullet",
                  title: `Bulleted list (${shortcutFor("text.bulletList")})`,
                },
                {
                  value: "number",
                  icon: "list-number",
                  title: `Numbered list (${shortcutFor("text.numberList")})`,
                },
              ]}
              value={listType ?? ""}
              onChange={(v) => v && editor.setList(v)}
            />
          </Row>
        ) : null}
        <Row label="Paragraph spacing">
          <Num
            editor={editor}
            nodes={nodes}
            prop="paragraphSpacing"
            label="¶"
            ariaLabel="Paragraph spacing"
            min={0}
          />
        </Row>
        {layer ? (
          <Row label="Truncate text">
            <Select<string>
              label="Truncate"
              value={
                truncation === undefined ? null : truncation === null ? "off" : String(truncation)
              }
              mixed={truncation === undefined}
              options={TRUNCATE}
              onChange={(v) =>
                editor.setProp(ids, "maxLines", v === "off" ? null : Number(v), "Truncate text")
              }
            />
          </Row>
        ) : null}
        {layer ? (
          <Row label="Resizing">
            <SegmentedControl
              label="Text box sizing"
              options={[
                { value: "width", icon: "text-auto-width", title: "Auto width" },
                { value: "height", icon: "text-auto-height", title: "Auto height" },
                { value: "none", icon: "text-fixed", title: "Fixed size" },
              ]}
              value={common(nodes, "textAutoResize") ?? ""}
              onChange={(v) => editor.setProp(ids, "textAutoResize", v, "Text sizing")}
            />
          </Row>
        ) : null}
      </div>
    </>
  );
}
