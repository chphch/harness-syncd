import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ApplyResult,
  CanonicalHarness,
  ProjectConfig,
  Scope,
  TargetName,
} from "../types.js";
import { TARGET_NAMES } from "../types.js";
import { getAdapter } from "../adapters/index.js";
import type {
  AdapterContext,
  NativeWritePreconditions,
} from "../adapters/adapter.js";
import {
  defaultHarness,
  defaultProjectConfig,
  findProjectConfig,
  isControllerId,
  loadHarness,
  loadProjectConfig,
  PROJECT_CONFIG_NAME,
  resolveStoreDir,
  resolveTargetRoot,
  writeHarness,
  writeProjectConfig,
} from "./config.js";
import {
  acquireLock,
  pathExists,
  readTextIfExists,
  resolvePhysicalPath,
  resolveInside,
  assertSafeStorePath,
  writeTextAtomicInside,
} from "./fs.js";
import { validateHarness } from "./validate.js";

export interface LoadedProject {
  configPath: string;
  projectRoot: string;
  storeDir: string;
  config: ProjectConfig;
}

export async function initializeProject(
  root: string,
  options: { scope?: Scope; store?: string; controllerId?: string } = {},
): Promise<LoadedProject> {
  const projectRoot = resolve(root);
  const configPath = join(projectRoot, PROJECT_CONFIG_NAME);
  const releaseInit = await acquireLock(`${configPath}.init.lock`);
  try {
    if (!(await pathExists(configPath))) {
      if (
        options.controllerId !== undefined &&
        !isControllerId(options.controllerId)
      ) {
        throw new Error(
          "controllerId must be 1-128 characters using letters, numbers, dot, underscore, or hyphen",
        );
      }
      const config = defaultProjectConfig(options.scope ?? "project");
      config.controllerId =
        options.controllerId ?? createControllerId(projectRoot);
      if (options.store) config.store = options.store;
      const storeDir = resolveStoreDir(configPath, config);
      await assertSafeProjectTopology({
        configPath,
        projectRoot,
        storeDir,
        config,
      });
      for (const relativePath of [
        ".gitignore",
        "harness.yaml",
        "instructions/root.md",
        ".managed.json",
        ".state.json",
        ".local/preserved/base",
        "backups/base",
        "conflicts/current.json",
      ]) {
        await assertSafeStorePath(storeDir, join(storeDir, relativePath));
      }
      await writeProjectConfig(configPath, config);
    }
    const project = await loadProject(configPath);
    await mkdir(project.storeDir, { recursive: true });
    const storeIgnore = join(project.storeDir, ".gitignore");
    await assertSafeStorePath(project.storeDir, storeIgnore);
    const requiredIgnoreLines = [
      "/.state.json",
      "/.managed.json",
      "/.lock",
      "/.local/",
      "/backups/",
      "/conflicts/",
    ];
    const existingIgnore = (await readTextIfExists(storeIgnore)) ?? "";
    const existingLines = new Set(
      existingIgnore.split(/\r?\n/u).map((line) => line.trim()),
    );
    const missingIgnoreLines = requiredIgnoreLines.filter(
      (line) => !existingLines.has(line),
    );
    if (missingIgnoreLines.length > 0) {
      const separator =
        existingIgnore.length > 0 && !existingIgnore.endsWith("\n") ? "\n" : "";
      await writeTextAtomicInside(
        project.storeDir,
        storeIgnore,
        `${existingIgnore}${separator}${missingIgnoreLines.join("\n")}\n`,
      );
    }
    const harnessPath = join(project.storeDir, "harness.yaml");
    if (!(await pathExists(harnessPath))) {
      const harness = defaultHarness(basename(projectRoot));
      await writeHarness(project.storeDir, harness);
      await writeTextAtomicInside(
        project.storeDir,
        resolveInside(project.storeDir, harness.instructions.root),
        `# ${basename(projectRoot)}\n\nAdd shared agent instructions here.\n`,
      );
    }
    return project;
  } finally {
    await releaseInit();
  }
}

export function createControllerId(root: string): string {
  const stem = basename(resolve(root))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 48) || "controller";
  return `${stem}-${randomUUID().slice(0, 8)}`;
}

export async function loadProject(startOrConfig: string): Promise<LoadedProject> {
  const absolute = resolve(startOrConfig);
  const configPath = absolute.endsWith(PROJECT_CONFIG_NAME)
    ? absolute
    : await findProjectConfig(absolute);
  if (!configPath) {
    throw new Error(
      `No ${PROJECT_CONFIG_NAME} found from ${absolute}; run harness-sync init first`,
    );
  }
  const config = await loadProjectConfig(configPath);
  const project = {
    configPath,
    projectRoot: dirname(configPath),
    storeDir: resolveStoreDir(configPath, config),
    config,
  };
  await assertSafeProjectTopology(project);
  return project;
}

export function adapterContext(
  project: LoadedProject,
  target: TargetName,
): AdapterContext {
  return {
    projectRoot: project.projectRoot,
    targetRoot: resolveTargetRoot(project.configPath, project.config, target),
    storeDir: project.storeDir,
    scope: project.config.scope,
  };
}

export function enabledTargets(project: LoadedProject): TargetName[] {
  return TARGET_NAMES.filter((target) => project.config.targets[target].enabled);
}

async function assertSafeProjectTopology(project: LoadedProject): Promise<void> {
  const store = await resolvePhysicalPath(project.storeDir);
  const config = await resolvePhysicalPath(project.configPath);
  if (pathsOverlap(store, config)) {
    throw new Error(
      `canonical store overlaps project controller ${config}; choose a separate store directory`,
    );
  }
  for (const target of enabledTargets(project)) {
    const context = adapterContext(project, target);
    for (const nativePath of getAdapter(target).watchPaths(context)) {
      // Root instruction leaves are expected to be managed links into the
      // store. Other watched leaves (notably skills/settings roots) must be
      // resolved fully so a directory alias cannot hide a topology overlap.
      const instructionLeaf = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
        .includes(basename(nativePath));
      const native = instructionLeaf
        ? join(
            await resolvePhysicalPath(dirname(nativePath)),
            basename(nativePath),
          )
        : await resolvePhysicalPath(nativePath);
      if (pathsOverlap(config, native)) {
        throw new Error(
          `project controller overlaps ${target} native path ${native}; choose a separate controller root`,
        );
      }
      if (pathsOverlap(store, native)) {
        throw new Error(
          `canonical store overlaps ${target} native path ${native}; choose a separate store directory`,
        );
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const contained = (value: string) =>
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return contained(leftToRight) || contained(rightToLeft);
}

export async function applyHarness(
  project: LoadedProject,
  harness: CanonicalHarness,
  options: {
    dryRun: boolean;
    force: boolean;
    exclude?: TargetName[];
    nativePreconditions?: NativeWritePreconditions;
  },
): Promise<ApplyResult[]> {
  await validateHarness(project.storeDir, harness);
  const excluded = new Set(options.exclude ?? []);
  const activeTargets = enabledTargets(project);
  const results: ApplyResult[] = [];
  for (const target of activeTargets) {
    if (excluded.has(target)) continue;
    results.push(
      await getAdapter(target).apply(harness, adapterContext(project, target), {
        dryRun: options.dryRun,
        force: options.force,
        linkMode: project.config.sync.linkMode,
        activeTargets,
        ...(options.nativePreconditions
          ? { nativePreconditions: options.nativePreconditions }
          : {}),
      }),
    );
  }
  return results;
}

export async function readCanonical(project: LoadedProject): Promise<CanonicalHarness> {
  return loadHarness(project.storeDir);
}
