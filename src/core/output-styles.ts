import {
  assertNamedFileName,
  normalizeNamedFiles,
  type NamedFileEntry,
} from "./named-files.js";

/** A Claude output style: a Markdown file whose frontmatter `name` is what
 * `settings.json`'s `outputStyle` selects. The setting already travels in the
 * portable settings passthrough, so without the file a projected store names a
 * style that does not exist on the target machine. No other vendor documents an
 * equivalent, so this kind is declared only by the Claude adapter. */
export type OutputStyleEntry = NamedFileEntry;

export function assertOutputStyleName(name: string): void {
  assertNamedFileName(name, "output style");
}

export function normalizeOutputStyles(value: unknown): OutputStyleEntry[] {
  return normalizeNamedFiles(value, "outputStyles", "output-styles", "output style");
}
