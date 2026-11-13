import type { VersionInfo } from "@drawpane/model";
import { Button, TextField } from "@drawpane/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api } from "../../api/client";
import { Dialog } from "../../app/Dialog";
import { whenPhrase } from "./labels";

/**
 * Names a version: the file as it is now (no `version`), or a saved one
 * (naming an autosave, or renaming a named version).
 */
export function NameVersionDialog({
  open,
  fileId,
  version,
  onClose,
  onSaved,
}: {
  open: boolean;
  fileId: string;
  version: VersionInfo | null;
  onClose: () => void;
  onSaved: (version: VersionInfo) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    setName(version?.name ?? "");
    setDescription(version?.description ?? "");
  }, [open, version]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), description: description.trim() };
      return version
        ? (await api.updateVersion(fileId, version.id, body)).version
        : (await api.saveVersion(fileId, body)).version;
    },
    onSuccess: (saved) => {
      onSaved(saved);
      onClose();
    },
  });
  useEffect(() => {
    if (open) save.reset();
  }, [open, save.reset]);

  const renaming = version?.name != null;
  const submit = () => {
    if (name.trim() && !save.isPending) save.mutate();
  };
  return (
    <Dialog
      open={open}
      title={
        renaming ? "Rename version" : version ? "Name this version" : "Name the current version"
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : renaming ? "Rename" : "Save version"}
          </Button>
        </>
      }
    >
      <p className="history-dialog__lede">
        {version
          ? `The version saved ${whenPhrase(version.createdAt)}. Named versions are kept for good.`
          : "Saves the file as it is right now. Named versions are kept for good, and anyone on the team can go back to them."}
      </p>
      <form
        className="history-dialog__form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Name"
          placeholder="Before the color pass"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          {...(save.error ? { error: save.error.message } : {})}
        />
        <div className="dp-tf">
          <label className="dp-tf__label" htmlFor={descriptionId}>
            Description <span className="history-dialog__optional">optional</span>
          </label>
          <textarea
            id={descriptionId}
            className="dp-tf__input history-dialog__textarea"
            placeholder="What changed, and why"
            value={description}
            maxLength={2000}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
        </div>
      </form>
    </Dialog>
  );
}
