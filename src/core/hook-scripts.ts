/** Machine-generated directories that must never enter the canonical store.
 * Their contents are rebuilt from source, so importing them makes every rebuild
 * a canonical change, and committing them ships bytes nobody authored. */
export const GENERATED_DIRECTORY_NAMES = [
  "__pycache__",
  "node_modules",
  ".pytest_cache",
] as const;

/** A hook script name is a native path relative to the target's script
 * directory, so unlike every other artifact name it may contain `/`. Each
 * segment is `SAFE_NAME` (validate.ts) with `_` added to the first-character
 * class — measured against a real 91-file hooks tree, that single relaxation is
 * what admits `_cache_io.py`, and nothing else in the tree needs more. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_SEGMENTS = 4;

export function assertHookScriptName(name: string): void {
  const invalid = (): never => {
    throw new Error(`Invalid hook script name: ${JSON.stringify(name)}`);
  };
  if (name === "" || name.startsWith("/") || name.endsWith("/")) invalid();
  const segments = name.split("/");
  if (segments.length > MAX_SEGMENTS) invalid();
  for (const segment of segments) {
    if (
      !SEGMENT.test(segment) ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      WINDOWS_RESERVED.test(segment)
    ) {
      invalid();
    }
  }
}

export interface HookScriptEntry {
  name: string;
  path: string;
}

const ENTRY_KEYS = new Set(["name", "path"]);

/** Shape check for the raw YAML, modelled on `normalizeSecretAllowlist`. Every
 * failure throws: a malformed list must never resolve to "sync nothing"
 * quietly, because an empty list is what makes `writer.finish` prune the
 * projected scripts. Deliberately does NOT sort — sorting would rewrite the
 * canonical bytes of a hand-ordered store on first load; the importer sorts. */
export function normalizeHookScripts(value: unknown): HookScriptEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid harness.hookScripts: expected an array");
  }
  return value.map((raw, index) => {
    const at = `harness.hookScripts[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid ${at}: expected an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) {
        throw new Error(`Invalid ${at}: unknown field ${JSON.stringify(key)}`);
      }
    }
    const text = (field: "name" | "path"): string => {
      const candidate = entry[field];
      if (typeof candidate !== "string" || candidate.trim() === "") {
        throw new Error(`Invalid ${at}.${field}: expected a non-empty string`);
      }
      return candidate;
    };
    const name = text("name");
    assertHookScriptName(name);
    const path = text("path");
    if (path !== `hook-scripts/${name}`) {
      throw new Error(
        `Invalid ${at}.path: expected ${JSON.stringify(`hook-scripts/${name}`)}`,
      );
    }
    return { name, path };
  });
}
