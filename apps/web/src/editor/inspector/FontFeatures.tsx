/**
 * OpenType features (decision 0005): a row showing what's on, opening a
 * panel of the features the text's font offers, as checkboxes. Reading the
 * font's features loads HarfBuzz and the font file, so it waits for the
 * panel to open.
 */
import type { Editor } from "@drawpane/editor";
import { type FontFeatures, getProp, type NodeRecord } from "@drawpane/model";
import { Icon, Popover } from "@drawpane/ui";
import { useEffect, useRef, useState } from "react";
import { fonts } from "../../fonts/fonts";
import { shaper } from "../shaping";
import { featureGroups, featureOn, featureSummary, withFeature } from "./opentype";

type Offered =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly names: ReadonlyMap<string, string | null> };

const sameMap = (a: FontFeatures, b: FontFeatures) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** The features every one of `maps` sets alike: what a change keeps when they differ. */
function shared(maps: readonly FontFeatures[]): FontFeatures {
  const [first = {}, ...rest] = maps;
  return Object.fromEntries(
    Object.entries(first).filter(([tag, on]) => rest.every((m) => m[tag] === on)),
  );
}

/** What the font of `face` offers, read once the panel opens. */
function useOffered(
  face: { family: string; weight: number; italic: boolean } | null,
  /** Bumped to read the font again after it failed. */
  attempt = 0,
): Offered {
  const key = face ? `${face.family}\u0000${face.weight}\u0000${face.italic}\u0000${attempt}` : "";
  const [state, setState] = useState<{ key: string; offered: Offered }>({
    key: "",
    offered: { status: "loading" },
  });
  useEffect(() => {
    if (!face) return;
    let alive = true;
    void shaper.offered(face).then((list) => {
      if (!alive) return;
      setState({
        key,
        offered: list
          ? { status: "ready", names: new Map(list.map((f) => [f.tag, f.name])) }
          : { status: "unavailable" },
      });
    });
    return () => {
      alive = false;
    };
    // The face is read through `key`, which names it.
  }, [key]);
  return state.key === key ? state.offered : { status: "loading" };
}

export function FontFeaturesField({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const maps = nodes.map((n) => getProp(n.props, "fontFeatures"));
  const first = maps[0] ?? {};
  const mixed = !maps.every((m) => sameMap(m, first));
  const summary = mixed ? "Mixed" : featureSummary(first);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="font-trigger features-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`OpenType features: ${summary ?? "as the font has them"}`}
        onClick={() => setOpen(!open)}
      >
        <span className="features-trigger__label" aria-hidden="true">
          OpenType
        </span>
        <span
          className={`font-trigger__name${summary ? "" : " features-trigger__default"}`}
          aria-hidden="true"
        >
          {summary ?? "Font defaults"}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && trigger.current ? (
        <Popover
          anchor={trigger.current}
          label="OpenType features"
          className="features dp-root"
          onClose={() => setOpen(false)}
        >
          <FeaturesPanel editor={editor} nodes={nodes} />
        </Popover>
      ) : null}
    </>
  );
}

function FeaturesPanel({ editor, nodes }: { editor: Editor; nodes: NodeRecord[] }) {
  const lead = nodes[0];
  const face = lead
    ? {
        family: getProp(lead.props, "fontFamily"),
        weight: getProp(lead.props, "fontWeight"),
        italic: getProp(lead.props, "fontStyle") === "italic",
      }
    : null;
  const [attempt, setAttempt] = useState(0);
  const offered = useOffered(face, attempt);
  const maps = nodes.map((n) => getProp(n.props, "fontFeatures"));
  const setAnywhere: FontFeatures = Object.assign({}, ...maps);

  const toggle = (tag: string, on: boolean, label: string) => {
    // Per layer: the features its looks (runs) share, with this one changed.
    const byId = new Map<string, FontFeatures[]>();
    for (const n of nodes)
      byId.set(n.id, [...(byId.get(n.id) ?? []), getProp(n.props, "fontFeatures")]);
    const verb = on ? "Turn on" : "Turn off";
    editor.beginGesture(`${verb} ${label.toLowerCase()}`);
    for (const [id, looks] of byId)
      editor.setProp([id], "fontFeatures", withFeature(shared(looks), tag, on), label);
    editor.endGesture();
  };

  const reset = () => {
    editor.setProp(
      [...new Set(nodes.map((n) => n.id))],
      "fontFeatures",
      null,
      "Reset OpenType features",
    );
  };

  const family = face?.family ?? "";
  return (
    <div className="features__body">
      <div className="features__head">
        <span className="features__title">OpenType features</span>
        <span className="features__family">{family}</span>
      </div>
      {offered.status === "loading" ? (
        <p className="features__note" role="status">
          Reading {family}’s features…
        </p>
      ) : offered.status === "unavailable" ? (
        <Unavailable
          family={family}
          onRetry={() => {
            if (face) shaper.retry(face);
            setAttempt((n) => n + 1);
          }}
        />
      ) : (
        (() => {
          const groups = featureGroups(offered.names, setAnywhere);
          if (groups.length === 0)
            return <p className="features__note">{family} has no features to turn on or off.</p>;
          return groups.map((group) => (
            <fieldset key={group.title} className="features__group">
              <legend className="features__legend">{group.title}</legend>
              {group.choices.map((choice) => {
                const states = maps.map((m) => featureOn(m, choice.tag));
                const on = states.every(Boolean);
                const some = !on && states.some(Boolean);
                return (
                  <label key={choice.tag} className="features__item">
                    <input
                      type="checkbox"
                      checked={on}
                      ref={(el) => {
                        if (el) el.indeterminate = some;
                      }}
                      onChange={() => toggle(choice.tag, !on, choice.label)}
                    />
                    <span className="features__label">{choice.label}</span>
                    <code className="features__tag">{choice.tag}</code>
                  </label>
                );
              })}
            </fieldset>
          ));
        })()
      )}
      {Object.keys(setAnywhere).length > 0 ? (
        <div className="features__foot">
          <button type="button" className="features__reset" onClick={reset}>
            Back to the font’s defaults
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Why a font's features can't be read, and what to do about it: a font on
 * this computer only, a team font uploaded only as WOFF (HarfBuzz reads
 * TrueType and OpenType files), or a file that didn't load (try again).
 */
function Unavailable({ family, onRetry }: { family: string; onRetry: () => void }) {
  const info = fonts.get(family);
  if (!info || info.source === "system" || info.source === "local")
    return (
      <p className="features__note">
        {family} isn’t a Google, team or built-in font, so its features can’t be read. Text in it
        draws without them.
      </p>
    );
  if (
    info.source === "team" &&
    (info.faces ?? []).every((f) => f.format === "woff" || f.format === "woff2")
  )
    return (
      <p className="features__note">
        {family} was uploaded as WOFF, which features can’t be read from. Upload its TTF or OTF
        files under Fonts to use them.
      </p>
    );
  return (
    <div className="features__retry">
      <p className="features__note">
        {family}’s font file didn’t load, so its features can’t be read.
      </p>
      <button type="button" className="features__reset" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
