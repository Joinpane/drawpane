/**
 * Editing a prototype: adding, changing and removing reactions, connecting a
 * layer to a screen, and managing a page's flows and device. Each command is
 * one undoable edit.
 */
import {
  actionTarget,
  type DeviceId,
  type Flow,
  getProp,
  newId,
  type Op,
  type Reaction,
} from "@drawpane/model";
import type { Editor } from "../editor";
import {
  isScreen,
  newReaction,
  pageOf,
  reactionsOf,
  screenOf,
  screensInReadingOrder,
} from "./screens";

function setReactions(
  editor: Editor,
  id: string,
  list: readonly Reaction[],
  label: string,
): boolean {
  return editor.commit([{ op: "set", id, prop: "reactions", value: list }], label);
}

/** Adds a reaction to a layer. Returns its id. */
export function addReaction(editor: Editor, id: string, reaction?: Reaction): string | null {
  const node = editor.doc.get(id);
  if (!node || node.type === "page") return null;
  const next = reaction ?? newReaction(defaultTarget(editor, id));
  return setReactions(editor, id, [...reactionsOf(node), next], "Add interaction") ? next.id : null;
}

export function updateReaction(editor: Editor, id: string, reaction: Reaction): void {
  const list = reactionsOf(editor.doc.get(id));
  const index = list.findIndex((r) => r.id === reaction.id);
  if (index === -1 || JSON.stringify(list[index]) === JSON.stringify(reaction)) return;
  setReactions(editor, id, list.with(index, reaction), "Change interaction");
}

export function removeReaction(editor: Editor, id: string, reactionId: string): void {
  const list = reactionsOf(editor.doc.get(id));
  if (!list.some((r) => r.id === reactionId)) return;
  setReactions(
    editor,
    id,
    list.filter((r) => r.id !== reactionId),
    "Remove interaction",
  );
}

/**
 * The screen a new interaction should lead to: the next screen after the
 * layer's own, so a fresh interaction already does something sensible.
 */
export function defaultTarget(editor: Editor, id: string): string | null {
  const page = pageOf(editor.doc, id);
  if (!page) return null;
  const screens = screensInReadingOrder(editor.doc, page);
  const own = screenOf(editor.doc, id);
  const index = own ? screens.indexOf(own) : -1;
  return screens[index + 1] ?? screens.find((s) => s !== own) ?? null;
}

/**
 * Connects a layer to a screen, as when you drag its connection handle onto
 * one: re-targets the layer's first tap interaction that goes somewhere, or
 * adds a tap → navigate. The first connection on a page also starts a flow
 * there, so the prototype can play straight away.
 */
export function connectToScreen(editor: Editor, sourceId: string, targetId: string): boolean {
  const doc = editor.doc;
  const source = doc.get(sourceId);
  if (!source || !isScreen(doc, targetId)) return false;
  const page = pageOf(doc, sourceId);
  if (!page || pageOf(doc, targetId) !== page) return false;
  if (screenOf(doc, sourceId) === targetId) return false;

  const list = reactionsOf(source);
  const index = list.findIndex((r) => r.trigger.type === "tap" && actionTarget(r.action) !== null);
  const existing = list[index];
  let next: readonly Reaction[];
  if (existing) {
    if (actionTarget(existing.action) === targetId) return false;
    next = list.with(index, {
      ...existing,
      action: { ...existing.action, to: targetId } as Reaction["action"],
    });
  } else {
    next = [...list, newReaction(targetId)];
  }
  const ops: Op[] = [{ op: "set", id: sourceId, prop: "reactions", value: next }];
  const pageNode = doc.get(page);
  const start = screenOf(doc, sourceId);
  if (pageNode && start && getProp(pageNode.props, "flows").length === 0) {
    ops.push({
      op: "set",
      id: page,
      prop: "flows",
      value: [{ id: newId(), name: "Flow 1", start, description: "" }],
    });
  }
  return editor.commit(ops, existing ? "Change connection" : "Connect");
}

/** Removes the layer's interactions that lead to a screen (dragging a connection off into space). */
export function disconnectFromScreen(editor: Editor, sourceId: string, targetId: string): void {
  const list = reactionsOf(editor.doc.get(sourceId));
  const next = list.filter((r) => actionTarget(r.action) !== targetId);
  if (next.length !== list.length) setReactions(editor, sourceId, next, "Remove connection");
}

// ---------------------------------------------------------------------------
// Flows

function flowsOf(editor: Editor, page: string): readonly Flow[] {
  const node = editor.doc.get(page);
  return node?.type === "page" ? getProp(node.props, "flows") : [];
}

/** "Flow 3": the first unused number. */
function nextFlowName(flows: readonly Flow[]): string {
  const taken = new Set(flows.map((f) => f.name));
  for (let n = flows.length + 1; ; n++) if (!taken.has(`Flow ${n}`)) return `Flow ${n}`;
}

/** Starts a flow on a screen. Returns the flow's id. */
export function addFlow(editor: Editor, start: string, name?: string): string | null {
  const page = pageOf(editor.doc, start);
  if (!page || !isScreen(editor.doc, start)) return null;
  const flows = flowsOf(editor, page);
  const flow: Flow = {
    id: newId(),
    name: name?.trim().slice(0, 64) || nextFlowName(flows),
    start,
    description: "",
  };
  return editor.commit(
    [{ op: "set", id: page, prop: "flows", value: [...flows, flow] }],
    "Add flow",
  )
    ? flow.id
    : null;
}

export function updateFlow(editor: Editor, page: string, flow: Flow): void {
  const flows = flowsOf(editor, page);
  const index = flows.findIndex((f) => f.id === flow.id);
  if (index === -1) return;
  const clean = { ...flow, name: flow.name.trim().slice(0, 64) || (flows[index] as Flow).name };
  if (JSON.stringify(flows[index]) === JSON.stringify(clean)) return;
  editor.commit(
    [{ op: "set", id: page, prop: "flows", value: flows.with(index, clean) }],
    "Change flow",
  );
}

export function removeFlow(editor: Editor, page: string, flowId: string): void {
  const flows = flowsOf(editor, page);
  if (!flows.some((f) => f.id === flowId)) return;
  editor.commit(
    [{ op: "set", id: page, prop: "flows", value: flows.filter((f) => f.id !== flowId) }],
    "Remove flow",
  );
}

export function setDevice(editor: Editor, page: string, device: DeviceId): void {
  editor.setProp([page], "prototypeDevice", device, "Change device");
}
