import {
  componentSetOf,
  countChanges,
  instanceProperties,
  instanceRootOf,
  instancesOf,
  isComponentSet,
  isMainComponent,
  swapTargets,
} from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Button, DropdownMenu, Icon, IconButton, PropertySection } from "@drawpane/ui";
import { useEffect, useState } from "react";
import { useEditor } from "./hooks";
import { InstancePropertiesPanel } from "./InstanceProperties";
import { ComponentPropertiesList, ComponentSetSection, VariantSection } from "./VariantSections";

/**
 * What a component, an instance or a layer inside one is, and what you can do
 * with it: describe a main component, jump to it, reset changes, detach.
 */
export function ComponentSection({ nodes }: { nodes: readonly NodeRecord[] }) {
  const editor = useEditor();
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (!only) {
    const instances = nodes.filter((n) => getProp(n.props, "instanceOf") !== null);
    if (instances.length === 0) return null;
    return (
      <PropertySection title="Instances">
        <div className="component-actions">
          <Button size="sm" onClick={() => editor.resetInstances()}>
            Reset all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => editor.detachInstances()}>
            Detach all
          </Button>
        </div>
      </PropertySection>
    );
  }

  if (isComponentSet(only)) return <ComponentSetSection set={only} />;
  if (isMainComponent(only)) {
    return (
      <>
        {componentSetOf(editor.doc, only.id) ? (
          <VariantSection variant={only} />
        ) : (
          <ComponentPropertiesList owner={only} />
        )}
        <MainComponent node={only} />
      </>
    );
  }

  const root = instanceRootOf(editor.doc, only.id);
  if (!root) return null;
  const mainId = getProp(root.props, "instanceOf");
  const main = mainId ? editor.doc.get(mainId) : undefined;
  const isRoot = root.id === only.id;
  const changed = countChanges(editor.doc, root.id, instanceProperties(editor.doc, root.id));

  return (
    <PropertySection
      title={isRoot ? "Main component" : "Instance"}
      actions={
        main ? (
          <IconButton
            icon="component"
            label="Go to main component"
            onClick={() => editor.goToMainComponent(only.id)}
          />
        ) : null
      }
    >
      <p className="component-note">
        <Icon name="instance" size={12} />
        <span>
          {main ? (
            <>
              {isRoot ? "Instance of " : "Part of "}
              <button
                type="button"
                className="component-link"
                onClick={() => editor.goToMainComponent(only.id)}
              >
                {getProp((componentSetOf(editor.doc, main.id) ?? main).props, "name") ||
                  "Component"}
              </button>
            </>
          ) : (
            "Its main component was deleted."
          )}
        </span>
      </p>
      {!isRoot ? (
        <p className="component-hint">
          Changes here stay on this instance when the main component changes.
        </p>
      ) : null}
      {isRoot && main ? <InstancePropertiesPanel instance={only} /> : null}
      {changed > 0 || isRoot ? (
        <div className="component-actions">
          {changed > 0 ? (
            <Button size="sm" onClick={() => editor.resetInstances()}>
              {changed === 1 ? "Reset 1 change" : `Reset all ${changed} changes`}
            </Button>
          ) : null}
          {isRoot ? <SwapInstance instanceId={only.id} /> : null}
          {isRoot ? (
            <Button size="sm" onClick={() => editor.detachInstances()}>
              Detach
            </Button>
          ) : null}
        </div>
      ) : null}
    </PropertySection>
  );
}

/** "Swap…": the components this instance can become, keeping its overrides. */
function SwapInstance({ instanceId }: { instanceId: string }) {
  const editor = useEditor();
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // Read only when the menu opens: finding them reads every component in the
  // file, which in a kit-sized file is more than selecting an instance should wait for.
  const targets = open ? swapTargets(editor.doc, instanceId) : [];
  if (!editor.canEdit) return null;
  return (
    <>
      <Button
        ref={setButton}
        size="sm"
        icon="instance"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Swap…
      </Button>
      {open && button ? (
        <DropdownMenu
          anchor={button}
          label="Swap instance with"
          align="start"
          items={
            targets.length > 0
              ? targets.map((t) => ({
                  id: t.id,
                  label: t.label,
                  onSelect: () => editor.swapInstance(instanceId, t.id),
                }))
              : [{ id: "none", label: "No other components", disabled: true, onSelect: () => {} }]
          }
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function MainComponent({ node }: { node: NodeRecord }) {
  const editor = useEditor();
  const description = getProp(node.props, "componentDescription");
  const [draft, setDraft] = useState(description);
  useEffect(() => setDraft(description), [description]);
  const uses = instancesOf(editor.doc, node.id).length;
  return (
    <PropertySection title="Usage">
      <p className="component-note">
        <Icon name="component" size={12} />
        <span>
          {uses === 0 ? "Not used yet" : `Used ${uses} ${uses === 1 ? "time" : "times"}`}
          {" · "}
          <button
            type="button"
            className="component-link"
            onClick={() => editor.insertInstance(node.id)}
          >
            Insert an instance
          </button>
        </span>
      </p>
      <textarea
        className="component-description"
        aria-label="Component description"
        placeholder="Describe when to use it"
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== description)
            editor.setProp([node.id], "componentDescription", draft || null, "Describe component");
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            setDraft(description);
            e.currentTarget.blur();
          }
        }}
      />
      {uses > 0 ? (
        <div className="component-actions">
          <Button size="sm" onClick={() => editor.select([...instancesOf(editor.doc, node.id)])}>
            Select instances
          </Button>
        </div>
      ) : null}
    </PropertySection>
  );
}
