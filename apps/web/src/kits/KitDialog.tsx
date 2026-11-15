/**
 * A kit's details: its cover, who made it, what it is, where it's from and
 * its licence exactly as its source gives it, then "Add to team" in one
 * click. Adding shows the download, the check and the import as they happen;
 * then "Open", and for a kit with components, "Publish as team library".
 */
import { Badge, Button, ButtonLink, Icon } from "@drawpane/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../app/Dialog";
import { ADD_START, addKit, type KitAdd, publishKitLibrary } from "./add-kit";
import { KitCover } from "./KitCover";
import type { AddedKit } from "./KitStore";
import { formatBytes, KIND_SINGULAR, type Kit, LICENCE_UNSTATED, licenceOf } from "./registry";

type Published = "idle" | "publishing" | "done" | { error: string };

export function KitDialog({
  kit,
  teamId,
  canEdit,
  added,
  onClose,
}: {
  kit: Kit | null;
  teamId: string;
  canEdit: boolean;
  /** The files this kit already became on the team. */
  added: readonly AddedKit[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<KitAdd | null>(null);
  const [published, setPublished] = useState<Record<string, Published>>({});
  const abort = useRef<AbortController | null>(null);
  const running = progress !== null && progress.stage !== "done" && progress.stage !== "failed";

  // Another kit, or the dialog closed: start from its details.
  useEffect(() => {
    setProgress(null);
    setPublished({});
  }, [kit?.id]);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const add = async () => {
    if (!kit || running) return;
    abort.current = new AbortController();
    setProgress(ADD_START);
    const result = await addKit(kit, teamId, setProgress, abort.current.signal);
    if (result.stage === "done") {
      void queryClient.invalidateQueries({ queryKey: ["team-kits", teamId] });
      void queryClient.invalidateQueries({ queryKey: ["files", teamId] });
      void queryClient.invalidateQueries({ queryKey: ["projects", teamId] });
    }
  };

  const open = (fileId: string) => {
    onClose();
    void navigate({ to: "/f/$fileId", params: { fileId } });
  };

  const publish = async (fileId: string) => {
    if (!kit) return;
    setPublished((p) => ({ ...p, [fileId]: "publishing" }));
    try {
      await publishKitLibrary(fileId, kit);
      setPublished((p) => ({ ...p, [fileId]: "done" }));
    } catch (e) {
      setPublished((p) => ({
        ...p,
        [fileId]: { error: e instanceof Error ? e.message : "Couldn't publish it." },
      }));
    }
  };

  if (!kit)
    return (
      <Dialog open={false} title="Kit" onClose={onClose}>
        {null}
      </Dialog>
    );
  const licence = licenceOf(kit);
  const done = progress?.stage === "done" ? progress.files.filter((f) => f.fileId) : [];
  const wasAdded = added.length > 0;
  const date = kit.updated ?? kit.published;

  return (
    <Dialog
      open
      size="lg"
      title={kit.name}
      // Closing while the file downloads stops it; an import already under way finishes.
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {progress?.stage === "done" ? "Done" : "Close"}
          </Button>
          {progress?.stage === "done" ? null : !kit.file?.importable ? (
            kit.source.page ? (
              <ButtonLink variant="primary" href={kit.source.page}>
                Open its page
              </ButtonLink>
            ) : null
          ) : canEdit ? (
            <Button
              variant="primary"
              {...(running ? {} : { icon: "plus" as const })}
              disabled={running}
              onClick={() => void add()}
            >
              {running ? "Adding…" : wasAdded ? "Add again" : "Add to team"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="kit">
        <div className="kit__cover">
          <KitCover kit={kit} eager />
        </div>
        <div className="kit__head">
          <p className="kit__by">
            {KIND_SINGULAR[kit.kind]}
            {kit.author ? (
              <>
                {" by "}
                {kit.author.url ? (
                  <a href={kit.author.url} target="_blank" rel="noreferrer">
                    {kit.author.name}
                  </a>
                ) : (
                  <strong>{kit.author.name}</strong>
                )}
              </>
            ) : null}
          </p>
          {wasAdded ? (
            <Badge tone="success" icon="check">
              Added
            </Badge>
          ) : null}
        </div>
        {kit.categories.length > 0 ? (
          <ul className="kit__tags" aria-label="Categories">
            {kit.categories.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
        {kit.description ? <p className="kit__description">{kit.description}</p> : null}

        {progress ? (
          <AddProgress
            progress={progress}
            published={published}
            onOpen={open}
            onPublish={(id) => void publish(id)}
            libraryLike={kit.kind !== "template"}
          />
        ) : null}

        <dl className="kit__facts">
          <div>
            <dt>Source</dt>
            <dd>
              {kit.source.page ? (
                <a href={kit.source.page} target="_blank" rel="noreferrer">
                  {kit.source.name}
                  <Icon name="arrow" size={12} className="kit__out" />
                </a>
              ) : (
                kit.source.name
              )}
              {kit.source.repository ? (
                <>
                  {" · "}
                  <a href={kit.source.repository} target="_blank" rel="noreferrer">
                    File
                  </a>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Licence</dt>
            <dd>
              {licence.kind === "unstated" ? (
                <span className="kit__unstated">
                  {licence.url && licence.label === LICENCE_UNSTATED ? (
                    <>
                      Licence not stated by the author: see{" "}
                      <a href={licence.url} target="_blank" rel="noreferrer">
                        Penpot's hub
                      </a>
                    </>
                  ) : (
                    licence.label
                  )}
                </span>
              ) : licence.url ? (
                <a href={licence.url} target="_blank" rel="noreferrer">
                  {licence.label}
                </a>
              ) : (
                licence.label
              )}
              {licence.kind === "file" && licence.text ? (
                <details className="kit__licence">
                  <summary>
                    <Icon name="chevron-right" size={12} className="kit__licence-chevron" />
                    Read the licence
                  </summary>
                  <pre>{licence.text}</pre>
                </details>
              ) : null}
            </dd>
          </div>
          {kit.attribution ? (
            <div>
              <dt>Credit</dt>
              <dd>{kit.attribution}</dd>
            </div>
          ) : null}
          {kit.file?.bytes || date ? (
            <div>
              <dt>File</dt>
              <dd>
                {[
                  kit.file?.bytes ? formatBytes(kit.file.bytes) : null,
                  date ? `updated ${date}` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
        {progress ? null : <p className="kit__note">{noteFor(kit)}</p>}
        {!canEdit && kit.file?.importable ? (
          <p className="kit__note">Viewers can browse kits; editors add them to the team.</p>
        ) : null}
        {done.length === 0 && wasAdded && !progress ? (
          <p className="kit__note">
            Your team added this kit already.{" "}
            <button
              type="button"
              className="kit__link"
              onClick={() => open(added[0]?.fileId ?? "")}
            >
              Open it
            </button>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** What adding does, or why this kit can't be added here. */
function noteFor(kit: Kit): string {
  const file = kit.file;
  if (!file)
    return `${kit.source.name} lists this kit without a file Drawpane can download. Open its page to get it.`;
  if (file.container === "lfs-pointer")
    return "Penpot keeps this file in Git LFS, which its public hosting doesn't serve, so Drawpane can't download it. Open its page to get it.";
  if (!file.importable)
    return "This file is in an older Penpot format, which Drawpane can't import yet. Open its page to use it in Penpot, or open it in a recent Penpot and export it to import it here.";
  return `Adding downloads the file from ${hostOf(file.url)}, checks it, and makes it a file in your team's Kits project, with this credit on its first page. ${
    kit.provider === "penpot" ? "Penpot files are converted, so some parts may look different." : ""
  }`.trim();
}

const hostOf = (url: string) => {
  try {
    return new URL(url, location.href).host;
  } catch {
    return "its host";
  }
};

function AddProgress({
  progress,
  published,
  onOpen,
  onPublish,
  libraryLike,
}: {
  progress: KitAdd;
  published: Record<string, Published>;
  onOpen: (fileId: string) => void;
  onPublish: (fileId: string) => void;
  libraryLike: boolean;
}) {
  const { stage, received, total, files } = progress;
  const importing = files.find((f) => f.stage !== "done" && f.stage !== "failed");
  const status =
    stage === "downloading"
      ? total
        ? `Downloading ${formatBytes(received)} of ${formatBytes(total)}`
        : `Downloading ${formatBytes(received)}`
      : stage === "checking"
        ? "Checking the file"
        : stage === "importing"
          ? importing?.stage === "images" && importing.images.total > 0
            ? `Uploading images ${importing.images.done} of ${importing.images.total}`
            : importing?.stage === "saving"
              ? "Saving"
              : "Converting"
          : stage === "failed"
            ? (progress.error ?? "Couldn't add it.")
            : "Added to your team's Kits project";
  // Downloading is the first half; converting and saving the rest.
  const fraction =
    stage === "downloading"
      ? total
        ? Math.min(1, received / total) * 0.5
        : null
      : stage === "checking"
        ? 0.5
        : stage === "importing"
          ? importing?.stage === "images" && importing.images.total > 0
            ? 0.55 + (importing.images.done / importing.images.total) * 0.3
            : importing?.stage === "saving"
              ? 0.95
              : 0.9
          : 1;
  return (
    <section className="kit__progress" data-stage={stage} aria-live="polite">
      {stage !== "done" && stage !== "failed" ? (
        <span
          className={fraction === null ? "import-bar import-bar--busy" : "import-bar"}
          role="progressbar"
          aria-label="Adding the kit"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(fraction === null ? {} : { "aria-valuenow": Math.round(fraction * 100) })}
          style={{ "--progress": fraction ?? 0 } as React.CSSProperties}
        />
      ) : null}
      <p className="kit__progress-status" role={stage === "failed" ? "alert" : undefined}>
        <Icon
          name={stage === "done" ? "check" : stage === "failed" ? "warning" : "import"}
          size={16}
        />
        {status}
      </p>
      {stage === "done" ? (
        <ul className="kit__results">
          {files
            .filter((f) => f.fileId)
            .map((f) => {
              const state = published[f.fileId as string] ?? "idle";
              return (
                <li key={f.key} className="kit__result">
                  <span className="kit__result-name">
                    {f.name}
                    <span className="kit__result-meta">
                      {f.pages} {f.pages === 1 ? "page" : "pages"}
                      {f.components > 0
                        ? ` · ${f.components} ${f.components === 1 ? "component" : "components"}`
                        : ""}
                    </span>
                  </span>
                  {libraryLike && f.components > 0 ? (
                    state === "done" ? (
                      <Badge tone="success" icon="check">
                        Published
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        icon="component"
                        disabled={state === "publishing"}
                        onClick={() => onPublish(f.fileId as string)}
                      >
                        {state === "publishing" ? "Publishing…" : "Publish as team library"}
                      </Button>
                    )
                  ) : null}
                  <Button size="sm" variant="primary" onClick={() => onOpen(f.fileId as string)}>
                    Open
                  </Button>
                  {typeof state === "object" ? (
                    <p className="kit__result-error" role="alert">
                      {state.error}
                    </p>
                  ) : null}
                  {f.notes.length > 0 ? (
                    <details className="import-row__notes kit__result-notes">
                      <summary>
                        <Icon
                          name="chevron-right"
                          size={12}
                          className="import-row__notes-chevron"
                        />
                        {f.notes.length === 1
                          ? "1 thing came across differently"
                          : `${f.notes.length} things came across differently`}
                      </summary>
                      <ul>
                        {f.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
        </ul>
      ) : null}
    </section>
  );
}
