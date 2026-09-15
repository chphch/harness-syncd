import {
  assertNamedFileName,
  normalizeNamedFiles,
  type NamedFileEntry,
} from "./named-files.js";

export type HookScriptEntry = NamedFileEntry;

export function assertHookScriptName(name: string): void {
  assertNamedFileName(name, "hook script");
}

export function normalizeHookScripts(value: unknown): HookScriptEntry[] {
  return normalizeNamedFiles(value, "hookScripts", "hook-scripts", "hook script");
}
