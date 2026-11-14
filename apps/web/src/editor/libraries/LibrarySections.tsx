/**
 * Team libraries in the Assets panel (docs/decisions/0010-team-libraries.md):
 * a section for each library the file uses, with its published components
 * to insert (click, or drag onto the canvas), and its updates to review.
 */
import {
  assetChanges,
  type Editor,
  type LibraryRef,
  libraryAssets,
  updateOps,
  usedLibraries,
} from "@drawpane/editor";
import type { LibraryAsset, LibraryPublish } from "@drawpane/model";
import { Button, Icon } from "@drawpane/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { Dialog } from "../../app/Dialog";
import { ComponentPreview } from "../ComponentPreview";
import { whenPhrase } from "../history/labels";
import { useDocVersion, useEditor } from "../hooks";
import { LIBRARY_DRAG_MIME, type LibraryDrag, librarySource, refOf } from "./sources";

/** A library's publishes, newest first: the one a file has, and the latest. */
export function useLibraryHistory(libraryFileId: string) {
  return useQuery({
    queryKey: ["library", libraryFileId],
    queryFn: async () => (await api.libraryPublishes(libraryFileId)).publishes,
    staleTime: 30_000,
  });
}

/** The libraries this file uses, a section each; `query` filters their components by name. */
export function LibrarySections({ query }: { query: string }) {
  const editor = useEditor();
  const version = useDocVersion();
  const used = useMemo(() => usedLibraries(editor.doc), [editor, version]);
  return (
    <>
      {used.map((lib) => (
        <LibrarySection key={lib.fileId} lib={lib} query={query} />
      ))}
    </>
  );
}

