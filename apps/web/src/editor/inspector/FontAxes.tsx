/**
 * Variable axes (decision 0009): a row showing what text sets, opening a
 * panel with a slider for each axis its font has (weight, width, optical
 * size, the font's own). Reading the axes loads HarfBuzz and the family's
 * variable file, so it waits for the panel to open.
 */
import type { Editor, FontAxis } from "@drawpane/editor";
import { type FontVariations, getProp, type NodeRecord } from "@drawpane/model";
import { SliderField } from "@drawpane/ui";
import { useEffect, useState } from "react";
import { fonts } from "../../fonts/fonts";
import { shaper } from "../shaping";
import { axisName, axisStep, onAxis, variationSummary, withAxis } from "./variable-axes";

type Axes =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly axes: readonly FontAxis[] };

const sameAxes = (a: FontVariations, b: FontVariations) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** The axes every one of `maps` sets alike: what a change keeps when they differ. */
function shared(maps: readonly FontVariations[]): FontVariations {
  const [first = {}, ...rest] = maps;
  return Object.fromEntries(
    Object.entries(first).filter(([tag, v]) => rest.every((m) => m[tag] === v)),
  );
}

/** Whether a family might have axes: a variable Google or built-in family, or a team font (its file says). */
function mayVary(family: string): boolean {
  const info = fonts.get(family);
  return !!info && (info.source === "team" || info.variable);
}

/** The axes of the family's variable file, read once the panel opens. */
function useAxes(
  face: { family: string; weight: number; italic: boolean } | null,
  attempt: number,
) {
  const key = face ? `${face.family}\u0000${face.italic}\u0000${attempt}` : "";
  const [state, setState] = useState<{ key: string; axes: Axes }>({
    key: "",
    axes: { status: "loading" },
  });
  useEffect(() => {
    if (!face) return;
    let alive = true;
    void shaper.axes(face).then((axes) => {
      if (alive)
        setState({ key, axes: axes ? { status: "ready", axes } : { status: "unavailable" } });
    });
    return () => {
      alive = false;
    };
    // The face is read through `key`, which names it.
  }, [key]);
  return state.key === key ? state.axes : ({ status: "loading" } as const);
}

/** Whether the layers' text can vary: a variable family, or axes set already. */
export function canVary(nodes: readonly NodeRecord[]): boolean {
  const lead = nodes[0];
  return (
    (!!lead && mayVary(getProp(lead.props, "fontFamily"))) ||
    nodes.some((n) => Object.keys(getProp(n.props, "fontVariations")).length > 0)
  );
}

/** Where the layers' axes are set, for a summary; null when it's the font's defaults. */
export function axesSummary(nodes: readonly NodeRecord[]): string | null {
  const maps = nodes.map((n) => getProp(n.props, "fontVariations"));
  const first = maps[0] ?? {};
  return maps.every((m) => sameAxes(m, first)) ? variationSummary(first) : "Mixed axes";
}

/** The font's axes, as sliders (Type settings, Variable). */
export function AxesPanel({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const lead = nodes[0];
  const face = lead
    ? {
        family: getProp(lead.props, "fontFamily"),
        weight: getProp(lead.props, "fontWeight"),
        italic: getProp(lead.props, "fontStyle") === "italic",
      }
    : null;
  const [attempt, setAttempt] = useState(0);
  const state = useAxes(face, attempt);
  const maps = nodes.map((n) => getProp(n.props, "fontVariations"));
  const setAnywhere = maps.some((m) => Object.keys(m).length > 0);
  const ids = [...new Set(nodes.map((n) => n.id))];
  const family = face?.family ?? "";
  const size = lead ? getProp(lead.props, "fontSize") : 16;

  /** Sets one axis on every layer, keeping the axes its looks (runs) share. */
  const setAxis = (axis: FontAxis, value: number | null, label: string) => {
    const byId = new Map<string, FontVariations[]>();
    for (const n of nodes)
      byId.set(n.id, [...(byId.get(n.id) ?? []), getProp(n.props, "fontVariations")]);
    for (const [id, looks] of byId) {
      const next = withAxis(shared(looks), axis.tag, value);
      editor.setProp([id], "fontVariations", Object.keys(next).length ? next : null, label);
    }
  };

  const currentValue = (axis: FontAxis): number => {
    if (axis.tag === "wght") return face?.weight ?? axis.default;
    const set = maps[0]?.[axis.tag];
    if (set !== undefined) return set;
    // Optical size follows the font size until it's set.
    if (axis.tag === "opsz") return onAxis(axis, size);
    return axis.default;
  };

  const change = (axis: FontAxis, raw: number) => {
    const name = axisName(axis);
    const value = onAxis(axis, raw);
    if (axis.tag === "wght") {
      editor.setProp(ids, "fontWeight", Math.round(value), "Font weight");
      return;
    }
    // At the font's default, the axis is left out: the text draws as the font comes.
    setAxis(axis, value === axis.default && axis.tag !== "opsz" ? null : value, name);
  };

  return (
    <div className="features__body">
      <div className="features__head">
        <span className="features__title">Variable axes</span>
        <span className="features__family">{family}</span>
      </div>
      {state.status === "loading" ? (
        <p className="features__note" role="status">
          Reading {family}’s axes…
        </p>
      ) : state.status === "unavailable" ? (
        <div className="features__retry">
          <p className="features__note">
            {family}’s variable font file isn’t available, so its axes can’t be set. Text in it
            draws at its weight.
          </p>
          <button
            type="button"
            className="features__reset"
            onClick={() => {
              if (face) shaper.retry({ ...face, variable: true });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : state.axes.length === 0 ? (
        <p className="features__note">{family} has no variable axes.</p>
      ) : (
        <div className="axes">
          {state.axes.map((axis) => {
            const name = axisName(axis);
            const auto = axis.tag === "opsz" && maps.every((m) => m.opsz === undefined);
            return (
              <div key={axis.tag} className="axes__axis">
                <div className="axes__head">
                  <span className="axes__name">{name}</span>
                  {axis.tag === "opsz" ? (
                    <button
                      type="button"
                      className="axes__auto"
                      aria-pressed={auto}
                      title={auto ? "Follows the font size" : "Follow the font size"}
                      onClick={() =>
                        setAxis(
                          axis,
                          auto ? currentValue(axis) : null,
                          auto ? name : `${name}: auto`,
                        )
                      }
                    >
                      Auto
                    </button>
                  ) : (
                    <code className="features__tag">{axis.tag}</code>
                  )}
                </div>
                <SliderField
                  label={name}
                  value={currentValue(axis)}
                  min={axis.min}
                  max={axis.max}
                  step={axisStep(axis)}
                  onChange={(v) => change(axis, v)}
                  onScrubStart={() => editor.beginGesture(name)}
                  onScrubEnd={() => editor.endGesture()}
                />
              </div>
            );
          })}
        </div>
      )}
      {setAnywhere ? (
        <div className="features__foot">
          <button
            type="button"
            className="features__reset"
            onClick={() => editor.setProp(ids, "fontVariations", null, "Reset variable axes")}
          >
            Back to the font’s defaults
          </button>
        </div>
      ) : null}
    </div>
  );
}
