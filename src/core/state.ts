import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanonicalHarness,
  ProjectionState,
  TargetName,
} from "../types.js";
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
    resolveInside(project.storeDir, harness.instructions.root),
    ...harness.rules.map((rule) => resolveInside(project.storeDir, rule.path)),
    ...harness.skills.map((skill) => resolveInside(project.storeDir, skill.path)),
    ...Object.values(harness.commands).map((command) =>
      resolveInside(project.storeDir, command.promptFile),
    ),
    ...Object.values(harness.agents).map((agent) =>
      resolveInside(project.storeDir, agent.instructionsFile),
    ),
  ];
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
