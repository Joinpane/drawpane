import {
  ACTION_LABEL,
  actionSentence,
  addFlow,
  addReaction,
  changeActionType,
  changeTriggerType,
  type Editor,
  flowScreens,
  hasTransition,
  isScreen,
  keyLabel,
  pageOf,
  reactionsOf,
  removeFlow,
  removeReaction,
  screenOf,
  screensInReadingOrder,
  setDevice,
  TRANSITION_LABEL,
  triggerLabel,
  updateFlow,
  updateReaction,
} from "@drawpane/editor";
import {
  ACTION_TYPES,
  type Action,
  actionTarget,
  DEVICE_IDS,
  DEVICES,
  type DeviceId,
  DIRECTIONS,
  type Flow,
  getProp,
  type NodeRecord,
  OVERLAY_POSITIONS,
  type Reaction,
  SafeUrl,
  TRANSITION_TYPES,
  type Trigger,
} from "@drawpane/model";
import {
  Icon,
  IconButton,
  Kbd,
  NumberField,
  PropertyRow,
  PropertySection,
  SegmentedControl,
  Switch,
} from "@drawpane/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "../hooks";
import { EasingEditor } from "./EasingEditor";
import "./prototype.css";

const nameOf = (editor: Editor, id: string) =>
  getProp(editor.doc.get(id)?.props ?? {}, "name") || "Untitled";

/**
 * The Prototype tab: what the selected layer does when someone taps, hovers,
 * drags or presses a key, with the transition that plays; then the page's
 * flows and the device the prototype plays in.
 */
