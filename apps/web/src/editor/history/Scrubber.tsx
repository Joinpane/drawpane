import type { VersionInfo } from "@drawpane/model";
import { Icon, SegmentedControl } from "@drawpane/ui";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { dateLabel, timeLabel, versionTitle, whenLabel } from "./labels";

type Range = "day" | "week" | "all";
const RANGE_MS: Record<Exclude<Range, "all">, number> = {
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
};

/** A point on the track: a saved version, or now (null). */
type Point = VersionInfo | null;

export interface ScrubberProps {
  /** Every saved version, newest first. */
  readonly versions: readonly VersionInfo[];
  readonly byId: ReadonlyMap<string, VersionInfo>;
  /** The version on screen (or loading), or null for now. */
  readonly selected: VersionInfo | null;
  readonly onPick: (version: VersionInfo | null) => void;
}

/**
 * The timeline under the canvas: one tick per saved version, named ones
 * taller, now at the right. Click or drag to look at a version; with focus,
 * ← and → step through them.
 */
export function Scrubber({ versions, byId, selected, onPick }: ScrubberProps) {
  const [range, setRange] = useState<Range>("all");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const oldest = versions.at(-1)?.createdAt ?? now - 60 * 60_000;
  const start =
    range === "all" ? oldest - Math.max(60_000, (now - oldest) * 0.02) : now - RANGE_MS[range];
  const span = Math.max(1, now - start);
  const xOf = (ms: number) => Math.min(1, Math.max(0, (ms - start) / span));

  // Points oldest first, then now.
  const points: Point[] = useMemo(
    () => [...versions.filter((v) => v.createdAt >= start).reverse(), null],
    [versions, start],
  );
  const index = Math.max(
    0,
    points.findIndex((p) => (p === null ? selected === null : p.id === selected?.id)),
  );

  // Looking at a version the range hides: widen it.
  useEffect(() => {
    if (selected && selected.createdAt < start) setRange("all");
  }, [selected, start]);

  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; point: Point } | null>(null);
  const dragging = useRef(false);

  const nearest = (clientX: number): { x: number; point: Point } => {
    const rect = track.current?.getBoundingClientRect();
    const x = rect ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 1;
    let best: Point = null;
    let bestDistance = 1 - x;
    for (const p of points) {
      if (!p) continue;
      const d = Math.abs(xOf(p.createdAt) - x);
      if (d < bestDistance) {
        best = p;
        bestDistance = d;
      }
    }
    return { x, point: best };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    setHover(nearest(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => setHover(nearest(e.clientX));
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    onPick(nearest(e.clientX).point);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    let next: number | null = null;
    if (step !== undefined) next = index + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    if (next === null) return;
    e.preventDefault();
    const point = points[Math.max(0, Math.min(points.length - 1, next))];
    if (point !== undefined) onPick(point);
  };

  const title = (p: Point) => (p ? versionTitle(p, byId) : "Now");
  const when = (p: Point) => (p ? whenLabel(p.createdAt) : "The file as it is now");
  const selectedX = selected ? xOf(selected.createdAt) : 1;

  const mid = start + span / 2;
  // Times for a span under a day and a half, dates beyond.
  const axis = (ms: number) => (span < 36 * 60 * 60_000 ? timeLabel(ms) : dateLabel(ms));

  return (
    <section className="scrubber pane" aria-label="Version timeline">
      <div className="scrubber__head">
        <Icon name="history" size={16} />
        <p className="scrubber__status">
          <b>{title(selected)}</b>
          <span className="scrubber__when">{when(selected)}</span>
        </p>
        <SegmentedControl
          label="Timeline range"
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "all", label: "All" },
          ]}
          value={range}
          onChange={(value) => setRange(value as Range)}
        />
      </div>
      <div
        ref={track}
        className="scrubber__track"
        role="slider"
        tabIndex={0}
        aria-label="Version"
        aria-valuemin={0}
        aria-valuemax={points.length - 1}
        aria-valuenow={index}
        aria-valuetext={`${title(selected)}, ${when(selected)}`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragging.current = false;
          setHover(null);
        }}
        onPointerLeave={() => {
          if (!dragging.current) setHover(null);
        }}
      >
        <span className="scrubber__rail" aria-hidden="true" />
        {points.map((p) =>
          p ? (
            <span
              key={p.id}
              className="scrubber__tick"
              data-named={p.name ? true : undefined}
              data-restore={p.reason === "restore" || undefined}
              style={{ left: `${xOf(p.createdAt) * 100}%` } as CSSProperties}
              aria-hidden="true"
            />
          ) : null,
        )}
        <span
          className="scrubber__now"
          data-current={selected === null || undefined}
          aria-hidden="true"
        />
        {selected ? (
          <span
            className="scrubber__head-marker"
            style={{ left: `${selectedX * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
        {hover ? (
          <span
            className="scrubber__tip"
            style={{ left: `${(hover.point ? xOf(hover.point.createdAt) : 1) * 100}%` }}
            data-edge={
              (hover.point ? xOf(hover.point.createdAt) : 1) > 0.85
                ? "end"
                : (hover.point ? xOf(hover.point.createdAt) : 1) < 0.15
                  ? "start"
                  : undefined
            }
            aria-hidden="true"
          >
            <b>{title(hover.point)}</b>
            <span>{hover.point ? whenLabel(hover.point.createdAt) : "Back to now"}</span>
          </span>
        ) : null}
      </div>
      <div className="scrubber__axis" aria-hidden="true">
        <span>{axis(start)}</span>
        <span>{axis(mid)}</span>
        <span>Now</span>
      </div>
    </section>
  );
}
