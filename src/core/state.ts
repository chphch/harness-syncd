import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanonicalHarness,
  ProjectionState,
  TargetName,
} from "../types.js";
import { canonicalArtifactPaths } from "./artifacts.js";
import { isRecord } from "./frontmatter.js";
import {
  assertSafeStorePath,
  hashPaths,
  resolveInside,
  writeJsonAtomicInside,
} from "./fs.js";
import type { LoadedProject } from "./project.js";

const STATE_FILE = ".state.json";

export async function hashCanonical(
  project: LoadedProject,
  harness: CanonicalHarness,
): Promise<string> {
  const paths = [
    project.configPath,
    join(project.storeDir, "harness.yaml"),
    ...canonicalArtifactPaths(harness).map((relativePath) =>
      resolveInside(project.storeDir, relativePath),
    ),
  ];
  // Dedupe AFTER resolving: two relative spellings can name one file, and
  // hashPaths would otherwise hash it twice.
  return hashPaths([...new Set(paths)]);
}

export async function readState(storeDir: string): Promise<ProjectionState | null> {
  const path = join(storeDir, STATE_FILE);
  await assertSafeStorePath(storeDir, path);
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path, "utf8"),
    );
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
    return parsed as unknown as ProjectionState;
  } catch {
    return null;
  }
}

export async function writeState(
  storeDir: string,
  value: ProjectionState,
): Promise<void> {
  await writeJsonAtomicInside(storeDir, join(storeDir, STATE_FILE), value);
}

export function nextState(
  previous: ProjectionState | null,
  canonicalHash: string,
  targetHashes: Partial<Record<TargetName, string>>,
  lastWriter?: "canonical" | TargetName,
): ProjectionState {
  return {
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    canonicalHash,
    targetHashes,
    updatedAt: new Date().toISOString(),
    ...(lastWriter ? { lastWriter } : {}),
  };
}
