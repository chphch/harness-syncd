import { lstat, opendir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getAdapter } from "../adapters/index.js";
import type { Scope } from "../types.js";
import { isRecord } from "./frontmatter.js";
import {
  isControllerId,
  PROJECT_CONFIG_NAME,
} from "./config.js";
import {
  pathExists,
  acquireLock,
  readTextIfExists,
  resolvePathClaims,
  resolvePhysicalPath,
  writeTextAtomic,
} from "./fs.js";
import {
  adapterContext,
  enabledTargets,
  loadProject,
  type LoadedProject,
} from "./project.js";
import { managedPathsForStore } from "./writer.js";

export const DEFAULT_REGISTRY_PATH = join(
  homedir(),
  ".config",
  "harness-sync",
  "registry.yaml",
);

export const DEFAULT_DISCOVERY_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
] as const;

export interface RegistryController {
  id: string;
  config: string;
  enabled: boolean;
  watch: boolean;
}

export interface RegistryDiscovery {
  roots: string[];
  ignore: string[];
  /** Reserved for a future opt-in policy. Version 1 never auto-enrolls. */
  autoEnroll: false;
}

export interface ControllerRegistry {
  schemaVersion: 1;
  controllers: RegistryController[];
  discovery: RegistryDiscovery;
}

export type ListedController =
  | (RegistryController & {
      status: "online";
      project: LoadedProject;
    })
  | (RegistryController & {
      status: "missing";
      error: string;
    })
  | (RegistryController & {
      status: "invalid";
      error: string;
    });

export interface AddControllerOptions {
  registryPath?: string;
  id?: string;
  enabled?: boolean;
  watch?: boolean;
}

export interface UpdateControllerOptions {
  id?: string;
  config?: string;
  enabled?: boolean;
  watch?: boolean;
}

export interface DiscoverControllersOptions {
  registryPath?: string;
  /** Overrides the registry roots for this read-only scan. */
  roots?: readonly string[];
  /** Overrides the registry ignore patterns for this read-only scan. */
  ignore?: readonly string[];
  /** Root is depth 0. Direct child directories are depth 1. */
  maxDepth?: number;
  /** Maximum directory entries inspected across all roots. */
  maxEntries?: number;
  /** Maximum valid controller markers returned. */
  maxResults?: number;
}

export interface DiscoveredController {
  config: string;
  projectRoot: string;
  storeDir: string;
  scope: Scope;
  registered: boolean;
  controllerId?: string;
}

export interface LoadedRegistryController {
  controller: RegistryController;
  project: LoadedProject;
}

interface ControllerFootprint {
  controller: RegistryController;
  config: string;
  store: string;
  watched: Array<{ target: string; path: string }>;
  scope: Scope;
}

const DEFAULT_MAX_DISCOVERY_DEPTH = 8;
const DEFAULT_MAX_DISCOVERY_ENTRIES = 20_000;
const DEFAULT_MAX_DISCOVERY_RESULTS = 1_000;

export function defaultRegistry(): ControllerRegistry {
  return {
    schemaVersion: 1,
    controllers: [],
    discovery: {
      roots: [],
      ignore: [...DEFAULT_DISCOVERY_IGNORE],
      autoEnroll: false,
    },
  };
}

/**
 * Load and strictly validate the machine-local registry. A missing registry is
 * equivalent to the empty default registry. Individual controller files are
 * deliberately not loaded here, so an offline project cannot invalidate the
 * registry as a whole.
 */
