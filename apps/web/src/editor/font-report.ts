/**
 * The open file's font report (decision 0036), worked out once per editor
 * and shared by everything that shows it: the top bar's missing fonts
 * button, the notice a file opens with, the page inspector's Fonts section
 * and the missing fonts panel.
 *
 * The faces in use are kept as the document changes (`FontUsageIndex`): a
 * change reads only the layers it names, and the whole file is read only
 * when it's opened or replaced. The report is worked out a beat after the
 * edits that could change the answer, and only those: a change that
 * touches no text layer or text style (moving a frame, recoloring a shape)
 * costs a look at the ids it changed and nothing more. A 500k-layer kit
 * stays quick to edit, and to type in, with the button on screen.
 */
import { type Doc, type DocChange, type Editor, FontUsageIndex } from "@drawpane/editor";
import { useEffect, useSyncExternalStore } from "react";
import { fonts } from "../fonts/fonts";
import { type FamilyReport, type FontLookup, fontReport } from "../fonts/missing-fonts";

/** What the store needs of the font registry. */
export interface ReportFonts extends FontLookup {
  /** Null until the Google catalog is in: until then a family nobody knows may be a Google one. */
  readonly google: unknown;
  subscribe(listener: () => void): () => void;
}

export interface FontReportState {
  /** Null until the catalog is in and the file has been read once. */
  readonly report: FamilyReport[] | null;
  /** The document version the report was worked out at. */
  readonly docVersion: number;
  /** A change that may alter the report is waiting to be read. */
  readonly pending: boolean;
}

/** After the first report, how long edits settle before the file is read again. */
export const REPORT_DELAY = 250;

/**
 * Whether a change may change which fonts the file uses: it reset the
 * document, or touched a text layer or text style, or removed something
 * (which may have been one, or held some).
 */
export function touchesFonts(
  change: DocChange,
  get: (id: string) => { readonly type: string } | null | undefined,
): boolean {
  if (change.reset) return true;
  for (const id of change.ids) {
    const node = get(id);
    if (!node || node.type === "text" || node.type === "textStyle") return true;
  }
  return false;
}

export class FontReportStore {
  readonly #doc: Doc;
  readonly #usage: FontUsageIndex;
  readonly #fonts: ReportFonts;
  #state: FontReportState = { report: null, docVersion: -1, pending: true };
  readonly #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #detach: (() => void) | null = null;

  constructor(doc: Doc, registry: ReportFonts) {
    this.#doc = doc;
    this.#usage = new FontUsageIndex(doc);
    this.#fonts = registry;
  }

  get = (): FontReportState => this.#state;

  /** Listens while anything shows the report; the last to leave stops the reading. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#attach();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  #attach(): void {
    const offDoc = this.#doc.subscribe((change) => {
      if (!touchesFonts(change, (id) => this.#doc.get(id))) return;
      this.#schedule();
    });
    // What's here, and what's aliased to what, decides what's missing.
    const offFonts = this.#fonts.subscribe(() => this.#schedule());
    this.#detach = () => {
      offDoc();
      offFonts();
    };
    // Whatever happened while nobody listened is unknown: read the file again.
    this.#schedule();
  }

  #stop(): void {
    this.#detach?.();
    this.#detach = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#set({ pending: true });
  }

  #schedule(): void {
    if (!this.#state.pending) this.#set({ pending: true });
    if (this.#timer !== null) clearTimeout(this.#timer);
    // Until the catalog is in, nothing is known to be missing; its arrival reschedules.
    if (this.#fonts.google === null) {
      this.#timer = null;
      return;
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#set({
          report: fontReport(this.#usage.usage(), this.#fonts),
          docVersion: this.#doc.version,
          pending: false,
        });
      },
      this.#state.report === null ? 0 : REPORT_DELAY,
    );
  }

  #set(patch: Partial<FontReportState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

const stores = new WeakMap<Editor, FontReportStore>();

/** The editor's report store, made on first use. */
export function fontReportFor(editor: Editor): FontReportStore {
  let store = stores.get(editor);
  if (!store) {
    store = new FontReportStore(editor.doc, fonts);
    stores.set(editor, store);
  }
  return store;
}

/** The report and whether it's up to date, kept up with the document and the registry. */
export function useFontReportState(editor: Editor): FontReportState {
  const store = fontReportFor(editor);
  useEffect(() => {
    void fonts.loadGoogle();
  }, []);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The file's font report: null until the catalog is in and the file has been read. */
export function useFontReport(editor: Editor): FamilyReport[] | null {
  return useFontReportState(editor).report;
}

/** What's really missing: families that aren't here and styles a family lacks, not aliases. */
export interface MissingFonts {
  /** Each family missing, or missing styles, most used first. */
  readonly families: readonly FamilyReport[];
  /** Text layers drawn in a fallback font or a nearby style. */
  readonly layers: number;
}

/** What's missing in a report, or null when nothing is (aliased families are fine). */
export function missingFonts(report: readonly FamilyReport[] | null): MissingFonts | null {
  if (!report) return null;
  const families = report.filter((r) => r.status !== "aliased");
  if (families.length === 0) return null;
  const layers = new Set(
    families.flatMap((r) => r.styles.filter((s) => s.missing).flatMap((s) => s.layers)),
  ).size;
  return { families, layers };
}

const number = (n: number) => n.toLocaleString("en-US");

/** "SF Pro", or for a family that's here without some styles, "Inter Black" or "2 Inter styles". */
function fontName(r: FamilyReport): { name: string; plural: boolean } {
  if (r.status !== "styles") return { name: r.family, plural: false };
  const short = r.styles.filter((s) => s.missing);
  return short.length === 1
    ? { name: `${r.family} ${short[0]?.label}`, plural: false }
    : { name: `${short.length} ${r.family} styles`, plural: true };
}

/** "SF Pro and 2 other fonts are missing on 1,240 layers." */
export function missingFontsMessage({ families, layers }: MissingFonts): string {
  const [first] = families;
  if (!first) return "";
  const { name, plural } = fontName(first);
  const others = families.length - 1;
  const subject =
    others === 0
      ? `${name} ${plural ? "are" : "is"}`
      : `${name} and ${number(others)} other ${others === 1 ? "font" : "fonts"} are`;
  return `${subject} missing on ${number(layers)} ${layers === 1 ? "layer" : "layers"}.`;
}

/**
 * Whether this file's missing fonts notice was already shown this session
 * (the browser tab's), and noting that it has been. Storage can be off or
 * full: then it's remembered until the page reloads.
 */
const shownHere = new Set<string>();
const noticeKey = (fileId: string) => `drawpane:missing-fonts-notice:${fileId}`;

export function noticeShown(fileId: string): boolean {
  if (shownHere.has(fileId)) return true;
  try {
    return sessionStorage.getItem(noticeKey(fileId)) !== null;
  } catch {
    return false;
  }
}

export function markNoticeShown(fileId: string): void {
  shownHere.add(fileId);
  try {
    sessionStorage.setItem(noticeKey(fileId), "1");
  } catch {
    // Remembered in memory instead.
  }
}
