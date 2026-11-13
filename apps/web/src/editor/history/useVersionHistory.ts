import type { Editor } from "@drawpane/editor";
import type { VersionInfo } from "@drawpane/model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../../api/client";
import { shareImages } from "../media";
import { versionReference } from "./labels";
import { layersLabel, restoreLayers } from "./restore";
import { VersionView } from "./view";

/** A version's nodes stay cached this long after you stop looking at it. */
const SNAPSHOT_CACHE_MS = 5 * 60_000;

/**
 * Everything the editor page needs for version history: the version list,
 * looking at a version, and restoring (layers or the whole file), with the
 * messages that go with each.
 */
export function useVersionHistory(editor: Editor, fileId: string, listOpen: boolean) {
  const queryClient = useQueryClient();
  const [view] = useState(() => {
    const v = new VersionView(editor, (version) =>
      queryClient.fetchQuery({
        queryKey: ["version-nodes", fileId, version.id],
        queryFn: () => api.versionNodes(fileId, version.id),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: SNAPSHOT_CACHE_MS,
      }),
    );
    shareImages(editor, v.preview);
    return v;
  });
  const state = useSyncExternalStore(view.state.subscribe, view.state.get);
  const open = listOpen || state.viewing !== null || state.loading !== null;

  const list = useQuery({
    queryKey: ["versions", fileId],
    queryFn: () => api.versions(fileId),
    enabled: open,
    // Autosaves happen in the room on their own; keep the list fresh while it shows.
    refetchInterval: open ? 60_000 : false,
  });
  const versions = list.data?.versions;
  const byId = useMemo(() => new Map((versions ?? []).map((v) => [v.id, v])), [versions]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["versions", fileId] });

  // The version on screen, kept up to date when it's renamed.
  const viewing = state.viewing ? (byId.get(state.viewing.id) ?? state.viewing) : null;

  // Someone else restored the file: say who, and show the new restore point.
  useEffect(
    () =>
      editor.sync.on("restored", (by, version) => {
        editor.notify(
          `${by.name} restored ${versionReference({ name: version.name, createdAt: version.at })}.`,
        );
        void refresh();
      }),
    [editor],
  );

  // Leaving the file view (tokens, a fatal error) leaves the version too.
  useEffect(() => () => view.leave(), [view]);

  const restoreFile = useMutation({
    mutationFn: (version: VersionInfo) =>
      api.restoreVersion(fileId, version.id, editor.sync.sessionId),
    onSuccess: (result, version) => {
      view.leave();
      void refresh();
      if (result.changed === 0) {
        editor.notify("The file already matches that version.");
        return;
      }
      editor.notify(`Restored ${versionReference(version)}.`, {
        label: "Undo",
        run: () => {
          void api
            .restoreVersion(fileId, result.restorePoint, editor.sync.sessionId)
            .then(() => {
              editor.notify("Put the file back as it was before the restore.");
              void refresh();
            })
            .catch((error: Error) => editor.notify(error.message));
        },
      });
    },
    onError: (error) => editor.notify(error.message),
  });

  const unname = useMutation({
    mutationFn: (version: VersionInfo) => api.updateVersion(fileId, version.id, { name: null }),
    onSuccess: () => void refresh(),
    onError: (error) => editor.notify(error.message),
  });

  return {
    view,
    state,
    open,
    versions,
    byId,
    error: list.error?.message ?? null,
    viewing,
    /** The editor whose document is on screen. */
    active: state.viewing ? view.preview : editor,
    show: (version: VersionInfo | null) => {
      if (version) void view.show(version);
      else view.leave();
    },
    leave: view.leave,
    refresh,
    restoreFile,
    unname,
    restoreLayers: (ids: readonly string[]) => {
      const version = state.viewing;
      if (!version) return;
      const result = restoreLayers(editor, view.preview, ids);
      switch (result.kind) {
        case "restored":
          editor.notify(
            `Restored ${layersLabel(view.preview, result.ids)} from ${versionReference(version)}.`,
            {
              label: "Show",
              run: () => {
                view.leave();
                const page = editor.doc.pageOf(result.ids[0] as string);
                if (page && page.id !== editor.s.pageId) editor.setPage(page.id);
                editor.select(result.ids);
                requestAnimationFrame(() => editor.revealSelection());
              },
            },
          );
          return;
        case "unchanged":
          editor.notify(`${layersLabel(view.preview, result.ids)} already matches this version.`);
          return;
        case "nothing":
          editor.notify("There's nowhere to put that back. Restore the whole version instead.");
          return;
        case "failed":
          return;
      }
    },
    copyLayers: () => {
      const data = view.preview.copy();
      if (!data) return;
      void navigator.clipboard.writeText(data).then(
        () => editor.notify("Copied from this version. Go back to now and paste."),
        () => editor.notify("Couldn't copy. Allow clipboard access and try again."),
      );
    },
  };
}

export type VersionHistory = ReturnType<typeof useVersionHistory>;