export async function loadRegistry(
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Promise<ControllerRegistry> {
  const absolutePath = resolve(registryPath);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return defaultRegistry();
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(
      `${absolutePath}: controller registry must be a regular file, not a symlink`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${absolutePath}: invalid registry YAML: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return normalizeRegistry(parsed, absolutePath);
}

/** Write a complete registry using the same-directory atomic writer. */
export async function writeRegistry(
  registry: ControllerRegistry,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Promise<void> {
  const absolutePath = resolve(registryPath);
  const release = await acquireLock(`${absolutePath}.lock`);
  try {
    const before = await readTextIfExists(absolutePath);
    const normalized = await normalizeRegistry(registry, absolutePath);
    if ((await readTextIfExists(absolutePath)) !== before) {
      throw new Error(`controller registry changed during write: ${absolutePath}`);
    }
    await writeRegistryUnlocked(normalized, absolutePath);
  } finally {
    await release();
  }
}

export async function listControllers(
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Promise<ListedController[]> {
  return inspectControllers(await loadRegistry(registryPath));
}

/** Inspect availability without changing the supplied registry or any project. */
export async function inspectControllers(
  registry: ControllerRegistry,
): Promise<ListedController[]> {
  const results: ListedController[] = [];
  for (const controller of registry.controllers) {
    if (!(await pathExists(controller.config))) {
      results.push({
        ...controller,
        status: "missing",
        error: `controller config is missing: ${controller.config}`,
      });
      continue;
    }
    try {
      const project = await loadProject(controller.config);
      if (project.config.controllerId !== controller.id) {
        results.push({
          ...controller,
          status: "invalid",
          error:
            `registry id ${controller.id} does not match controllerId ` +
            `${project.config.controllerId ?? "<missing>"} in ${controller.config}`,
        });
      } else {
        results.push({ ...controller, status: "online", project });
      }
    } catch (error) {
      if (!(await pathExists(controller.config))) {
        results.push({
          ...controller,
          status: "missing",
          error: `controller config is missing: ${controller.config}`,
        });
      } else {
        results.push({
          ...controller,
          status: "invalid",
          error: errorMessage(error),
        });
      }
    }
  }
  return results;
}

/**
 * Register an existing controller. `configPath` may name either the controller
 * file or a directory from which the existing project loader can find it.
 */
export async function addController(
  configPath: string,
  options: AddControllerOptions = {},
): Promise<RegistryController> {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  return mutateRegistry(registryPath, async (registry) => {
    const project = await loadCanonicalProject(configPath);
    if (!project.config.controllerId) {
      throw new Error(
        `${project.configPath}: controllerId is missing; assign it before registry enrollment`,
      );
    }
    const id = options.id ?? project.config.controllerId;
    assertControllerId(id, `${project.configPath}: controllerId`);
    if (project.config.controllerId && project.config.controllerId !== id) {
      throw new Error(
        `registry id ${id} does not match controllerId ${project.config.controllerId} ` +
          `in ${project.configPath}`,
      );
    }

    const controller: RegistryController = {
      id,
      config: project.configPath,
      enabled: options.enabled ?? true,
      watch: options.watch ?? true,
    };
    const normalized = await normalizeRegistry(
      { ...registry, controllers: [...registry.controllers, controller] },
      resolve(registryPath),
    );
    await validateControllerTopology(normalized, {
      requireOnline: true,
      registryPath,
    });
    return { registry: normalized, value: controller };
  });
}

/** Update registry metadata only; controller configuration is never rewritten. */
export async function updateController(
  currentId: string,
  updates: UpdateControllerOptions,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Promise<RegistryController> {
  return mutateRegistry(registryPath, async (registry) => {
    const index = registry.controllers.findIndex((entry) => entry.id === currentId);
    if (index < 0) throw new Error(`unknown registry controller: ${currentId}`);
    const current = registry.controllers[index]!;
    const identityChanging = updates.config !== undefined || updates.id !== undefined;
    const project = identityChanging
      ? await loadCanonicalProject(updates.config ?? current.config)
      : undefined;
    const config = project?.configPath ?? current.config;
    const replacement: RegistryController = {
      id: updates.id ?? current.id,
      config,
      enabled: updates.enabled ?? current.enabled,
      watch: updates.watch ?? current.watch,
    };
    if (project && project.config.controllerId !== replacement.id) {
      throw new Error(
        `registry id ${replacement.id} does not match controllerId ` +
          `${project.config.controllerId ?? "<missing>"} in ${project.configPath}`,
      );
    }
    const controllers = [...registry.controllers];
    controllers[index] = replacement;
    const normalized = await normalizeRegistry(
      { ...registry, controllers },
      resolve(registryPath),
    );
    if (replacement.enabled) {
      await validateControllerTopology(normalized, {
        requireOnline: true,
        registryPath,
      });
    }
    return { registry: normalized, value: normalized.controllers[index]! };
  });
}

/** Remove only the machine-local enrollment; project files and stores remain. */
export async function removeController(
  id: string,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Promise<RegistryController> {
  return mutateRegistry(registryPath, async (registry) => {
    const index = registry.controllers.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`unknown registry controller: ${id}`);
    const removed = registry.controllers[index]!;
    return {
      registry: {
        ...registry,
        controllers: registry.controllers.filter((_, candidate) => candidate !== index),
      },
      value: removed,
    };
  });
}

/**
 * Validate safety relationships among every enabled, currently loadable
 * controller. Missing/offline controllers remain registered and are skipped;
 * their topology should be checked again when they come online.
 */
export async function validateControllerTopology(
  registry: ControllerRegistry,
  options: { requireOnline?: boolean; registryPath?: string } = {},
): Promise<void> {
  const listed = await inspectControllers(registry);
  const invalid = listed.filter(
    (entry): entry is Extract<ListedController, { status: "invalid" }> =>
      entry.enabled && entry.status === "invalid",
  );
  if (invalid.length > 0) {
    throw new Error(
      `enabled registry controller is invalid: ${invalid
        .map((entry) => `${entry.id}: ${entry.error}`)
        .join("; ")}`,
    );
  }
  const missing = listed.filter(
    (entry) => entry.enabled && entry.status === "missing",
  );
  if (options.requireOnline === true && missing.length > 0) {
    throw new Error(
      `enabled registry controller is offline: ${missing
        .map((entry) => `${entry.id}: ${entry.config}`)
        .join(", ")}`,
    );
  }
  const online = listed.filter(
    (entry): entry is Extract<ListedController, { status: "online" }> =>
      entry.status === "online" && entry.enabled,
  );
  await validateLoadedControllerTopology(
    online.map((entry) => ({ controller: entry, project: entry.project })),
    options.registryPath ? { registryPath: options.registryPath } : {},
  );
}

/** Validate topology using already-loaded, byte-stable controller snapshots. */
export async function validateLoadedControllerTopology(
  entries: readonly LoadedRegistryController[],
  options: { registryPath?: string } = {},
): Promise<void> {
  const enabled = entries.filter((entry) => entry.controller.enabled);
  for (const entry of enabled) {
    if (entry.project.config.controllerId !== entry.controller.id) {
      throw new Error(
        `registry id ${entry.controller.id} does not match controllerId ` +
          `${entry.project.config.controllerId ?? "<missing>"} in ` +
          `${entry.project.configPath}`,
      );
    }
  }
  const enabledUsers = enabled.filter(
    (entry) => entry.project.config.scope === "user",
  );
  if (enabledUsers.length > 1) {
    throw new Error(
      `only one enabled user-scope controller is allowed; found ${enabledUsers
        .map((entry) => entry.controller.id)
        .join(", ")}`,
    );
  }

  const footprints: ControllerFootprint[] = [];
  for (const entry of enabled) {
    const watched: ControllerFootprint["watched"] = [];
    for (const target of enabledTargets(entry.project)) {
      const context = adapterContext(entry.project, target);
      for (const path of getAdapter(target).watchPaths(context)) {
        for (const claim of await resolvePathClaims(path)) {
          if (!watched.some((candidate) => candidate.path === claim)) {
            watched.push({ target, path: claim });
          }
        }
      }
    }
    for (const path of await managedPathsForStore(entry.project.storeDir)) {
      for (const claim of await resolvePathClaims(path)) {
        if (!watched.some((candidate) => candidate.path === claim)) {
          watched.push({ target: "managed", path: claim });
        }
      }
    }
    footprints.push({
      controller: entry.controller,
      config: await resolvePhysicalPath(entry.project.configPath),
      store: await resolvePhysicalPath(entry.project.storeDir),
      watched,
      scope: entry.project.config.scope,
    });
  }

  for (let leftIndex = 0; leftIndex < footprints.length; leftIndex += 1) {
    const left = footprints[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < footprints.length; rightIndex += 1) {
      const right = footprints[rightIndex]!;
      await assertFootprintsSeparate(left, right);
    }
  }
  if (options.registryPath) {
    const registryPath = await bestEffortPhysicalPath(resolve(options.registryPath));
    for (const footprint of footprints) {
      if (await pathsOverlap(registryPath, footprint.store)) {
        throw new Error(
          `controller registry ${registryPath} overlaps ${footprint.controller.id} ` +
            `canonical store ${footprint.store}`,
        );
      }
      for (const watched of footprint.watched) {
        if (await pathsOverlap(registryPath, watched.path)) {
          throw new Error(
            `controller registry ${registryPath} overlaps ${footprint.controller.id} ` +
              `${watched.target} native path ${watched.path}`,
          );
        }
      }
    }
  }
}

/**
 * Scan configured roots for valid markers without enrolling anything. Symlinked
 * directories are not followed, and hard limits prevent an accidentally broad
 * root from becoming an unbounded filesystem crawl.
 */
export async function discoverControllers(
  options: DiscoverControllersOptions = {},
): Promise<DiscoveredController[]> {
  const registry = await loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const maxDepth = boundedInteger(
    options.maxDepth,
    DEFAULT_MAX_DISCOVERY_DEPTH,
    "maxDepth",
    true,
  );
  const maxEntries = boundedInteger(
    options.maxEntries,
    DEFAULT_MAX_DISCOVERY_ENTRIES,
    "maxEntries",
    false,
  );
  const maxResults = boundedInteger(
    options.maxResults,
    DEFAULT_MAX_DISCOVERY_RESULTS,
    "maxResults",
    false,
  );
  const ignore = options.ignore ?? registry.discovery.ignore;
  for (const [index, pattern] of ignore.entries()) {
    assertNonEmptyString(pattern, `discovery ignore[${index}]`);
  }
  const matchers = ignore.map(compileGlob);
  const rawRoots = options.roots ?? registry.discovery.roots;
  const roots: string[] = [];
  for (const rawRoot of rawRoots) {
    assertNonEmptyString(rawRoot, "discovery root");
    const physical = await bestEffortPhysicalPath(resolve(rawRoot));
    if (!roots.includes(physical)) roots.push(physical);
  }
  roots.sort((left, right) => left.localeCompare(right));

  const registered = new Set(registry.controllers.map((entry) => entry.config));
  const candidates = new Map<string, DiscoveredController>();
  let inspectedEntries = 0;

  const walk = async (
    root: string,
    current: string,
    depth: number,
    visitedDirectories: Set<string>,
  ): Promise<void> => {
    if (visitedDirectories.has(current)) return;
    visitedDirectories.add(current);
    const entries = [];
    try {
      const directory = await opendir(current);
      for await (const entry of directory) {
        inspectedEntries += 1;
        if (inspectedEntries > maxEntries) {
          throw new Error(
            `controller discovery exceeded maxEntries (${maxEntries}); ` +
              "narrow the roots or raise the explicit limit",
          );
        }
        entries.push(entry);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relativePath = normalizeSlashes(relative(root, absolute));
      const directory = entry.isDirectory();
      if (isIgnored(relativePath, absolute, directory, matchers)) continue;

      if (entry.isFile() && entry.name === PROJECT_CONFIG_NAME) {
        try {
          const project = await loadCanonicalProject(absolute);
          if (!candidates.has(project.configPath)) {
            if (candidates.size >= maxResults) {
              throw new Error(
                `controller discovery exceeded maxResults (${maxResults}); narrow the roots or raise the explicit limit`,
              );
            }
            const discovered: DiscoveredController = {
              config: project.configPath,
              projectRoot: project.projectRoot,
              storeDir: project.storeDir,
              scope: project.config.scope,
              registered: registered.has(project.configPath),
            };
            if (project.config.controllerId) {
              discovered.controllerId = project.config.controllerId;
            }
            candidates.set(project.configPath, discovered);
          }
        } catch (error) {
          if (errorMessage(error).includes("discovery exceeded maxResults")) {
            throw error;
          }
          // Discovery returns valid controllers only. Explicit add gives the
          // caller the detailed validation error for a chosen invalid marker.
        }
        continue;
      }
      if (directory && depth < maxDepth) {
        await walk(root, absolute, depth + 1, visitedDirectories);
      }
      // Never follow symbolic links or filesystem-special entries.
    }
  };

  for (const root of roots) {
    let info;
    try {
      info = await lstat(root);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory()) {
      throw new Error(`controller discovery root is not a directory: ${root}`);
    }
    await walk(root, root, 0, new Set());
  }

  return [...candidates.values()].sort((left, right) =>
    left.config.localeCompare(right.config),
  );
}

async function normalizeRegistry(
  value: unknown,
  sourcePath: string,
): Promise<ControllerRegistry> {
  if (!isRecord(value)) {
    throw new Error(`${sourcePath}: registry must be an object`);
  }
  assertExactKeys(
    value,
    ["schemaVersion", "controllers", "discovery"],
    `${sourcePath}: registry`,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${sourcePath}: expected schemaVersion: 1`);
  }
  if (!Array.isArray(value.controllers)) {
    throw new Error(`${sourcePath}: controllers must be an array`);
  }
  if (!isRecord(value.discovery)) {
    throw new Error(`${sourcePath}: discovery must be an object`);
  }

  const controllers: RegistryController[] = [];
  for (const [index, raw] of value.controllers.entries()) {
    const context = `${sourcePath}: controllers[${index}]`;
    if (!isRecord(raw)) throw new Error(`${context} must be an object`);
    assertExactKeys(raw, ["id", "config", "enabled", "watch"], context);
    assertControllerId(raw.id, `${context}.id`);
    assertAbsolutePath(raw.config, `${context}.config`);
    if (typeof raw.enabled !== "boolean") {
      throw new Error(`${context}.enabled must be a boolean`);
    }
    if (typeof raw.watch !== "boolean") {
      throw new Error(`${context}.watch must be a boolean`);
    }
    controllers.push({
      id: raw.id,
      config: await bestEffortPhysicalPath(raw.config),
      enabled: raw.enabled,
      watch: raw.watch,
    });
  }

  const discovery = value.discovery;
  assertExactKeys(discovery, ["roots", "ignore", "autoEnroll"], `${sourcePath}: discovery`);
  if (!Array.isArray(discovery.roots)) {
    throw new Error(`${sourcePath}: discovery.roots must be an array`);
  }
  if (!Array.isArray(discovery.ignore)) {
    throw new Error(`${sourcePath}: discovery.ignore must be an array`);
  }
  if (discovery.autoEnroll !== false) {
    throw new Error(`${sourcePath}: discovery.autoEnroll must be false`);
  }
  const roots: string[] = [];
  for (const [index, raw] of discovery.roots.entries()) {
    assertAbsolutePath(raw, `${sourcePath}: discovery.roots[${index}]`);
    roots.push(await bestEffortPhysicalPath(raw));
  }
  const ignore: string[] = [];
  for (const [index, raw] of discovery.ignore.entries()) {
    assertNonEmptyString(raw, `${sourcePath}: discovery.ignore[${index}]`);
    ignore.push(raw);
  }

  assertUnique(controllers.map((entry) => entry.id), "controller id", sourcePath);
  assertUnique(controllers.map((entry) => entry.config), "controller config path", sourcePath);
  await assertUniqueExistingNodes(
    controllers.map((entry) => entry.config),
    "controller config path",
    sourcePath,
  );
  assertUnique(roots, "discovery root", sourcePath);
  assertUnique(ignore, "discovery ignore pattern", sourcePath);
  return {
    schemaVersion: 1,
    controllers,
    discovery: { roots, ignore, autoEnroll: false },
  };
}

async function loadCanonicalProject(input: string): Promise<LoadedProject> {
  const discovered = await loadProject(input);
  const configPath = await resolvePhysicalPath(discovered.configPath);
  return configPath === discovered.configPath
    ? discovered
    : loadProject(configPath);
}

async function assertFootprintsSeparate(
  left: ControllerFootprint,
  right: ControllerFootprint,
): Promise<void> {
  if (await pathsOverlap(left.store, right.store)) {
    throwOverlap(left, "canonical store", left.store, right, "canonical store", right.store);
  }
  if (await pathsOverlap(left.config, right.store)) {
    throwOverlap(left, "controller config", left.config, right, "canonical store", right.store);
  }
  if (await pathsOverlap(left.store, right.config)) {
    throwOverlap(left, "canonical store", left.store, right, "controller config", right.config);
  }
  for (const watched of right.watched) {
    if (await pathsOverlap(left.config, watched.path)) {
      throwOverlap(
        left,
        "controller config",
        left.config,
        right,
        `${watched.target} native path`,
        watched.path,
      );
    }
    if (await pathsOverlap(left.store, watched.path)) {
      throwOverlap(
        left,
        "canonical store",
        left.store,
        right,
        `${watched.target} native path`,
        watched.path,
      );
    }
  }
  for (const watched of left.watched) {
    if (await pathsOverlap(watched.path, right.config)) {
      throwOverlap(
        left,
        `${watched.target} native path`,
        watched.path,
        right,
        "controller config",
        right.config,
      );
    }
    if (await pathsOverlap(watched.path, right.store)) {
      throwOverlap(
        left,
        `${watched.target} native path`,
        watched.path,
        right,
        "canonical store",
        right.store,
      );
    }
  }
  for (const leftWatched of left.watched) {
    for (const rightWatched of right.watched) {
      if (await pathsOverlap(leftWatched.path, rightWatched.path)) {
        throwOverlap(
          left,
          `${leftWatched.target} native path`,
          leftWatched.path,
          right,
          `${rightWatched.target} native path`,
          rightWatched.path,
        );
      }
    }
  }
}

async function mutateRegistry<T>(
  registryPath: string,
  operation: (
    registry: ControllerRegistry,
  ) => Promise<{ registry: ControllerRegistry; value: T }>,
): Promise<T> {
  const absolutePath = resolve(registryPath);
  const release = await acquireLock(`${absolutePath}.lock`);
  try {
    const before = await readTextIfExists(absolutePath);
    const registry = await loadRegistry(absolutePath);
    const result = await operation(registry);
    if ((await readTextIfExists(absolutePath)) !== before) {
      throw new Error(
        `controller registry changed during mutation: ${absolutePath}`,
      );
    }
    const normalized = await normalizeRegistry(result.registry, absolutePath);
    await writeRegistryUnlocked(normalized, absolutePath);
    return result.value;
  } finally {
    await release();
  }
}

async function writeRegistryUnlocked(
  registry: ControllerRegistry,
  absolutePath: string,
): Promise<void> {
  await writeTextAtomic(
    absolutePath,
    stringifyYaml(registry, { lineWidth: 0 }),
  );
}

function throwOverlap(
  left: ControllerFootprint,
  leftKind: string,
  leftPath: string,
  right: ControllerFootprint,
  rightKind: string,
  rightPath: string,
): never {
  throw new Error(
    `controller paths overlap: ${left.controller.id} ${leftKind} ${leftPath} and ` +
      `${right.controller.id} ${rightKind} ${rightPath}`,
  );
}

async function pathsOverlap(left: string, right: string): Promise<boolean> {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    isContained(leftToRight) ||
    isContained(rightToLeft) ||
    (await sameExistingNode(left, right))
  );
}

function isContained(value: string): boolean {
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expectedSet.has(key));
  const missing = expected.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown.length > 0) {
    throw new Error(`${context} contains unknown field: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`${context} is missing required field: ${missing.join(", ")}`);
  }
}

function assertControllerId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !isControllerId(value)) {
    throw new Error(
      `${context} must be 1-128 characters using letters, numbers, dot, underscore, or hyphen`,
    );
  }
}

function assertAbsolutePath(value: unknown, context: string): asserts value is string {
  assertNonEmptyString(value, context);
  if (!isAbsolute(value)) throw new Error(`${context} must be an absolute path`);
}

function assertNonEmptyString(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${context} must be a non-empty string without surrounding whitespace`);
  }
}

function assertUnique(values: readonly string[], label: string, sourcePath: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${sourcePath}: duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

async function assertUniqueExistingNodes(
  paths: readonly string[],
  label: string,
  sourcePath: string,
): Promise<void> {
  const identities = new Map<string, string>();
  for (const path of paths) {
    const identity = await existingNodeIdentity(path);
    if (!identity) continue;
    const previous = identities.get(identity);
    if (previous !== undefined) {
      throw new Error(
        `${sourcePath}: duplicate ${label}: ${path} is the same filesystem object as ${previous}`,
      );
    }
    identities.set(identity, path);
  }
}

async function sameExistingNode(left: string, right: string): Promise<boolean> {
  const [leftIdentity, rightIdentity] = await Promise.all([
    existingNodeIdentity(left),
    existingNodeIdentity(right),
  ]);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

async function existingNodeIdentity(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function bestEffortPhysicalPath(path: string): Promise<string> {
  try {
    return await resolvePhysicalPath(path);
  } catch (error) {
    // A broken symlink can be a temporarily offline mount/controller. Preserve
    // its absolute lexical identity so it remains visible and removable.
    if (errorMessage(error).includes("broken symlink")) return resolve(path);
    throw error;
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  allowZero: boolean,
): number {
  const result = value ?? fallback;
  if (
    !Number.isSafeInteger(result) ||
    result < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return result;
}

type GlobMatcher = RegExp;

function compileGlob(rawPattern: string): GlobMatcher {
  const pattern = normalizeSlashes(rawPattern);
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`${source}$`, "u");
}

function isIgnored(
  relativePath: string,
  absolutePath: string,
  directory: boolean,
  matchers: readonly GlobMatcher[],
): boolean {
  const absolute = normalizeSlashes(absolutePath);
  const suffix = directory ? "/" : "";
  return matchers.some(
    (matcher) =>
      matcher.test(relativePath) ||
      matcher.test(`${relativePath}${suffix}`) ||
      matcher.test(absolute) ||
      matcher.test(`${absolute}${suffix}`),
  );
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(value) ? `\\${value}` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
