/**
 * Import from Figma (a .fig file it saved, or a file's link and a personal
 * access token) or from Penpot (a .penpot export), then watch each file
 * come across (reading, images, converting, saving), with a short note on
 * anything that couldn't come across exactly, and a way to open it.
 *
 * A .fig too large for one Drawpane file has its pages chosen first, by
 * their estimated sizes, and can then be imported again, other pages into
 * another file, without reading it twice.
 */

import type { FigPage } from "@drawpane/fig";
import { Button, Icon, SegmentedControl, Switch, TextField } from "@drawpane/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../app/Dialog";
import { FigImportError, isFigFile, type OpenedFigImport, openFigImport } from "./fig-import";
import { figmaFileKey, importFigma } from "./figma-import";
import { FILE_LAYERS } from "./import-save";
import { type FileImport, importPenpot, isPenpotFile } from "./penpot-import";

type Phase = "choose" | "running" | "pages" | "finished";
type Source = "figma" | "penpot";

/** Where a Figma token is kept: for this tab, or (when asked) on this device. */
const TOKEN_KEY = "drawpane:figma-token";
function savedToken(): { token: string; remembered: boolean } {
  try {
    const remembered = localStorage.getItem(TOKEN_KEY);
    if (remembered) return { token: remembered, remembered: true };
    return { token: sessionStorage.getItem(TOKEN_KEY) ?? "", remembered: false };
  } catch {
    return { token: "", remembered: false };
  }
}
function saveToken(token: string, remember: boolean): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked: the token is used for this import only.
  }
}

