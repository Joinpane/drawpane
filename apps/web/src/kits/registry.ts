/**
 * The kit store's registry, as the page reads it (docs/decisions/0022-kit-store.md):
 * an index of kits from two sources, Penpot's hub (passed through as Penpot
 * publishes it) and kits hosted in the registry itself (under its licence
 * rules). The index comes from another server, so every field is checked
 * here; an entry that doesn't make sense is left out, never shown half-read.
 *
 * Also here: what a kit's licence says, in the words the store shows, the
 * credit that goes into the file a kit becomes, and the check that a
 * downloaded file is the one the index lists.
 */

export type KitKind = "ui-kit" | "library" | "template" | "icons" | "wireframe" | "other";
export const KIT_KINDS: readonly KitKind[] = [
  "ui-kit",
  "library",
  "template",
  "icons",
  "wireframe",
  "other",
];
export const KIND_LABEL: Record<KitKind, string> = {
  "ui-kit": "UI kits",
  library: "Libraries",
  template: "Templates",
  icons: "Icons",
  wireframe: "Wireframes",
  other: "More",
};
/** One kit of a kind, for its card ("UI kit", "Icon set"). */
export const KIND_SINGULAR: Record<KitKind, string> = {
  "ui-kit": "UI kit",
  library: "Library",
  template: "Template",
  icons: "Icon set",
  wireframe: "Wireframe kit",
  other: "Kit",
};

export type KitProvider = "penpot" | "drawpane";

export interface KitLicence {
  /** An SPDX id: kits hosted in the registry always have one. */
  readonly spdx: string | null;
  readonly url: string | null;
  /** The licence file's text, as its author wrote it (Penpot's `<name>.LICENSE`). */
  readonly text: string | null;
}

export interface KitFile {
  readonly url: string;
  readonly format: "penpot";
  readonly bytes: number | null;
  readonly sha256: string | null;
  /** The git blob SHA-1 of the file, for files in a git repository (Penpot's). */
  readonly gitSha1: string | null;
  /** What kind of file it is, when the registry knows (`zip`, `binfile-v1`, `lfs-pointer`). */
  readonly container: string | null;
  /** Whether Drawpane can import it: not Penpot's older format, nor a Git LFS pointer. */
  readonly importable: boolean;
}

export interface Kit {
  readonly id: string;
  readonly name: string;
  readonly provider: KitProvider;
  readonly kind: KitKind;
  readonly categories: readonly string[];
  readonly description: string | null;
  readonly author: { readonly name: string; readonly url: string | null } | null;
  readonly source: {
    readonly name: string;
    readonly page: string | null;
    readonly repository: string | null;
  };
  readonly licence: KitLicence | null;
  readonly attribution: string | null;
  readonly modified: boolean;
  /** Null when the source lists the kit without a file to download. */
  readonly file: KitFile | null;
  readonly hasCover: boolean;
  readonly published: string | null;
  readonly updated: string | null;
}

export interface KitIndex {
  readonly kits: readonly Kit[];
  /** Entries left out because they didn't make sense. */
  readonly skipped: number;
}

