export type ImportErrorCode =
  /** Not a zip, or a broken one. */
  | "corrupt"
  /** A zip, but not a Penpot export (or an old binary one). */
  | "not-penpot"
  /** A Penpot export in a version this importer doesn't read. */
  | "unsupported"
  | "too-large";

/** Why an import can't go ahead, in words for the person importing. */
export class ImportError extends Error {
  override readonly name = "ImportError";
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}
