import type { Editor } from "@drawpane/editor";
import type { VersionInfo } from "@drawpane/model";
import { Button, Icon, MenuButton, type MenuItem } from "@drawpane/ui";
import { modKey } from "../../app/format";
import { Avatar } from "../comments/people";
import { useEditorStateOutside } from "../hooks";
import {
  changeRows,
  count,
  KIND_ICON,
  KIND_LABEL,
  revisionLabel,
  versionByline,
  versionTitle,
} from "./labels";
import { layersLabel } from "./restore";

export interface VersionDetailsProps {
  readonly version: VersionInfo;
  readonly byId: ReadonlyMap<string, VersionInfo>;
  /** The version's read-only editor, for its selection. */
  readonly preview: Editor;
  readonly canEdit: boolean;
  readonly restoring: boolean;
  readonly onRestoreFile: () => void;
  readonly onRestoreLayers: (ids: readonly string[]) => void;
  readonly onCopyLayers: () => void;
  readonly onName: () => void;
  readonly onUnname: () => void;
}

/**
 * The right pane while looking at a version: what it is, what changed in it,
 * and the ways back: restore the selected layers, or the whole file.
 */
export function VersionDetails({
  version,
  byId,
  preview,
  canEdit,
  restoring,
  onRestoreFile,
  onRestoreLayers,
  onCopyLayers,
  onName,
  onUnname,
}: VersionDetailsProps) {
  const selection = useEditorStateOutside(preview, (s) => s.selection);
  const rows = changeRows(version);
  const menuItems: MenuItem[] = [
    {
      id: "name",
      label: version.name ? "Rename…" : "Name this version…",
      icon: "text",
      onSelect: onName,
    },
    ...(version.name
      ? [{ id: "unname", label: "Remove name", icon: "close" as const, onSelect: onUnname }]
      : []),
  ];

  return (
    <div className="version">
      <header className="version__head">
        <div className="version__heading">
          <h2 className="version__title">{versionTitle(version, byId)}</h2>
          <p className="version__byline">{versionByline(version)}</p>
        </div>
        {canEdit ? (
          <MenuButton label="Version options" items={menuItems} className="version__more" />
        ) : null}
      </header>
      {version.description ? <p className="version__description">{version.description}</p> : null}

      <div className="version__body">
        <section className="version__section" aria-labelledby="version-changes">
          <div className="version__section-head">
            <h3 id="version-changes" className="version__section-title">
              {version.reason === "restore" ? "Edits before the restore" : "Edits in this version"}
            </h3>
            <span className="version__caption">
              {version.summary.edits > 0 ? count(version.summary.edits, "edit") : null}
            </span>
          </div>
          {rows.length > 0 ? (
            <ul className="version__changes">
              {rows.map((row) => (
                <li key={row.kind} className="version__change">
                  <Icon name={KIND_ICON[row.kind]} size={12} />
                  <span>{KIND_LABEL[row.kind]}</span>
                  <span className="version__count">{row.n}</span>
                </li>
              ))}
              {rows.reduce((sum, row) => sum + row.n, 0) > version.summary.edits ? (
                // One edit can restyle and move at once: it counts under each.
                <li className="version__note version__note--fine">
                  Some edits made more than one kind of change.
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="version__note">
              {version.summary.edits === 0
                ? "No edit details were kept for this version."
                : "Edits that changed nothing visible."}
            </p>
          )}
          {version.authors.length > 0 ? (
            <ul className="version__people" aria-label="Edited by">
              {version.authors.map((person) => (
                <li key={person.id} className="version__person">
                  <Avatar person={person} />
                  <span>{person.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="version__section" aria-labelledby="version-layers">
          <div className="version__section-head">
            <h3 id="version-layers" className="version__section-title">
              Layers
            </h3>
            <span className="version__caption">{revisionLabel(version.revn)}</span>
          </div>
          {selection.length > 0 ? (
            <>
              <p className="version__note">
                {selection.length === 1
                  ? `${layersLabel(preview, selection)} as it was in this version.`
                  : `${count(selection.length, "layer")} as they were in this version.`}
              </p>
              <div className="version__layer-actions">
                {canEdit ? (
                  <Button
                    size="sm"
                    icon="history"
                    onClick={() => onRestoreLayers(selection)}
                    disabled={restoring}
                  >
                    {selection.length === 1 ? "Restore layer" : "Restore layers"}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" shortcut={modKey("C")} onClick={onCopyLayers}>
                  Copy
                </Button>
              </div>
            </>
          ) : (
            <p className="version__note">
              {canEdit
                ? "Select layers on the canvas to bring just those back, or copy them into now."
                : "Select layers on the canvas to inspect or copy them."}
            </p>
          )}
        </section>
      </div>

      <footer className="version__foot">
        {canEdit ? (
          <>
            <Button
              variant="secondary"
              icon="history"
              className="version__restore"
              onClick={onRestoreFile}
              disabled={restoring}
            >
              {restoring ? "Restoring…" : "Restore this version"}
            </Button>
            <p className="version__note">
              Restoring adds a new revision for everyone. The file as it is now is saved first, so
              nothing is lost.
            </p>
          </>
        ) : (
          <p className="version__note">Only editors can restore versions.</p>
        )}
      </footer>
    </div>
  );
}
