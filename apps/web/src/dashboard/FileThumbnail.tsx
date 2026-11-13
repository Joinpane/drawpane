import { useState } from "react";

/**
 * A file's card picture. Files show the thumbnail the editor publishes,
 * fitted and centred on the canvas ground with room around it, like a print
 * on a mat. Until a file has one, or if it fails to load, a calm
 * deterministic placeholder stands in: a tinted board with a few blocks,
 * seeded by the file id so each file keeps its own look.
 */
const TINTS = ["presence-1", "presence-3", "presence-5", "signal", "presence-2", "presence-6"];

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function Placeholder({ fileId }: { fileId: string }) {
  const h = hash(fileId);
  const tint = `var(--${TINTS[h % TINTS.length]})`;
  const wide = 40 + (h % 30);
  return (
    <span
      className="thumb"
      style={{ "--thumb-tint": tint } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="thumb__board" />
      <span className="thumb__block" style={{ width: `${wide}%` }} />
      <span className="thumb__bar" style={{ width: `${wide * 0.7}%` }} />
    </span>
  );
}

export function FileThumbnail({
  fileId,
  thumbnailAt = null,
}: {
  fileId: string;
  thumbnailAt?: number | null;
}) {
  // Which version loaded or failed, so a newer thumbnail gets its own chance.
  const [loaded, setLoaded] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  if (thumbnailAt === null || failed === thumbnailAt) return <Placeholder fileId={fileId} />;
  const ready = loaded === thumbnailAt;
  return (
    <span className={ready ? "thumb thumb--image thumb--ready" : "thumb thumb--image"}>
      {ready ? null : <Placeholder fileId={fileId} />}
      <img
        className="thumb__image"
        src={`/api/files/${encodeURIComponent(fileId)}/thumbnail?v=${thumbnailAt}`}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(thumbnailAt)}
        onError={() => setFailed(thumbnailAt)}
      />
    </span>
  );
}
