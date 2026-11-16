export type ImportErrorCode =
  /** Not a .fig file at all. */
  | "not-fig"
  /** A FigJam board or a Slides deck: only design files are read. */
  | "not-design"
  /** A .fig file that's damaged or cut short. */
  | "corrupt"
  /** Larger than a browser tab can read. */
  | "too-large"
  /** More layers than one Drawpane file holds: some of its pages can still come in. */
  | "too-many-layers";

/** Why a .fig import can't go ahead, in words for the person importing. */
export class ImportError extends Error {
  override readonly name = "ImportError";
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export const SAVE_LOCAL_COPY = "In Figma, use File → Save local copy to make one.";
