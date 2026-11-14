/**
 * Every font the editor can use, where it comes from, and loading it.
 *
 * - Bundled: the three families the app ships (Instrument Sans and Serif,
 *   JetBrains Mono), always there.
 * - System: web-safe families every desktop has.
 * - Google: the open-source Google Fonts catalog (google-fonts.json, loaded
 *   on first use), served from this server's /api/fonts, never from Google.
 * - Local: families installed on this computer, when the browser lets us
 *   list them (Chrome's Local Font Access). Only you see these.
 * - Team: fonts the file's team uploaded, served from this server to the
 *   team's members. A team font wins over any other family of its name.
 *
 * Anything else a file names is missing: it renders in the fallback until
 * someone installs or swaps it.
 */

import type { TeamFontFace } from "@drawpane/model";

export type FontSource = "bundled" | "system" | "google" | "local" | "team";

export interface FontFamily {
  readonly family: string;
  readonly source: FontSource;
  /** Sans Serif, Serif, Display, Handwriting or Monospace, when known. */
  readonly category: string | null;
  /** Upright weights available, ascending. */
  readonly weights: readonly number[];
  /** Italic weights available, ascending. */
  readonly italics: readonly number[];
  /** Has a weight axis: any weight between the ends renders. */
  readonly variable: boolean;
  /** A team font's uploaded faces (its files). */
  readonly faces?: readonly TeamFontFace[];
}

/** A team's faces as families: weights from static faces and every hundred a variable one spans. */
export function teamFamilies(faces: readonly TeamFontFace[]): FontFamily[] {
  const byFamily = new Map<string, TeamFontFace[]>();
  for (const face of faces) byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
  return [...byFamily]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => {
      const weightsOf = (italic: boolean) =>
        [
          ...new Set(
            list
              .filter((f) => f.italic === italic)
              .flatMap((f) => (f.weightMax ? span(f.weight, f.weightMax) : [f.weight])),
          ),
        ].sort((a, b) => a - b);
      return {
        family: name,
        source: "team" as const,
        category: null,
        weights: weightsOf(false),
        italics: weightsOf(true),
        variable: list.some((f) => f.weightMax !== null),
        faces: list,
      };
    });
}

const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const span = (from: number, to: number) => ALL_WEIGHTS.filter((w) => w >= from && w <= to);

const family = (
  name: string,
  source: FontSource,
  category: string,
  weights: readonly number[],
  italics: readonly number[] = [],
  variable = false,
): FontFamily => ({ family: name, source, category, weights, italics, variable });

const BUNDLED: readonly FontFamily[] = [
  family("Instrument Sans", "bundled", "Sans Serif", span(400, 700), [], true),
  family("Instrument Serif", "bundled", "Serif", [400]),
  family("JetBrains Mono", "bundled", "Monospace", span(100, 800), [], true),
];

const SYSTEM: readonly FontFamily[] = [
  family("system-ui", "system", "Sans Serif", ALL_WEIGHTS, ALL_WEIGHTS),
  family("Arial", "system", "Sans Serif", [400, 700], [400, 700]),
  family("Helvetica", "system", "Sans Serif", [400, 700], [400, 700]),
  family("Verdana", "system", "Sans Serif", [400, 700], [400, 700]),
  family("Tahoma", "system", "Sans Serif", [400, 700]),
  family("Trebuchet MS", "system", "Sans Serif", [400, 700], [400, 700]),
  family("Georgia", "system", "Serif", [400, 700], [400, 700]),
  family("Times New Roman", "system", "Serif", [400, 700], [400, 700]),
  family("Courier New", "system", "Monospace", [400, 700], [400, 700]),
];

const fromMask = (mask: number) => ALL_WEIGHTS.filter((_, i) => mask & (1 << i));

/** Weight names, as type designers use them. */
export const WEIGHT_NAMES: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

/** The available weight nearest to `wanted` (ties go heavier, like CSS for weights above 500). */
export function nearestWeight(available: readonly number[], wanted: number): number {
  let best = available[0] ?? wanted;
  for (const w of available) {
    const d = Math.abs(w - wanted);
    const bd = Math.abs(best - wanted);
    if (d < bd || (d === bd && w > best)) best = w;
  }
  return best;
}

/** "Google · 9 weights · variable", for a picker row. */
export function describeFamily(f: FontFamily): string {
  const where = {
    bundled: "Built in",
    system: "System",
    google: "Google",
    local: "On this computer · not shared",
    team: "Team",
  }[f.source];
  if (f.source === "local") return where;
  const count = new Set([...f.weights, ...f.italics]).size;
  const weights = count === 1 ? "1 weight" : `${count} weights`;
  return [where, weights, f.variable ? "variable" : null].filter(Boolean).join(" · ");
}

type Listener = () => void;

/** Local Font Access, where the browser has it (Chrome). */
interface LocalFontData {
  readonly family: string;
  readonly style: string;
}
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

