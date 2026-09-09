import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import type {
  AdapterWarning,
  ApplyResult,
  CanonicalHarness,
  CaptureResult,
  ProjectionState,
  SyncConflict,
  TargetName,
} from "../types.js";
import { getAdapter } from "../adapters/index.js";
import { loadHarness, writeHarness } from "./config.js";
import {
  acquireLock,
  assertSafeStorePath,
  copyFileAtomicInside,
  copyTreeForImportInside,
  hashPath,
  isNodeError,
  pathExists,
  resolveInside,
  writeJsonAtomicInside,
} from "./fs.js";
import {
  adapterContext,
  applyHarness,
  enabledTargets,
  type LoadedProject,
} from "./project.js";
import { hashCanonical, nextState, readState, writeState } from "./state.js";
import { validateHarness } from "./validate.js";
import { parseFrontmatter } from "./frontmatter.js";
import { clearPreservedLocalBase } from "./local-base.js";
import {
  assertManagedTargetMatchesRegistry,
  assertManagedTargetStructure,
  changedManagedPathsForTarget,
  managedPathsForTarget,
  refreshManagedTargetHashes,
} from "./writer.js";

export type ReconcileAction =
  | "baseline"
  | "noop"
  | "projected-canonical"
  | "captured-native"
  | "preferred-canonical"
  | "conflict";

export interface ReconcileResult {
  action: ReconcileAction;
  changedTargets: TargetName[];
  applyResults: ApplyResult[];
  warnings: AdapterWarning[];
  state: ProjectionState | null;
  conflict?: SyncConflict;
}

export async function reconcileOnce(
  project: LoadedProject,
  options: { lock?: boolean } = {},
): Promise<ReconcileResult> {
  const release = options.lock === false
    ? null
    : await acquireLock(join(project.storeDir, ".lock"));
  try {
    return await reconcileUnlocked(project);
  } finally {
    if (release) await release();
  }
}

