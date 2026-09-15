/**
 * The grammar for `carry` — the one artifact kind whose destination is NOT
 * derived from a target root and which has no adapter. A carried file is an
 * ordinary file the store keeps a copy of because keeping it beside the harness
 * is convenient: a launchd plist, a hand-written CLI, a plugin manifest.
 *
 * Everything here is a pure function with no filesystem access, because the
 * grammar is what decides whether a declaration is allowed to name a path at
 * all. The filesystem guards live in carry.ts and run after these pass.
 */

// validate.ts imports this module back, so the two form a cycle. It is safe by
// construction rather than by luck: nothing at this module's top level CALLS
// anything from validate.ts, so no partially-initialised const is ever read
// during module evaluation. Verified by importing from both ends.
import { assertArtifactName } from "./validate.js";

export const CARRY_STORE_PREFIX = "carry";

/** POSIX NAME_MAX. The only length limit in the grammar that corresponds to a
 * real filesystem rule rather than to somebody's sense of proportion. */
const MAX_SEGMENT_BYTES = 255;
const MAX_REASON_BYTES = 2048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface CarryEntry {
  name: string;
  kind: "file" | "directory";
  path: string;
  /** Always `~/`-rooted. See `assertCarryDestinationSpelling` for why nothing
   * else — including an absolute path — is spellable. */
  destination: string;
  /** Required on `kind: "directory"`, forbidden on `kind: "file"`. Matched
   * against the basenames of IMMEDIATE file children of the destination. */
  include?: string[];
  /** Applied AFTER include, for the file a pattern legitimately selects but
   * that can never be carried. Without it such a file is refused on every run
   * and `doctor` is red forever — which is how a red signal stops meaning
   * anything. Measured on a real tree: one of 51 matching launchd plists is a
   * symlink into a project repo that is already backed up there. */
  exclude?: string[];
  reason?: string;
}

const ENTRY_KEYS = new Set([
  "name", "kind", "path", "destination", "include", "exclude", "reason",
]);

export function assertCarryName(name: string): void {
  assertArtifactName(name, "carry");
}

/**
 * A destination is `~/` plus at least one path segment, and nothing else.
 *
 * `$` is banned ANYWHERE rather than interpreted, because this codebase already
 * holds two incompatible readings of it: `containsNativeEnvironmentTemplate`
 * (validate.ts) does not treat `${env:HOME}` as a template, while the secret
 * scanner's `(?:env:)?` lookaheads do. Picking one would make the other wrong;
 * refusing the character makes neither apply.
 */
export function assertCarryDestinationSpelling(destination: unknown, at: string): void {
  const invalid = (why: string): never => {
    throw new Error(`Invalid ${at}.destination (${why}): ${JSON.stringify(destination)}`);
  };
  if (typeof destination !== "string" || destination === "") invalid("empty");
  const text = destination as string;
  if (!text.startsWith("~/")) {
    invalid("must start with ~/ — a carried destination is always inside $HOME");
  }
  if (text.includes("\\")) invalid("backslash");
  if (text.includes("$")) invalid("environment reference");
  if (CONTROL_CHARACTER.test(text)) invalid("control character");
  if (text.startsWith("~//") || /^~\/[A-Za-z]:/u.test(text)) invalid("drive or UNC path");
  if (text.endsWith("/")) invalid("trailing slash");
  for (const segment of text.slice(2).split("/")) {
    if (segment === "") invalid("empty path segment");
    if (segment === "." || segment === "..") invalid("relative path segment");
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) {
      invalid(`path segment over ${MAX_SEGMENT_BYTES} bytes`);
    }
  }
}

/**
 * One basename pattern. `*` and `?` only, one segment, never `**`: a pattern
 * that can cross a directory boundary turns a named selection into a sweep, and
 * the sweep is what would carry 267 MB of vendor binaries out of `~/.local/bin`.
 */
export function assertCarryIncludePattern(
  pattern: unknown,
  at: string,
): asserts pattern is string {
  const invalid = (why: string): never => {
    throw new Error(`Invalid ${at} include pattern (${why}): ${JSON.stringify(pattern)}`);
  };
  if (typeof pattern !== "string" || pattern === "") invalid("empty");
  const text = pattern as string;
  if (text.includes("/")) invalid("crosses a directory boundary");
  if (text.includes("**")) invalid("recursive wildcard");
  if (text.startsWith(".")) invalid("leading dot — dotfiles are not carried");
  if (CONTROL_CHARACTER.test(text)) invalid("control character");
  if (Buffer.byteLength(text, "utf8") > MAX_SEGMENT_BYTES) invalid("over 255 bytes");
}

