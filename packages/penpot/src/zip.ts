/** Penpot exports are zips: the shared reader, with Penpot's words for what goes wrong. */
import { readZip as readAnyZip, type ZipEntry } from "@drawpane/import-kit";
import { ImportError } from "./errors";

export type { ZipEntry };

export function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  return readAnyZip(bytes, {
    corrupt: () => new ImportError("corrupt", "This file isn't a readable .penpot export."),
    unsupported: (name) =>
      new ImportError("corrupt", `"${name}" uses a compression this importer can't read.`),
    tooLarge: (name) => new ImportError("too-large", `"${name}" is too large.`),
  });
}