async function reconcileUnlocked(project: LoadedProject): Promise<ReconcileResult> {
  let harness = await loadHarness(project.storeDir);
  await validateHarness(project.storeDir, harness);
  const previous = await readState(project.storeDir);
  const canonicalHash = await hashCanonical(project, harness);
  const targetHashes = await fingerprintTargets(project);

  if (!previous) {
    const applyResults = await applyHarness(project, harness, {
      dryRun: false,
      force: false,
    });
    assertNoSkippedWrites(applyResults, "Initial projection");
    const state = await snapshotState(project, harness, null, "canonical", canonicalHash);
    return {
      action: "baseline",
      changedTargets: [],
      applyResults,
      warnings: flattenWarnings(applyResults),
      state,
    };
  }

  const canonicalChanged = canonicalHash !== previous.canonicalHash;
  const targets = enabledTargets(project);
  const newTargets = targets.filter(
    (target) => previous.targetHashes[target] === undefined,
  );
  const changedTargets = targets.filter(
    (target) =>
      previous.targetHashes[target] !== undefined &&
      targetHashes[target] !== previous.targetHashes[target],
  );

  if (!canonicalChanged && changedTargets.length === 0 && newTargets.length === 0) {
    return {
      action: "noop",
      changedTargets,
      applyResults: [],
      warnings: [],
      state: previous,
    };
  }

  if (changedTargets.length === 0 && (canonicalChanged || newTargets.length > 0)) {
    const applyResults = await applyHarness(project, harness, {
      dryRun: false,
      force: false,
      ...(canonicalChanged
        ? {}
        : { exclude: targets.filter((target) => !newTargets.includes(target)) }),
    });
    assertNoSkippedWrites(applyResults, "Canonical projection");
    const state = await snapshotState(project, harness, previous, "canonical", canonicalHash);
    return {
      action: "projected-canonical",
      changedTargets,
      applyResults,
      warnings: flattenWarnings(applyResults),
      state,
    };
  }

  const inverseCapture = !canonicalChanged
    ? await selectInverseCapture(project, changedTargets)
    : null;
  if (inverseCapture) {
    const { source, changedPaths: changedManagedPaths } = inverseCapture;
    const adapter = getAdapter(source);
    try {
      await Promise.all(
        changedTargets.map((target) =>
          assertManagedTargetStructure(project.storeDir, target),
        ),
      );
    } catch (error) {
      return recordConflict(
        project,
        previous,
        false,
        changedTargets,
        error instanceof Error ? error.message : String(error),
      );
    }
    const sourceHashBeforeCapture = await adapter.fingerprint(
      adapterContext(project, source),
    );
    if (sourceHashBeforeCapture !== targetHashes[source]) {
      return recordConflict(
        project,
        previous,
        false,
        changedTargets,
        `${source} changed again before inverse capture began; no state was advanced`,
      );
    }
    if ((await hashCanonical(project, harness)) !== canonicalHash) {
      return recordConflict(
        project,
        previous,
        true,
        changedTargets,
        "Canonical content changed before inverse capture began; no native content was adopted",
      );
    }

    const controllerHash = await hashPath(project.configPath);
    const semanticStageDir = await createCaptureStage(project.storeDir, harness);
    let semanticMismatches: string[];
    try {
      semanticMismatches = await nativeRoundTripMismatches(
        adapter,
        adapterContext(project, source),
        harness,
        semanticStageDir,
        changedManagedPaths,
      );
    } finally {
      await rm(semanticStageDir, { recursive: true, force: true });
    }
    if (semanticMismatches.length === 0) {
      if (
        (await adapter.fingerprint(adapterContext(project, source))) !==
        sourceHashBeforeCapture ||
        (await hashCanonical(project, harness)) !== canonicalHash ||
        (await hashPath(project.configPath)) !== controllerHash
      ) {
        return recordConflict(
          project,
          previous,
          false,
          changedTargets,
          `${source} or canonical configuration changed while a semantic no-op was being verified`,
        );
      }
      // The comparison above deliberately renders without the machine-local
      // takeover base. Equality therefore also proves that any values which
      // used to exist only in that base were intentionally removed from the
      // native file and must not be resurrected by the next projection.
      const sourceHashBeforeRefresh = await adapter.fingerprint(
        adapterContext(project, source),
      );
      if (sourceHashBeforeRefresh !== sourceHashBeforeCapture) {
        return recordConflict(
          project,
          previous,
          false,
          changedTargets,
          `${source} changed after semantic verification; ownership hashes were not refreshed`,
        );
      }
      await refreshManagedTargetHashes(project.storeDir, source);
      const sourceHashAfterRefresh = await adapter.fingerprint(
        adapterContext(project, source),
      );
      if (sourceHashAfterRefresh !== sourceHashBeforeCapture) {
        return recordConflict(
          project,
          previous,
          false,
          changedTargets,
          `${source} changed while ownership hashes were refreshed; state was not advanced`,
        );
      }
      if (
        (await hashCanonical(project, harness)) !== canonicalHash ||
        (await hashPath(project.configPath)) !== controllerHash
      ) {
        return recordConflict(
          project,
          previous,
          true,
          changedTargets,
          "Canonical configuration changed while ownership hashes were refreshed; state was not advanced",
        );
      }
      await clearPreservedLocalBase(project.storeDir, source);
      const state = await snapshotState(
        project,
        harness,
        previous,
        source,
        canonicalHash,
      );
      return {
        action: "captured-native",
        changedTargets,
        applyResults: [],
        warnings: [{
          code: "native-formatting-only",
          message:
            `${source} was semantically unchanged (format/key order or removal of takeover-only local values); ownership hashes were refreshed without rewriting canonical content`,
          fidelity: "compatible",
        }],
        state,
      };
    }

    const originalContentHash = await hashCanonicalContent(project.storeDir, harness);
    const stageDir = await createCaptureStage(project.storeDir, harness);
    let captured: CaptureResult;
    try {
      captured = await adapter.capture(
        harness,
        { ...adapterContext(project, source), storeDir: stageDir },
        {
          includeLocal: false,
          includeAssets: true,
          write: true,
          managedPaths: await managedPathsForTarget(project.storeDir, source),
        },
      );
      await writeHarness(stageDir, captured.harness);
      await validateHarness(stageDir, captured.harness);

      const sourceHashAfterCapture = await adapter.fingerprint(
        adapterContext(project, source),
      );
      if (sourceHashAfterCapture !== sourceHashBeforeCapture) {
        return recordConflict(
          project,
          previous,
          false,
          changedTargets,
          `${source} changed while it was being captured; staged data was discarded`,
        );
      }
      if ((await hashCanonical(project, harness)) !== canonicalHash) {
        return recordConflict(
          project,
          previous,
          true,
          changedTargets,
          "Canonical content changed while native content was being captured; staged data was discarded",
        );
      }
      if (
        (await hashCanonicalContent(stageDir, captured.harness)) ===
        originalContentHash
      ) {
        return recordConflict(
          project,
          previous,
          false,
          changedTargets,
          `${source} changed, but its managed inverse adapter could not represent the edit; use an explicit migration or edit the canonical store`,
        );
      }
      const roundTripMismatches = await nativeRoundTripMismatches(
        adapter,
        adapterContext(project, source),
        captured.harness,
        stageDir,
        changedManagedPaths,
      );
      if (roundTripMismatches.length > 0) {
        return recordConflict(
          project,
          previous,
          false,
          changedTargets,
          `${source} edits were only partially representable (${roundTripMismatches.join(", ")}); staged data was discarded`,
        );
      }

      try {
        await commitCaptureStage(
          project,
          harness,
          captured.harness,
          stageDir,
          canonicalHash,
        );
        await clearPreservedLocalBase(project.storeDir, source);
      } catch (error) {
        return recordConflict(
          project,
          previous,
          true,
          changedTargets,
          error instanceof Error ? error.message : String(error),
        );
      }
      harness = captured.harness;
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }

    if ((await hashPath(project.configPath)) !== controllerHash) {
      return recordConflict(
        project,
        previous,
        true,
        changedTargets,
        "Controller configuration changed during inverse capture; state was not advanced",
      );
    }

    const capturedCanonicalHash = await hashCanonical(project, harness);
    if ((await hashPath(project.configPath)) !== controllerHash) {
      return recordConflict(
        project,
        previous,
        true,
        changedTargets,
        "Controller configuration changed while the canonical revision was hashed; state was not advanced",
      );
    }
    const sourceHashBeforeRefresh = await adapter.fingerprint(
      adapterContext(project, source),
    );
    if (sourceHashBeforeRefresh !== sourceHashBeforeCapture) {
      return recordConflict(
        project,
        previous,
        true,
        changedTargets,
        `${source} changed after capture; canonical changes were retained but state was not advanced`,
      );
    }
    await refreshManagedTargetHashes(project.storeDir, source);
    const sourceHashAfterRefresh = await adapter.fingerprint(
      adapterContext(project, source),
    );
    if (sourceHashAfterRefresh !== sourceHashBeforeCapture) {
      return recordConflict(
        project,
        previous,
        true,
        changedTargets,
        `${source} changed while ownership hashes were refreshed; state was not advanced`,
      );
    }
    if ((await hashPath(project.configPath)) !== controllerHash) {
      return recordConflict(
        project,
        previous,
        true,
        changedTargets,
        "Controller configuration changed before target projection; state was not advanced",
      );
    }
    const applyResults = await applyHarness(project, harness, {
      dryRun: false,
      force: false,
      exclude: [source],
    });
    assertNoSkippedWrites(applyResults, `Projection after capturing ${source}`);
    const state = await snapshotState(
      project,
      harness,
      previous,
      source,
      capturedCanonicalHash,
    );
    return {
      action: "captured-native",
      changedTargets,
      applyResults,
      warnings: [...captured.warnings, ...flattenWarnings(applyResults)],
      state,
    };
  }

  if (project.config.sync.onConflict === "prefer-canonical" && canonicalChanged) {
    const applyResults = await applyHarness(project, harness, {
      dryRun: false,
      force: true,
    });
    assertNoSkippedWrites(applyResults, "Forced canonical projection");
    const state = await snapshotState(project, harness, previous, "canonical", canonicalHash);
    return {
      action: "preferred-canonical",
      changedTargets,
      applyResults,
      warnings: flattenWarnings(applyResults),
      state,
    };
  }

  return recordConflict(
    project,
    previous,
    canonicalChanged,
    changedTargets,
    "Concurrent canonical/native or multi-target edits require an explicit migration or conflict policy",
  );
}