/** Compiled with every non-metacharacter escaped and both ends anchored. Never
 * `new RegExp(raw)`: an include pattern travels in Git, so a store accepted
 * from a remote would otherwise be able to supply a regular expression. */
export function carryIncludeMatches(pattern: string, basename: string): boolean {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u").test(basename);
}

/**
 * Two declarations must not be able to own one file. Without this the winner is
 * decided by iteration order — the order somebody happened to type the entries
 * in — and the loser's store copy silently stops being updated.
 */
export function assertCarryEntriesDistinct(entries: readonly CarryEntry[]): void {
  for (let outer = 0; outer < entries.length; outer += 1) {
    for (let inner = outer + 1; inner < entries.length; inner += 1) {
      const first = entries[outer]!;
      const second = entries[inner]!;
      const left = `${first.destination}/`;
      const right = `${second.destination}/`;
      if (left === right || left.startsWith(right) || right.startsWith(left)) {
        throw new Error(
          `Carry destinations overlap: ${JSON.stringify(first.destination)} (${first.name}) ` +
            `and ${JSON.stringify(second.destination)} (${second.name}). ` +
            "One file must have exactly one owner.",
        );
      }
    }
  }
}

/**
 * Shape check for the raw YAML, modelled on `normalizeNamedFiles`. Deliberately
 * does NOT sort: sorting would rewrite the canonical bytes of a hand-ordered
 * store on its first load.
 */
export function normalizeCarry(value: unknown): CarryEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid harness.carry: expected an array");
  }
  return value.map((raw, index) => {
    const at = `harness.carry[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid ${at}: expected an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) {
        throw new Error(`Invalid ${at}: unknown field ${JSON.stringify(key)}`);
      }
    }
    const text = (field: "name" | "path" | "destination"): string => {
      const candidate = entry[field];
      if (typeof candidate !== "string" || candidate.trim() === "") {
        throw new Error(`Invalid ${at}.${field}: expected a non-empty string`);
      }
      return candidate;
    };

    const name = text("name");
    assertCarryName(name);

    // NEVER inferred from the presence of `include`: a mistyped `includes:`
    // would otherwise turn a three-file selection into a directory sweep.
    const kind = entry.kind;
    if (kind !== "file" && kind !== "directory") {
      throw new Error(`Invalid ${at}.kind: expected "file" or "directory"`);
    }

    const path = text("path");
    if (path !== `${CARRY_STORE_PREFIX}/${name}`) {
      throw new Error(
        `Invalid ${at}.path: expected ${JSON.stringify(`${CARRY_STORE_PREFIX}/${name}`)}`,
      );
    }

    const destination = text("destination");
    assertCarryDestinationSpelling(destination, at);

    let include: string[] | undefined;
    if (kind === "directory") {
      if (!Array.isArray(entry.include) || entry.include.length === 0) {
        throw new Error(
          `Invalid ${at}.include: a directory entry must list at least one pattern. ` +
            "Without one the default would be everything in the directory.",
        );
      }
      for (const pattern of entry.include) assertCarryIncludePattern(pattern, at);
      include = [...(entry.include as string[])];
    } else if (entry.include !== undefined) {
      throw new Error(`Invalid ${at}.include: a file entry names one file already`);
    }

    let exclude: string[] | undefined;
    if (entry.exclude !== undefined) {
      if (kind === "file") {
        throw new Error(`Invalid ${at}.exclude: a file entry names one file already`);
      }
      if (!Array.isArray(entry.exclude)) {
        throw new Error(`Invalid ${at}.exclude: expected an array`);
      }
      for (const pattern of entry.exclude) assertCarryIncludePattern(pattern, at);
      exclude = [...(entry.exclude as string[])];
    }

    let reason: string | undefined;
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== "string") {
        throw new Error(`Invalid ${at}.reason: expected a string`);
      }
      if (Buffer.byteLength(entry.reason, "utf8") > MAX_REASON_BYTES) {
        throw new Error(`Invalid ${at}.reason: over ${MAX_REASON_BYTES} bytes`);
      }
      reason = entry.reason;
    }

    return {
      name,
      kind,
      path,
      destination,
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}
