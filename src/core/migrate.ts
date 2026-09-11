import type {
  AdapterWarning,
  ApplyResult,
  CanonicalHarness,
  TargetName,
} from "../types.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { writeHarness } from "./config.js";
import {
  adapterContext,
  applyHarness,
  readCanonical,
  type LoadedProject,
} from "./project.js";
import {
  commitCaptureStage,
  createCaptureStage,
  establishBaseline,
} from "./reconcile.js";
import { hashCanonical } from "./state.js";
import { validateHarness } from "./validate.js";
import { clearPreservedLocalBase } from "./local-base.js";
import {
  hashPaths,
  pathExists,
  resolveInside,
  snapshotNativePaths,
} from "./fs.js";
import { captureBoundary } from "../adapters/adapter.js";

export interface MigrationOptions {
  apply: boolean;
  install: boolean;
  includeLocal: boolean;
  force: boolean;
  excludeSkills: readonly string[];
}

export interface MigrationResult {
  source: TargetName;
  mode: "plan" | "applied";
  imported: string[];
  summary: {
    rules: number;
    skills: number;
    commands: number;
    agents: number;
    mcpServers: number;
    hookEvents: number;
  };
  excluded?: { skills: string[] };
  warnings: AdapterWarning[];
  projections: ApplyResult[];
}

export async function migrateFrom(
  project: LoadedProject,
  source: TargetName,
  options: MigrationOptions,
): Promise<MigrationResult> {
  const current = await readCanonical(project);
  await validateHarness(project.storeDir, current);
  const expectedCanonicalHash = await hashCanonical(project, current);
  const adapter = getAdapter(source);
  const sourceContext = adapterContext(project, source);
  const migrationSourcePaths = [
    ...adapter.watchPaths(sourceContext),
    ...(source === "claude" && options.includeLocal
      ? [
          project.config.scope === "project"
            ? join(sourceContext.targetRoot, ".claude", "settings.local.json")
            : join(sourceContext.targetRoot, "settings.local.json"),
        ]
      : []),
  ];
  const nativeContentRoot = captureBoundary(sourceContext);
  const nativePreconditions = await snapshotNativePaths(
    migrationSourcePaths,
    nativeContentRoot,
  );
  const expectedSourceHash = nativePreconditions.fingerprint;
  const stageDir = await createCaptureStage(project.storeDir, current);
  try {
    const captured = await adapter.capture(
      current,
      {
        ...sourceContext,
        storeDir: stageDir,
        canonicalSourceStoreDir: project.storeDir,
      },
      {
        includeLocal: options.includeLocal,
        includeAssets: true,
        write: true,
        excludeSkills: options.excludeSkills,
      },
    );
    await writeHarness(stageDir, captured.harness);
    await validateHarness(stageDir, captured.harness);
    await assertMigrationSourceUnchanged(
      migrationSourcePaths,
      expectedSourceHash,
      source,
      "while it was being captured",
      nativeContentRoot,
    );
    const stagedLocalArtifacts = options.includeLocal
      ? await localCaptureArtifacts(source, stageDir)
      : [];
    let projections: ApplyResult[] = [];
    if (options.apply) {
      if (options.install) {
        // Validate every destination against the staged canonical tree before
        // committing any canonical artifact. In particular, this catches
        // native directory symlink ancestors that a writer cannot safely own.
        await applyHarness(
          { ...project, storeDir: stageDir },
          captured.harness,
          {
            dryRun: true,
            force: options.force,
            nativePreconditions,
          },
        );
      }
      await assertMigrationSourceUnchanged(
        migrationSourcePaths,
        expectedSourceHash,
        source,
        "before the staged capture was committed",
        nativeContentRoot,
      );
      await commitCaptureStage(
        project,
        current,
        captured.harness,
        stageDir,
        expectedCanonicalHash,
        stagedLocalArtifacts,
      );
      if (options.install) {
        await assertMigrationSourceUnchanged(
          migrationSourcePaths,
          expectedSourceHash,
          source,
          "after the canonical capture was committed; native installation was not started",
          nativeContentRoot,
        );
        const installedCanonicalHash = await hashCanonical(project, captured.harness);
        projections = await applyHarness(project, captured.harness, {
          dryRun: false,
          force: options.force,
          nativePreconditions,
        });
        if (projections.some((result) => result.skipped.length > 0)) {
          captured.warnings.push({
            code: "projection-skipped",
            message:
              "Some occupied native paths were left untouched. Re-run with --force after reviewing the content-addressed backup policy.",
            fidelity: "target-only",
          });
        } else {
          await establishBaseline(
            project,
            captured.harness,
            source,
            installedCanonicalHash,
          );
          await clearPreservedLocalBase(project.storeDir, source);
        }
      }
    }
    if (options.excludeSkills.length > 0) {
      captured.warnings.push({
        code: "import-excluded",
        message:
          `Excluded from import by --exclude-skill: ${[...options.excludeSkills].sort().join(", ")}. ` +
          "These native paths stay unmanaged and are not projected; an excluded name that is " +
          "already in the canonical harness is left there untouched.",
        fidelity: "target-only",
      });
    }
    return migrationReport(
      source,
      captured.harness,
      captured.imported,
      captured.warnings,
      projections,
      options.apply,
      options.excludeSkills,
    );
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function assertMigrationSourceUnchanged(
  paths: readonly string[],
  expectedHash: string,
  source: TargetName,
  phase: string,
  nativeRoot: string,
): Promise<void> {
  if ((await hashPaths([...paths], {
    symlinkContentRoot: nativeRoot,
  })) !== expectedHash) {
    throw new Error(
      `${source} native source changed ${phase}; rerun migration to capture a stable snapshot`,
    );
  }
}

async function localCaptureArtifacts(
  source: TargetName,
  stageDir: string,
): Promise<string[]> {
  const candidates = source === "claude"
    ? [".local/claude.settings.json"]
    : [];
  const present: string[] = [];
  for (const relativePath of candidates) {
    if (await pathExists(resolveInside(stageDir, relativePath))) {
      present.push(relativePath);
    }
  }
  return present;
}

function migrationReport(
  source: TargetName,
  harness: CanonicalHarness,
  imported: string[],
  warnings: AdapterWarning[],
  projections: ApplyResult[],
  applied: boolean,
  excludeSkills: readonly string[] = [],
): MigrationResult {
  const excluded = [...excludeSkills].sort();
  return {
    source,
    mode: applied ? "applied" : "plan",
    imported,
    ...(excluded.length > 0 ? { excluded: { skills: excluded } } : {}),
    summary: {
      rules: harness.rules.length,
      skills: harness.skills.length,
      commands: Object.keys(harness.commands).length,
      agents: Object.keys(harness.agents).length,
      mcpServers: Object.keys(harness.mcpServers).length,
      hookEvents: Object.keys(harness.hooks).length,
    },
    warnings,
    projections,
  };
}