/** A copied file can be jointly owned when two clients intentionally use the
 * same native path (notably Codex and Antigravity AGENTS.md/.agents skills).
 * Identical non-empty changed-path sets are one physical edit, not concurrent
 * writers, so one compatible inverse adapter may capture it. */
async function selectInverseCapture(
  project: LoadedProject,
  changedTargets: TargetName[],
): Promise<{ source: TargetName; changedPaths: string[] } | null> {
  if (changedTargets.length === 0) return null;
  const entries = await Promise.all(
    changedTargets.map(async (target) => ({
      target,
      paths: await changedManagedPathsForTarget(project.storeDir, target),
    })),
  );
  if (entries.length === 1) {
    return entries[0]!.paths.length > 0
      ? { source: entries[0]!.target, changedPaths: entries[0]!.paths }
      : null;
  }
  const sharedPaths = entries[0]!.paths;
  if (sharedPaths.length === 0) return null;
  const signature = JSON.stringify(sharedPaths);
  if (!entries.every((entry) => JSON.stringify(entry.paths) === signature)) {
    return null;
  }
  return { source: entries[0]!.target, changedPaths: sharedPaths };
}

export async function createCaptureStage(
  storeDir: string,
  harness: CanonicalHarness,
): Promise<string> {
  const stageDir = await mkdtemp(join(dirname(storeDir), ".harness-sync-capture-"));
  try {
    for (const relativePath of canonicalArtifactPaths(harness)) {
      await copyCanonicalArtifact(storeDir, stageDir, relativePath);
    }
    await writeHarness(stageDir, harness);
    return stageDir;
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

export async function commitCaptureStage(
  project: LoadedProject,
  original: CanonicalHarness,
  captured: CanonicalHarness,
  stageDir: string,
  expectedCanonicalHash: string,
  additionalRelativePaths: readonly string[] = [],
): Promise<void> {
  if ((await hashCanonical(project, original)) !== expectedCanonicalHash) {
    throw new Error("canonical content changed before the staged capture could be committed");
  }
  const originalPaths = new Set([
    "harness.yaml",
    ...canonicalArtifactPaths(original),
    ...additionalRelativePaths,
  ]);
  const capturedPaths = [
    ...canonicalArtifactPaths(captured),
    "harness.yaml",
    ...additionalRelativePaths,
  ];
  const baselineHashes = new Map<string, string>();
  const baselineExists = new Map<string, boolean>();
  for (const relativePath of originalPaths) {
    await assertSafeStorePath(
      project.storeDir,
      resolveInside(project.storeDir, relativePath),
    );
    baselineExists.set(
      relativePath,
      await pathExists(resolveInside(project.storeDir, relativePath)),
    );
    baselineHashes.set(
      relativePath,
      await hashPath(resolveInside(project.storeDir, relativePath)),
    );
  }
  if ((await hashCanonical(project, original)) !== expectedCanonicalHash) {
    throw new Error("canonical content changed while capture baselines were collected");
  }
  for (const relativePath of capturedPaths) {
    await assertSafeStorePath(
      project.storeDir,
      resolveInside(project.storeDir, relativePath),
    );
    if (
      !originalPaths.has(relativePath) &&
      (await pathExists(resolveInside(project.storeDir, relativePath)))
    ) {
      throw new Error(
        `staged capture would overwrite an untracked canonical artifact: ${relativePath}`,
      );
    }
  }
  const changedPaths: string[] = [];
  for (const relativePath of [...new Set(capturedPaths)]) {
    const stagedHash = await hashPath(resolveInside(stageDir, relativePath));
    if (baselineHashes.get(relativePath) !== stagedHash) {
      changedPaths.push(relativePath);
    }
  }
  changedPaths.sort((left, right) => {
    if (left === "harness.yaml") return 1;
    if (right === "harness.yaml") return -1;
    return left.localeCompare(right);
  });
  const backupRoot = join(
    project.storeDir,
    "backups",
    `capture-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  for (const relativePath of changedPaths) {
    const destination = resolveInside(project.storeDir, relativePath);
    const prepared = join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.capture`,
    );
    const stagedSource = resolveInside(stageDir, relativePath);
    await assertSafeStorePath(stageDir, stagedSource);
    await assertSafeStorePath(project.storeDir, destination);
    await assertSafeStorePath(project.storeDir, prepared);
    const stagedInfo = await lstat(stagedSource);
    if (stagedInfo.isFile()) {
      await copyFileAtomicInside(project.storeDir, stagedSource, prepared);
    } else {
      await copyTreeForImportInside(project.storeDir, stagedSource, prepared);
    }
    const expected = baselineHashes.get(relativePath);
    let backup: string | undefined;
    try {
      if (baselineExists.get(relativePath)) {
        if ((await hashPath(destination)) !== expected) {
          throw new Error(`canonical artifact changed before capture commit: ${relativePath}`);
        }
        backup = resolveInside(backupRoot, relativePath);
        await assertSafeStorePath(project.storeDir, backup);
        await mkdir(dirname(backup), { recursive: true });
        await assertSafeStorePath(project.storeDir, dirname(backup));
        await rename(destination, backup);
        if ((await hashPath(backup)) !== expected) {
          if (!(await pathExists(destination))) await rename(backup, destination);
          throw new Error(`canonical artifact changed while capture commit began: ${relativePath}`);
        }
      } else if (await pathExists(destination)) {
        throw new Error(`new canonical artifact appeared during capture commit: ${relativePath}`);
      }
      if (await pathExists(destination)) {
        throw new Error(`canonical artifact reappeared during capture commit: ${relativePath}`);
      }
      if (stagedInfo.isFile()) {
        await link(prepared, destination);
        await rm(prepared, { force: true });
      } else {
        await rename(prepared, destination);
      }
    } catch (error) {
      if (backup && !(await pathExists(destination)) && (await pathExists(backup))) {
        await rename(backup, destination);
      }
      throw error;
    } finally {
      await rm(prepared, { recursive: true, force: true });
    }
  }
  const expectedContentHash = await hashCanonicalContent(stageDir, captured);
  if ((await hashCanonicalContent(project.storeDir, captured)) !== expectedContentHash) {
    throw new Error("canonical content changed while the staged capture was being committed");
  }
  for (const relativePath of additionalRelativePaths) {
    if (
      (await hashPath(resolveInside(project.storeDir, relativePath))) !==
      (await hashPath(resolveInside(stageDir, relativePath)))
    ) {
      throw new Error(`local capture artifact changed while it was committed: ${relativePath}`);
    }
  }
}

async function copyCanonicalArtifact(
  sourceStore: string,
  destinationStore: string,
  relativePath: string,
): Promise<void> {
  const source = resolveInside(sourceStore, relativePath);
  const destination = resolveInside(destinationStore, relativePath);
  await assertSafeStorePath(sourceStore, source);
  await assertSafeStorePath(destinationStore, destination);
  const info = await lstat(source);
  if (info.isFile()) {
    await copyFileAtomicInside(destinationStore, source, destination);
    return;
  }
  await copyTreeForImportInside(destinationStore, source, destination);
}

async function hashCanonicalContent(
  storeDir: string,
  harness: CanonicalHarness,
): Promise<string> {
  const digest = createHash("sha256");
  const relativePaths = ["harness.yaml", ...canonicalArtifactPaths(harness)];
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    digest.update(`${relativePath}\0${await hashPath(resolveInside(storeDir, relativePath))}\0`);
  }
  return digest.digest("hex");
}

