/**
 * Branches from the title bar (decision 0012). On a main file, a button; on
 * a branch, a chip with its name. Either opens the file's branches: open
 * ones (to switch to, or review), merged ones (read-only history), and a
 * field to make a new one from main.
 */
import type { BranchInfo } from "@drawpane/model";
import {
  Button,
  Icon,
  IconButton,
  MenuButton,
  Popover,
  SegmentedControl,
  TextField,
} from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../api/client";
import { Dialog } from "../../app/Dialog";
import { timeAgo } from "../../app/format";
import "./branches.css";

export interface BranchMenuProps {
  /** The file open now: main, or one of its branches. */
  readonly fileId: string;
  readonly main: { readonly id: string; readonly name: string };
  /** Set when the file open now is a branch. */
  readonly branch: BranchInfo | null;
}

export function BranchMenu({ fileId, main, branch }: BranchMenuProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<BranchInfo | null>(null);
  const toggle = () => setOpen((v) => !v);
  return (
    <>
      {branch ? (
        <button
          ref={setAnchor}
          type="button"
          className="branch-chip"
          data-merged={branch.merged ? true : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={branch.merged ? `${branch.name} (merged)` : `Branch: ${branch.name}`}
          onClick={toggle}
        >
          <Icon name={branch.merged ? "check" : "branch"} size={12} />
          <span className="branch-chip__name">{branch.name}</span>
          {branch.merged ? <span className="branch-chip__state">Merged</span> : null}
        </button>
      ) : (
        <IconButton
          ref={setAnchor}
          icon="branch"
          label="Branches"
          aria-haspopup="dialog"
          aria-expanded={open}
          pressed={open}
          className="file-title__branches"
          onClick={toggle}
        />
      )}
      {open && anchor ? (
        <Popover
          anchor={anchor}
          label="Branches"
          side="bottom"
          autoFocus={false}
          onClose={() => setOpen(false)}
          className="branch-menu"
        >
          <BranchList
            fileId={fileId}
            main={main}
            onDone={() => setOpen(false)}
            onDelete={(b) => {
              setOpen(false);
              setDeleting(b);
            }}
          />
        </Popover>
      ) : null}
      <DeleteBranchDialog
        branch={deleting}
        here={fileId}
        mainId={main.id}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

type Tab = "open" | "merged";

function BranchList({
  fileId,
  main,
  onDone,
  onDelete,
}: {
  fileId: string;
  main: { readonly id: string; readonly name: string };
  onDone: () => void;
  onDelete: (branch: BranchInfo) => void;
}) {
  const list = useQuery({
    queryKey: ["branches", main.id],
    queryFn: () => api.branches(main.id),
  });
  const branches = list.data?.branches ?? [];
  const open = branches.filter((b) => !b.merged);
  const merged = branches.filter((b) => b.merged);
  const [tab, setTab] = useState<Tab>("open");
  const shown = tab === "open" ? open : merged;
  const canBranch = list.data?.canBranch ?? false;

  return (
    <div className="branch-menu__body">
      <div className="branch-menu__head">
        <h2>Branches</h2>
        <SegmentedControl
          label="Show"
          options={[
            { value: "open", label: open.length > 0 ? `Open · ${open.length}` : "Open" },
            { value: "merged", label: "Merged", disabled: merged.length === 0 },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
      </div>
      <ul className="branch-menu__list" aria-busy={list.isPending || undefined}>
        {tab === "open" ? (
          <li>
            <Link
              to="/f/$fileId"
              params={{ fileId: main.id }}
              className="branch-row"
              aria-current={main.id === fileId ? "page" : undefined}
              onClick={onDone}
            >
              <span className="branch-row__icon branch-row__icon--main" aria-hidden="true">
                <Icon name="branch" size={12} />
              </span>
              <span className="branch-row__text">
                <span className="branch-row__name">{main.name}</span>
                <span className="branch-row__meta">Main file</span>
              </span>
            </Link>
          </li>
        ) : null}
        {list.isPending ? (
          <li className="branch-menu__skeleton" />
        ) : list.error ? (
          <li className="branch-menu__note" role="alert">
            {list.error.message}
          </li>
        ) : shown.length === 0 ? (
          <li className="branch-menu__note">
            {canBranch
              ? "A branch is a copy to try changes on. Main stays as it is until you merge."
              : "No branches yet. Editors can make one to try changes without touching main."}
          </li>
        ) : (
          shown.map((b) => (
            <BranchRow
              key={b.id}
              branch={b}
              here={b.id === fileId}
              canEdit={canBranch}
              onDone={onDone}
              onDelete={() => onDelete(b)}
            />
          ))
        )}
      </ul>
      {canBranch ? <NewBranch main={main} onDone={onDone} /> : null}
    </div>
  );
}

function branchMeta(branch: BranchInfo): string {
  if (branch.merged) {
    const by = branch.merged.by ? `Merged by ${branch.merged.by.name}` : "Merged";
    return `${by} · ${timeAgo(branch.merged.at)}`;
  }
  const who = branch.createdBy?.name.split(/\s+/)[0];
  const edited =
    branch.updatedAt > branch.createdAt + 1000
      ? `edited ${timeAgo(branch.updatedAt)}`
      : `made ${timeAgo(branch.createdAt)}`;
  return who ? `${who} · ${edited}` : edited.charAt(0).toUpperCase() + edited.slice(1);
}

function BranchRow({
  branch,
  here,
  canEdit,
  onDone,
  onDelete,
}: {
  branch: BranchInfo;
  here: boolean;
  canEdit: boolean;
  onDone: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="branch-menu__item">
      <Link
        to="/f/$fileId"
        params={{ fileId: branch.id }}
        className="branch-row"
        aria-current={here ? "page" : undefined}
        onClick={onDone}
      >
        <span className="branch-row__icon" aria-hidden="true">
          <Icon name={branch.merged ? "check" : "branch"} size={12} />
        </span>
        <span className="branch-row__text">
          <span className="branch-row__name">{branch.name}</span>
          <span className="branch-row__meta">{branchMeta(branch)}</span>
        </span>
      </Link>
      <span className="branch-row__actions">
        {branch.merged ? null : (
          <Link
            to="/f/$fileId"
            params={{ fileId: branch.id }}
            search={{ review: true }}
            className="branch-row__review"
            onClick={onDone}
          >
            Review
          </Link>
        )}
        {canEdit ? (
          <MenuButton
            label={`${branch.name} options`}
            items={[{ id: "delete", label: "Delete branch…", icon: "trash", onSelect: onDelete }]}
          />
        ) : null}
      </span>
    </li>
  );
}

function NewBranch({
  main,
  onDone,
}: {
  main: { readonly id: string; readonly name: string };
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createBranch(main.id, name.trim()),
    onSuccess: ({ branch }) => {
      void queryClient.invalidateQueries({ queryKey: ["branches", main.id] });
      onDone();
      void navigate({ to: "/f/$fileId", params: { fileId: branch.id } });
    },
  });
  return (
    <form
      className="branch-menu__new"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !create.isPending) create.mutate();
      }}
    >
      <TextField
        label={`New branch from ${main.name}`}
        placeholder="What you're trying"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => e.stopPropagation()}
        error={create.error?.message}
      />
      <Button
        type="submit"
        variant="primary"
        icon="branch"
        disabled={!name.trim() || create.isPending}
      >
        {create.isPending ? "Making…" : "Make branch"}
      </Button>
    </form>
  );
}

function DeleteBranchDialog({
  branch,
  here,
  mainId,
  onClose,
}: {
  branch: BranchInfo | null;
  here: string;
  mainId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (b: BranchInfo) => api.deleteBranch(b.id),
    onSuccess: (_, b) => {
      void queryClient.invalidateQueries({ queryKey: ["branches", mainId] });
      onClose();
      // Its own file is gone: back to main.
      if (b.id === here) void navigate({ to: "/f/$fileId", params: { fileId: mainId } });
    },
  });
  return (
    <Dialog
      open={branch !== null}
      title="Delete this branch?"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => branch && remove.mutate(branch)}
          >
            {remove.isPending ? "Deleting…" : "Delete branch"}
          </Button>
        </>
      }
    >
      <p className="branch-dialog__lede">
        {branch?.merged
          ? `“${branch.name}” was merged, so main keeps its changes. Deleting it removes the branch and its history for good.`
          : `“${branch?.name ?? ""}” and its changes are deleted for good. Main isn't affected.`}
      </p>
      {remove.error ? (
        <p className="branch-dialog__error" role="alert">
          {remove.error.message}
        </p>
      ) : null}
    </Dialog>
  );
}