export function ImportDialog({
  open,
  projectId,
  projectName,
  file,
  onClose,
  onImported,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  /** A file dropped on the dashboard: imported as soon as the dialog opens. */
  file: File | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const navigate = useNavigate();
  const [source, setSource] = useState<Source>("figma");
  const [link, setLink] = useState("");
  const [token, setToken] = useState(() => savedToken().token);
  const [remember, setRemember] = useState(() => savedToken().remembered);
  const [phase, setPhase] = useState<Phase>("choose");
  const [rows, setRows] = useState<readonly FileImport[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Whether the error is about a chosen file or the link form, so it shows beside the right one. */
  const [errorAt, setErrorAt] = useState<"file" | "link">("link");
  /** An opened .fig too large for one file, while its pages are being chosen and imported. */
  const [fig, setFig] = useState<OpenedFigImport | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  /**
   * Estimated layers the chosen pages may come to: FILE_LAYERS, until an import of this file
   * proves too large once converted and shows how much fits.
   */
  const [budget, setBudget] = useState(FILE_LAYERS);
  /** Its pages imported so far, this time the dialog is open. */
  const [imported, setImported] = useState<ReadonlySet<string>>(new Set());
  // The worker holding a decoded file goes when the dialog does.
  const figRef = useRef<OpenedFigImport | null>(null);
  figRef.current = fig;
  useEffect(() => () => figRef.current?.close(), []);

  /**
   * Imports some (or all, for null) of an opened .fig's pages. Whether the file is kept open
   * afterwards, to choose (other) pages: when there were too many, or when only some came in.
   */
  const importFigPages = async (
    opened: OpenedFigImport,
    pageIds: readonly string[] | null,
  ): Promise<boolean> => {
    setError(null);
    setRows([]);
    setPhase("running");
    try {
      const [row] = await opened.import(projectId, pageIds, setRows);
      onImported();
      if (row?.stage === "done")
        setImported((was) => new Set([...was, ...(pageIds ?? opened.pages.map((p) => p.id))]));
      setPhase("finished");
      return pageIds !== null;
    } catch (e) {
      setErrorAt("file");
      setError(e instanceof Error ? e.message : "That file couldn't be imported.");
      if (e instanceof FigImportError && e.tooManyLayers) {
        // Fewer pages will do: what fits is now known from these, so the budget follows it.
        const tried = opened.pages
          .filter((p) => pageIds === null || pageIds.includes(p.id))
          .reduce((sum, p) => sum + p.layers, 0);
        const fits = Math.floor(tried * (e.fits ?? 0.8) * 0.9);
        const next = Math.min(budget, fits);
        setBudget(next);
        setFig(opened);
        setChosen(firstThatFit(opened.pages, imported, next));
        setPhase("pages");
        return true;
      }
      opened.close();
      setFig(null);
      setPhase("choose");
      return false;
    }
  };

  /** A .fig: imported whole when it fits one file, else its pages are chosen first. */
  const startFig = async (source: File) => {
    let opened: OpenedFigImport;
    try {
      opened = await openFigImport(source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be imported.");
      setPhase("choose");
      return;
    }
    if (opened.layers <= FILE_LAYERS) {
      // Imported whole, nothing is left to choose, so the decoded file goes.
      if (!(await importFigPages(opened, null))) opened.close();
      return;
    }
    setFig(opened);
    setImported(new Set());
    setBudget(FILE_LAYERS);
    setChosen(firstThatFit(opened.pages, new Set(), FILE_LAYERS));
    setPhase("pages");
  };

  const startFigma = async () => {
    setErrorAt("link");
    if (!figmaFileKey(link)) {
      setError("Paste a link to a Figma design file (figma.com/design/…).");
      return;
    }
    if (!token.trim()) {
      setError("Paste a personal access token from Figma.");
      return;
    }
    saveToken(token.trim(), remember);
    setError(null);
    setRows([]);
    setPhase("running");
    try {
      await importFigma(link, token.trim(), projectId, setRows);
      onImported();
      setPhase("finished");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be imported.");
      setPhase("choose");
    }
  };

  /** A dropped or chosen file, imported by its kind; `tab` is where it was dropped, if anywhere. */
  const start = async (source: File, tab?: Source) => {
    const fig = isFigFile(source);
    setErrorAt("file");
    if (!fig && !isPenpotFile(source)) {
      setSource(tab ?? "figma");
      setError(
        tab === "penpot"
          ? `"${source.name}" isn't a .penpot file. Export one from Penpot first.`
          : tab === "figma"
            ? `"${source.name}" isn't a .fig file. In Figma, choose File → Save local copy to make one.`
            : `"${source.name}" can't be imported. Drop a .fig file from Figma or a .penpot file from Penpot.`,
      );
      return;
    }
    setSource(fig ? "figma" : "penpot");
    setError(null);
    setRows([]);
    setPhase("running");
    figRef.current?.close();
    setFig(null);
    if (fig) return startFig(source);
    try {
      await importPenpot(source, projectId, setRows);
      onImported();
      setPhase("finished");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be imported.");
      setPhase("choose");
    }
  };

  // A file dropped on the dashboard starts right away.
  const started = useRef<File | null>(null);
  useEffect(() => {
    if (open && file && started.current !== file) {
      started.current = file;
      void start(file);
    }
  }, [open, file]);

  const close = () => {
    if (phase === "running") return;
    fig?.close();
    setFig(null);
    setImported(new Set());
    setPhase("choose");
    setRows([]);
    setError(null);
    started.current = null;
    onClose();
  };

  const picked = fig ? fig.pages.filter((p) => chosen.has(p.id)) : [];
  const pickedLayers = picked.reduce((sum, p) => sum + p.layers, 0);
  const left = fig ? fig.pages.filter((p) => !imported.has(p.id) && !isDivider(p)) : [];

  return (
    <Dialog
      open={open}
      title="Import"
      onClose={close}
      footer={
        phase === "running" ? (
          <Button variant="primary" disabled>
            Importing…
          </Button>
        ) : phase === "finished" ? (
          <>
            {fig && left.length > 0 ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setChosen(firstThatFit(fig.pages, imported, budget));
                  setError(null);
                  setPhase("pages");
                }}
              >
                Import other pages
              </Button>
            ) : null}
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : phase === "pages" ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="import"
              disabled={picked.length === 0 || pickedLayers > budget}
              onClick={() =>
                fig &&
                void importFigPages(
                  fig,
                  picked.map((p) => p.id),
                )
              }
            >
              {picked.length === 1 ? "Import 1 page" : `Import ${picked.length} pages`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            {source === "figma" ? (
              <Button
                variant="primary"
                icon="import"
                disabled={!link.trim() || !token.trim()}
                onClick={() => void startFigma()}
              >
                Import
              </Button>
            ) : null}
          </>
        )
      }
    >
      {phase === "choose" ? (
        <div className="import-source">
          <SegmentedControl
            label="Import from"
            options={[
              { value: "figma", label: "Figma" },
              { value: "penpot", label: "Penpot" },
            ]}
            value={source}
            onChange={(v) => {
              setSource(v as Source);
              setError(null);
            }}
          />
        </div>
      ) : null}
      {phase === "choose" && source === "figma" ? (
        <form
          className="app-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void startFigma();
          }}
        >
          <DropZone
            compact
            title="Drop a .fig file here"
            accept=".fig"
            hint={
              <>
                In Figma, choose <strong>File → Save local copy</strong>. No token needed, and
                everything comes into <strong>{projectName}</strong> as a new file.
              </>
            }
            onFile={(f) => void start(f, "figma")}
          />
          {error && errorAt === "file" ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="import-or">
            <span>or import from a link</span>
          </div>
          <TextField
            label="Figma file link"
            placeholder="https://www.figma.com/design/…"
            value={link}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setLink(e.currentTarget.value)}
          />
          <TextField
            label="Personal access token"
            type="password"
            placeholder="figd_…"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.currentTarget.value)}
            hint="In Figma: Settings → Security → Personal access tokens, with File content read access."
          />
          <Switch
            label="Remember the token on this device"
            checked={remember}
            onChange={setRemember}
          />
          <p className="app-muted import-hint">
            The token goes from this browser to Figma only; Drawpane never sees it. Files on Figma's
            free plan can be read only a few times a month.
          </p>
          {error && errorAt === "link" ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          {/* Enter in a field submits. */}
          <button type="submit" hidden />
        </form>
      ) : phase === "pages" && fig ? (
        <PagePicker
          fig={fig}
          chosen={chosen}
          imported={imported}
          projectName={projectName}
          error={error}
          budget={budget}
          onChange={setChosen}
        />
      ) : phase === "choose" ? (
        <div className="app-stack">
          <DropZone
            title="Drop a .penpot file here"
            accept=".penpot"
            hint={
              <>
                In Penpot, use <strong>Export</strong> on a file and choose the .penpot format. Its
                pages, boards, components, text, colors and text styles come into{" "}
                <strong>{projectName}</strong> as new files.
              </>
            }
            onFile={(f) => void start(f, "penpot")}
          />
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="import-rows" aria-live="polite">
          {rows.length === 0 ? (
            <li className="import-row">
              <span className="import-row__icon" aria-hidden="true">
                <Icon name="board" size={16} />
              </span>
              <span className="import-row__name">Reading the file…</span>
              <span
                className="import-bar import-bar--busy"
                role="progressbar"
                aria-label="Reading the file"
              />
            </li>
          ) : (
            rows.map((row) => (
              <ImportRow
                key={row.key}
                row={row}
                onOpen={(id) => {
                  close();
                  void navigate({ to: "/f/$fileId", params: { fileId: id } });
                }}
              />
            ))
          )}
        </ul>
      )}
    </Dialog>
  );
}

