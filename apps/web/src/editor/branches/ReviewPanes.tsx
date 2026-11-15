/**
 * Reviewing a branch (decision 0012): the changes on the left, each named by
 * its layer and said in words, conflicts first with a side to pick; what
 * merging will do on the right, with the merge itself.
 */
import type { BranchInfo, Resolution } from "@drawpane/model";
import { Badge, Button, Icon, IconButton, type IconName } from "@drawpane/ui";
import { useEffect, useRef } from "react";
import { isMac, modKey } from "../../app/format";
import { count, revisionLabel, whenPhrase } from "../history/labels";
import type { ChangeKind, ReviewRow } from "./review";
import { kindCounts } from "./review";
import type { BranchReviewState } from "./useBranchReview";
import "./branches.css";

const KIND_WORD: Record<ChangeKind, string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
};

export function ReviewPane({
  branch,
  main,
  review,
  canMerge,
  active,
  onSelect,
  onClose,
}: {
  branch: BranchInfo;
  main: { readonly name: string };
  review: BranchReviewState;
  canMerge: boolean;
  /** The change picked here or on the canvas. */
  active: string | null;
  /** Shows a change's layer on the canvas. */
  onSelect: (row: ReviewRow) => void;
  onClose: () => void;
}) {
  const rows = review.rows;
  const counts = rows ? kindCounts(rows) : null;
  const who = branch.createdBy?.name ?? "Someone";
  return (
    <aside className="pane pane--left review" aria-label="Branch review">
      <header className="review__head">
        <div className="review__heading">
          <h2 className="review__title">
            <span className="review__branch">{branch.name}</span>
            <Icon name="arrow-right" size={12} />
            <span className="review__main">{main.name}</span>
          </h2>
          <p className="review__byline">
            {who} branched {whenPhrase(branch.createdAt)}, from{" "}
            {revisionLabel(branch.baseRevn).toLowerCase()}
          </p>
        </div>
        <IconButton icon="close" label="Close review" onClick={onClose} />
      </header>
      {counts && rows && rows.length > 0 ? (
        <div className="review__counts">
          {counts.added > 0 ? <Badge tone="success">{counts.added} added</Badge> : null}
          {counts.changed > 0 ? <Badge tone="info">{counts.changed} changed</Badge> : null}
          {counts.removed > 0 ? (
            <Badge tone="danger" icon="trash">
              {counts.removed} removed
            </Badge>
          ) : null}
        </div>
      ) : null}
      <div className="review__body">
        {review.loading ? (
          <ul className="review__list" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="review__skeleton" />
            ))}
          </ul>
        ) : review.error ? (
          <p className="review__note" role="alert">
            {review.error}
          </p>
        ) : !rows || rows.length === 0 ? (
          <div className="review__empty">
            <Icon name="branch" size={16} />
            <p>
              No changes yet. Edit this branch, then review it here: {main.name} doesn't change
              until you merge.
            </p>
          </div>
        ) : (
          <ol className="review__list">
            {rows.map((row, i) => (
              <ReviewItem
                key={row.key}
                row={row}
                n={i + 1}
                active={row.key === active}
                included={!review.skipped.has(row.key)}
                side={review.resolutions.get(row.key) ?? null}
                canMerge={canMerge}
                onSelect={() => onSelect(row)}
                onInclude={(on) => review.include(row.key, on)}
                onResolve={(side) => review.resolve(row.key, side)}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function ReviewItem({
  row,
  n,
  active,
  included,
  side,
  canMerge,
  onSelect,
  onInclude,
  onResolve,
}: {
  row: ReviewRow;
  n: number;
  active: boolean;
  included: boolean;
  side: Resolution | null;
  canMerge: boolean;
  onSelect: () => void;
  onInclude: (included: boolean) => void;
  onResolve: (side: Resolution) => void;
}) {
  const status = row.conflict ? (side ? "Decided" : "Conflict") : KIND_WORD[row.kind];
  const item = useRef<HTMLLIElement>(null);
  // Picked on the canvas: bring it into view in the list.
  useEffect(() => {
    if (active) item.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li
      ref={item}
      className="review-row"
      data-active={active || undefined}
      data-kind={row.kind}
      data-conflict={row.conflict || undefined}
      data-skipped={!included || undefined}
    >
      <div className="review-row__line">
        {canMerge ? (
          <input
            type="checkbox"
            className="review-row__check"
            checked={included}
            aria-label={`Merge “${row.layer}”: ${row.detail}`}
            onChange={(e) => onInclude(e.currentTarget.checked)}
          />
        ) : null}
        <button type="button" className="review-row__main" onClick={onSelect}>
          <span className="review-row__n" aria-hidden="true">
            {n}
          </span>
          <span className="review-row__text">
            <span className="review-row__layer">{row.layer}</span>
            <span className="review-row__detail">{row.detail}</span>
          </span>
          <span className="review-row__status">{status}</span>
        </button>
      </div>
      {row.conflict && row.sides && included ? (
        <fieldset className="review-row__sides" disabled={!canMerge}>
          <legend className="review-row__legend">Keep which?</legend>
          <SideOption
            label="Main"
            value={row.sides.main}
            checked={side === "main"}
            onPick={() => onResolve("main")}
          />
          <SideOption
            label="This branch"
            value={row.sides.branch}
            checked={side === "branch"}
            onPick={() => onResolve("branch")}
          />
        </fieldset>
      ) : null}
    </li>
  );
}

function SideOption({
  label,
  value,
  checked,
  onPick,
}: {
  label: string;
  value: string;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <label className="review-side" data-checked={checked || undefined}>
      <input type="radio" checked={checked} onChange={onPick} className="review-side__radio" />
      <span className="review-side__text">
        <span className="review-side__label">Keep {label.toLowerCase()}</span>
        <span className="review-side__value">{value}</span>
      </span>
    </label>
  );
}

export function MergePane({
  main,
  review,
  canMerge,
}: {
  main: { readonly name: string };
  review: BranchReviewState;
  canMerge: boolean;
}) {
  const plan = review.plan;
  // ⌘↵ merges, from anywhere in the editor, once it's ready.
  useEffect(() => {
    if (!canMerge || !plan?.ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(isMac() ? e.metaKey : e.ctrlKey)) return;
      if (document.querySelector("dialog[open]:modal")) return;
      e.preventDefault();
      e.stopPropagation();
      review.merge();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [canMerge, plan?.ready, review.merge]);

  return (
    <aside className="pane pane--right merge" aria-label="Merge">
      <h2 className="merge__title">Before merging</h2>
      {plan ? (
        <ul className="merge__checks">
          {plan.conflicts === 0 ? (
            <Check ok icon="check" title="No conflicts with main" />
          ) : (
            <Check
              ok={plan.undecided === 0}
              icon={plan.undecided === 0 ? "check" : "warning"}
              title={
                plan.undecided === 0
                  ? `${count(plan.conflicts, "conflict")} resolved`
                  : `${count(plan.undecided, "conflict")} to resolve`
              }
              detail={`${plan.conflicts - plan.undecided} of ${plan.conflicts} decided`}
            />
          )}
          {review.mainMoved !== null ? (
            review.mainMoved > 0 ? (
              <Check
                ok
                icon="history"
                title={`${main.name} moved since you branched`}
                detail={`${count(review.mainMoved, "revision")}: the merge goes onto the latest`}
              />
            ) : (
              <Check ok icon="check" title={`${main.name} hasn't changed since you branched`} />
            )
          ) : null}
          {plan.undecided > 0 ? null : (
            <Check
              ok={plan.included > 0}
              icon={plan.included > 0 ? "check" : "warning"}
              title={
                plan.total === 0
                  ? "Nothing to merge yet"
                  : `${plan.included} of ${count(plan.total, "change")} included`
              }
              detail={
                plan.included < plan.total ? "Changes left out stay on this branch" : undefined
              }
            />
          )}
        </ul>
      ) : (
        <ul className="merge__checks" aria-busy="true">
          <li className="review__skeleton" />
        </ul>
      )}
      <footer className="merge__foot">
        {review.mergeError ? (
          <p className="merge__error" role="alert">
            {review.mergeError}
          </p>
        ) : null}
        <p className="merge__note">
          {canMerge && plan && plan.undecided > 0
            ? "Pick a side for each conflict, then merge."
            : canMerge
              ? `Merging applies ${plan ? count(plan.included, "change") : "the changes"} to ${main.name} as one revision. ${main.name} keeps a restore point in History.`
              : `Only editors of ${main.name} can merge branches into it.`}
        </p>
        {canMerge ? (
          <Button
            variant="primary"
            icon="branch"
            className="merge__button"
            shortcut={modKey("↵")}
            disabled={!plan?.ready || review.merging}
            onClick={review.merge}
          >
            {review.merging ? "Merging…" : `Merge into ${main.name}`}
          </Button>
        ) : null}
      </footer>
    </aside>
  );
}

function Check({
  ok,
  icon,
  title,
  detail,
}: {
  ok: boolean;
  icon: IconName;
  title: string;
  detail?: string | undefined;
}) {
  return (
    <li className="merge-check" data-ok={ok || undefined}>
      <Icon name={icon} size={16} />
      <span className="merge-check__text">
        <span className="merge-check__title">{title}</span>
        {detail ? <span className="merge-check__detail">{detail}</span> : null}
      </span>
    </li>
  );
}
