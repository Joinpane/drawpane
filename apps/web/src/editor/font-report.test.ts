import { Doc } from "@drawpane/editor";
import { fontAliasIndex, type Op, ROOT_ID, resolveFont } from "@drawpane/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontFamily } from "../fonts/fonts";
import type { FamilyReport, StyleReport } from "../fonts/missing-fonts";
import {
  FontReportStore,
  markNoticeShown,
  missingFonts,
  missingFontsMessage,
  noticeShown,
  REPORT_DELAY,
  type ReportFonts,
  touchesFonts,
} from "./font-report";

const family = (name: string): FontFamily => ({
  family: name,
  source: "team",
  category: null,
  weights: [400, 700],
  italics: [],
  variable: false,
});

/** A registry that knows `here`, with the catalog loaded or not. */
function registry(here: string[], { catalog = true } = {}) {
  const known = new Map(here.map((n) => [n, family(n)]));
  const listeners = new Set<() => void>();
  const r = {
    google: catalog ? [] : null,
    get: (n: string) => known.get(n) ?? null,
    resolution: (f: string, size: number) =>
      resolveFont(f, size, (n) => known.has(n), fontAliasIndex([])),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Adds a family, as a team upload or the catalog arriving would. */
    add(name: string) {
      known.set(name, family(name));
      for (const l of listeners) l();
    },
    loadCatalog() {
      r.google = [];
      for (const l of listeners) l();
    },
  };
  return r satisfies ReportFonts;
}

const create = (id: string, type: string, parent: string, key: string, props = {}): Op =>
  ({ op: "create", id, type, parent, key, props }) as Op;

function file() {
  const doc = new Doc();
  doc.apply([
    create("p", "page", ROOT_ID, "a0"),
    create("frame", "frame", "p", "a0", { name: "Card" }),
    create("title", "text", "frame", "a0", { characters: "Hi", fontFamily: "Gone Grotesk" }),
    create("body", "text", "frame", "a1", { characters: "Body", fontFamily: "Inter" }),
  ]);
  return doc;
}

describe("FontReportStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the catalog, then reads the file at once", () => {
    const doc = file();
    const fonts = registry(["Inter"], { catalog: false });
    const store = new FontReportStore(doc, fonts);
    const off = store.subscribe(() => {});
    vi.runAllTimers();
    expect(store.get()).toMatchObject({ report: null, pending: true });

    fonts.loadCatalog();
    vi.advanceTimersByTime(0);
    expect(store.get().pending).toBe(false);
    expect(store.get().docVersion).toBe(doc.version);
    expect(store.get().report?.map((r) => [r.family, r.status])).toEqual([
      ["Gone Grotesk", "missing"],
    ]);
    off();
  });

  it("doesn't read the file again for edits that touch no text", () => {
    const doc = file();
    const fonts = registry(["Inter"]);
    const store = new FontReportStore(doc, fonts);
    const off = store.subscribe(() => {});
    vi.runAllTimers();
    const first = store.get();

    doc.apply([{ op: "set", id: "frame", prop: "x", value: 40 }]);
    expect(store.get()).toBe(first);
    vi.runAllTimers();
    expect(store.get()).toBe(first);
    off();
  });

  it("reads it again a beat after a text edit, once for a burst", () => {
    const doc = file();
    const fonts = registry(["Inter"]);
    const store = new FontReportStore(doc, fonts);
    const reads = vi.fn();
    const off = store.subscribe(() => {
      if (!store.get().pending) reads();
    });
    vi.runAllTimers();
    reads.mockClear();

    doc.apply([{ op: "set", id: "title", prop: "fontFamily", value: "Inter" }]);
    expect(store.get().pending).toBe(true);
    vi.advanceTimersByTime(REPORT_DELAY / 2);
    doc.apply([{ op: "set", id: "title", prop: "characters", value: "Hello" }]);
    vi.advanceTimersByTime(REPORT_DELAY - 1);
    expect(reads).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(store.get().report).toEqual([]);
    off();
  });

  it("follows the registry: a font that arrives is no longer missing", () => {
    const doc = file();
    const fonts = registry(["Inter"]);
    const store = new FontReportStore(doc, fonts);
    const off = store.subscribe(() => {});
    vi.runAllTimers();
    expect(missingFonts(store.get().report)).not.toBeNull();

    fonts.add("Gone Grotesk");
    vi.runAllTimers();
    expect(missingFonts(store.get().report)).toBeNull();
    off();
  });

  it("stops listening when nothing shows it, and catches up when something does again", () => {
    const doc = file();
    const fonts = registry(["Inter"]);
    const store = new FontReportStore(doc, fonts);
    const off = store.subscribe(() => {});
    vi.runAllTimers();
    off();

    doc.apply([{ op: "set", id: "title", prop: "fontFamily", value: "Inter" }]);
    vi.runAllTimers();
    expect(store.get().pending).toBe(true);

    const again = store.subscribe(() => {});
    vi.runAllTimers();
    expect(store.get()).toMatchObject({ report: [], pending: false });
    again();
  });
});

