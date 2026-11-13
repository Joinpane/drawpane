/**
 * Image paints in the Fill section: a chip in the paint row, a toggle that
 * switches a paint between solid and image, and the image's own controls
 * (preview, replace, scale mode), after the image tab of the fill picker
 * design.
 */
import { type Editor, imagePlacement, type ScaleMode } from "@drawpane/editor";
import type { Paint } from "@drawpane/model";
import { Button, IconButton, SegmentedControl, type SegmentedOption } from "@drawpane/ui";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api/client";
import {
  chooseImageFile,
  imagesFor,
  type MediaInfo,
  uploadImageForFill,
  uploadsFor,
} from "./media";
import "./media.css";

type ImagePaint = Extract<Paint, { type: "image" }>;

const SCALE_MODES: readonly SegmentedOption<ScaleMode>[] = [
  { value: "fill", label: "Fill" },
  { value: "fit", label: "Fit" },
  { value: "tile", label: "Tile" },
  { value: "stretch", label: "Stretch" },
];

const MODE_LABEL: Record<ScaleMode, string> = {
  fill: "Fill",
  fit: "Fit",
  tile: "Tile",
  stretch: "Stretch",
};

/** A new paint's shared fields (visibility, opacity, blend), copied only when set. */
function base(paint: Paint) {
  return {
    ...(paint.visible !== undefined ? { visible: paint.visible } : {}),
    ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}),
    ...(paint.blendMode !== undefined ? { blendMode: paint.blendMode } : {}),
  };
}

function useFileId(): string {
  return useParams({ from: "/f/$fileId" }).fileId;
}

/** Draws a cached image into a canvas the way the layer shows it, and repaints when it loads. */
function useImagePreview(
  editor: Editor,
  canvas: React.RefObject<HTMLCanvasElement | null>,
  sha: string,
  mode: ScaleMode,
): boolean {
  const cache = imagesFor(editor);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const draw = () => {
      const el = canvas.current;
      if (!el) return;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      const natural = cache.natural(sha);
      const place = natural ? imagePlacement(mode, { width: w, height: h }, natural) : null;
      const view = place ? cache.get(sha, place.width * dpr) : null;
      setLoaded(!!view);
      if (!place || !view) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = "high";
      if (place.tile) {
        const pattern = ctx.createPattern(view.bitmap, "repeat");
        if (!pattern) return;
        pattern.setTransform(
          new DOMMatrix().scale(
            view.naturalWidth / view.bitmap.width,
            view.naturalHeight / view.bitmap.height,
          ),
        );
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      } else {
        ctx.drawImage(view.bitmap, place.x, place.y, place.width, place.height);
      }
    };
    draw();
    return cache.subscribe(draw);
  }, [cache, canvas, sha, mode]);
  return loaded;
}

/** The left slot of an image paint's row: a tiny preview and the scale mode. */
export function ImageChip({ editor, paint }: { editor: Editor; paint: ImagePaint }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useImagePreview(editor, canvas, paint.ref, "fill");
  return (
    <span className="image-chip">
      <span className="image-chip__thumb" aria-hidden="true">
        <canvas ref={canvas} />
      </span>
      <span className="image-chip__label">Image · {MODE_LABEL[paint.scaleMode]}</span>
    </span>
  );
}

/** Switches a fill between a solid colour and an image (choosing the image first). */
export function PaintKindToggle({
  editor,
  paint,
  onChange,
}: {
  editor: Editor;
  paint: Paint;
  onChange: (next: Paint, label: string) => void;
}) {
  const fileId = useFileId();
  const image = paint.type === "image";
  return (
    <IconButton
      icon="image"
      label={image ? "Use a solid color" : "Use an image"}
      pressed={image}
      onClick={async () => {
        if (image) {
          onChange({ type: "solid", color: "#d9d9d6", ...base(paint) }, "Fill type");
          return;
        }
        const file = await chooseImageFile();
        if (!file) return;
        const ref = await uploadImageForFill(editor, fileId, file);
        if (ref) onChange({ type: "image", ref, scaleMode: "fill", ...base(paint) }, "Fill type");
      }}
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Preview, replace and scale mode for one image paint. */
export function ImageFillEditor({
  editor,
  paint,
  onChange,
}: {
  editor: Editor;
  paint: ImagePaint;
  onChange: (next: ImagePaint, label: string) => void;
}) {
  const fileId = useFileId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const loaded = useImagePreview(editor, canvas, paint.ref, paint.scaleMode);
  const queue = uploadsFor(editor);
  const upload = useSyncExternalStore(queue.subscribe, () =>
    queue.items.findLast((i) => i.sha === paint.ref),
  );
  const uploading = upload?.status === "waiting" || upload?.status === "uploading";
  const info = useQuery({
    queryKey: ["media", paint.ref],
    queryFn: () => api.get<MediaInfo>(`/media/${paint.ref}/info`),
    enabled: !uploading,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });
  const natural = loaded ? imagesFor(editor).natural(paint.ref) : null;
  const size = natural ?? (info.data ? { width: info.data.width, height: info.data.height } : null);
  const pct = upload && upload.bytes > 0 ? Math.round((upload.loaded / upload.bytes) * 100) : 0;
  const meta = [
    size ? `${size.width} × ${size.height}` : null,
    uploading ? `uploading ${pct}%` : info.data ? formatBytes(info.data.bytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="image-fill">
      <div className="image-fill__preview">
        <canvas ref={canvas} role="img" aria-label={loaded ? "Image preview" : "Image loading"} />
        {loaded ? null : <span className="image-fill__status">Loading image…</span>}
        <Button
          size="sm"
          className="image-fill__replace"
          onClick={async () => {
            const file = await chooseImageFile();
            if (!file) return;
            const ref = await uploadImageForFill(editor, fileId, file);
            if (ref) onChange({ ...paint, ref }, "Replace image");
          }}
        >
          Replace
        </Button>
      </div>
      <SegmentedControl
        label="Image scale mode"
        options={SCALE_MODES}
        value={paint.scaleMode}
        onChange={(scaleMode) => onChange({ ...paint, scaleMode }, "Image scale mode")}
      />
      {meta ? <p className="image-fill__meta">{meta}</p> : null}
    </div>
  );
}
