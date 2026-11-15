/**
 * A kit's cover: the picture its source publishes, through this server. A
 * kit without one, or whose cover doesn't load, gets a calm placeholder
 * with its initial, tinted from its id so each kit keeps its own look.
 */
import { useState } from "react";
import type { Kit } from "./registry";

const TINTS = ["presence-1", "presence-3", "presence-5", "signal", "presence-2", "presence-6"];

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function KitCover({ kit, eager = false }: { kit: Kit; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (kit.hasCover && !failed)
    return (
      <img
        className="kits__cover"
        src={`/api/kits/${encodeURIComponent(kit.id)}/cover`}
        alt=""
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  return (
    <span
      className="kits__cover kits__cover--none"
      style={
        { "--kit-tint": `var(--${TINTS[hash(kit.id) % TINTS.length]})` } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {Array.from(kit.name.trim())[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