describe("touchesFonts", () => {
  const types: Record<string, string> = { t: "text", s: "textStyle", f: "frame" };
  const get = (id: string) => (types[id] ? { type: types[id] as string } : null);
  const change = (ids: string[], reset = false) => ({
    ids: new Set(ids),
    parents: new Set<string>(),
    reset,
  });

  it("is true for text layers, text styles, removals and resets", () => {
    expect(touchesFonts(change(["f", "t"]), get)).toBe(true);
    expect(touchesFonts(change(["s"]), get)).toBe(true);
    expect(touchesFonts(change(["gone"]), get)).toBe(true);
    expect(touchesFonts(change([], true), get)).toBe(true);
  });

  it("is false for anything else", () => {
    expect(touchesFonts(change(["f"]), get)).toBe(false);
    expect(touchesFonts(change([]), get)).toBe(false);
  });
});

const style = (label: string, layers: string[], missing = true): StyleReport => ({
  family: "",
  weight: 400,
  italic: false,
  key: label,
  label,
  layers,
  styles: 0,
  missing,
});

const row = (
  name: string,
  status: FamilyReport["status"],
  styles: StyleReport[],
): FamilyReport => ({
  family: name,
  status,
  drawnIn: [],
  via: status === "aliased" ? "built-in" : null,
  layers: new Set(styles.flatMap((s) => s.layers)).size,
  styles,
});

describe("missingFonts", () => {
  it("is null before the report, with nothing missing, and for aliases alone", () => {
    expect(missingFonts(null)).toBeNull();
    expect(missingFonts([])).toBeNull();
    expect(missingFonts([row("SF Pro", "aliased", [style("Regular", ["a"], true)])])).toBeNull();
  });

  it("counts each layer once, across families and styles", () => {
    const missing = missingFonts([
      row("SF Pro", "missing", [style("Regular", ["a", "b"]), style("Bold", ["b", "c"])]),
      row("Inter", "styles", [style("Regular", ["d"], false), style("Black", ["c", "e"])]),
      row("New York", "aliased", [style("Regular", ["f"])]),
    ]);
    expect(missing?.families.map((r) => r.family)).toEqual(["SF Pro", "Inter"]);
    expect(missing?.layers).toBe(4);
  });
});

describe("missingFontsMessage", () => {
  const layers = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

  it("names one family", () => {
    const m = missingFonts([row("SF Pro", "missing", [style("Regular", ["a"])])]);
    expect(m && missingFontsMessage(m)).toBe("SF Pro is missing on 1 layer.");
  });

  it("names the most used and counts the others", () => {
    const m = missingFonts([
      row("SF Pro", "missing", [style("Regular", layers(1240))]),
      row("Acme", "missing", [style("Regular", ["l1"])]),
      row("Gone", "missing", [style("Regular", ["l2"])]),
    ]);
    expect(m && missingFontsMessage(m)).toBe(
      "SF Pro and 2 other fonts are missing on 1,240 layers.",
    );
    const two = missingFonts([
      row("SF Pro", "missing", [style("Regular", ["a"])]),
      row("Acme", "missing", [style("Regular", ["b"])]),
    ]);
    expect(two && missingFontsMessage(two)).toBe(
      "SF Pro and 1 other font are missing on 2 layers.",
    );
  });

  it("names a style a family here lacks", () => {
    const one = missingFonts([
      row("Inter", "styles", [style("Regular", ["a"], false), style("Black", ["b", "c"])]),
    ]);
    expect(one && missingFontsMessage(one)).toBe("Inter Black is missing on 2 layers.");
    const some = missingFonts([
      row("Inter", "styles", [style("Thin", ["a"]), style("Black", ["b"])]),
    ]);
    expect(some && missingFontsMessage(some)).toBe("2 Inter styles are missing on 2 layers.");
  });
});

describe("notice once per file per session", () => {
  it("remembers a file once shown, and only that file", () => {
    expect(noticeShown("file-a")).toBe(false);
    markNoticeShown("file-a");
    expect(noticeShown("file-a")).toBe(true);
    expect(noticeShown("file-b")).toBe(false);
  });
});
