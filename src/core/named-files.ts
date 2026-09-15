/**
 * Shared shape for artifact kinds that are just "a named file under one store
 * directory" — hook scripts, output styles. Each entry pins `path` to
 * `<prefix>/<name>` so the store layout cannot drift from the declaration, and
 * every malformed field throws rather than resolving to a shorter list: an
 * entry silently dropped here becomes a native file the next apply prunes.
 */

/** A name is a native path relative to the kind's directory, so unlike every
 * other artifact name it may contain `/`. Each segment is `SAFE_NAME`
 * (validate.ts) with `_` added to the first-character class — measured against a
 * real 91-file hooks tree, that single relaxation is what admits `_cache_io.py`,
 * and nothing else in the tree needs more. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_SEGMENTS = 4;

export interface NamedFileEntry {
  name: string;
  path: string;
}

export function assertNamedFileName(name: string, kind: string): void {
  const invalid = (): never => {
    throw new Error(`Invalid ${kind} name: ${JSON.stringify(name)}`);
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

const ENTRY_KEYS = new Set(["name", "path"]);

/** Shape check for the raw YAML, modelled on `normalizeSecretAllowlist`.
 * Deliberately does NOT sort — sorting would rewrite the canonical bytes of a
 * hand-ordered store on first load; the importer sorts instead. */
export function normalizeNamedFiles(
  value: unknown,
  field: string,
  prefix: string,
  kind: string,
): NamedFileEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid harness.${field}: expected an array`);
  }
  return value.map((raw, index) => {
    const at = `harness.${field}[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid ${at}: expected an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) {
        throw new Error(`Invalid ${at}: unknown field ${JSON.stringify(key)}`);
      }
    }
    const text = (name: "name" | "path"): string => {
      const candidate = entry[name];
      if (typeof candidate !== "string" || candidate.trim() === "") {
        throw new Error(`Invalid ${at}.${name}: expected a non-empty string`);
      }
      return candidate;
    };
    const name = text("name");
    assertNamedFileName(name, kind);
    const path = text("path");
    if (path !== `${prefix}/${name}`) {
      throw new Error(`Invalid ${at}.path: expected ${JSON.stringify(`${prefix}/${name}`)}`);
    }
    return { name, path };
  });
}

/** Claude keeps two more authored directories that no other vendor documents:
 * `scripts/` (helper programs its hooks and commands invoke — the reason a hook
 * can break on a second machine) and `workflows/`. Both are code, so they are
 * imported and projected like hook scripts rather than like documents. */
export function normalizeScripts(value: unknown): NamedFileEntry[] {
  return normalizeNamedFiles(value, "scripts", "scripts", "script");
}

export function normalizeWorkflows(value: unknown): NamedFileEntry[] {
  return normalizeNamedFiles(value, "workflows", "workflows", "workflow");
}