function canonicalArtifactPaths(harness: CanonicalHarness): string[] {
  return [...new Set([
    harness.instructions.root,
    ...harness.rules.map((rule) => rule.path),
    ...harness.skills.map((skill) => skill.path),
    ...Object.values(harness.commands).map((command) => command.promptFile),
    ...Object.values(harness.agents).map((agent) => agent.instructionsFile),
  ])];
}

async function nativeRoundTripMismatches(
  adapter: ReturnType<typeof getAdapter>,
  sourceContext: ReturnType<typeof adapterContext>,
  harness: CanonicalHarness,
  storeDir: string,
  changedPaths: readonly string[],
): Promise<string[]> {
  if (changedPaths.length === 0) return [];
  const shadowContainer = await mkdtemp(
    join(dirname(storeDir), ".harness-sync-roundtrip-"),
  );
  const shadowTargetRoot = sourceContext.scope === "project"
    ? join(shadowContainer, "project")
    : join(shadowContainer, basename(sourceContext.targetRoot));
  const shadowContext = {
    ...sourceContext,
    projectRoot: sourceContext.scope === "project"
      ? shadowTargetRoot
      : shadowContainer,
    targetRoot: shadowTargetRoot,
    storeDir,
  };
  const sourceProjectionRoot = sourceContext.scope === "project"
    ? resolve(sourceContext.targetRoot)
    : resolve(dirname(sourceContext.targetRoot));
  const shadowProjectionRoot = sourceContext.scope === "project"
    ? resolve(shadowTargetRoot)
    : resolve(dirname(shadowTargetRoot));
  try {
    // Adapters intentionally preserve a lone native fallback name such as
    // `.claude/CLAUDE.md` or `GEMINI.md`. Reproduce only the watched path
    // shapes in the isolated target so round-trip verification chooses the
    // same destination without copying native data into the verifier.
    for (const sourcePath of adapter.watchPaths(sourceContext)) {
      if (!["AGENTS.md", "CLAUDE.md", "GEMINI.md"].includes(basename(sourcePath))) {
        continue;
      }
      if (!(await pathExists(sourcePath))) continue;
      const remainder = relative(sourceProjectionRoot, resolve(sourcePath));
      if (remainder === ".." || remainder.startsWith(`..${sep}`)) continue;
      const shadowPath = resolve(shadowProjectionRoot, remainder);
      const info = await lstat(sourcePath);
      if (!info.isDirectory()) {
        await mkdir(dirname(shadowPath), { recursive: true });
        await writeFile(shadowPath, "");
      }
    }
    const projection = await adapter.apply(harness, shadowContext, {
      dryRun: false,
      force: true,
      linkMode: "copy",
      activeTargets: [adapter.name],
      ignoreLocalBase: true,
    });
    const mismatches = projection.skipped.map((path) => `unprojected:${path}`);
    for (const sourcePath of changedPaths) {
      const remainder = relative(sourceProjectionRoot, resolve(sourcePath));
      if (
        remainder === ".." ||
        remainder.startsWith(`..${sep}`)
      ) {
        mismatches.push(sourcePath);
        continue;
      }
      const shadowPath = resolve(shadowProjectionRoot, remainder);
      if (!(await nativePathsEquivalent(sourcePath, shadowPath, adapter.name))) {
        mismatches.push(sourcePath);
      }
    }
    return [...new Set(mismatches)];
  } finally {
    await rm(shadowContainer, { recursive: true, force: true });
  }
}

