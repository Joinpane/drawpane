/**
 * A calm, deterministic placeholder until files publish real thumbnails: a
 * tinted board with a few blocks, seeded by the file id so each file keeps
 * its own look.
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

export function FileThumbnail({ fileId }: { fileId: string }) {
  const h = hash(fileId);
  const tint = `var(--${TINTS[h % TINTS.length]})`;
  const wide = 40 + (h % 30);
  return (
    <span className="thumb" style={{ "--thumb-tint": tint } as React.CSSProperties} aria-hidden="true">
      <span className="thumb__board" />
      <span className="thumb__block" style={{ width: `${wide}%` }} />
      <span className="thumb__bar" style={{ width: `${wide * 0.7}%` }} />
    </span>
  );
}