export function PrototypePanel({ fileId }: { fileId: string }) {
  const editor = useEditor();
  useDocVersion();
  const selection = useEditorState((s) => s.selection);
  const pageId = useEditorState((s) => s.pageId);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const node = selection.length === 1 ? editor.doc.get(selection[0] as string) : undefined;
  const inScreen = node ? screenOf(editor.doc, node.id) !== null : false;
  if (!pageId) return null;

  return (
    <fieldset className="inspector proto" disabled={!canEdit} aria-label="Prototype">
      <h2 className="inspector__title">{node ? nameOf(editor, node.id) : "Prototype"}</h2>
      {node && inScreen ? (
        <Interactions key={node.id} node={node} />
      ) : (
        <p className="inspector__hint proto__intro">
          {selection.length > 1
            ? "Select one layer to give it interactions."
            : node
              ? "Interactions work on layers inside a top-level frame. Move this layer into a screen first."
              : "Select a layer, then drag its handle onto a screen to connect them."}
        </p>
      )}
      <FlowsSection pageId={pageId} fileId={fileId} />
      <DeviceSection pageId={pageId} />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Interactions

function Interactions({ node }: { node: NodeRecord }) {
  const editor = useEditor();
  const reactions = reactionsOf(node);
  const [selectedId, setSelectedId] = useState<string | null>(reactions[0]?.id ?? null);
  const selected = reactions.find((r) => r.id === selectedId) ?? reactions[0] ?? null;

  const add = () => {
    const id = addReaction(editor, node.id);
    if (id) setSelectedId(id);
  };

  return (
    <>
      <PropertySection
        title="Interactions"
        actions={<IconButton icon="plus" label="Add interaction" onClick={add} />}
      >
        {reactions.length === 0 ? (
          <button type="button" className="proto__empty" onClick={add}>
            <span className="proto__empty-dot" aria-hidden="true">
              <Icon name="plus" size={12} />
            </span>
            <span>
              Drag the handle on the canvas onto a screen, or <strong>add an interaction</strong>.
            </span>
          </button>
        ) : (
          <ul className="proto__list">
            {reactions.map((reaction) => (
              <li key={reaction.id}>
                <ReactionRow
                  editor={editor}
                  reaction={reaction}
                  selected={reaction.id === selected?.id}
                  onSelect={() => setSelectedId(reaction.id)}
                  onRemove={() => removeReaction(editor, node.id, reaction.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </PropertySection>
      {selected ? <ReactionEditor node={node} reaction={selected} /> : null}
    </>
  );
}

function ReactionRow({
  editor,
  reaction,
  selected,
  onSelect,
  onRemove,
}: {
  editor: Editor;
  reaction: Reaction;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const target = actionTarget(reaction.action);
  const broken = target !== null && !isScreen(editor.doc, target);
  return (
    <div className="proto__row" data-selected={selected || undefined}>
      <button type="button" className="proto__row-main" aria-pressed={selected} onClick={onSelect}>
        <span className="proto__row-trigger">{triggerLabel(reaction.trigger)}</span>
        <span className="proto__row-action" data-broken={broken || undefined}>
          {broken ? <Icon name="warning" size={12} /> : null}
          {actionSentence(editor.doc, reaction.action)}
        </span>
      </button>
      <IconButton
        icon="minus"
        label="Remove interaction"
        className="proto__row-remove"
        onClick={onRemove}
      />
    </div>
  );
}

function ReactionEditor({ node, reaction }: { node: NodeRecord; reaction: Reaction }) {
  const editor = useEditor();
  const update = (next: Reaction) => updateReaction(editor, node.id, next);
  const own = screenOf(editor.doc, node.id);
  const page = pageOf(editor.doc, node.id);
  const screens = page ? screensInReadingOrder(editor.doc, page).filter((id) => id !== own) : [];
  const isScreenItself = own === node.id;
  const triggers: { value: Trigger["type"]; label: string }[] = isScreenItself
    ? [
        { value: "tap", label: "Tap" },
        { value: "key", label: "Key" },
        { value: "delay", label: "Delay" },
      ]
    : [
        { value: "tap", label: "Tap" },
        { value: "hover", label: "Hover" },
        { value: "drag", label: "Drag" },
        { value: "key", label: "Key" },
      ];
  // A delay that was set on a screen stays visible if the layer stops being one.
  if (!triggers.some((t) => t.value === reaction.trigger.type))
    triggers.push({ value: reaction.trigger.type, label: triggerLabel(reaction.trigger) });
  const { action, trigger } = reaction;
  const target = actionTarget(action);

  return (
    <>
      <PropertySection title="Interaction">
        <PropertyRow columns="label">
          <span className="inspector__label">Trigger</span>
          <SegmentedControl
            label="Trigger"
            options={triggers}
            value={trigger.type}
            onChange={(type) => update({ ...reaction, trigger: changeTriggerType(trigger, type) })}
          />
        </PropertyRow>
        {trigger.type === "key" ? (
          <PropertyRow columns="label">
            <span className="inspector__label">Key</span>
            <KeyCapture
              trigger={trigger}
              onChange={(next) => update({ ...reaction, trigger: next })}
            />
          </PropertyRow>
        ) : null}
        {trigger.type === "delay" ? (
          <PropertyRow columns="label">
            <span className="inspector__label">After</span>
            <NumberField
              label="ms"
              ariaLabel="Delay"
              value={trigger.ms}
              min={0}
              max={60_000}
              step={100}
              onChange={(ms) =>
                update({ ...reaction, trigger: { type: "delay", ms: Math.round(ms) } })
              }
            />
          </PropertyRow>
        ) : null}
        <PropertyRow columns="label">
          <span className="inspector__label">Action</span>
          <select
            className="inspector__select"
            aria-label="Action"
            value={action.type}
            onChange={(e) =>
              update({
                ...reaction,
                action: changeActionType(
                  action,
                  e.target.value as Action["type"],
                  screens[0] ?? "",
                ),
              })
            }
          >
            {ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {ACTION_LABEL[type]}
              </option>
            ))}
          </select>
        </PropertyRow>
        {target !== null && "to" in action ? (
          <PropertyRow columns="label">
            <span className="inspector__label">Destination</span>
            <ScreenSelect
              value={action.to}
              screens={screens}
              onChange={(to) => update({ ...reaction, action: { ...action, to } })}
            />
          </PropertyRow>
        ) : null}
        {action.type === "overlay" ? (
          <OverlayOptions
            action={action}
            onChange={(next) => update({ ...reaction, action: next })}
          />
        ) : null}
        {action.type === "url" ? (
          <UrlOptions action={action} onChange={(next) => update({ ...reaction, action: next })} />
        ) : null}
      </PropertySection>
      {hasTransition(action) && action.type !== "back" ? (
        <TransitionSection reaction={reaction} onChange={update} />
      ) : action.type === "back" ? (
        <p className="inspector__hint proto__note">
          Back plays the transition that led here, in reverse.
        </p>
      ) : null}
    </>
  );
}

function ScreenSelect({
  value,
  screens,
  onChange,
}: {
  value: string;
  screens: readonly string[];
  onChange: (id: string) => void;
}) {
  const editor = useEditor();
  const missing = !screens.includes(value);
  return (
    <span className="proto__select-wrap" data-broken={(missing && value !== "") || undefined}>
      <Icon name={missing && value !== "" ? "warning" : "board"} size={12} />
      <select
        className="inspector__select proto__select"
        aria-label="Destination"
        value={missing ? "" : value}
        onChange={(e) => onChange(e.target.value)}
      >
        {missing ? (
          <option value="" disabled>
            {value === ""
              ? "Choose a screen"
              : editor.doc.has(value)
                ? "Not a screen"
                : "Deleted screen"}
          </option>
        ) : null}
        {screens.map((id) => (
          <option key={id} value={id}>
            {nameOf(editor, id)}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Press a key to record it, with its modifiers. */
function KeyCapture({
  trigger,
  onChange,
}: {
  trigger: Extract<Trigger, { type: "key" }>;
  onChange: (trigger: Trigger) => void;
}) {
  const [listening, setListening] = useState(false);
  return (
    <button
      type="button"
      className="proto__key"
      data-listening={listening || undefined}
      aria-label={listening ? "Press a key" : `Key ${keyLabel(trigger)}. Click to change`}
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        if (!listening || e.key === "Tab") return;
        e.preventDefault();
        e.stopPropagation();
        if (["Shift", "Alt", "Meta", "Control"].includes(e.key)) return;
        setListening(false);
        onChange({
          type: "key",
          key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
          shift: e.shiftKey,
          alt: e.altKey,
          mod: e.metaKey || e.ctrlKey,
        });
      }}
    >
      {listening ? (
        <span className="proto__key-hint">Press a key…</span>
      ) : (
        <Kbd>{keyLabel(trigger)}</Kbd>
      )}
    </button>
  );
}

function OverlayOptions({
  action,
  onChange,
}: {
  action: Extract<Action, { type: "overlay" }>;
  onChange: (action: Action) => void;
}) {
  return (
    <>
      <PropertyRow columns="label">
        <span className="inspector__label">Position</span>
        <div className="proto__position">
          <fieldset className="inspector__align" aria-label="Overlay position">
            {OVERLAY_POSITIONS.map((position) => (
              <button
                key={position}
                type="button"
                className="inspector__align-dot"
                aria-pressed={action.position === position}
                aria-label={position.replace("-", " ")}
                title={position.replace("-", " ")}
                onClick={() => onChange({ ...action, position })}
              />
            ))}
          </fieldset>
          <NumberField
            icon="opacity"
            ariaLabel="Background dim"
            unit="%"
            value={Math.round(action.dim * 100)}
            min={0}
            max={100}
            onChange={(v) => onChange({ ...action, dim: Math.min(1, Math.max(0, v / 100)) })}
          />
        </div>
      </PropertyRow>
      <Switch
        label="Close when tapping outside"
        checked={action.closeOnOutside}
        onChange={(closeOnOutside) => onChange({ ...action, closeOnOutside })}
      />
    </>
  );
}

function UrlOptions({
  action,
  onChange,
}: {
  action: Extract<Action, { type: "url" }>;
  onChange: (action: Action) => void;
}) {
  const [draft, setDraft] = useState(action.url);
  useEffect(() => setDraft(action.url), [action.url]);
  const valid = SafeUrl.safeParse(draft).success;
  const commit = () => {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(draft) ? draft.trim() : `https://${draft.trim()}`;
    if (SafeUrl.safeParse(url).success && url !== action.url) onChange({ ...action, url });
    else setDraft(action.url);
  };
  return (
    <>
      <PropertyRow columns="label">
        <span className="inspector__label">Link</span>
        <input
          className="inspector__select proto__url"
          aria-label="Link"
          aria-invalid={(!valid && draft !== action.url) || undefined}
          placeholder="https://"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(action.url);
              e.currentTarget.blur();
            }
          }}
        />
      </PropertyRow>
      <Switch
        label="Open in a new tab"
        checked={action.newTab}
        onChange={(newTab) => onChange({ ...action, newTab })}
      />
    </>
  );
}

const DIRECTION_ICON = {
  left: "arrow-left",
  right: "arrow-right",
  up: "arrow-up",
  down: "arrow-down",
} as const;

function TransitionSection({
  reaction,
  onChange,
}: {
  reaction: Reaction;
  onChange: (reaction: Reaction) => void;
}) {
  const editor = useEditor();
  const { transition } = reaction;
  const directional = transition.type !== "instant" && transition.type !== "dissolve";
  return (
    <PropertySection title="Animation">
      <PropertyRow columns="label">
        <span className="inspector__label">Transition</span>
        <select
          className="inspector__select"
          aria-label="Transition"
          value={transition.type}
          onChange={(e) =>
            onChange({
              ...reaction,
              transition: {
                ...transition,
                type: e.target.value as (typeof TRANSITION_TYPES)[number],
              },
            })
          }
        >
          {TRANSITION_TYPES.map((type) => (
            <option key={type} value={type}>
              {TRANSITION_LABEL[type]}
            </option>
          ))}
        </select>
      </PropertyRow>
      {directional ? (
        <PropertyRow columns="label">
          <span className="inspector__label">Direction</span>
          <SegmentedControl
            label="Direction"
            options={DIRECTIONS.map((d) => ({
              value: d,
              icon: DIRECTION_ICON[d],
              title: d[0]?.toUpperCase() + d.slice(1),
            }))}
            value={transition.direction}
            onChange={(direction) =>
              onChange({ ...reaction, transition: { ...transition, direction } })
            }
          />
        </PropertyRow>
      ) : null}
      {transition.type !== "instant" ? (
        <EasingEditor
          transition={transition}
          onChange={(next) => onChange({ ...reaction, transition: next })}
          onGestureStart={() => editor.beginGesture("Change timing")}
          onGestureEnd={() => editor.endGesture()}
        />
      ) : null}
    </PropertySection>
  );
}

// ---------------------------------------------------------------------------
// Flows and device

function FlowsSection({ pageId, fileId }: { pageId: string; fileId: string }) {
  const editor = useEditor();
  const page = editor.doc.get(pageId);
  const selection = useEditorState((s) => s.selection);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (page?.type !== "page") return null;
  const flows = getProp(page.props, "flows");
  const screens = screensInReadingOrder(editor.doc, pageId);
  const selectedScreen =
    selection.length === 1 ? screenOf(editor.doc, selection[0] as string) : null;

  const add = () => {
    const starts = new Set(flows.map((f) => f.start));
    const start = selectedScreen ?? screens.find((id) => !starts.has(id)) ?? screens[0];
    if (start) addFlow(editor, start);
  };

  return (
    <PropertySection
      title="Flows"
      actions={
        <IconButton
          icon="plus"
          label={selectedScreen ? `Start a flow on ${nameOf(editor, selectedScreen)}` : "Add flow"}
          disabled={screens.length === 0}
          onClick={add}
        />
      }
    >
      {flows.length === 0 ? (
        <p className="inspector__hint proto__flat">
          {screens.length === 0
            ? "Add a frame to the page to start a prototype."
            : "A flow is where a prototype starts. Connect two screens, or press + to start one."}
        </p>
      ) : (
        <ul className="proto__list">
          {flows.map((flow) => (
            <li key={flow.id}>
              <FlowRow
                flow={flow}
                pageId={pageId}
                fileId={fileId}
                renaming={renaming === flow.id}
                onRename={(on) => setRenaming(on ? flow.id : null)}
                onSelect={() => {
                  if (!isScreen(editor.doc, flow.start)) return;
                  editor.select([flow.start]);
                  editor.revealSelection();
                }}
                onRemove={() => removeFlow(editor, pageId, flow.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </PropertySection>
  );
}

function FlowRow({
  flow,
  pageId,
  fileId,
  renaming,
  onRename,
  onSelect,
  onRemove,
}: {
  flow: Flow;
  pageId: string;
  fileId: string;
  renaming: boolean;
  onRename: (on: boolean) => void;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const editor = useEditor();
  const live = isScreen(editor.doc, flow.start);
  const count = live ? flowScreens(editor.doc, flow.start).length : 0;
  const selected = useEditorState((s) => s.selection.length === 1 && s.selection[0] === flow.start);
  return (
    <div
      className="proto__row proto__flow"
      data-selected={selected || undefined}
      data-broken={!live || undefined}
    >
      <Link
        to="/f/$fileId/present"
        params={{ fileId }}
        search={{ page: pageId, flow: flow.id }}
        className="proto__play"
        aria-label={`Play ${flow.name}`}
        title={`Play ${flow.name}`}
        aria-disabled={!live || undefined}
        onClick={(e) => {
          if (!live) e.preventDefault();
        }}
      >
        <Icon name="play" size={12} />
      </Link>
      {renaming ? (
        <input
          className="proto__rename"
          aria-label="Flow name"
          defaultValue={flow.name}
          maxLength={64}
          // biome-ignore lint/a11y/noAutofocus: renaming starts from an explicit double-click
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            updateFlow(editor, pageId, { ...flow, name: e.currentTarget.value });
            onRename(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onRename(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="proto__row-main"
          onClick={onSelect}
          onDoubleClick={() => onRename(true)}
          title="Double-click to rename"
        >
          <span className="proto__flow-name">{flow.name}</span>
          <span className="proto__flow-meta">
            {live ? `${count} ${count === 1 ? "screen" : "screens"}` : "Start screen deleted"}
          </span>
        </button>
      )}
      <IconButton
        icon="minus"
        label="Remove flow"
        className="proto__row-remove"
        onClick={onRemove}
      />
    </div>
  );
}

function DeviceSection({ pageId }: { pageId: string }) {
  const editor = useEditor();
  const page = editor.doc.get(pageId);
  if (page?.type !== "page") return null;
  const device = getProp(page.props, "prototypeDevice");
  return (
    <PropertySection title="Device">
      <span className="proto__select-wrap">
        <Icon name="device" size={12} />
        <select
          className="inspector__select proto__select"
          aria-label="Device"
          value={device}
          onChange={(e) => setDevice(editor, pageId, e.target.value as DeviceId)}
        >
          {DEVICE_IDS.map((id) => {
            const d = DEVICES[id];
            return (
              <option key={id} value={id}>
                {d.kind === "none"
                  ? "No device, fit to window"
                  : `${d.name} · ${d.width} × ${d.height}`}
              </option>
            );
          })}
        </select>
      </span>
    </PropertySection>
  );
}
