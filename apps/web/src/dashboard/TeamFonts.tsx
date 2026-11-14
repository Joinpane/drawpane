/**
 * The team's fonts: every family the team uploaded, each shown in its own
 * face, with its weights and license; upload by dropping files or choosing
 * them, and remove a face from its family. Fonts are read on the server, so
 * a family lands under its real name whatever the file is called.
 */
import type { TeamFontFace } from "@drawpane/model";
import { Badge, Button, Icon, IconButton } from "@drawpane/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, api } from "../api/client";
import { type FontFamily, fonts, teamFamilies, WEIGHT_NAMES } from "../fonts/fonts";

const ACCEPT = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";

interface Upload {
  readonly id: number;
  readonly name: string;
  readonly status: "waiting" | "uploading" | "added" | "replaced" | "error";
  readonly progress: number;
  readonly message?: string;
  readonly face?: TeamFontFace;
}

/** Sends one font file, reporting progress. */
function uploadFont(
  teamId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ face: TeamFontFace; replaced: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/teams/${encodeURIComponent(teamId)}/fonts`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: reported below.
      }
      if (xhr.status >= 200 && xhr.status < 300)
        resolve(body as { face: TeamFontFace; replaced: boolean });
      else
        reject(
          new ApiError(
            xhr.status,
            "upload",
            (body as { error?: { message?: string } } | null)?.error?.message ??
              "Couldn't upload that font. Try again.",
          ),
        );
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "network", "Couldn't reach Drawpane. Check your connection."));
    xhr.send(file);
  });
}

const formatBytes = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/** "Bold", or "100–900" for a variable face. */
const weightLabel = (f: TeamFontFace) =>
  f.weightMax ? `${f.weight}–${f.weightMax}` : (WEIGHT_NAMES[f.weight] ?? String(f.weight));

/** "6 weights · variable · uploaded by Lena". */
function familyMeta(family: FontFamily): string {
  const faces = family.faces ?? [];
  const count = new Set([...family.weights, ...family.italics]).size;
  const uploaders = [...new Set(faces.map((f) => f.uploadedBy).filter(Boolean))];
  return [
    family.variable ? "Variable" : count === 1 ? "1 weight" : `${count} weights`,
    family.italics.length > 0 ? "italics" : null,
    uploaders.length === 1 ? `uploaded by ${uploaders[0]}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TeamFontsView({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["team-fonts", teamId],
    queryFn: () => api.get<{ faces: TeamFontFace[] }>(`/teams/${teamId}/fonts`),
  });
  const config = useQuery({
    queryKey: ["fonts-config"],
    queryFn: () => api.get<{ google: boolean }>("/fonts/config"),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const families = useMemo(() => teamFamilies(list.data?.faces ?? []), [list.data]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);

  // Samples render in each family's own face: the registry loads the team's stylesheet.
  useSyncExternalStore(fonts.subscribe, () => fonts.version);
  const signature = (list.data?.faces ?? []).map((f) => f.sha).join(",");
  useEffect(() => {
    void signature;
    void fonts.loadTeam(teamId);
  }, [teamId, signature]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["team-fonts", teamId] });

  const upload = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const batch = files.map(
      (file): Upload => ({ id: nextId.current++, name: file.name, status: "waiting", progress: 0 }),
    );
    setUploads((prev) => [...batch, ...prev.filter((u) => u.status === "uploading")]);
    const set = (id: number, patch: Partial<Upload>) =>
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    // One at a time: fonts are big, and order keeps the list readable.
    for (const [i, file] of files.entries()) {
      const id = (batch[i] as Upload).id;
      set(id, { status: "uploading" });
      try {
        const { face, replaced } = await uploadFont(teamId, file, (progress) =>
          set(id, { progress }),
        );
        set(id, { status: replaced ? "replaced" : "added", progress: 1, face });
      } catch (error) {
        set(id, {
          status: "error",
          message: error instanceof Error ? error.message : "Couldn't upload that font.",
        });
      }
    }
    await refresh();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canEdit) return;
    void upload([...e.dataTransfer.files]);
  };

  const remove = async (face: TeamFontFace) => {
    await api.delete(`/teams/${teamId}/fonts/${face.id}`);
    await refresh();
  };

  const faceCount = list.data?.faces.length ?? 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the Upload buttons are the keyboard way in
    <div
      className={`team-fonts${dragging ? " team-fonts--dragging" : ""}`}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="dash__header">
        <h1 className="dash__title">Fonts</h1>
        {canEdit ? (
          <Button variant="primary" size="lg" icon="plus" onClick={() => input.current?.click()}>
            Upload fonts
          </Button>
        ) : null}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          aria-label="Font files"
          onChange={(e) => {
            void upload([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = "";
          }}
        />
      </header>

      <div className="team-fonts__layout">
        <section className="team-fonts__card" aria-labelledby="team-fonts-title">
          <div className="team-fonts__head">
            <h2 id="team-fonts-title">
              Team fonts
              {families.length > 0
                ? ` · ${families.length === 1 ? "1 family" : `${families.length} families`}`
                : ""}
            </h2>
            {faceCount > 0 ? (
              <span className="team-fonts__total">
                {faceCount === 1 ? "1 file" : `${faceCount} files`}
              </span>
            ) : null}
          </div>
          {list.isPending ? (
            <ul className="team-fonts__list" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="team-fonts__row team-fonts__row--skeleton" />
              ))}
            </ul>
          ) : list.error ? (
            <p className="team-fonts__empty" role="alert">
              {list.error.message}
            </p>
          ) : families.length === 0 ? (
            <div className="team-fonts__empty">
              <p className="team-fonts__empty-title">No team fonts yet</p>
              <p>
                Upload your brand typefaces once, and everyone on the team can set text in them.
                Each file is read for its family, weight and style.
              </p>
              {canEdit ? (
                <Button icon="plus" onClick={() => input.current?.click()}>
                  Upload fonts
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="team-fonts__list">
              {families.map((family) => (
                <FamilyRow
                  key={family.family}
                  family={family}
                  canEdit={canEdit}
                  onRemove={(face) => void remove(face)}
                />
              ))}
            </ul>
          )}
        </section>

        <aside className="team-fonts__side">
          {canEdit ? (
            <button
              type="button"
              className="team-fonts__drop"
              onClick={() => input.current?.click()}
            >
              <Icon name="export" />
              <strong>Drop .ttf, .otf, .woff or .woff2</strong>
              <span>
                Served from this server to everyone on your team. Never sent to Google or anyone
                else.
              </span>
            </button>
          ) : null}
          {uploads.length > 0 ? <Uploads uploads={uploads} /> : null}
          <section className="team-fonts__card team-fonts__note">
            <strong>Google Fonts</strong>
            <p>
              {config.data?.google === false
                ? "Turned off on this server: the font picker offers built-in, team and local fonts only."
                : "On. The font picker offers every open-source Google font, copied to this server on first use, so viewers never load anything from Google."}
            </p>
          </section>
        </aside>
      </div>
      {dragging ? (
        <div className="team-fonts__overlay" aria-hidden="true">
          <Icon name="export" />
          Drop to add to the team's fonts
        </div>
      ) : null}
    </div>
  );
}