async function nativePathsEquivalent(
  left: string,
  right: string,
  target: TargetName,
): Promise<boolean> {
  const [leftInfo, rightInfo] = await Promise.all([
    lstatIfExists(left),
    lstatIfExists(right),
  ]);
  if (!leftInfo || !rightInfo) {
    if (!leftInfo && !rightInfo) return true;
    return nativeConfigEquivalentToAbsence(
      leftInfo ? left : right,
      leftInfo ?? rightInfo!,
    );
  }
  if (leftInfo.isSymbolicLink() || rightInfo.isSymbolicLink()) {
    return leftInfo.isSymbolicLink() &&
      rightInfo.isSymbolicLink() &&
      (await readlink(left)) === (await readlink(right));
  }
  if (leftInfo.isDirectory() || rightInfo.isDirectory()) {
    if (!leftInfo.isDirectory() || !rightInfo.isDirectory()) return false;
    const [leftEntries, rightEntries] = await Promise.all([
      readdir(left),
      readdir(right),
    ]);
    if (stableStringify(leftEntries.sort()) !== stableStringify(rightEntries.sort())) {
      return false;
    }
    for (const entry of leftEntries) {
      if (!(await nativePathsEquivalent(join(left, entry), join(right, entry), target))) {
        return false;
      }
    }
    return true;
  }
  if (!leftInfo.isFile() || !rightInfo.isFile()) return false;
  if ((leftInfo.mode & 0o111) !== (rightInfo.mode & 0o111)) return false;
  const [leftBuffer, rightBuffer] = await Promise.all([readFile(left), readFile(right)]);
  const extension = extname(left).toLowerCase();
  try {
    if (extension === ".json") {
      const parse = target === "antigravity"
        ? parseJsoncForComparison
        : JSON.parse;
      return stableStringify(parse(leftBuffer.toString("utf8"))) ===
        stableStringify(parse(rightBuffer.toString("utf8")));
    }
    if (extension === ".jsonc") {
      return stableStringify(parseJsoncForComparison(leftBuffer.toString("utf8"))) ===
        stableStringify(parseJsoncForComparison(rightBuffer.toString("utf8")));
    }
    if (extension === ".toml") {
      return stableStringify(parseToml(leftBuffer.toString("utf8"))) ===
        stableStringify(parseToml(rightBuffer.toString("utf8")));
    }
    if (extension === ".md") {
      const leftDocument = parseFrontmatter(leftBuffer.toString("utf8"));
      const rightDocument = parseFrontmatter(rightBuffer.toString("utf8"));
      return leftDocument.body === rightDocument.body &&
        stableStringify(leftDocument.data) === stableStringify(rightDocument.data);
    }
  } catch {
    return false;
  }
  return leftBuffer.equals(rightBuffer);
}

