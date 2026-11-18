/**
 * The missing fonts panel (decision 0034), as Figma's: every family and
 * style the file uses that isn't here, with how many layers use each, and a
 * replacement for each.
 *
 * - **This file**: the replacements are written into the file, in one change
 *   you can undo, styles and all.
 * - **Every file in the team**: a team font alias. Files keep the family they
 *   name; everyone on the team sees it in the replacement, in every file,
 *   re-imports included. Aliases go by family: each style keeps its weight.
 *
 * Families drawn through an alias (SF Pro in SF Pro Text and SF Pro Display,
 * say) are listed too, so it's clear what's standing in for what.
 */
import {
  type Editor,
  fontFaceKey,
  fontUsage,
  replaceFontOps,
  type TextFace,
} from "@drawpane/editor";
import { builtInFontAlias, type FontAlias, type TeamFontAlias } from "@drawpane/model";
import { Badge, Button, SegmentedControl } from "@drawpane/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Dialog } from "../app/Dialog";
import { type FontFamily, fonts, nearestWeight } from "../fonts/fonts";
import { type FamilyReport, fontReport, styleLabel } from "../fonts/missing-fonts";
import { useFonts } from "./inspector/FontPicker";
import "./missing-fonts.css";

type Scope = "file" | "team";

/**
 * The file's font report, kept up with the document and the registry. It
 * reads every text layer, so it's worked out a beat after edits rather than
 * on each one: a large file stays quick to edit with the page inspector open.
 */
export function useFontReport(editor: Editor): FamilyReport[] | null {
  const version = useSyncExternalStore(
    (cb) => editor.doc.subscribe(cb),
    () => editor.doc.version,
  );
  const registry = useFonts();
  const [report, setReport] = useState<FamilyReport[] | null>(null);
  useEffect(() => {
    void fonts.loadGoogle();
  }, []);
  const ready = report !== null;
  useEffect(() => {
    // Until the catalog is in, a family nobody knows yet may still be a Google one.
    if (fonts.google === null) return;
    const timer = setTimeout(
      () => setReport(fontReport(fontUsage(editor.doc), fonts)),
      ready ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [editor, version, registry]);
  return report;
}

/** Every family a replacement can be, by where it comes from. */
function choices(): Array<{ label: string; families: readonly FontFamily[] }> {
  const seen = new Set<string>();
  const group = (label: string, list: readonly FontFamily[] | null) => {
    const families = (list ?? []).filter((f) => !seen.has(f.family));
    for (const f of families) seen.add(f.family);
    return { label, families };
  };
  return [
    group("Team", fonts.team),
    group(
      "Built in",
      fonts.builtIn.filter((f) => f.source === "bundled"),
    ),
    group(
      "System",
      fonts.builtIn.filter((f) => f.source === "system"),
    ),
    group("Google", fonts.google),
    group("On this computer", fonts.local),
  ].filter((g) => g.families.length > 0);
}

/** A family's styles, as `weight:i` values. */
function stylesOf(f: FontFamily): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const w of f.weights) out.push({ value: `${w}:n`, label: styleLabel(w, false) });
  for (const w of f.italics) out.push({ value: `${w}:i`, label: styleLabel(w, true) });
  return out.length > 0 ? out : [{ value: "400:n", label: "Regular" }];
}

/** The style of `f` nearest a face: the same italic if it has one, then the nearest weight. */
function nearestStyle(f: FontFamily, face: TextFace): string {
  const italic = face.italic ? f.italics.length > 0 : f.weights.length === 0;
  const pool = italic ? f.italics : f.weights;
  if (pool.length === 0) return "400:n";
  return `${nearestWeight(pool, face.weight)}:${italic ? "i" : "n"}`;
}

const parseStyle = (value: string) => {
  const [w, i] = value.split(":");
  return { weight: Number(w), italic: i === "i" };
};

const layers = (n: number) => (n === 1 ? "1 layer" : `${n} layers`);

/** "SF Pro Text below 20 px, SF Pro Display from 20 px". */
function describeAlias(alias: FontAlias, drawnIn: readonly string[]): string {
  const parts = alias.targets
    .filter((t) => drawnIn.includes(t.family))
    .map((t) => {
      if (t.minSize !== undefined && t.maxSize !== undefined)
        return `${t.family} from ${t.minSize} to ${t.maxSize} px`;
      if (t.maxSize !== undefined) return `${t.family} below ${t.maxSize} px`;
      if (t.minSize !== undefined) return `${t.family} from ${t.minSize} px`;
      return t.family;
    });
  return parts.length > 0 ? parts.join(", ") : drawnIn.join(", ");
}

