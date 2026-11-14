/**
 * Accessibility at selection (PRD): a layer the prototype taps, on a phone
 * or tablet board, that's smaller than a comfortable tap target says so here,
 * with a fix that grows it around its centre. See packages/editor/src/accessibility.ts.
 */
import { tapTargetIssue } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { Button, Icon, PropertySection } from "@drawpane/ui";
import { useDocVersion, useEditor } from "../hooks";

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function AccessibilitySection({ nodes }: { nodes: readonly NodeRecord[] }) {
  const editor = useEditor();
  useDocVersion();
  const only = nodes.length === 1 ? nodes[0] : undefined;
  const issue = only ? tapTargetIssue(editor, only.id) : null;
  if (!only || !issue) return null;
  return (
    <PropertySection title="Accessibility">
      <div className="a11y-note" role="note">
        <Icon name="warning" size={12} />
        <span>
          Tapped, but {n(issue.width)} × {n(issue.height)}. On touch screens, make tap targets at
          least {issue.min} × {issue.min}.
        </span>
      </div>
      {issue.growable && editor.canEdit ? (
        <Button size="sm" onClick={() => editor.growTapTarget(only.id)}>
          Grow to {issue.min} × {issue.min}
        </Button>
      ) : null}
    </PropertySection>
  );
}
