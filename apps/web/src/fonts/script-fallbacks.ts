import type { Editor, ShapingFace } from "@drawpane/editor";
import { getProp, SCRIPT_SUBSET_LIMIT, type ScriptSubset, scriptSubsets } from "@drawpane/model";

interface Asset {
  readonly face: ScriptSubset & ShapingFace;
  readonly coverage: ReadonlySet<string>;
  readonly bytes: ArrayBuffer;
}

const assets = new Map<string, Asset>();
const claimed = new Map<string, Set<string>>();
const listeners = new Set<(subset: ScriptSubset) => void>();
const key = ({ family, subset }: { family: string; subset: string }) => `${family}\0${subset}`;

export function scriptFallbackBytes(face: { family: string; subset: string }): ArrayBuffer | null {
  return assets.get(key(face))?.bytes ?? null;
}

export function scriptFallbackFaces(text: string): readonly ShapingFace[] {
  return [...assets.values()]
    .reverse()
    .filter((asset) => [...text].some((char) => asset.coverage.has(char)))
    .map((asset) => asset.face);
}

async function attach(subset: ScriptSubset): Promise<void> {
  const url = new URLSearchParams({ family: subset.family, characters: subset.subset });
  const response = await fetch(`/api/fonts/fallback?${url}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Fallback font: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const coverage = new Set(subset.subset);
  const font = new FontFace(`Drawpane ${subset.family}`, bytes, {
    weight: "100 900",
    unicodeRange: [...coverage].map((char) => `U+${char.codePointAt(0)?.toString(16)}`).join(","),
  });
  await font.load();
  if (
    [...assets.values()].some(
      (asset) =>
        asset.face.family === subset.family &&
        [...coverage].every((char) => asset.coverage.has(char)),
    )
  )
    return;
  document.fonts.add(font);
  assets.set(key(subset), { face: { ...subset, weight: 400, italic: false }, coverage, bytes });
  for (const listener of listeners) listener(subset);
}

function prepare(texts: Iterable<string>): void {
  if (typeof FontFace === "undefined") return;
  const subsets = scriptSubsets(texts);
  for (const { family, subset } of subsets) {
    const previous = claimed.get(family) ?? new Set<string>();
    const fresh = [...subset].filter((char) => !previous.has(char));
    if (fresh.length === 0) continue;
    for (const char of fresh) previous.add(char);
    claimed.set(family, previous);
    // Joining forms must share a font file. If a new edit expands a
    // joining script's alphabet, replace the earlier subset with its union.
    const joining = family === "Noto Sans Arabic" || family === "Noto Sans Hebrew";
    const chars = joining && previous.size <= SCRIPT_SUBSET_LIMIT ? [...previous] : fresh;
    const sorted = chars.sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
    void attach({ family, subset: sorted.join("") }).catch(() => {
      for (const char of fresh) previous.delete(char);
    });
  }
}

/** Prepare one active page at a time. Subsequent edits only request newly seen characters. */
export function watchScriptFallbacks(
  editor: Editor,
  onReady: (subset: ScriptSubset) => void,
): () => void {
  let pageId = editor.s.pageId;
  let queued = false;
  let stopped = false;
  function refresh() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (stopped || !editor.s.pageId) return;
      const stack = [...editor.doc.childIds(editor.s.pageId)];
      const text: string[] = [];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        const node = editor.doc.get(id);
        if (!node || node.props.visible === false) continue;
        if (node.type === "text") text.push(getProp(node.props, "characters"));
        for (const child of editor.doc.childIds(id)) stack.push(child);
      }
      prepare(text);
    });
  }
  listeners.add(onReady);
  const offState = editor.state.subscribe(() => {
    if (pageId === editor.s.pageId) return;
    pageId = editor.s.pageId;
    refresh();
  });
  const offDoc = editor.doc.subscribe((change) => {
    if (change.reset) {
      refresh();
      return;
    }
    prepare(
      [...change.ids].flatMap((id) => {
        const node = editor.doc.get(id);
        return node?.type === "text" ? [getProp(node.props, "characters")] : [];
      }),
    );
  });
  refresh();
  return () => {
    stopped = true;
    listeners.delete(onReady);
    offState();
    offDoc();
  };
}
