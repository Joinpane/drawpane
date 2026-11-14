/**
 * Publishing a file as a team library (docs/decisions/0010-team-libraries.md):
 * its components, what changed since the last publish, and a note for the
 * files that use it.
 */
import { assetChanges, libraryAssets } from "@drawpane/editor";
import type { LibraryAsset } from "@drawpane/model";
import { Button, Icon } from "@drawpane/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../../api/client";
import { Dialog } from "../../app/Dialog";
import { whenPhrase } from "../history/labels";
import { useEditor } from "../hooks";
import { useLibraryHistory } from "./LibrarySections";

type Status = "new" | "changed" | "same";

export function PublishDialog({
  open,
  fileId,
  onClose,
}: {
  open: boolean;
  fileId: string;
  onClose: () => void;
}) {
  const editor = useEditor();
  const queries = useQueryClient();
  const history = useLibraryHistory(fileId);
  const [description, setDescription] = useState("");
  const descriptionId = useId();
  // What it offers, read when the dialog opens.
  const assets = useMemo(() => (open ? libraryAssets(editor.doc) : []), [open, editor]);
  const last = history.data?.[0] ?? null;
  const changes = assetChanges(last?.assets ?? [], assets);
  const status = (a: LibraryAsset): Status =>
    !last || changes.added.some((x) => x.id === a.id)
      ? "new"
      : changes.changed.some((x) => x.id === a.id)
        ? "changed"
        : "same";
  const changed = changes.added.length + changes.changed.length + changes.removed.length;
  const nothingNew = last !== null && changed === 0;

  const publish = useMutation({
    // The server reads what's offered from the version it saves: this list is a preview.
    mutationFn: () => api.publishLibrary(fileId, { description: description.trim() }),
    onSuccess: ({ publish: published }) => {
      void queries.invalidateQueries({ queryKey: ["library", fileId] });
      const n = published.assets.length;
      editor.notify(`Published ${n} ${n === 1 ? "component" : "components"} to the team.`);
      onClose();
    },
  });
  useEffect(() => {
    if (!open) return;
    setDescription("");
    publish.reset();
  }, [open, publish.reset]);

  const submit = () => {
    if (assets.length > 0 && !nothingNew && !publish.isPending) publish.mutate();
  };
  return (
    <Dialog
      open={open}
      title={last ? "Publish library changes" : "Publish as a library"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={assets.length === 0 || nothingNew || publish.isPending || history.isPending}
            onClick={submit}
          >
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </>
      }
    >
      <p className="library-dialog__lede">
        {last
          ? `Last published ${whenPhrase(last.publishedAt)}. Files using this library are told, and choose when to update.`
          : "Anyone on your team can use this file’s components in their files. When you publish again, those files choose when to take the changes."}
      </p>
      {assets.length === 0 ? (
        <div className="library-dialog__empty">
          <Icon name="component" size={16} />
          <p>This file has no components yet. Make one, then publish.</p>
        </div>
      ) : (
        <>
          <h3 className="library-dialog__group-title">
            Components <span className="library-dialog__count">{assets.length}</span>
            {last && changed > 0 ? (
              <span className="library-dialog__summary">
                {[
                  changes.changed.length ? `${changes.changed.length} changed` : null,
                  changes.added.length ? `${changes.added.length} new` : null,
                  changes.removed.length ? `${changes.removed.length} removed` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </h3>
          <ul className="library-dialog__list library-dialog__list--status">
            {assets.map((a) => {
              const s = status(a);
              return (
                <li key={a.id} data-status={s}>
                  <Icon name="component" size={12} />
                  <span className="library-dialog__item">{a.name}</span>
                  {s !== "same" ? (
                    <span className="library-dialog__badge">{s === "new" ? "New" : "Changed"}</span>
                  ) : null}
                </li>
              );
            })}
            {changes.removed.map((a) => (
              <li key={a.id} data-status="removed">
                <Icon name="component" size={12} />
                <span className="library-dialog__item">{a.name}</span>
                <span className="library-dialog__badge">Removed</span>
              </li>
            ))}
          </ul>
          {nothingNew ? (
            <p className="library-dialog__hint">Nothing changed since the last publish.</p>
          ) : (
            <div className="dp-tf">
              <label className="dp-tf__label" htmlFor={descriptionId}>
                What changed <span className="library-dialog__optional">optional</span>
              </label>
              <textarea
                id={descriptionId}
                className="dp-tf__input library-dialog__textarea"
                placeholder="Rounder buttons, a new Card"
                value={description}
                maxLength={2000}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
              />
            </div>
          )}
        </>
      )}
      {publish.error ? (
        <p className="library-dialog__error" role="alert">
          {publish.error.message}
        </p>
      ) : null}
    </Dialog>
  );
}
