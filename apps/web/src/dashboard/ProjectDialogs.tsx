/**
 * Organising a team's work: renaming and deleting projects, moving a file to
 * another project, and deleting from the trash for good. Each is a small
 * dialog the dashboard opens; they say what will happen before it does, in
 * numbers ("Its 12 files move to the trash").
 */
import { Button, Icon, TextField } from "@drawpane/ui";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, type FileMeta, type Project } from "../api/client";
import { Dialog } from "../app/Dialog";

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

export function RenameProjectDialog({
  project,
  onClose,
  onRenamed,
}: {
  project: Project | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  return (
    <Dialog open={project !== null} title="Rename project" onClose={onClose}>
      {project ? (
        <RenameForm key={project.id} project={project} onClose={onClose} onRenamed={onRenamed} />
      ) : null}
    </Dialog>
  );
}

function RenameForm({
  project,
  onClose,
  onRenamed,
}: {
  project: Project;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(project.name);
  const formId = useId();
  const rename = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}`, { name: name.trim() }),
    onSuccess: () => {
      onRenamed();
      onClose();
    },
  });
  const unchanged = name.trim() === project.name;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || rename.isPending) return;
    if (unchanged) onClose();
    else rename.mutate();
  };
  return (
    <>
      <form id={formId} onSubmit={submit}>
        <TextField
          label="Name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
          {...(rename.error ? { error: rename.error.message } : {})}
        />
      </form>
      <div className="app-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="primary"
          disabled={!name.trim() || rename.isPending}
        >
          Rename
        </Button>
      </div>
    </>
  );
}

export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project | null;
  onClose: () => void;
  onDeleted: (project: Project) => void;
}) {
  const remove = useMutation({
    mutationFn: (p: Project) => api.delete<{ trashed: number }>(`/projects/${p.id}`),
    onSuccess: (_, p) => {
      onDeleted(p);
      onClose();
    },
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  const count = project?.fileCount ?? 0;
  return (
    <Dialog
      open={project !== null}
      title={project ? `Delete “${project.name}”?` : "Delete project"}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => project && remove.mutate(project)}
          >
            Delete project
          </Button>
        </>
      }
    >
      <p className="app-muted">
        {count > 0
          ? `Its ${files(count)} move to the trash. Restore any of them to bring the project back.`
          : "It has no files. Anything of it in the trash stays there."}
      </p>
      {remove.error ? (
        <p className="dash__dialog-error" role="alert">
          <Icon name="warning" size={16} />
          {remove.error.message}
        </p>
      ) : null}
    </Dialog>
  );
}

export function MoveFileDialog({
  file,
  projects,
  onClose,
  onMoved,
}: {
  file: FileMeta | null;
  projects: readonly Project[];
  onClose: () => void;
  onMoved: (to: Project) => void;
}) {
  return (
    <Dialog
      open={file !== null}
      title={file ? `Move “${file.name}”` : "Move file"}
      onClose={onClose}
    >
      {file ? (
        <MoveForm
          key={file.id}
          file={file}
          projects={projects}
          onClose={onClose}
          onMoved={onMoved}
        />
      ) : null}
    </Dialog>
  );
}

function MoveForm({
  file,
  projects,
  onClose,
  onMoved,
}: {
  file: FileMeta;
  projects: readonly Project[];
  onClose: () => void;
  onMoved: (to: Project) => void;
}) {
  const others = projects.filter((p) => p.id !== file.projectId);
  const [choice, setChoice] = useState<string | null>(others[0]?.id ?? null);
  const formId = useId();
  const move = useMutation({
    mutationFn: (to: Project) => moveFile(file.id, to.id),
    onSuccess: (_, to) => {
      onMoved(to);
      onClose();
    },
  });
  const chosen = others.find((p) => p.id === choice);
  if (others.length === 0)
    return (
      <>
        <p className="app-muted">
          This team has no other project yet. Create one to move files into.
        </p>
        <div className="app-dialog__footer">
          <Button variant="primary" onClick={onClose}>
            OK
          </Button>
        </div>
      </>
    );
  return (
    <>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen && !move.isPending) move.mutate(chosen);
        }}
      >
        <fieldset className="dash__move">
          <legend className="dp-visually-hidden">Project</legend>
          {others.map((p) => (
            <label key={p.id} className="dash__move-option">
              <input
                type="radio"
                name="project"
                value={p.id}
                checked={choice === p.id}
                onChange={() => setChoice(p.id)}
                // biome-ignore lint/a11y/noAutofocus: the dialog just opened on this choice
                autoFocus={choice === p.id}
              />
              <span className="dash__move-name">{p.name}</span>
              <span className="dash__count">{p.fileCount > 0 ? p.fileCount : ""}</span>
            </label>
          ))}
        </fieldset>
      </form>
      {move.error ? (
        <p className="dash__dialog-error" role="alert">
          <Icon name="warning" size={16} />
          {move.error.message}
        </p>
      ) : null}
      <div className="app-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form={formId} variant="primary" disabled={!chosen || move.isPending}>
          Move
        </Button>
      </div>
    </>
  );
}

/** Moves a file to another project on its team. */
export function moveFile(fileId: string, projectId: string): Promise<unknown> {
  return api.patch(`/files/${fileId}`, { projectId });
}

/** One file in the trash, deleted for good once confirmed. */
export function DeleteForeverDialog({
  file,
  onClose,
  onDeleted,
}: {
  file: FileMeta | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: (f: FileMeta) => api.delete(`/files/${f.id}?permanent=1`),
    onSuccess: () => {
      onDeleted();
      onClose();
    },
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={file !== null}
      title={file ? `Delete “${file.name}” for good?` : "Delete for good"}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => file && remove.mutate(file)}
          >
            Delete forever
          </Button>
        </>
      }
    >
      <p className="app-muted">
        The file, its branches, versions and comments are gone for everyone. This can't be undone.
      </p>
      {remove.error ? (
        <p className="dash__dialog-error" role="alert">
          <Icon name="warning" size={16} />
          {remove.error.message}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Everything in the team's trash, deleted for good once confirmed, a batch at a time. */
export function EmptyTrashDialog({
  open,
  teamId,
  count,
  onClose,
  onEmptied,
}: {
  open: boolean;
  teamId: string;
  /** Files in the trash, as listed. */
  count: number;
  onClose: () => void;
  onEmptied: () => void;
}) {
  const [deleted, setDeleted] = useState(0);
  const empty = useMutation({
    mutationFn: async () => {
      setDeleted(0);
      let done = 0;
      for (;;) {
        const step = await api.post<{ deleted: number; remaining: number }>(
          `/teams/${teamId}/trash/empty`,
        );
        done += step.deleted;
        setDeleted(done);
        if (step.remaining === 0 || step.deleted === 0) return done;
      }
    },
    onSettled: onEmptied,
    onSuccess: () => finish(),
  });
  const finish = () => {
    empty.reset();
    setDeleted(0);
    onClose();
  };
  // Not while it's deleting: what's gone is gone, and the count says how far it got.
  const close = () => {
    if (!empty.isPending) finish();
  };
  return (
    <Dialog
      open={open}
      title="Empty the trash?"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={empty.isPending}>
            Cancel
          </Button>
          <Button variant="danger" disabled={empty.isPending} onClick={() => empty.mutate()}>
            {empty.isPending
              ? `Deleting… ${deleted} of ${Math.max(count, deleted)}`
              : "Empty trash"}
          </Button>
        </>
      }
    >
      <p className="app-muted">
        {`${count === 1 ? "The file" : `All ${files(count)}`} in the trash, with ${count === 1 ? "its" : "their"} branches, versions and comments, will be gone for everyone. This can't be undone.`}
      </p>
      {empty.error ? (
        <p className="dash__dialog-error" role="alert">
          <Icon name="warning" size={16} />
          {empty.error.message}
        </p>
      ) : null}
    </Dialog>
  );
}