/** The licences a kit hosted in the registry may carry (the registry's CI enforces the same list). */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "OFL-1.1",
  "MPL-2.0",
  "CC0-1.0",
]);
export const LICENCE_NAME: Record<string, string> = {
  MIT: "MIT License",
  "Apache-2.0": "Apache License 2.0",
  "CC-BY-4.0": "Creative Commons Attribution 4.0",
  "CC-BY-SA-4.0": "Creative Commons Attribution-ShareAlike 4.0",
  "OFL-1.1": "SIL Open Font License 1.1",
  "MPL-2.0": "Mozilla Public License 2.0",
  "CC0-1.0": "CC0 1.0 (public domain)",
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX = (n: number) => new RegExp(`^[a-f0-9]{${n}}$`);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;
/** An https link, or null: links in an index are shown and opened, so nothing else passes. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function readLicence(v: unknown, provider: KitProvider): KitLicence | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) return undefined;
  const spdx = text(v.spdx, 64);
  const licence = { spdx, url: httpsUrl(v.url), text: text(v.text, 64_000) };
  if (provider === "drawpane") {
    // Hosted in the registry: an allowed licence with its link, always.
    if (!spdx || !ALLOWED_LICENCES.has(spdx) || !licence.url) return undefined;
  }
  return licence.spdx || licence.url || licence.text ? licence : null;
}

function readFile(v: unknown, provider: KitProvider, base: string): KitFile | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || typeof v.url !== "string" || v.url.length > 2000) return undefined;
  // Relative to the index; shown to people, so it must end up a web address.
  let url: string;
  try {
    url = new URL(v.url, base).href;
  } catch {
    return undefined;
  }
  if (!/^https?:/.test(url)) return undefined;
  if (v.format !== "penpot") return undefined;
  const bytes =
    typeof v.bytes === "number" && Number.isInteger(v.bytes) && v.bytes > 0 ? v.bytes : null;
  const sha256 = typeof v.sha256 === "string" && HEX(64).test(v.sha256) ? v.sha256 : null;
  const gitSha1 = typeof v.gitSha1 === "string" && HEX(40).test(v.gitSha1) ? v.gitSha1 : null;
  // A kit hosted in the registry is checked by sha256, and is 25 MB at most.
  if (provider === "drawpane" && (!sha256 || !bytes || bytes > 25 * 1024 * 1024)) return undefined;
  const container = typeof v.container === "string" ? v.container : null;
  return {
    url,
    format: "penpot",
    bytes,
    sha256,
    gitSha1,
    importable:
      container !== "binfile-v1" && container !== "binfile-v2" && container !== "lfs-pointer",
    container,
  };
}

/** Where an index is served from when it's read without one (tests): relative URLs stay relative to it. */
const NO_BASE = "https://registry.invalid/";

/** One index entry, or null when it doesn't make sense. `base` is the index's own URL. */
export function readKit(v: unknown, base: string = NO_BASE): Kit | null {
  if (!isObject(v)) return null;
  const id = typeof v.id === "string" && ID.test(v.id) ? v.id : null;
  const name = text(v.name, 200);
  const provider = v.provider === "penpot" || v.provider === "drawpane" ? v.provider : null;
  if (!id || !name || !provider) return null;
  const kind = KIT_KINDS.includes(v.kind as KitKind) ? (v.kind as KitKind) : "other";
  const licence = readLicence(v.licence, provider);
  const file = readFile(v.file, provider, base);
  if (licence === undefined || file === undefined) return null;
  const attribution = text(v.attribution, 2000);
  if (provider === "drawpane" && !attribution) return null;
  const source = isObject(v.source) ? v.source : {};
  const author = isObject(v.author) ? text(v.author.name, 200) : null;
  return {
    id,
    name,
    provider,
    kind,
    categories: Array.isArray(v.categories)
      ? v.categories
          .map((c) => text(c, 60))
          .filter((c): c is string => c !== null)
          .slice(0, 12)
      : [],
    description: text(v.description, 4000),
    author: author
      ? { name: author, url: isObject(v.author) ? httpsUrl(v.author.url) : null }
      : null,
    source: {
      name:
        text(source.name, 200) ??
        (provider === "penpot" ? "Penpot's libraries and templates hub" : "Drawpane kits"),
      page: httpsUrl(source.page),
      repository: httpsUrl(source.repository),
    },
    licence,
    attribution,
    modified: v.modified === true,
    file,
    hasCover: typeof v.cover === "string" && v.cover.length > 0,
    published: typeof v.published === "string" && DATE.test(v.published) ? v.published : null,
    updated: typeof v.updated === "string" && DATE.test(v.updated) ? v.updated : null,
  };
}

/** Reads an index; throws only when it isn't one at all. */
export function parseIndex(json: unknown, base: string = NO_BASE): KitIndex {
  if (!isObject(json) || !Array.isArray(json.kits))
    throw new Error("The kit store's list isn't in a format Drawpane reads.");
  if (typeof json.format === "number" && json.format > 1)
    throw new Error(
      "The kit store's list is newer than this Drawpane. Update Drawpane to read it.",
    );
  const kits: Kit[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of json.kits) {
    const kit = readKit(entry, base);
    if (!kit || seen.has(kit.id)) {
      skipped++;
      continue;
    }
    seen.add(kit.id);
    kits.push(kit);
  }
  return { kits, skipped };
}

/** The store's licence line for a kit, and where to read more. */
export type LicenceView =
  | { readonly kind: "spdx"; readonly label: string; readonly url: string | null }
  | {
      readonly kind: "file";
      readonly label: string;
      readonly text: string;
      readonly url: string | null;
    }
  | { readonly kind: "unstated"; readonly label: string; readonly url: string | null };

export const LICENCE_UNSTATED = "Licence not stated by the author: see Penpot's hub";

export function licenceOf(kit: Kit): LicenceView {
  const licence = kit.licence;
  if (licence?.spdx)
    return {
      kind: "spdx",
      label: LICENCE_NAME[licence.spdx] ?? licence.spdx,
      url: licence.url,
    };
  if (licence?.text)
    return {
      kind: "file",
      label: "Licence file from the author",
      text: licence.text,
      url: licence.url,
    };
  if (licence?.url)
    return { kind: "file", label: "Licence file from the author", text: "", url: licence.url };
  return {
    kind: "unstated",
    label: kit.provider === "penpot" ? LICENCE_UNSTATED : "Licence not stated by the author",
    url: kit.source.page ?? kit.source.repository,
  };
}

/**
 * The credit written into the file a kit becomes, so it travels with the
 * file: what it is, who made it, where it's from, and its licence as given.
 */
export function creditLines(kit: Kit, today: Date = new Date()): string[] {
  const by = kit.author ? ` by ${kit.author.name}` : "";
  const lines = [kit.attribution ?? `"${kit.name}"${by}.`];
  if (kit.provider === "penpot")
    lines.push(`From ${kit.source.name}${kit.source.page ? `: ${kit.source.page}` : "."}`);
  else if (kit.source.page) lines.push(`Original: ${kit.source.page}`);
  const licence = licenceOf(kit);
  if (licence.kind === "spdx")
    lines.push(`Licence: ${licence.label}${licence.url ? ` (${licence.url})` : ""}`);
  else if (licence.kind === "file")
    lines.push(
      `Licence: as stated by the author${licence.url ? ` in ${licence.url}` : ""}${
        licence.text ? `\n${firstParagraph(licence.text)}` : ""
      }`,
    );
  else lines.push(`${licence.label}${licence.url ? `: ${licence.url}` : "."}`);
  if (kit.file) {
    const day = today.toISOString().slice(0, 10);
    lines.push(
      `Converted to Drawpane from ${kit.file.url} on ${day}. Some parts may differ from the original.`,
    );
  }
  return lines;
}

/** The start of a licence text, for the credit (the whole text is linked). */
function firstParagraph(text: string): string {
  const para = text.split(/\n\s*\n/).find((p) => p.trim() !== "") ?? "";
  const flat = para.replace(/\s+/g, " ").trim();
  return flat.length > 280 ? `${flat.slice(0, 277)}...` : flat;
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A git blob's SHA-1: of `blob <size>\0` and the bytes, as git hashes files. */
export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header);
  all.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** A Git LFS pointer instead of the file: what a host serves for a file it keeps in LFS. */
export function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 1024) return false;
  return new TextDecoder().decode(bytes).startsWith("version https://git-lfs.github.com/spec/");
}

/**
 * Checks a downloaded file is the one the index lists: its size, and its
 * hash (sha256, or the git blob SHA-1 for files in a repository). Throws a
 * sentence a person can act on.
 */
export async function verifyKitFile(bytes: Uint8Array, file: KitFile): Promise<void> {
  if (isLfsPointer(bytes))
    throw new Error(
      "This file is stored with Git LFS, which its host doesn't serve. Open its page to get it.",
    );
  const mismatch = new Error(
    "The downloaded file isn't the one the store lists (it may have just been updated). Try again later.",
  );
  if (file.bytes !== null && bytes.byteLength !== file.bytes) throw mismatch;
  if (file.sha256) {
    if ((await sha256Hex(bytes)) !== file.sha256) throw mismatch;
  } else if (file.gitSha1) {
    if ((await gitBlobSha1(bytes)) !== file.gitSha1) throw mismatch;
  }
}

/** Kits matching a search, in every word, over name, author, categories and description. */
export function searchKits(kits: readonly Kit[], query: string): Kit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...kits];
  return kits.filter((kit) => {
    const hay = [kit.name, kit.author?.name ?? "", ...kit.categories, kit.description ?? ""]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A size for people: "1.9 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