async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function nativeConfigEquivalentToAbsence(
  path: string,
  info: Stats,
): Promise<boolean> {
  if (!info.isFile() || (info.mode & 0o111) !== 0) return false;
  const extension = extname(path).toLowerCase();
  const input = await readFile(path, "utf8");
  try {
    const parsed = extension === ".toml"
      ? parseToml(input)
      : extension === ".json"
        ? JSON.parse(input)
        : extension === ".jsonc"
          ? parseJsoncForComparison(input)
          : undefined;
    return parsed !== undefined &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length === 0;
  } catch {
    return false;
  }
}

function parseJsoncForComparison(input: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(input, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) throw new Error("invalid JSONC during comparison");
  return parsed;
}

function stableStringify(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `number:${String(value)}`;
  }
  if (value instanceof Date) {
    return `date:${value.constructor.name}:${value.toJSON()}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function recordConflict(
  project: LoadedProject,
  previous: ProjectionState,
  canonicalChanged: boolean,
  changedTargets: TargetName[],
  message: string,
): Promise<ReconcileResult> {
  const conflict: SyncConflict = {
    detectedAt: new Date().toISOString(),
    canonicalChanged,
    changedTargets,
    message,
  };
  await writeJsonAtomicInside(
    project.storeDir,
    join(project.storeDir, "conflicts", "current.json"),
    conflict,
  );
  return {
    action: "conflict",
    changedTargets,
    applyResults: [],
    warnings: [],
    state: previous,
    conflict,
  };
}

export async function establishBaseline(
  project: LoadedProject,
  harness: CanonicalHarness,
  lastWriter: "canonical" | TargetName = "canonical",
  expectedCanonicalHash?: string,
): Promise<ProjectionState> {
  return snapshotState(
    project,
    harness,
    await readState(project.storeDir),
    lastWriter,
    expectedCanonicalHash ?? await hashCanonical(project, harness),
  );
}

async function snapshotState(
  project: LoadedProject,
  harness: CanonicalHarness,
  previous: ProjectionState | null,
  lastWriter: "canonical" | TargetName,
  expectedCanonicalHash: string,
): Promise<ProjectionState> {
  await assertProjectionStable(project, harness, expectedCanonicalHash);
  const targetHashes = await fingerprintTargets(project);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await assertProjectionStable(project, harness, expectedCanonicalHash);
  const verifiedTargetHashes = await fingerprintTargets(project);
  if (JSON.stringify(targetHashes) !== JSON.stringify(verifiedTargetHashes)) {
    throw new Error("native targets changed while the reconciliation snapshot was being created");
  }
  const state = nextState(
    previous,
    expectedCanonicalHash,
    verifiedTargetHashes,
    lastWriter,
  );
  await writeState(project.storeDir, state);
  return state;
}

async function assertProjectionStable(
  project: LoadedProject,
  harness: CanonicalHarness,
  expectedCanonicalHash: string,
): Promise<void> {
  const actualCanonicalHash = await hashCanonical(project, harness);
  if (actualCanonicalHash !== expectedCanonicalHash) {
    throw new Error("canonical store changed while projection was in progress; state was not advanced");
  }
  await Promise.all(
    enabledTargets(project).map((target) =>
      assertManagedTargetMatchesRegistry(project.storeDir, target),
    ),
  );
}

async function fingerprintTargets(
  project: LoadedProject,
): Promise<Partial<Record<TargetName, string>>> {
  const entries = await Promise.all(
    enabledTargets(project).map(async (target) => [
      target,
      await getAdapter(target).fingerprint(adapterContext(project, target)),
    ] as const),
  );
  return Object.fromEntries(entries);
}

function flattenWarnings(results: ApplyResult[]): AdapterWarning[] {
  return results.flatMap((result) => result.warnings);
}

function assertNoSkippedWrites(results: ApplyResult[], action: string): void {
  const skipped = results.flatMap((result) => result.skipped);
  if (skipped.length > 0) {
    throw new Error(
      `${action} found unmanaged or externally changed native paths; state was not advanced: ${skipped.join(", ")}`,
    );
  }
}
