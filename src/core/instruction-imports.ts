import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Claude Code expands an `@path` line in CLAUDE.md into that file's content
 * before the model sees it. Codex and Antigravity do not: they pass the line
 * through as text, so a file imported that way never reaches them (measured
 * 2026-10-07 with codex-cli 0.160.1 and agy). Projection therefore renders the
 * imports into the instruction file it writes for those targets, and capture
 * folds the rendered blocks back into the `@path` line.
 *
 * Only a line that consists of nothing but `@path` is an import here. Claude
 * also expands `@path` inside running text, but a prose line that mentions
 * `@user` or an email address must not be rewritten, so inline references are
 * left as text. A line whose path does not name an existing regular file is
 * left as it is, which is also what Claude does.
 */

/** Claude Code follows imports up to this many hops. */
export const MAX_IMPORT_DEPTH = 5;

const IMPORT_LINE = /^[\t ]*@(\S+)[\t ]*$/u;
const FENCE = /^[\t ]*(`{3,}|~{3,})/u;
const START_MARKER = /^<!-- harness-sync:import (\S+) -->$/u;
const END_MARKER = /^<!-- harness-sync:end-import (\S+) -->$/u;

function startMarker(spec: string): string {
  return `<!-- harness-sync:import ${spec} -->`;
}

function endMarker(spec: string): string {
  return `<!-- harness-sync:end-import ${spec} -->`;
}

/** Resolve an import spec the way Claude Code does: `~/` is the home
 * directory, an absolute path stays as it is, anything else is relative to the
 * directory of the file that contains the line. */
export function resolveImportSpec(spec: string, baseDir: string): string {
  if (spec === "~" || spec.startsWith("~/")) {
    return join(homedir(), spec.slice(1));
  }
  return isAbsolute(spec) ? spec : resolve(baseDir, spec);
}

/** `null` content means nothing to expand. `dependency` is false for an
 * existing non-file (a directory such as `@~`), which must not be hashed. */
async function readImportedFile(
  path: string,
): Promise<{ content: string | null; dependency: boolean }> {
  try {
    if (!(await stat(path)).isFile()) return { content: null, dependency: false };
    return { content: await readFile(path, "utf8"), dependency: true };
  } catch {
    return { content: null, dependency: true };
  }
}

/** Visit every import line outside fenced code blocks. */
function importLines(text: string): Array<{ index: number; spec: string }> {
  let fence: "`" | "~" | null = null;
  const found: Array<{ index: number; spec: string }> = [];
  text.split("\n").forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~";
      fence = fence === null ? marker : fence === marker ? null : fence;
      return;
    }
    if (fence !== null) return;
    const match = IMPORT_LINE.exec(line);
    if (match) found.push({ index, spec: match[1]! });
  });
  return found;
}

export function hasImportLines(text: string): boolean {
  return importLines(text).length > 0;
}

export interface RenderedImports {
  text: string;
  /** Every file an import line pointed at, present or not. A file that does
   * not exist yet still belongs here: creating it must change the render. */
  dependencies: string[];
}

/**
 * Replace each import line with the imported file's content wrapped in
 * markers that `collapseInstructionImports` reverses. `baseDir` is the
 * directory Claude Code reads the instruction file from, not the store: the
 * canonical file is written in Claude's syntax, so it resolves the way Claude
 * resolves it.
 */
export async function renderInstructionImports(
  text: string,
  baseDir: string,
): Promise<RenderedImports> {
  const dependencies = new Set<string>();
  const render = async (
    input: string,
    dir: string,
    depth: number,
    chain: readonly string[],
  ): Promise<string> => {
    const imports = importLines(input);
    if (imports.length === 0) return input;
    const lines = input.split("\n");
    for (const { index, spec } of imports.reverse()) {
      const path = resolveImportSpec(spec, dir);
      const { content, dependency } = await readImportedFile(path);
      if (dependency) dependencies.add(path);
      if (depth >= MAX_IMPORT_DEPTH || chain.includes(path)) continue;
      if (content === null) continue;
      const body = (await render(content, dirname(path), depth + 1, [...chain, path]))
        .replace(/\n+$/u, "");
      lines.splice(index, 1, startMarker(spec), body, endMarker(spec));
    }
    return lines.join("\n");
  };
  const rendered = await render(text, baseDir, 0, []);
  return { text: rendered, dependencies: [...dependencies].sort() };
}

/** Fold every rendered import block back into its `@path` line. A nested
 * block disappears with the block that contains it. */
export function collapseInstructionImports(text: string): string {
  const output: string[] = [];
  let open: string | null = null;
  let depth = 0;
  for (const line of text.split("\n")) {
    const start = START_MARKER.exec(line);
    const end = END_MARKER.exec(line);
    if (open === null) {
      if (start) {
        open = start[1]!;
        depth = 1;
        output.push(`@${open}`);
      } else {
        output.push(line);
      }
      continue;
    }
    if (start) depth += 1;
    if (end) {
      depth -= 1;
      if (depth === 0) open = null;
    }
  }
  // An unterminated block is not something projection wrote; keep the text
  // rather than silently dropping everything after the start marker.
  return open === null ? output.join("\n") : text;
}