export function MissingFontsDialog({
  editor,
  open,
  onClose,
}: {
  editor: Editor;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title="Missing fonts" size="lg" onClose={onClose}>
      {open ? <MissingFontsBody editor={editor} onClose={onClose} /> : null}
    </Dialog>
  );
}

function MissingFontsBody({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const report = useFontReport(editor);
  const [scope, setScope] = useState<Scope>("file");
  /** The family chosen for each family, and the style for each style (`fontFaceKey`). */
  const [families, setFamilies] = useState<Record<string, string>>({});
  const [styles, setStyles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(choices, [report]);
  const canEdit = editor.canEdit;
  const teamId = fonts.teamId;

  if (!report)
    return <p className="missing-fonts__summary">Checking which fonts this file uses…</p>;

  const missing = report.filter((r) => r.status !== "aliased");
  const aliased = report.filter((r) => r.status === "aliased");
  // An alias stands in for a family that isn't here; a family here missing a style can't have one.
  const listed = scope === "team" ? missing.filter((r) => r.status === "missing") : missing;
  const missingLayers = new Set(
    missing.flatMap((r) => r.styles.filter((s) => s.missing).flatMap((s) => s.layers)),
  ).size;

  const familyFor = (r: FamilyReport) =>
    families[r.family] ?? (r.status === "styles" ? r.family : "");
  const styleFor = (r: FamilyReport, s: FamilyReport["styles"][number]) => {
    const f = fonts.get(familyFor(r));
    return styles[s.key] ?? (f ? nearestStyle(f, s) : "");
  };

  const chosen = listed.filter((r) => fonts.get(familyFor(r)) !== null);

  const replaceInFile = () => {
    const replacements = new Map<string, TextFace>();
    for (const r of listed) {
      const family = familyFor(r);
      const f = fonts.get(family);
      if (!f) continue;
      // A missing family's every style; a family that's here, the styles it lacks.
      for (const s of r.styles)
        if (r.status === "missing" || s.missing)
          replacements.set(fontFaceKey(s), { family, ...parseStyle(styleFor(r, s)) });
    }
    const ops = replaceFontOps(editor.doc, replacements);
    if (ops.length === 0) {
      onClose();
      return;
    }
    if (editor.commit(ops, "Replace fonts")) {
      const count = new Set(ops.map((o) => o.id)).size;
      editor.notify(`Replaced fonts in ${layers(count)}. Undo to put them back.`);
      onClose();
    }
  };

  const saveAliases = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const r of listed) {
        const family = familyFor(r);
        if (family) await fonts.saveAlias({ family: r.family, targets: [{ family }] });
      }
      editor.notify("Saved. Everyone on the team now sees those fonts in what you picked.");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The aliases couldn't be saved.");
    } finally {
      setBusy(false);
    }
  };

  const removeAlias = async (family: string) => {
    setBusy(true);
    setError(null);
    try {
      await fonts.removeAlias(family);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The alias couldn't be removed.");
    } finally {
      setBusy(false);
    }
  };

  const fontCount = missing.length === 1 ? "1 font" : `${missing.length} fonts`;
  const isAre = missing.length === 1 ? "isn't" : "aren't";
  const shows = missingLayers === 1 ? "shows" : "show";
  const summary =
    missing.length === 0
      ? aliased.length > 0
        ? "Every font in this file is available, some through an alias."
        : "Every font in this file is available."
      : `${fontCount} in this file ${isAre} available here, so ${layers(missingLayers)} ${shows} in a fallback font or a nearby style.`;

  return (
    <div className="missing-fonts">
      <p className="missing-fonts__summary">{summary}</p>
      {missing.length > 0 && teamId ? (
        <div className="missing-fonts__scope">
          <SegmentedControl
            label="Replace in"
            options={[
              { value: "file" as const, label: "This file" },
              { value: "team" as const, label: "Every file in the team" },
            ]}
            value={scope}
            onChange={setScope}
          />
          <p className="missing-fonts__hint">
            {scope === "file"
              ? "Rewrites these layers in one change you can undo."
              : "Saves a team font alias. Files keep the font they name, and everyone on the team sees your pick instead, in every file. Each style keeps its weight."}
          </p>
        </div>
      ) : null}

      {listed.length > 0 ? (
        <ul className="missing-fonts__list" aria-label="Missing fonts">
          {listed.map((r) => {
            const family = familyFor(r);
            const target = fonts.get(family);
            return (
              <li key={r.family} className="missing-fonts__family">
                <div className="missing-fonts__head">
                  <span className="missing-fonts__name">{r.family}</span>
                  <span className="missing-fonts__count">{layers(r.layers)}</span>
                  <Badge tone="warning">
                    {r.status === "missing" ? "Missing" : "Missing styles"}
                  </Badge>
                </div>
                {r.status === "missing" ? (
                  <label className="missing-fonts__row">
                    <span className="missing-fonts__label">Replace with</span>
                    <select
                      className="inspector__select"
                      aria-label={`Replace ${r.family} with`}
                      value={family}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFamilies((m) => ({ ...m, [r.family]: value }));
                        // New family, new styles: start from the nearest again.
                        setStyles((m) => {
                          const next = { ...m };
                          for (const s of r.styles) delete next[s.key];
                          return next;
                        });
                      }}
                    >
                      <option value="">Choose a font</option>
                      {groups.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.families.map((f) => (
                            <option key={f.family} value={f.family}>
                              {f.family}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                ) : null}
                {scope === "file" ? (
                  <ul className="missing-fonts__styles">
                    {r.styles
                      .filter((s) => r.status === "missing" || s.missing)
                      .map((s) => (
                        <li key={s.key} className="missing-fonts__row">
                          <span className="missing-fonts__label">
                            {s.label}
                            <span className="missing-fonts__count">
                              {layers(s.layers.length)}
                              {s.styles > 0
                                ? ` · ${s.styles === 1 ? "1 style" : `${s.styles} styles`}`
                                : ""}
                            </span>
                          </span>
                          <select
                            className="inspector__select"
                            aria-label={`${r.family} ${s.label} becomes`}
                            disabled={!target}
                            value={target ? styleFor(r, s) : ""}
                            onChange={(e) => {
                              const value = e.target.value;
                              setStyles((m) => ({ ...m, [s.key]: value }));
                            }}
                          >
                            {target ? (
                              stylesOf(target).map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))
                            ) : (
                              <option value="">Style</option>
                            )}
                          </select>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {aliased.length > 0 ? (
        <section className="missing-fonts__aliases" aria-label="Shown through aliases">
          <h3 className="missing-fonts__subhead">Shown through aliases</h3>
          <ul className="missing-fonts__list">
            {aliased.map((r) => {
              const own = (fonts.aliases ?? []).find((a) => a.family === r.family) as
                | TeamFontAlias
                | undefined;
              const alias = r.via === "team" ? own : builtInFontAlias(r.family);
              const short = r.styles.filter((s) => s.missing);
              return (
                <li key={r.family} className="missing-fonts__family">
                  <div className="missing-fonts__head">
                    <span className="missing-fonts__name">{r.family}</span>
                    <span className="missing-fonts__count">{layers(r.layers)}</span>
                    <Badge tone={r.via === "team" ? "component" : "neutral"}>
                      {r.via === "team" ? "Team alias" : "Built in"}
                    </Badge>
                  </div>
                  <p className="missing-fonts__alias">
                    Shown in {alias ? describeAlias(alias, r.drawnIn) : r.drawnIn.join(", ")}.
                    {short.length > 0
                      ? ` Not every style is there: ${short.map((s) => s.label).join(", ")} ${short.length === 1 ? "shows" : "show"} in the nearest.`
                      : ""}
                  </p>
                  {r.via === "team" && own ? (
                    <div className="missing-fonts__row missing-fonts__row--end">
                      <span className="missing-fonts__count">
                        {own.updatedBy ? `Set by ${own.updatedBy}` : "Set for the team"}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeAlias(r.family)}
                      >
                        Remove alias
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {error ? (
        <p className="missing-fonts__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="app-dialog__footer">
        <Button size="lg" variant="ghost" onClick={onClose}>
          {listed.length > 0 ? "Cancel" : "Close"}
        </Button>
        {listed.length > 0 ? (
          scope === "file" ? (
            <Button
              size="lg"
              variant="primary"
              disabled={!canEdit || chosen.length === 0}
              onClick={replaceInFile}
            >
              Replace fonts
            </Button>
          ) : (
            <Button
              size="lg"
              variant="primary"
              disabled={busy || chosen.length === 0}
              onClick={() => void saveAliases()}
            >
              Save for the team
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}
