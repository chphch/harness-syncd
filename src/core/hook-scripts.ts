import {
  assertNamedFileName,
  normalizeNamedFiles,
  type NamedFileEntry,
} from "./named-files.js";

/** Machine-generated directories that must never enter the canonical store.
 * Their contents are rebuilt from source, so importing them makes every rebuild
 * a canonical change, and committing them ships bytes nobody authored. */
export const GENERATED_DIRECTORY_NAMES = [
  "__pycache__",
  "node_modules",
  ".pytest_cache",
] as const;

export type HookScriptEntry = NamedFileEntry;

export function assertHookScriptName(name: string): void {
  assertNamedFileName(name, "hook script");
}

export function normalizeHookScripts(value: unknown): HookScriptEntry[] {
  return normalizeNamedFiles(value, "hookScripts", "hook-scripts", "hook script");
}
