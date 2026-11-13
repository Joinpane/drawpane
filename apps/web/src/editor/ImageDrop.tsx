import { Icon } from "@drawpane/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useEditor, useEditorState } from "./hooks";
import { filesFrom, importImageFiles, uploadsFor } from "./media";
import "./media.css";

/** True when a drag carries files (not text or a link). */
function carriesFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
}

/**
 * Files dragged over the canvas: a signal ring around the canvas and a tag
 * at the pointer, then the drop places them where they land. Drops anywhere
 * else in the editor are swallowed so the browser doesn't navigate away.
 */
export function ImageDrop({ fileId }: { fileId: string }) {
  const editor = useEditor();
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const [drag, setDrag] = useState<{ x: number; y: number; count: number } | null>(null);

  useEffect(() => {
    let leaveTimer = 0;
    const overCanvas = (e: DragEvent) =>
      e.target instanceof Element && e.target.closest(".canvas") !== null;
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      clearTimeout(leaveTimer);
      const ok = canEdit && overCanvas(e);
      e.dataTransfer.dropEffect = ok ? "copy" : "none";
      if (!ok) {
        setDrag(null);
        return;
      }
      const count = [...e.dataTransfer.items].filter((i) => i.kind === "file").length;
      setDrag({ x: e.clientX, y: e.clientY, count });
    };
    // dragleave fires when crossing child elements: only clear if nothing follows.
    const onLeave = () => {
      clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => setDrag(null), 60);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDrag(null);
      if (!canEdit || !overCanvas(e)) return;
      const canvas = document.querySelector(".canvas");
      const rect = canvas?.getBoundingClientRect();
      const at = rect
        ? editor.s.camera.toPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
        : undefined;
      void importImageFiles(editor, fileId, filesFrom(e.dataTransfer), at);
    };
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      clearTimeout(leaveTimer);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [editor, fileId, canEdit]);

  if (!drag) return null;
  return (
    <div className="drop-zone" aria-hidden="true">
      <span className="drop-zone__tag" style={{ left: drag.x + 12, top: drag.y + 16 }}>
        {drag.count > 1 ? `Drop to place ${drag.count} images` : "Drop to place image"}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Upload progress, bottom centre, while images travel to storage. Stays a
 * moment after the last one finishes, then clears itself.
 */
export function UploadTray() {
  const editor = useEditor();
  const queue = uploadsFor(editor);
  const items = useSyncExternalStore(queue.subscribe, () => queue.items);
  const notice = useEditorState((s) => s.notice);
  const [noticeShown, setNoticeShown] = useState(false);
  const busy = items.some((i) => i.status === "waiting" || i.status === "uploading");

  useEffect(() => {
    if (busy || items.length === 0) return;
    const t = setTimeout(() => queue.clearFinished(), 2500);
    return () => clearTimeout(t);
  }, [busy, items, queue]);

  // Notices show in the same spot for four seconds: sit above them meanwhile.
  useEffect(() => {
    if (!notice) return;
    setNoticeShown(true);
    const t = setTimeout(() => setNoticeShown(false), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (items.length === 0) return null;
  const shown = items.slice(-4);
  return (
    <section
      className={`upload-tray${noticeShown ? " upload-tray--raised" : ""}`}
      aria-label="Image uploads"
      aria-live="polite"
    >
      <ul className="upload-tray__list">
        {shown.map((item) => {
          const pct = item.bytes > 0 ? Math.round((item.loaded / item.bytes) * 100) : 0;
          const label =
            item.status === "done"
              ? "Done"
              : item.status === "error"
                ? "Failed"
                : item.status === "waiting"
                  ? "Waiting"
                  : `${pct}%`;
          return (
            <li key={item.id} className={`upload-tray__item upload-tray__item--${item.status}`}>
              <Icon name={item.status === "error" ? "warning" : "image"} size={12} />
              <span className="upload-tray__name">
                {item.name} · {formatBytes(item.bytes)}
              </span>
              <span className="upload-tray__state">{label}</span>
              <span
                className="upload-tray__bar"
                role="progressbar"
                aria-label={`Uploading ${item.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.status === "done" ? 100 : pct}
              >
                <span style={{ width: `${item.status === "done" ? 100 : pct}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > shown.length ? (
        <p className="upload-tray__note">and {items.length - shown.length} more</p>
      ) : null}
      <p className="upload-tray__note">
        {busy
          ? "Collaborators see each image once its upload finishes."
          : "Uploaded. Everyone in the file can see these images."}
      </p>
    </section>
  );
}
