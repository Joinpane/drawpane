/**
 * What a layer is called on screen. Its own name, or for a text layer that
 * hasn't been named (or still has the automatic "Text 3"), the first line
 * of what it says, like Figma's, so the layers panel reads like the design.
 */
import { getProp, type NodeRecord } from "@drawpane/model";

/** "Text 3" and the like: a name made up for it, not given by someone. */
const AUTOMATIC = /^Text \d+$/;
/** Long text is cut here, at a word, with an ellipsis. */
const MAX = 48;

export function layerName(node: NodeRecord): string {
  const name = getProp(node.props, "name");
  if (node.type === "text" && (name === "" || AUTOMATIC.test(name))) {
    const words = textName(getProp(node.props, "characters"));
    if (words) return words;
  }
  return name || node.type;
}

/** The first line of some text, trimmed to a readable length. */
function textName(characters: string): string {
  const line = characters.trim().split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
  if (line.length <= MAX) return line;
  const cut = line.slice(0, MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
