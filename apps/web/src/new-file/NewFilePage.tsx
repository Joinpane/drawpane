/**
 * New file: start blank, with a first frame of a common size, from one of
 * Drawpane's templates, or from one of your team's. N makes a blank file
 * straight away; Esc goes back to the files.
 */
import { Button, Icon, IconButton, Kbd, Logo, SegmentedControl } from "@drawpane/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { api, type FileMeta } from "../api/client";
import { FileThumbnail } from "../dashboard/FileThumbnail";
import {
  createBlank,
  createFromFile,
  createFromTemplate,
  createSized,
  templatePreview,
} from "./create";
import { BUILT_IN_TEMPLATES, type BuiltInTemplate } from "./templates";
import "./new-file.css";

interface Size {
  readonly id: string;
  readonly label: string;
  readonly frame: string;
  readonly width: number;
  readonly height: number;
}

const SIZES: readonly Size[] = [
  { id: "phone", label: "Phone", frame: "iPhone 18 Pro", width: 402, height: 874 },
  { id: "tablet", label: "Tablet", frame: "iPad Pro 11″", width: 834, height: 1210 },
  { id: "desktop", label: "Desktop", frame: "Desktop", width: 1440, height: 1024 },
  { id: "watch", label: "Watch", frame: "Apple Watch 46mm", width: 208, height: 248 },
  { id: "slide", label: "Slide", frame: "Slide 16:9", width: 1920, height: 1080 },
];

