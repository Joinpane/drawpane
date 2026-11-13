import type { VersionInfo } from "@drawpane/model";
import { Button, Icon } from "@drawpane/ui";
import { Dialog } from "../../app/Dialog";
import { versionTitle, whenLabel, whenPhrase } from "./labels";

/** The strip under the toolbar while a version is on screen. */
export function VersionBanner({
  viewing,
  loading,
  error,
  byId,
  onBack,
}: {
  viewing: VersionInfo | null;
  loading: VersionInfo | null;
  error: string | null;
  byId: ReadonlyMap<string, VersionInfo>;
  onBack: () => void;
}) {
  const shown = loading ?? viewing;
  if (!shown && !error) return null;
  return (
    <div className="version-banner" role="status" aria-live="polite">
      <Icon name={error ? "warning" : "history"} size={16} />
      <span className="version-banner__text">
        {error ? (
          error
        ) : loading ? (
          <>
            Loading <b>{versionTitle(loading, byId)}</b>…
          </>
        ) : shown ? (
          <>
            Viewing <b>{versionTitle(shown, byId)}</b> · {whenLabel(shown.createdAt)} · read-only
          </>
        ) : null}
      </span>
      <button type="button" className="version-banner__back" onClick={onBack}>
        Back to now
      </button>
    </div>
  );
}

/** Confirms restoring the whole file. */
export function RestoreDialog({
  version,
  busy,
  onCancel,
  onConfirm,
}: {
  version: VersionInfo | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={version !== null}
      title="Restore this version?"
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" icon="history" disabled={busy} onClick={onConfirm}>
            {busy ? "Restoring…" : "Restore version"}
          </Button>
        </>
      }
    >
      {version ? (
        <p className="history-dialog__lede">
          {version.name
            ? `The file goes back to “${version.name}”, saved ${whenPhrase(version.createdAt)}, for everyone in it.`
            : `The file goes back to how it was ${whenPhrase(version.createdAt)}, for everyone in it.`}{" "}
          The file as it is now is saved in history first, so you can undo this.
        </p>
      ) : null}
    </Dialog>
  );
}
