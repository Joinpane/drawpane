/**
 * Saying a file's fonts are missing (decision 0036), as Figma does:
 *
 * - **The notice**: once per file per session, when the file has loaded and
 *   some family or style it uses isn't here, a toast names what's missing
 *   and opens the missing fonts panel. It waits for the Google catalog and
 *   the team's fonts, so it never shows for a family that turns out to be
 *   here. It takes no focus and blocks nothing.
 * - **The top bar button**: while anything is missing, a quiet button with a
 *   count opens the panel too.
 *
 * Families drawn through an alias aren't missing: they show neither. Both
 * read the editor's one font report (font-report.ts), so neither costs an
 * edit anything.
 */
import type { Editor } from "@drawpane/editor";
import { Button, Icon, IconButton, Tooltip } from "@drawpane/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { fonts } from "../fonts/fonts";
import { PASS_GESTURES } from "./canvas-gestures";
import {
  markNoticeShown,
  missingFonts,
  missingFontsMessage,
  noticeShown,
  useFontReport,
  useFontReportState,
} from "./font-report";
import { useFonts } from "./inspector/FontPicker";
import { openMissingFonts, useUi } from "./ui-state";

/** The top bar's missing fonts button: there only while something is missing. */
export function MissingFontsButton({ editor }: { editor: Editor }) {
  const missing = missingFonts(useFontReport(editor));
  const open = useUi(editor, (ui) => ui.missingFonts);
  if (!missing) return null;
  const n = missing.families.length;
  return (
    <Tooltip label="Missing fonts" describe={false}>
      <button
        type="button"
        className="dp-iconbtn dp-iconbtn--md fonts-missing"
        aria-label={`Missing fonts: ${n}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => openMissingFonts(editor)}
      >
        <Icon name="text" />
        <span className="fonts-missing__count" aria-hidden="true">
          {n > 99 ? "99+" : n}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The notice a file opens with when its fonts are missing. `teamId` is
 * undefined until the file's details have loaded (its team's fonts count as
 * here), and `hidden` while another toast has the spot.
 */
export function MissingFontsNotice({
  editor,
  fileId,
  teamId,
  hidden,
}: {
  editor: Editor;
  fileId: string;
  teamId: string | null | undefined;
  hidden: boolean;
}) {
  const { report, pending, docVersion } = useFontReportState(editor);
  const live = useSyncExternalStore(editor.state.subscribe, () => editor.s.status === "live");
  // The team's fonts arriving moves the registry.
  useFonts();
  /** The document's version when the file had loaded: a report from before then doesn't count. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [decided, setDecided] = useState(false);
  const [open, setOpen] = useState(false);
  const panelOpen = useUi(editor, (ui) => ui.missingFonts);
  useEffect(() => {
    if (live && loadedAt === null) setLoadedAt(editor.doc.version);
  }, [editor, live, loadedAt]);
  // Opening the panel any way at all answers the notice.
  useEffect(() => {
    if (panelOpen) setOpen(false);
  }, [panelOpen]);

  const missing = missingFonts(report);
  const teamReady = teamId === null || (teamId !== undefined && fonts.teamLoaded(teamId));
  const ready =
    loadedAt !== null && report !== null && !pending && docVersion >= loadedAt && teamReady;
  useEffect(() => {
    if (decided || !ready) return;
    setDecided(true);
    // It's about the file as it opened: fonts set since (in a new file, say) needn't be announced.
    if (!missing || editor.s.canUndo || noticeShown(fileId)) return;
    markNoticeShown(fileId);
    setOpen(true);
  }, [editor, decided, ready, missing, fileId]);

  // Replaced or aliased since: nothing left to say.
  const shown = open && missing !== null && !hidden;
  // The slot stays, so screen readers hear the notice arrive (politely: it takes no focus).
  return (
    <div className="fonts-notice-slot" aria-live="polite">
      {shown ? (
        <section className="fonts-notice" aria-label="Missing fonts notice" {...PASS_GESTURES}>
          <Icon name="warning" size={16} />
          <span className="fonts-notice__text">{missingFontsMessage(missing)}</span>
          <Button size="sm" variant="ghost" onClick={() => openMissingFonts(editor)}>
            Replace fonts…
          </Button>
          <IconButton icon="close" label="Dismiss" onClick={() => setOpen(false)} />
        </section>
      ) : null}
    </div>
  );
}
