/**
 * Figma's node ids ("7:187", "I12:3;45:6" inside instances) as Drawpane
 * ids: the same characters with ":" and ";" spelled "-" and "_", so the same
 * Figma file always imports to the same ids (and re-importing can match
 * layers up). One too long for Drawpane is shortened with a hash.
 */
const MAX = 64;

/** FNV-1a, as base 36: short, stable, and enough to keep long ids apart. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function drawpaneId(figmaId: string): string {
  const id = `f${figmaId
    .replace(/:/g, "-")
    .replace(/;/g, "_")
    .replace(/[^0-9A-Za-z_-]/g, "")}`;
  if (id.length <= MAX) return id;
  const tail = hash(figmaId);
  return `${id.slice(0, MAX - tail.length - 1)}_${tail}`;
}

/** The main component's layer an instance's layer copies: the last part of its id path. */
export function mirroredId(figmaId: string): string | null {
  if (!figmaId.startsWith("I")) return null;
  const parts = figmaId.slice(1).split(";");
  if (parts.length < 2) return null;
  // "I<instance>;<layer>": the main's layer. Deeper, "I<instance>;<inner instance>;<layer>": the
  // main's copy of the inner instance's layer, which is itself "I<inner instance>;<layer>".
  return parts.length === 2 ? (parts[1] as string) : `I${parts.slice(1).join(";")}`;
}

/**
 * The layer a copy's layer copies when it's inside a nested instance that
 * isn't a copy of its main's layer as it is (`base`, that instance's Figma
 * id): one swapped for another component, or one copying nothing, as slot
 * content. Figma names a layer by its path of instances, the last element
 * the layer in the innermost one's component, so under such an instance
 * the path goes on in its own component: "<base>;<layer>" is that
 * component's own layer, and deeper ones its copies, as `mirroredId` reads
 * them from there. Null when the id isn't under `base`.
 */
export function mirroredUnder(figmaId: string, base: string): string | null {
  if (!figmaId.startsWith("I") || !base.startsWith("I")) return null;
  const parts = figmaId.slice(1).split(";");
  const prefix = base.slice(1).split(";");
  if (parts.length <= prefix.length || prefix.some((p, i) => parts[i] !== p)) return null;
  const rest = parts.slice(prefix.length);
  return rest.length === 1 ? (rest[0] as string) : `I${rest.join(";")}`;
}