/** The weight a local font's style name implies ("Semibold Italic" → 600). */
function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s-]/g, "");
  const named: Array<[RegExp, number]> = [
    [/thin|hairline/, 100],
    [/extralight|ultralight/, 200],
    [/light/, 300],
    [/medium/, 500],
    [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800],
    [/black|heavy/, 900],
    [/bold/, 700],
  ];
  return named.find(([re]) => re.test(s))?.[1] ?? 400;
}

/** Asks the server whether it serves Google Fonts; assumes it does if it can't tell. */
async function serverAllowsGoogle(): Promise<boolean> {
  if (typeof fetch === "undefined" || typeof location === "undefined") return true;
  try {
    const response = await fetch("/api/fonts/config");
    if (!response.ok) return true;
    return ((await response.json()) as { google?: boolean }).google !== false;
  } catch {
    return true;
  }
}

class FontRegistry {
  readonly #known = new Map<string, FontFamily>();
  #google: readonly FontFamily[] | null = null;
  #googleLoading: Promise<readonly FontFamily[]> | null = null;
  #googleEnabled: boolean | null = null;
  #local: readonly FontFamily[] | null = null;
  readonly #stylesheets = new Set<string>();
  readonly #previews = new Map<string, Promise<string>>();
  readonly #listeners = new Set<Listener>();
  #version = 0;
  #teamId: string | null = null;
  #team: readonly FontFamily[] | null = null;
  /** Team families, checked before anything else: a team font wins over others of its name. */
  readonly #teamKnown = new Map<string, FontFamily>();
  #teamSheet: {
    readonly signature: string;
    readonly link: HTMLLinkElement;
    readonly loaded: Promise<void>;
  } | null = null;

  constructor() {
    for (const f of [...BUNDLED, ...SYSTEM]) this.#known.set(f.family, f);
  }

  /** Changes when the catalog or local fonts arrive, for `useSyncExternalStore`. */
  get version(): number {
    return this.#version;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #changed(): void {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  /** Bundled and system families, in picker order. */
  get builtIn(): readonly FontFamily[] {
    return [...BUNDLED, ...SYSTEM];
  }

  /** The Google catalog once loaded, most popular first. */
  get google(): readonly FontFamily[] | null {
    return this.#google;
  }

  /** Local families once listed. */
  get local(): readonly FontFamily[] | null {
    return this.#local;
  }

  /** Whether this browser can list local fonts at all. */
  get canListLocal(): boolean {
    return typeof window !== "undefined" && typeof window.queryLocalFonts === "function";
  }

  /** What we know about a family now (null if unknown, or the catalog hasn't loaded). */
  get(name: string): FontFamily | null {
    return this.#teamKnown.get(name) ?? this.#known.get(name) ?? null;
  }

  /** The open file's team, once `loadTeam` has been called. */
  get teamId(): string | null {
    return this.#teamId;
  }

  /** The team's families once loaded, by name. */
  get team(): readonly FontFamily[] | null {
    return this.#team;
  }

  /**
   * Uses a team's fonts (the open file's team): lists them, and reloads
   * their stylesheet when the files changed. Call again to pick up uploads.
   */
  async loadTeam(teamId: string): Promise<readonly FontFamily[]> {
    this.#teamId = teamId;
    let faces: TeamFontFace[] = [];
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(teamId)}/fonts`, {
        credentials: "same-origin",
      });
      if (response.ok) faces = ((await response.json()) as { faces: TeamFontFace[] }).faces;
    } catch {
      // Offline or signed out: the team's fonts show as missing until the next load.
    }
    if (this.#teamId !== teamId) return [];
    const list = teamFamilies(faces);
    this.#teamKnown.clear();
    for (const f of list) this.#teamKnown.set(f.family, f);
    this.#team = list;
    const signature = faces
      .map((f) => f.sha)
      .sort()
      .join(",");
    if (this.#teamSheet && this.#teamSheet.signature !== signature) {
      this.#teamSheet.link.remove();
      this.#teamSheet = null;
    }
    this.#changed();
    return list;
  }

  /** The team's stylesheet, added once per set of files. */
  #teamStylesheet(): Promise<void> {
    const teamId = this.#teamId;
    if (!teamId) return Promise.resolve();
    if (!this.#teamSheet) {
      const signature = (this.#team ?? [])
        .flatMap((f) => f.faces ?? [])
        .map((f) => f.sha)
        .sort()
        .join(",");
      const link = document.createElement("link");
      link.rel = "stylesheet";
      // The version busts the browser's cache when the team's files change.
      link.href = `/api/teams/${encodeURIComponent(teamId)}/fonts.css?v=${hash(signature)}`;
      link.dataset.teamFonts = teamId;
      const loaded = new Promise<void>((resolve) => {
        link.onload = link.onerror = () => resolve();
      });
      document.head.append(link);
      this.#teamSheet = { signature, link, loaded };
    }
    return this.#teamSheet.loaded;
  }

  /** Whether this server serves Google Fonts (null until asked). */
  get googleEnabled(): boolean | null {
    return this.#googleEnabled;
  }

  /**
   * Loads the Google catalog (about 15 KB gzipped) once, unless the server
   * has Google Fonts turned off, in which case it's empty.
   */
  loadGoogle(): Promise<readonly FontFamily[]> {
    this.#googleLoading ??= serverAllowsGoogle().then(async (allowed) => {
      this.#googleEnabled = allowed;
      if (!allowed) {
        this.#google = [];
        this.#changed();
        return [];
      }
      const { default: data } = await import("./google-fonts.json");
      const list = (data.families as Array<[string, number, number, number, number]>).map(
        ([name, category, upright, italic, variable]) =>
          family(
            name,
            "google",
            data.categories[category] ?? "Sans Serif",
            fromMask(upright),
            fromMask(italic),
            variable === 1,
          ),
      );
      for (const f of list) if (!this.#known.has(f.family)) this.#known.set(f.family, f);
      this.#google = list;
      this.#changed();
      return list;
    });
    return this.#googleLoading;
  }

  /** Lists this computer's fonts (asks permission the first time). */
  async loadLocal(): Promise<readonly FontFamily[]> {
    if (this.#local) return this.#local;
    if (!this.canListLocal || !window.queryLocalFonts) return [];
    const faces = await window.queryLocalFonts();
    const byFamily = new Map<string, { upright: Set<number>; italic: Set<number> }>();
    for (const face of faces) {
      const entry = byFamily.get(face.family) ?? { upright: new Set(), italic: new Set() };
      (/italic|oblique/i.test(face.style) ? entry.italic : entry.upright).add(
        styleWeight(face.style),
      );
      byFamily.set(face.family, entry);
    }
    const list = [...byFamily]
      .filter(([name]) => !this.#known.has(name) || this.#known.get(name)?.source === "local")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { upright, italic }]) =>
        family(
          name,
          "local",
          "",
          [...upright].sort((a, b) => a - b),
          [...italic].sort((a, b) => a - b),
        ),
      );
    for (const f of list) this.#known.set(f.family, f);
    this.#local = list;
    this.#changed();
    return list;
  }

  /**
   * What a family is, loading the catalog when it might be a Google font.
   * Null means missing.
   */
  async resolve(name: string): Promise<FontFamily | null> {
    const known = this.get(name);
    if (known) return known;
    await this.loadGoogle();
    return this.get(name);
  }

  /**
   * Makes a family's faces available to the page and the canvas. Google
   * families get their stylesheet (every face, from this server; the browser
   * downloads only what text uses), team families the team's, then the
   * given faces load. False when nothing provides the family (yet).
   */
  async ensure(
    name: string,
    faces: ReadonlyArray<{ weight: number; italic: boolean }> = [],
  ): Promise<boolean> {
    const f = await this.resolve(name);
    if (!f) return false;
    if (f.source === "team") await this.#teamStylesheet();
    else if (f.source !== "google") return true;
    else if (!this.#stylesheets.has(name)) {
      this.#stylesheets.add(name);
      const variants = [...f.weights.map(String), ...f.italics.map((w) => `${w}i`)];
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `/api/fonts/google.css?family=${encodeURIComponent(name)}&variants=${variants.join(",")}`;
      link.dataset.font = name;
      const loaded = new Promise<void>((resolve) => {
        link.onload = link.onerror = () => resolve();
      });
      document.head.append(link);
      await loaded;
    }
    await Promise.all(
      faces.map((face) =>
        document.fonts
          .load(`${face.italic ? "italic " : ""}${face.weight} 16px "${name}"`)
          .catch(() => []),
      ),
    );
    return true;
  }

  /**
   * A CSS font-family that shows `name` in its own face, for a picker row.
   * Google families load a tiny subset with just the letters of their name,
   * under a separate family so it never stands in for the real font.
   */
  preview(f: FontFamily): Promise<string> {
    if (f.source === "team")
      return this.#teamStylesheet()
        .then(() => document.fonts.load(`16px "${f.family}"`, f.family))
        .then(
          () => `"${f.family}"`,
          () => `"${f.family}"`,
        );
    if (f.source !== "google") return Promise.resolve(`"${f.family}"`);
    let pending = this.#previews.get(f.family);
    if (!pending) {
      const alias = `${f.family} Preview`;
      pending = fetch(
        `/api/fonts/google.css?family=${encodeURIComponent(f.family)}&text=${encodeURIComponent(f.family)}`,
      )
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then(async (css) => {
          const style = document.createElement("style");
          style.dataset.fontPreview = f.family;
          style.textContent = css.replace(/font-family:\s*'[^']*'/g, `font-family: '${alias}'`);
          document.head.append(style);
          await document.fonts.load(`16px "${alias}"`, f.family).catch(() => []);
          return `"${alias}"`;
        })
        .catch(() => "inherit");
      this.#previews.set(f.family, pending);
    }
    return pending;
  }
}

/** A short, stable hash of a string (FNV-1a), for cache-busting URLs. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The app's one font registry. */
export const fonts = new FontRegistry();