function FamilyRow({
  family,
  canEdit,
  onRemove,
}: {
  family: FontFamily;
  canEdit: boolean;
  onRemove: (face: TeamFontFace) => void;
}) {
  const [open, setOpen] = useState(false);
  const faces = family.faces ?? [];
  const licenses = [...new Set(faces.map((f) => f.license).filter(Boolean))];
  const restricted = faces.some((f) => f.restricted);
  const panel = `family-${family.family.replace(/\W+/g, "-")}`;
  return (
    <li className="team-fonts__family">
      <button
        type="button"
        className="team-fonts__row"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className="team-fonts__sample"
          // A picture of the face, not a name: the row reads as its family.
          aria-hidden="true"
          style={{ fontFamily: `"${family.family}", var(--font-ui)` }}
        >
          Aa Gg 123
        </span>
        <span className="team-fonts__name">
          <strong>{family.family}</strong>
          <span>{familyMeta(family)}</span>
        </span>
        <span className="team-fonts__license">
          {restricted ? (
            <Badge tone="warning">Restricted</Badge>
          ) : licenses.length === 1 ? (
            <Badge>{licenses[0]}</Badge>
          ) : null}
        </span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open ? (
        <div id={panel} className="team-fonts__faces">
          {restricted ? (
            <p className="team-fonts__warning">
              <Icon name="warning" size={12} />
              This font marks its license as restricting embedding. Using it on the web may need a
              web license from its foundry.
            </p>
          ) : null}
          <table>
            <thead>
              <tr>
                <th scope="col">Style</th>
                <th scope="col">Weight</th>
                <th scope="col">File</th>
                <th scope="col">Added</th>
                {canEdit ? <th scope="col" aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {faces.map((face) => (
                <tr key={face.id}>
                  <td
                    style={{
                      fontFamily: `"${family.family}", var(--font-ui)`,
                      fontWeight: face.weight,
                      fontStyle: face.italic ? "italic" : "normal",
                    }}
                  >
                    {face.style}
                  </td>
                  <td>{weightLabel(face)}</td>
                  <td>
                    {face.format.toUpperCase()} · {formatBytes(face.bytes)}
                  </td>
                  <td>
                    {new Date(face.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                    {face.uploadedBy ? ` · ${face.uploadedBy}` : ""}
                  </td>
                  {canEdit ? (
                    <td>
                      <IconButton
                        icon="trash"
                        size="sm"
                        label={`Remove ${family.family} ${face.style}`}
                        onClick={() => onRemove(face)}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  );
}

function Uploads({ uploads }: { uploads: readonly Upload[] }) {
  const families = [...new Set(uploads.map((u) => u.face?.family).filter(Boolean))];
  const restricted = uploads.filter((u) => u.face?.restricted);
  return (
    <section className="team-fonts__card team-fonts__uploads" aria-live="polite">
      <strong>{families.length === 1 ? `Uploading · ${families[0]}` : "Uploads"}</strong>
      <ul>
        {uploads.map((u) => (
          <li key={u.id} className={`team-fonts__upload team-fonts__upload--${u.status}`}>
            <span className="team-fonts__upload-name" title={u.name}>
              {u.name}
            </span>
            <span className="team-fonts__upload-state">
              {u.status === "waiting"
                ? "Waiting"
                : u.status === "uploading"
                  ? `${Math.round(u.progress * 100)}%`
                  : u.status === "added"
                    ? "Added"
                    : u.status === "replaced"
                      ? "Replaced"
                      : "Failed"}
            </span>
            {u.status === "error" && u.message ? (
              <span className="team-fonts__upload-error">{u.message}</span>
            ) : null}
            {u.face && u.status !== "error" ? (
              <span className="team-fonts__upload-face">
                {u.face.family} {u.face.style}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {restricted.length > 0 ? (
        <p className="team-fonts__warning">
          <Icon name="warning" size={12} />
          {restricted.length === 1
            ? `${restricted[0]?.face?.family} marks its license as restricting embedding.`
            : `${restricted.length} files mark their license as restricting embedding.`}{" "}
          Web use may need a web license.
        </p>
      ) : null}
    </section>
  );
}