function LibrarySection({ lib, query }: { lib: LibraryRef; query: string }) {
  const editor = useEditor();
  const history = useLibraryHistory(lib.fileId);
  // The publish this file has, however old (the history lists the latest ones).
  const currentQuery = useQuery({
    queryKey: ["library-publish", lib.fileId, lib.publishId],
    queryFn: async () => (await api.libraryPublish(lib.fileId, lib.publishId)).publish,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const current = currentQuery.data ?? null;
  const latest = history.data?.[0] ?? null;
  const source = useQuery({
    queryKey: ["library-source", current?.id],
    queryFn: () => librarySource(current as LibraryPublish, editor.measurer),
    enabled: current !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [reviewing, setReviewing] = useState(false);
  const q = query.trim().toLowerCase();
  const assets = (current?.assets ?? []).filter(
    (a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
  );
  const hasUpdate = latest !== null && latest.id !== lib.publishId;
  if (q && assets.length === 0) return null;
  return (
    <section className="assets__group assets__library" aria-label={lib.name}>
      <div className="assets__library-head">
        <Icon name="book" size={12} />
        <h3 className="assets__group-title">{lib.name}</h3>
        {hasUpdate ? (
          <button
            type="button"
            className="assets__update"
            onClick={() => setReviewing(true)}
            disabled={!editor.canEdit}
          >
            Update
          </button>
        ) : null}
      </div>
      {history.isError || currentQuery.isError || source.isError ? (
        <p className="assets__empty-body assets__pad">
          Couldn’t load {lib.name}.{" "}
          <button
            type="button"
            className="assets__link"
            onClick={() => {
              void history.refetch();
              void currentQuery.refetch();
              void source.refetch();
            }}
          >
            Try again
          </button>
        </p>
      ) : !source.data ? (
        <p className="assets__empty-body assets__pad" role="status">
          Loading {lib.name}…
        </p>
      ) : assets.length === 0 ? (
        <p className="assets__empty-body assets__pad">This library has no components.</p>
      ) : (
        <ul className="assets__grid">
          {assets.map((asset) => (
            <li key={asset.id}>
              <LibraryTile asset={asset} source={source.data} publish={current as LibraryPublish} />
            </li>
          ))}
        </ul>
      )}
      {reviewing && latest ? (
        <ReviewUpdatesDialog
          current={current}
          latest={latest}
          onClose={() => setReviewing(false)}
        />
      ) : null}
    </section>
  );
}

function LibraryTile({
  asset,
  source,
  publish,
}: {
  asset: LibraryAsset;
  source: Editor;
  publish: LibraryPublish;
}) {
  const editor = useEditor();
  const node = source.doc.get(asset.id);
  const drag: LibraryDrag = {
    publishId: publish.id,
    fileId: publish.fileId,
    name: publish.fileName,
    assetId: asset.id,
  };
  return (
    <button
      type="button"
      className="assets__tile"
      title={asset.description ? `${asset.name}: ${asset.description}` : asset.name}
      draggable={editor.canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBRARY_DRAG_MIME, JSON.stringify(drag));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => editor.insertLibraryComponent(source.doc, refOf(publish), asset.id)}
      disabled={!editor.canEdit}
    >
      {node ? <ComponentPreview node={node} source={source} /> : null}
      <span className="assets__name">{asset.name}</span>
    </button>
  );
}

/**
 * A library's updates: what its newer publish changed, added and removed,
 * from the two publishes' lists; taking them updates every copy, and every
 * instance follows, keeping its overrides.
 */
function ReviewUpdatesDialog({
  current,
  latest,
  onClose,
}: {
  current: LibraryPublish | null;
  latest: LibraryPublish;
  onClose: () => void;
}) {
  const editor = useEditor();
  // Without the publish the file has (pruned from the list), everything counts as changed.
  const changes = assetChanges(current?.assets ?? [], latest.assets);
  const update = useMutation({
    mutationFn: async () => {
      const source = await librarySource(latest, editor.measurer);
      // Nothing to change counts as done; a refused edit keeps the dialog open to say so.
      if (
        updateOps(editor.doc, source.doc, refOf(latest)).length > 0 &&
        !editor.updateLibrary(source.doc, refOf(latest))
      )
        throw new Error("This file couldn't take the update. Reload it and try again.");
    },
    onSuccess: () => {
      editor.notify(`Updated ${latest.fileName}.`);
      onClose();
    },
  });
  const by = latest.publishedBy?.name;
  const groups: Array<[string, readonly LibraryAsset[], string]> = [
    [
      "Changed",
      changes.changed,
      "Instances in this file follow, keeping what you changed in them.",
    ],
    ["New", changes.added, "Ready to insert from Assets."],
    ["Removed", changes.removed, "Kept in this file as they are, so nothing breaks."],
  ];
  return (
    <Dialog
      open
      title={`Update ${latest.fileName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate()}>
            {update.isPending ? "Updating…" : "Update"}
          </Button>
        </>
      }
    >
      <p className="library-dialog__lede">
        Published {whenPhrase(latest.publishedAt)}
        {by ? ` by ${by}` : ""}.
      </p>
      {latest.description ? <p className="library-dialog__note">{latest.description}</p> : null}
      {groups.map(([title, list, note]) =>
        list.length > 0 ? (
          <section key={title} className="library-dialog__group" aria-label={title}>
            <h3 className="library-dialog__group-title">
              {title} <span className="library-dialog__count">{list.length}</span>
            </h3>
            <p className="library-dialog__hint">{note}</p>
            <ul className="library-dialog__list">
              {list.map((a) => (
                <li key={a.id}>
                  <Icon name="component" size={12} />
                  {a.name}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {changes.changed.length + changes.added.length + changes.removed.length === 0 ? (
        <p className="library-dialog__hint">No component changed: this takes its latest publish.</p>
      ) : null}
      {update.error ? (
        <p className="library-dialog__error" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </Dialog>
  );
}

/**
 * The team's libraries, to start or stop using in this file. Stopping needs
 * the file to have no instances of its components left.
 */
export function BrowseLibrariesDialog({
  open,
  fileId,
  onClose,
  onPublish,
}: {
  open: boolean;
  fileId: string;
  onClose: () => void;
  /** Publishes this file's own components (opens its dialog). */
  onPublish: () => void;
}) {
  const editor = useEditor();
  const version = useDocVersion();
  const own = useLibraryHistory(fileId);
  const ownCount = useMemo(
    () => (open ? libraryAssets(editor.doc).length : 0),
    [open, editor, version],
  );
  const ownLast = own.data?.[0] ?? null;
  const available = useQuery({
    queryKey: ["libraries", fileId],
    queryFn: async () => (await api.availableLibraries(fileId)).libraries,
    enabled: open,
  });
  const used = useMemo(
    () => new Set(usedLibraries(editor.doc).map((l) => l.fileId)),
    [editor, version],
  );
  return (
    <Dialog
      open={open}
      title="Team libraries"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="library-row library-row--own">
        <span className="library-row__icon" aria-hidden="true">
          <Icon name="component" size={16} />
        </span>
        <span className="library-row__text">
          <span className="library-row__name">This file</span>
          <span className="library-row__meta">
            {ownCount} {ownCount === 1 ? "component" : "components"}
            {ownLast ? ` · published ${whenPhrase(ownLast.publishedAt)}` : " · not published"}
          </span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!editor.canEdit || ownCount === 0}
          onClick={onPublish}
        >
          Publish…
        </Button>
      </div>
      <h3 className="library-dialog__group-title">From your team</h3>
      <p className="library-dialog__hint">
        Use a library to insert its components here. When it publishes again, you choose when to
        take the changes.
      </p>
      {available.isPending ? (
        <p className="library-dialog__hint" role="status">
          Loading libraries…
        </p>
      ) : available.isError ? (
        <p className="library-dialog__error" role="alert">
          Couldn’t load the team’s libraries.
        </p>
      ) : available.data.length === 0 ? (
        <div className="library-dialog__empty">
          <Icon name="book" size={16} />
          <p>
            No libraries yet. Publish one from a file with components: <b>Publish library…</b> in
            its File menu, or in Assets.
          </p>
        </div>
      ) : (
        <ul className="library-dialog__libraries">
          {available.data.map((lib) => {
            const inUse = used.has(lib.fileId);
            const count = lib.assets.length;
            return (
              <li key={lib.fileId} className="library-row">
                <span className="library-row__icon" aria-hidden="true">
                  <Icon name="book" size={16} />
                </span>
                <span className="library-row__text">
                  <span className="library-row__name">{lib.fileName}</span>
                  <span className="library-row__meta">
                    {count} {count === 1 ? "component" : "components"} · published{" "}
                    {whenPhrase(lib.publishedAt)}
                  </span>
                </span>
                {inUse ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!editor.canEdit}
                    aria-label={`Stop using ${lib.fileName}`}
                    onClick={() => editor.stopUsingLibrary(lib.fileId)}
                  >
                    Stop using
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!editor.canEdit}
                    aria-label={`Use ${lib.fileName}`}
                    onClick={() => editor.useLibrary(refOf(lib))}
                  >
                    Use
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
