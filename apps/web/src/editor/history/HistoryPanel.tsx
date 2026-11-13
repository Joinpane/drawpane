import type { VersionInfo } from "@drawpane/model";
import { Button, SegmentedControl } from "@drawpane/ui";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { presenceSlotFor } from "../comments/people";
import { dayLabel, revisionLabel, versionMeta, versionPeople, versionTitle } from "./labels";

export type HistoryFilter = "all" | "named";

export interface HistoryPanelProps {
  readonly versions: readonly VersionInfo[] | undefined;
  readonly error: string | null;
  /** The version on screen, or null for now. */
  readonly viewing: VersionInfo | null;
  /** A version that is loading. */
  readonly loading: VersionInfo | null;
  readonly revn: number | null;
  readonly canEdit: boolean;
  readonly onView: (version: VersionInfo | null) => void;
  readonly onSave: () => void;
}

/** One entry in the list: now, or a saved version. */
type Row = { readonly kind: "now" } | { readonly kind: "version"; readonly version: VersionInfo };

/**
 * The History tab: the file's saved versions by day, newest first, with the
 * file as it is now on top. Picking one shows it on the canvas; arrow keys
 * walk through them like a scrubber.
 */
export function HistoryPanel({
  versions,
  error,
  viewing,
  loading,
  revn,
  canEdit,
  onView,
  onSave,
}: HistoryPanelProps) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const byId = useMemo(() => new Map((versions ?? []).map((v) => [v.id, v])), [versions]);
  const shown = useMemo(
    () => (versions ?? []).filter((v) => filter === "all" || v.name !== null),
    [versions, filter],
  );
  const rows: Row[] = [
    { kind: "now" },
    ...shown.map((version) => ({ kind: "version" as const, version })),
  ];
  const selectedId = (loading ?? viewing)?.id ?? null;
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) =>
      row.kind === "now" ? selectedId === null : row.version.id === selectedId,
    ),
  );
  const list = useRef<HTMLDivElement>(null);

  const pick = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    onView(row.kind === "now" ? null : row.version);
    requestAnimationFrame(() => {
      list.current
        ?.querySelector<HTMLElement>(`[data-row="${row.kind === "now" ? "now" : row.version.id}"]`)
        ?.focus();
    });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step !== undefined) pick(selectedIndex + step);
    else if (e.key === "Home") pick(0);
    else if (e.key === "End") pick(rows.length - 1);
    else return;
    e.preventDefault();
  };

  // Group the saved versions under day headings.
  const groups: Array<{ day: string; rows: VersionInfo[] }> = [];
  for (const version of shown) {
    const day = dayLabel(version.createdAt);
    const last = groups.at(-1);
    if (last?.day === day) last.rows.push(version);
    else groups.push({ day, rows: [version] });
  }

  const option = (row: Row) => {
    const isNow = row.kind === "now";
    const id = isNow ? null : row.version.id;
    const selected = id === selectedId;
    const version = isNow ? null : row.version;
    const person = version ? versionPeople(version)[0] : undefined;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys for all its options
      <div
        key={id ?? "now"}
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-row={id ?? "now"}
        className="history__row"
        data-named={version?.name ? true : undefined}
        aria-busy={version && loading?.id === version.id ? true : undefined}
        onClick={() => onView(version)}
      >
        <span
          className="history__dot"
          data-now={isNow || undefined}
          style={
            person
              ? ({
                  "--dot": `var(--presence-${presenceSlotFor(person.id)})`,
                } as React.CSSProperties)
              : undefined
          }
          aria-hidden="true"
        />
        <span className="history__text">
          <span className="history__title">
            {version ? versionTitle(version, byId) : "Current version"}
          </span>
          <span className="history__meta">
            {version ? versionMeta(version) : `Live · ${revisionLabel(revn ?? 0)}`}
          </span>
        </span>
        {version && loading?.id === version.id ? (
          <span className="history__spinner" aria-hidden="true" />
        ) : null}
      </div>
    );
  };

  return (
    <div className="history">
      <div className="history__filters">
        <SegmentedControl
          label="Show"
          options={[
            { value: "all", label: "All versions" },
            { value: "named", label: "Named" },
          ]}
          value={filter}
          onChange={(value) => setFilter(value as HistoryFilter)}
        />
      </div>
      <div
        ref={list}
        className="history__list"
        role="listbox"
        aria-label="Versions"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {option(rows[0] as Row)}
        {groups.map((group) => (
          // biome-ignore lint/a11y/useSemanticElements: listbox groups are divs with role group
          <div key={group.day} role="group" aria-label={group.day} className="history__group">
            <div className="history__day" aria-hidden="true">
              {group.day}
            </div>
            {group.rows.map((version) => option({ kind: "version", version }))}
          </div>
        ))}
        {error ? (
          <p className="history__note" role="alert">
            {error}
          </p>
        ) : versions === undefined ? (
          <p className="history__note">Loading versions…</p>
        ) : shown.length === 0 ? (
          <div className="history__empty">
            <p className="history__empty-title">
              {filter === "named" ? "No named versions yet" : "No saved versions yet"}
            </p>
            <p className="history__note">
              {filter === "named"
                ? "Name a version to mark a milestone. Named versions are kept for good."
                : "Drawpane saves a version as you work: when you pause for a few minutes, and at least once an hour while you edit."}
            </p>
          </div>
        ) : (
          <p className="history__note history__note--end">
            Unnamed versions are kept for 30 days. Named ones are kept for good.
          </p>
        )}
      </div>
      {canEdit ? (
        <div className="history__foot">
          <Button size="sm" icon="plus" onClick={onSave}>
            Name this version
          </Button>
        </div>
      ) : null}
    </div>
  );
}
