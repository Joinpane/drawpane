import {
  CanvasRenderer,
  type Editor,
  exportBounds,
  exportFileName,
  fitScale,
  isVectorFormat,
  snapToPixels,
} from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { Button, PropertySection, SegmentedControl, type SegmentedOption } from "@drawpane/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isMac } from "../app/format";
import { formatShortcut } from "./actions";
import { type ExportSettings, exportName, exportSelection, exportSettings } from "./exporting";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { imagesFor } from "./media";
import "./media.css";

const PREVIEW = { width: 232, height: 96 };

const SCALES: readonly SegmentedOption<"1" | "2" | "3">[] = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
];

const FORMATS: readonly SegmentedOption<ExportSettings["format"]>[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
  { value: "svg", label: "SVG" },
  { value: "pdf", label: "PDF" },
];

/**
 * A small picture of what will export, redrawn when the layers settle
 * (never mid-drag). Returns an object URL, revoked when it changes.
 */
function useExportPreview(editor: Editor, ids: readonly string[], version: number): string | null {
  const gesture = useEditorState((s) => s.gesture);
  const [url, setUrl] = useState<string | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    if (gesture || typeof OffscreenCanvas === "undefined") return;
    let cancelled = false;
    let made: string | null = null;
    const timer = setTimeout(async () => {
      const list = key.split(",").filter(Boolean);
      const bounds = exportBounds(editor.scene, list);
      if (!bounds) {
        setUrl(null);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const scale = fitScale(bounds, {
        width: (PREVIEW.width - 16) * dpr,
        height: (PREVIEW.height - 16) * dpr,
      });
      const rect = snapToPixels(bounds, scale);
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(rect.width * scale)),
        Math.max(1, Math.round(rect.height * scale)),
      );
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const renderer = new CanvasRenderer(editor.scene, editor.measurer, {
        images: imagesFor(editor),
      });
      renderer.renderNodes(ctx, list, rect, scale);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      if (cancelled) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (made) URL.revokeObjectURL(made);
    };
  }, [editor, key, version, gesture]);
  return url;
}

/** Each selected layer is a page of the PDF. */
const pageCount = (n: number) => (n === 1 ? "1 page" : `${n} pages`);

/** The Export section: scale, format and a button, plus ⇧⌘E. Viewers can export too. */
export function ExportSection({
  editor,
  nodes,
  version,
}: {
  editor: Editor;
  nodes: readonly NodeRecord[];
  version: number;
}) {
  const settings = useSyncExternalStore(exportSettings.subscribe, exportSettings.get);
  const ids = nodes.map((n) => n.id);
  const preview = useExportPreview(editor, ids, version);
  const file = exportFileName(exportName(editor, ids), settings.format, settings.scale);
  return (
    <div className="inspector inspector-export">
      <PropertySection title="Export">
        {preview ? (
          <div className="export-section__preview">
            <img src={preview} alt="" />
          </div>
        ) : null}
        <SegmentedControl
          label="Export scale"
          options={SCALES}
          value={isVectorFormat(settings.format) ? "1" : String(settings.scale)}
          disabled={isVectorFormat(settings.format)}
          onChange={(value) =>
            exportSettings.set({ scale: Number(value) as ExportSettings["scale"] })
          }
        />
        <SegmentedControl
          label="Export format"
          options={FORMATS}
          value={settings.format}
          onChange={(format) => exportSettings.set({ format })}
        />
        <Button
          icon="export"
          size="sm"
          className="export-section__button"
          shortcut={formatShortcut({ key: "e", mod: true, shift: true })}
          aria-keyshortcuts={isMac() ? "Shift+Meta+E" : "Shift+Control+E"}
          onClick={() => void exportSelection(editor)}
        >
          {settings.format === "pdf"
            ? "Export PDF"
            : nodes.length > 1
              ? `Export ${nodes.length} layers`
              : "Export layer"}
        </Button>
        <p className="export-section__hint" title={file}>
          Saves {file}
          {settings.format === "pdf" ? ` · ${pageCount(nodes.length)}` : ""}
        </p>
      </PropertySection>
    </div>
  );
}

/**
 * The Export section for the current selection. It sits after the
 * Inspector's fieldset, not inside it, so viewers can export too.
 */
export function ExportPanel() {
  const editor = useEditor();
  const version = useDocVersion();
  const selection = useEditorState((s) => s.selection);
  const nodes = selection.map((id) => editor.doc.get(id)).filter((n): n is NodeRecord => !!n);
  if (nodes.length === 0) return null;
  return <ExportSection editor={editor} nodes={nodes} version={version} />;
}
