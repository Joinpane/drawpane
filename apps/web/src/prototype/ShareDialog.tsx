import { Button, Icon, Switch } from "@drawpane/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { Dialog } from "../app/Dialog";

/**
 * Sharing a file: a prototype link anyone can open (editors turn it on, off
 * or reset it), and the file's own link for people on the team.
 */
export function ShareDialog({
  fileId,
  fileName,
  canEdit,
  flowId = null,
  open,
  onClose,
}: {
  fileId: string;
  fileName: string;
  canEdit: boolean;
  /** Copy the prototype link opening on this flow. */
  flowId?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const key = ["share", fileId];
  const query = useQuery({ queryKey: key, queryFn: () => api.shareLink(fileId), enabled: open });
  const set = (link: Awaited<ReturnType<typeof api.shareLink>>["link"]) =>
    queryClient.setQueryData(key, { link });
  const turnOn = useMutation({
    mutationFn: () => api.createShareLink(fileId),
    onSuccess: ({ link }) => set(link),
  });
  const turnOff = useMutation({
    mutationFn: () => api.deleteShareLink(fileId),
    onSuccess: () => set(null),
  });
  const reset = useMutation({
    mutationFn: async () => {
      await api.deleteShareLink(fileId);
      return api.createShareLink(fileId);
    },
    onSuccess: ({ link }) => set(link),
  });
  const [copied, setCopied] = useState<"prototype" | "file" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const copy = async (text: string, which: "prototype" | "file") => {
    await navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 1600);
  };

  const link = query.data?.link ?? null;
  const url = link ? (flowId ? `${link.url}?flow=${encodeURIComponent(flowId)}` : link.url) : null;
  const busy = turnOn.isPending || turnOff.isPending || reset.isPending;
  const error = turnOn.error ?? turnOff.error ?? reset.error ?? query.error;

  return (
    <Dialog
      open={open}
      title={`Share “${fileName || "Untitled"}”`}
      onClose={() => {
        setConfirmReset(false);
        onClose();
      }}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <section className="share__section" aria-labelledby="share-prototype">
        <div className="share__head">
          <span className="share__badge" data-on={link ? true : undefined} aria-hidden="true">
            <Icon name="play" size={16} />
          </span>
          <div className="share__text">
            <h3 id="share-prototype" className="share__title">
              Prototype link
            </h3>
            <p className="share__note">
              {link
                ? "Anyone with the link can play the prototype. They can't edit, comment or see who's here."
                : canEdit
                  ? "Turn this on to let anyone play the prototype, no account needed."
                  : "Off. Someone who can edit this file can turn it on."}
            </p>
          </div>
          <Switch
            aria-label="Anyone with the link can play the prototype"
            checked={link !== null}
            disabled={!canEdit || busy || query.isPending}
            onChange={(on) => (on ? turnOn.mutate() : turnOff.mutate())}
          />
        </div>
        {url ? (
          <div className="app-copy">
            <code>{url}</code>
            <Button size="sm" variant="primary" onClick={() => void copy(url, "prototype")}>
              {copied === "prototype" ? "Copied" : "Copy link"}
            </Button>
          </div>
        ) : null}
        {link && canEdit ? (
          confirmReset ? (
            <div className="share__confirm">
              <span>The current link stops working for everyone who has it.</span>
              <Button size="sm" variant="secondary" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setConfirmReset(false);
                  reset.mutate();
                }}
              >
                Reset link
              </Button>
            </div>
          ) : (
            <button type="button" className="share__reset" onClick={() => setConfirmReset(true)}>
              Reset link…
            </button>
          )
        ) : null}
        {error ? (
          <p className="share__error" role="alert">
            {error.message}
          </p>
        ) : null}
      </section>
      <section className="share__section share__section--file" aria-labelledby="share-file">
        <div className="share__head">
          <span className="share__badge" aria-hidden="true">
            <Icon name="link" size={16} />
          </span>
          <div className="share__text">
            <h3 id="share-file" className="share__title">
              File link
            </h3>
            <p className="share__note">People on your team can open the file with this link.</p>
          </div>
          <Button size="sm" onClick={() => void copy(`${location.origin}/f/${fileId}`, "file")}>
            {copied === "file" ? "Copied" : "Copy"}
          </Button>
        </div>
      </section>
    </Dialog>
  );
}