/** The size card's little picture: the frame's shape, scaled into a 72px box. */
function shapeOf(width: number, height: number): React.CSSProperties {
  const scale = Math.min(88 / width, 64 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

type Source = "built-in" | "team";

export function NewFilePage() {
  const { teamId } = useParams({ from: "/t/$teamId/new" });
  const { project: projectId } = useSearch({ from: "/t/$teamId/new" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams });
  const projects = useQuery({
    queryKey: ["projects", teamId],
    queryFn: () => api.projects(teamId),
  });
  const templates = useQuery({
    queryKey: ["templates", teamId],
    queryFn: () => api.get<{ files: FileMeta[] }>(`/teams/${teamId}/templates`),
  });
  const team = teams.data?.teams.find((t) => t.id === teamId);
  const project =
    projects.data?.projects.find((p) => p.id === projectId) ?? projects.data?.projects[0];
  const [source, setSource] = useState<Source>("built-in");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ width: string; height: string } | null>(null);

  const back = () =>
    navigate({
      to: "/t/$teamId",
      params: { teamId },
      search: projectId ? { project: projectId } : {},
    });

  const make = async (key: string, run: (projectId: string) => Promise<FileMeta>) => {
    if (!project || busy) return;
    setBusy(key);
    setError(null);
    try {
      const file = await run(project.id);
      void queryClient.invalidateQueries({ queryKey: ["files", teamId] });
      await navigate({ to: "/f/$fileId", params: { fileId: file.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be made. Try again.");
      setBusy(null);
    }
  };

  // N: a blank file now; Esc: back to the files.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") void back();
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void make("blank", createBlank);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const width = Math.round(Number(custom?.width));
    const height = Math.round(Number(custom?.height));
    if (!(width > 0 && width <= 100_000 && height > 0 && height <= 100_000)) {
      setError("Enter a width and height in pixels, like 1280 × 800.");
      return;
    }
    void make("custom", (p) => createSized(p, { name: `Frame ${width}×${height}`, width, height }));
  };

  return (
    <div className="new-file">
      <header className="new-file__bar">
        <Logo size={22} />
        <nav className="new-file__crumbs" aria-label="Where the file goes">
          <span>{team?.name ?? "…"}</span>
          <span aria-hidden="true">/</span>
          <strong>{project?.name ?? "…"}</strong>
          <span aria-hidden="true">/</span>
          <span>New file</span>
        </nav>
        <IconButton
          icon="close"
          label="Close"
          shortcut="Esc"
          size="md"
          onClick={() => void back()}
        />
      </header>

      <main className="new-file__main">
        <div className="new-file__intro">
          <div>
            <h1 className="new-file__title">Start with a blank pane</h1>
            <p className="new-file__lede">
              Pick a size, or begin from a template so the structure is ready.
            </p>
          </div>
          <p className="new-file__hint">
            Or press <Kbd keys={["N"]} /> for a blank file
          </p>
        </div>

        {error ? (
          <p className="new-file__error" role="alert">
            <Icon name="warning" size={16} />
            {error}
          </p>
        ) : null}

        <section aria-labelledby="sizes">
          <h2 id="sizes" className="new-file__heading">
            Frame size
          </h2>
          <div className="new-file__sizes">
            {SIZES.map((size) => (
              <button
                key={size.id}
                type="button"
                className="new-file__size"
                disabled={!!busy}
                data-busy={busy === size.id || undefined}
                onClick={() =>
                  void make(size.id, (p) =>
                    createSized(p, { name: size.frame, width: size.width, height: size.height }),
                  )
                }
              >
                <span className="new-file__size-art">
                  <span className="new-file__size-shape" style={shapeOf(size.width, size.height)} />
                </span>
                <span className="new-file__size-name">{size.label}</span>
                <span className="new-file__size-dim">
                  {busy === size.id ? "Making…" : `${size.width} × ${size.height}`}
                </span>
              </button>
            ))}
            {custom ? (
              <form className="new-file__size new-file__size--custom" onSubmit={submitCustom}>
                <span className="new-file__size-fields">
                  <input
                    aria-label="Width"
                    inputMode="numeric"
                    placeholder="W"
                    value={custom.width}
                    onChange={(e) => setCustom({ ...custom, width: e.target.value })}
                    // biome-ignore lint/a11y/noAutofocus: the person just chose to type a size
                    autoFocus
                  />
                  <span aria-hidden="true">×</span>
                  <input
                    aria-label="Height"
                    inputMode="numeric"
                    placeholder="H"
                    value={custom.height}
                    onChange={(e) => setCustom({ ...custom, height: e.target.value })}
                  />
                </span>
                <Button type="submit" size="sm" variant="primary" disabled={!!busy}>
                  {busy === "custom" ? "Making…" : "Create"}
                </Button>
              </form>
            ) : (
              <button
                type="button"
                className="new-file__size"
                disabled={!!busy}
                onClick={() => setCustom({ width: "", height: "" })}
              >
                <span className="new-file__size-art">
                  <span className="new-file__size-shape new-file__size-shape--custom" />
                </span>
                <span className="new-file__size-name">Custom</span>
                <span className="new-file__size-dim">Type W × H</span>
              </button>
            )}
          </div>
        </section>

        <section aria-labelledby="templates">
          <div className="new-file__heading-row">
            <h2 id="templates" className="new-file__heading">
              Templates
            </h2>
            <SegmentedControl<Source>
              label="Templates from"
              value={source}
              onChange={setSource}
              options={[
                { value: "built-in", label: "Drawpane" },
                { value: "team", label: team ? team.name : "Your team" },
              ]}
            />
          </div>
          {source === "built-in" ? (
            <div className="new-file__templates">
              {BUILT_IN_TEMPLATES.map((t) => (
                <TemplateCard
                  key={t.id}
                  name={t.name}
                  meta={t.meta}
                  busy={busy === t.id}
                  disabled={!!busy}
                  onPick={() => void make(t.id, (p) => createFromTemplate(p, t))}
                >
                  <BuiltInPreview template={t} />
                </TemplateCard>
              ))}
            </div>
          ) : templates.data && templates.data.files.length > 0 ? (
            <div className="new-file__templates">
              {templates.data.files.map((f) => (
                <TemplateCard
                  key={f.id}
                  name={f.name}
                  meta={`Edited ${new Date(f.updatedAt).toLocaleDateString()}`}
                  busy={busy === f.id}
                  disabled={!!busy}
                  onPick={() => void make(f.id, (p) => createFromFile(p, f))}
                >
                  <FileThumbnail fileId={f.id} thumbnailAt={f.thumbnailAt} />
                </TemplateCard>
              ))}
            </div>
          ) : (
            <div className="new-file__empty">
              <Icon name="duplicate" size={16} />
              <p>
                <strong>No team templates yet.</strong> Make any file a template from its menu on
                the dashboard, and everyone on the team can start from it here.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function TemplateCard({
  name,
  meta,
  busy,
  disabled,
  onPick,
  children,
}: {
  name: string;
  meta: string;
  busy: boolean;
  disabled: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="new-file__template"
      disabled={disabled}
      data-busy={busy || undefined}
      onClick={onPick}
    >
      <span className="new-file__template-thumb">{children}</span>
      <span className="new-file__template-text">
        <span className="new-file__template-name">{name}</span>
        <span className="new-file__template-meta">{busy ? "Making your copy…" : meta}</span>
      </span>
    </button>
  );
}

function BuiltInPreview({ template }: { template: BuiltInTemplate }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void templatePreview(template).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [template]);
  return src ? (
    <img src={src} alt="" className="new-file__preview" />
  ) : (
    <span className="new-file__preview new-file__preview--loading" />
  );
}
