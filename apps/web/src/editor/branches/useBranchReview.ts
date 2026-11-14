/**
 * Reviewing a branch from inside it (decision 0012): its base and main come
 * from the server, the branch is the live document, so the changes follow
 * edits made during review. Choices (a side per conflict, changes left out)
 * stay in this hook until the merge sends them.
 */
import type { Editor } from "@drawpane/editor";
import { type BranchInfo, branchChanges, nodeReader, type Resolution } from "@drawpane/model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { ApiError, api } from "../../api/client";
import { type MergePlan, mergePlan, type ReviewRow, reviewRows } from "./review";

export interface BranchReviewState {
  readonly rows: readonly ReviewRow[] | null;
  readonly plan: MergePlan | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** Main's revisions since the branch was made, when known. */
  readonly mainMoved: number | null;
  readonly resolutions: ReadonlyMap<string, Resolution>;
  readonly skipped: ReadonlySet<string>;
  resolve(key: string, side: Resolution): void;
  /** Includes a change in the merge, or leaves it out. */
  include(key: string, included: boolean): void;
  merge(): void;
  readonly merging: boolean;
  /** Why the last merge didn't go through. */
  readonly mergeError: string | null;
}

export function useBranchReview(
  editor: Editor,
  /** The branch open in `editor`; null on a main file, where there's nothing to review. */
  branch: BranchInfo | null,
  enabled: boolean,
  onMerged: (merged: { branch: BranchInfo; restorePoint: string }) => void,
): BranchReviewState {
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: ["branch-review", branch?.id],
    queryFn: () => api.branchReview(branch?.id as string),
    enabled: enabled && branch !== null,
    // Main may move while this is open: read it again on coming back to the tab.
    staleTime: 0,
  });
  // The live branch: rows follow edits made during review.
  const version = useSyncExternalStore(
    (notify) => editor.doc.subscribe(notify),
    () => editor.doc.version,
  );
  const live = useEditorLive(editor);
  const rows = useMemo(() => {
    void version;
    if (!review.data || !live) return null;
    const docs = {
      base: nodeReader(review.data.base),
      branch: editor.doc,
      main: nodeReader(review.data.main),
    };
    return reviewRows(branchChanges(docs.base, docs.branch, docs.main), docs);
  }, [review.data, editor, version, live]);

  const [resolutions, setResolutions] = useState<ReadonlyMap<string, Resolution>>(new Map());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const resolve = useCallback((key: string, side: Resolution) => {
    setResolutions((prev) => new Map(prev).set(key, side));
  }, []);
  const include = useCallback((key: string, included: boolean) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (included) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const plan = useMemo(
    () => (rows ? mergePlan(rows, { resolutions, skipped }) : null),
    [rows, resolutions, skipped],
  );

  const mutation = useMutation({
    mutationFn: () => {
      // Only choices about changes that are still there.
      const keys = new Set(rows?.map((r) => r.key));
      return api.mergeBranch(branch?.id as string, {
        resolutions: Object.fromEntries([...resolutions].filter(([k]) => keys.has(k))),
        skip: [...skipped].filter((k) => keys.has(k)),
      });
    },
    onSuccess: (merged) => {
      void queryClient.invalidateQueries({ queryKey: ["file", branch?.id] });
      void queryClient.invalidateQueries({ queryKey: ["branches"] });
      onMerged(merged);
    },
    onError: (error) => {
      // Main moved under the review: show it as it is now.
      if (error instanceof ApiError && error.status === 409) void review.refetch();
    },
  });

  return {
    rows,
    plan,
    loading: review.isPending || (review.isSuccess && !live),
    error: review.error ? review.error.message : null,
    mainMoved: review.data && branch ? Math.max(0, review.data.mainRevn - branch.baseRevn) : null,
    resolutions,
    skipped,
    resolve,
    include,
    merge: () => {
      if (plan?.ready && !mutation.isPending) mutation.mutate();
    },
    merging: mutation.isPending,
    mergeError: mutation.error ? mutation.error.message : null,
  };
}

/** The branch's document has arrived (its rows mean nothing before). */
function useEditorLive(editor: Editor): boolean {
  return useSyncExternalStore(
    (notify) => editor.state.subscribe(notify),
    () => editor.s.status === "live",
  );
}