/** A page that only separates others in Figma's page list ("---"), not one to import. */
const isDivider = (page: FigPage) => page.layers === 0 && /^[\s\-–—_=*·•.|/]*$/.test(page.name);

/** Pages in Figma's order that fit one file together, not yet imported: what the picker starts with. */
function firstThatFit(
  pages: readonly FigPage[],
  imported: ReadonlySet<string>,
  budget: number,
): Set<string> {
  const out = new Set<string>();
  let total = 0;
  for (const page of pages) {
    if (imported.has(page.id) || isDivider(page)) continue;
    if (total + page.layers > budget) continue;
    out.add(page.id);
    total += page.layers;
  }
  return out;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");

/** A file too large for one Drawpane file: its pages, by size, to choose from. */
function PagePicker({
  fig,
  chosen,
  imported,
  projectName,
  error,
  budget,
  onChange,
}: {
  fig: OpenedFigImport;
  chosen: ReadonlySet<string>;
  imported: ReadonlySet<string>;
  projectName: string;
  error: string | null;
  /** Estimated layers the chosen pages may come to. */
  budget: number;
  onChange: (chosen: ReadonlySet<string>) => void;
}) {
  const total = fig.pages.reduce((sum, p) => (chosen.has(p.id) ? sum + p.layers : sum), 0);
  const count = fig.pages.filter((p) => chosen.has(p.id)).length;
  const over = total > budget;
  const meterId = useId();
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    onChange(next);
  };
  return (
    <div className="app-stack import-pages">
      <p className="import-hint">
        <strong>{fig.name}</strong> comes to about {whole.format(roundTo(fig.layers))} layers once
        its components are filled in. One Drawpane file holds about {whole.format(roundTo(budget))},
        so choose the pages to bring into <strong>{projectName}</strong>. You can import the others
        into another file afterwards.
      </p>
      <div className="import-pages__meter" data-over={over || undefined} id={meterId}>
        <span className="import-pages__total">
          {over
            ? `About ${compact.format(total)} layers, more than one file holds`
            : `About ${compact.format(total)} of ${compact.format(budget)} layers`}
        </span>
        <span className="import-pages__count">
          {count === 1 ? "1 page" : `${count} pages`}
          {count > 0 ? (
            <button
              type="button"
              className="import-pages__clear"
              onClick={() => onChange(new Set())}
            >
              Clear
            </button>
          ) : null}
        </span>
        <meter
          className="dp-visually-hidden"
          aria-label="Layers chosen"
          min={0}
          max={budget}
          value={Math.min(total, budget)}
          aria-valuetext={`About ${whole.format(total)} of ${whole.format(budget)} layers`}
        />
        <span
          className="import-bar import-pages__bar"
          aria-hidden="true"
          style={{ "--progress": Math.min(1, total / budget) } as React.CSSProperties}
        />
      </div>
      <fieldset className="import-pages__list" aria-describedby={meterId}>
        <legend className="dp-visually-hidden">Pages</legend>
        {fig.pages.map((page) =>
          isDivider(page) ? (
            <hr key={page.id} className="import-pages__divider" />
          ) : (
            <label key={page.id} className="import-pages__page">
              <input
                type="checkbox"
                checked={chosen.has(page.id)}
                onChange={() => toggle(page.id)}
              />
              <span className="import-pages__name">{page.name || "Untitled page"}</span>
              {imported.has(page.id) ? <span className="import-pages__done">Imported</span> : null}
              <span className="import-pages__size">
                {page.layers === 0 ? "Empty" : compact.format(page.layers)}
                <span className="dp-visually-hidden">{page.layers === 0 ? "" : " layers"}</span>
              </span>
            </label>
          ),
        )}
      </fieldset>
      <p className="app-muted import-hint">
        Sizes are estimates. Copies of components on pages left out come in detached.
      </p>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A large estimate to two significant figures: it's no more exact than that. */
function roundTo(n: number): number {
  if (n < 1000) return n;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / step) * step;
}

/** Reading from Figma: in parts when the file is too large to send at once. */
function readingStatus(reading: FileImport["reading"]): string {
  if (reading?.waiting) return `Figma asked for a pause: going on in ${reading.waiting} s`;
  if (reading && reading.total > 1)
    return `Reading from Figma in parts: ${Math.min(reading.done + 1, reading.total)} of ${reading.total}`;
  return "Reading from Figma";
}

/** Reading a .fig: decoding it, then building its pages (with their instances) one by one. */
function buildingStatus(building: NonNullable<FileImport["building"]>): string {
  if (building.total === 0) return "Reading the file";
  if (building.total === 1) return "Building its page";
  return `Building pages: ${Math.min(building.done + 1, building.total)} of ${building.total}`;
}

/** How far along a row is, 0 to 1, or null while there's no telling. */
function progressOf(row: FileImport): number | null {
  const { stage, images, building } = row;
  // A .fig's reading takes real time; images and the rest share what's left.
  const read = building ? 0.3 : 0;
  if (stage === "reading")
    return building && building.total > 0 ? (building.done / building.total) * read : null;
  if (stage === "images")
    return images.total > 0 ? read + (images.done / images.total) * (0.7 - read) : read || null;
  if (stage === "converting") return 0.8;
  if (stage === "saving") return 0.9;
  if (stage === "done") return 1;
  return null;
}

function ImportRow({ row, onOpen }: { row: FileImport; onOpen: (fileId: string) => void }) {
  const { stage, images, reading, building } = row;
  const status =
    stage === "waiting"
      ? "Waiting"
      : stage === "reading"
        ? building
          ? buildingStatus(building)
          : readingStatus(reading)
        : stage === "images"
          ? images.total > 0
            ? `Uploading images ${images.done} of ${images.total}`
            : "Preparing"
          : stage === "converting"
            ? "Converting"
            : stage === "saving"
              ? "Saving"
              : stage === "failed"
                ? (row.error ?? "Failed")
                : `${whole.format(row.pages)} ${row.pages === 1 ? "page" : "pages"} · ${whole.format(row.layers)} ${row.layers === 1 ? "layer" : "layers"}`;
  const progress = progressOf(row);
  return (
    <li className="import-row" data-stage={stage}>
      <span className="import-row__icon" aria-hidden="true">
        <Icon
          name={stage === "done" ? "check" : stage === "failed" ? "warning" : "board"}
          size={16}
        />
      </span>
      <span className="import-row__name">{row.name}</span>
      {stage === "done" && row.fileId ? (
        <Button size="sm" onClick={() => onOpen(row.fileId as string)}>
          Open
        </Button>
      ) : null}
      <span className="import-row__status" role={stage === "failed" ? "alert" : undefined}>
        {status}
      </span>
      {stage !== "done" && stage !== "failed" ? (
        <span
          className={progress === null ? "import-bar import-bar--busy" : "import-bar"}
          role="progressbar"
          aria-label={`Importing ${row.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(progress === null ? {} : { "aria-valuenow": Math.round(progress * 100) })}
          style={{ "--progress": progress ?? 0 } as React.CSSProperties}
        />
      ) : null}
      {row.notes.length > 0 && stage === "done" ? (
        <details className="import-row__notes">
          <summary>
            <Icon name="chevron-right" size={12} className="import-row__notes-chevron" />
            {row.notes.length === 1
              ? "1 thing came across differently"
              : `${row.notes.length} things came across differently`}
          </summary>
          <ul>
            {row.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** A dashed area that takes a dropped file, with a button as the keyboard (and click) way in. */
function DropZone({
  title,
  accept,
  hint,
  compact = false,
  onFile,
}: {
  title: string;
  accept: string;
  hint: React.ReactNode;
  compact?: boolean;
  onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard way in */}
      <div
        className={compact ? "import-drop import-drop--compact" : "import-drop"}
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) onFile(dropped);
        }}
      >
        <span className="import-drop__icon" aria-hidden="true">
          <Icon name="import" size={16} />
        </span>
        <p className="import-drop__title">{title}</p>
        <Button onClick={() => input.current?.click()} aria-describedby={hintId}>
          Choose file
        </Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (chosen) onFile(chosen);
          }}
        />
      </div>
      <p id={hintId} className="app-muted import-hint">
        {hint}
      </p>
    </>
  );
}
