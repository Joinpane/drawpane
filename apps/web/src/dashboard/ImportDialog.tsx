/**
 * Import from Figma (a file's link and a personal access token) or from
 * Penpot (a .penpot export), then watch each file come across (images,
 * converting, saving), with a short note on anything that couldn't come
 * across exactly, and a way to open it.
 */
import { Button, Icon, SegmentedControl, Switch, TextField } from "@drawpane/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../app/Dialog";
import { figmaFileKey, importFigma } from "./figma-import";
import { type FileImport, importPenpot, isPenpotFile } from "./penpot-import";

type Phase = "choose" | "running" | "finished";
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
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  const startFigma = async () => {
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

  const start = async (source: File) => {
    setSource("penpot");
    if (!isPenpotFile(source)) {
      setError(`"${source.name}" isn't a .penpot file. Export one from Penpot first.`);
      return;
    }
    setError(null);
    setRows([]);
    setPhase("running");
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
    setPhase("choose");
    setRows([]);
    setError(null);
    started.current = null;
    onClose();
  };

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
          <Button variant="primary" onClick={close}>
            Done
          </Button>
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
            The token goes from this browser to Figma only; Drawpane never sees it. Pages, frames,
            components, auto layout, text, images and effects come into{" "}
            <strong>{projectName}</strong> as a new file. Files on Figma's free plan can be read
            only a few times a month.
          </p>
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          {/* Enter in a field submits. */}
          <button type="submit" hidden />
        </form>
      ) : phase === "choose" ? (
        <div className="app-stack">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard way in */}
          <div
            className="import-drop"
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
              if (dropped) void start(dropped);
            }}
          >
            <span className="import-drop__icon" aria-hidden="true">
              <Icon name="import" size={16} />
            </span>
            <p className="import-drop__title">Drop a .penpot file here</p>
            <Button onClick={() => input.current?.click()} aria-describedby={hintId}>
              Choose file
            </Button>
            <input
              ref={input}
              type="file"
              accept=".penpot"
              hidden
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = "";
                if (chosen) void start(chosen);
              }}
            />
          </div>
          <p id={hintId} className="app-muted import-hint">
            In Penpot, use <strong>Export</strong> on a file and choose the .penpot format. Its
            pages, boards, components, text, colors and text styles come into{" "}
            <strong>{projectName}</strong> as new files.
          </p>
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
              <span className="import-row__name">Reading the export…</span>
              <span className="import-bar import-bar--busy" />
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

function ImportRow({ row, onOpen }: { row: FileImport; onOpen: (fileId: string) => void }) {
  const { stage, images } = row;
  const status =
    stage === "waiting"
      ? "Waiting"
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
              : `${row.pages} ${row.pages === 1 ? "page" : "pages"} · ${row.layers} ${row.layers === 1 ? "layer" : "layers"}`;
  // Images are most of the waiting; converting and saving are short.
  const progress =
    stage === "images" && images.total > 0
      ? (images.done / images.total) * 0.7
      : stage === "converting"
        ? 0.8
        : stage === "saving"
          ? 0.9
          : stage === "done"
            ? 1
            : null;
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
