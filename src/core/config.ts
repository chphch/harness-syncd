import { access, lstat, readFile } from "node:fs/promises";
import { normalizeSecretAllowlist } from "./secret-allowlist.js";
import { normalizeHookScripts } from "./hook-scripts.js";
import { normalizeOutputStyles } from "./output-styles.js";
import { normalizeScripts, normalizeWorkflows } from "./named-files.js";
import { normalizeCarry } from "./carry-entry.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  CanonicalHarness,
  ProjectConfig,
  Scope,
  TargetName,
  TargetOverlay,
} from "../types.js";
import { TARGET_NAMES } from "../types.js";
import { isRecord } from "./frontmatter.js";
import { pathExists, writeTextAtomic, writeTextAtomicInside } from "./fs.js";

export const PROJECT_CONFIG_NAME = "harness-sync.yaml";
export const HARNESS_FILE_NAME = "harness.yaml";

export function isControllerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

export function defaultProjectConfig(scope: Scope = "project"): ProjectConfig {
  return {
    schemaVersion: 1,
    scope,
    store:
      scope === "project"
        ? ".harness-sync"
        : join(homedir(), ".config", "harness-sync", "store"),
    targets: {
      claude: { enabled: true },
      codex: { enabled: true },
      antigravity: { enabled: true },
    },
    sync: {
      debounceMs: 250,
      auditIntervalMs: 30_000,
      linkMode: "symlink",
      onConflict: "stop",
      backupRetention: 200,
    },
    git: {
      enabled: false,
      autoPush: false,
      backupIntervalMs: 0,
      branch: "main",
      remote: "origin",
    },
  };
}

export function defaultHarness(name: string): CanonicalHarness {
  return {
    schemaVersion: 1,
    metadata: { name },
    instructions: { root: "instructions/root.md" },
    rules: [],
    skills: [],
    commands: {},
    agents: {},
    mcpServers: {},
    permissions: {},
    hooks: {},
    overlays: {
      claude: {},
      codex: {},
      antigravity: {},
    },
  };
}

export async function findProjectConfig(start: string): Promise<string | null> {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, PROJECT_CONFIG_NAME);
    if (await pathExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  await assertRegularControlFile(path, "project controller");
  const parsed: unknown = parseYaml(await readFile(path, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`${path}: expected schemaVersion: 1`);
  }
  if (
    parsed.scope !== undefined &&
    parsed.scope !== "project" &&
    parsed.scope !== "user"
  ) {
    throw new Error(`${path}: scope must be project or user`);
  }
  if (
    parsed.controllerId !== undefined &&
    (typeof parsed.controllerId !== "string" ||
      !isControllerId(parsed.controllerId))
  ) {
    throw new Error(
      `${path}: controllerId must be 1-128 characters using letters, numbers, dot, underscore, or hyphen`,
    );
  }
  assertOptionalConfigType(parsed, "store", (value) => typeof value === "string", path);
  assertOptionalConfigType(parsed, "targets", isRecord, path);
  assertOptionalConfigType(parsed, "sync", isRecord, path);
  assertOptionalConfigType(parsed, "git", isRecord, path);
  assertOptionalConfigType(parsed, "carry", isRecord, path);
  const defaults = defaultProjectConfig(
    parsed.scope === "user" ? "user" : "project",
  );
  const targets = { ...defaults.targets };
  if (isRecord(parsed.targets)) {
    for (const target of TARGET_NAMES) {
      const value = parsed.targets[target];
      if (value !== undefined && !isRecord(value)) {
        throw new Error(`${path}: targets.${target} must be an object`);
      }
      if (isRecord(value)) {
        if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
          throw new Error(`${path}: targets.${target}.enabled must be a boolean`);
        }
        if (value.root !== undefined && (typeof value.root !== "string" || value.root.length === 0)) {
          throw new Error(`${path}: targets.${target}.root must be a non-empty string`);
        }
        targets[target] = {
          enabled: value.enabled !== false,
          ...(typeof value.root === "string" ? { root: value.root } : {}),
        };
      }
    }
  }

  const sync = isRecord(parsed.sync) ? parsed.sync : {};
  const git = isRecord(parsed.git) ? parsed.git : {};
  assertOptionalFiniteNumber(sync, "debounceMs", path, "sync");
  assertOptionalFiniteNumber(sync, "auditIntervalMs", path, "sync");
  assertOptionalFiniteNumber(sync, "backupRetention", path, "sync");
  if (
    sync.backupRetention !== undefined &&
    (!Number.isInteger(sync.backupRetention) || (sync.backupRetention as number) < 1)
  ) {
    throw new Error(`${path}: sync.backupRetention must be an integer of at least 1`);
  }
  if (
    sync.linkMode !== undefined &&
    sync.linkMode !== "symlink" &&
    sync.linkMode !== "copy"
  ) {
    throw new Error(`${path}: sync.linkMode must be symlink or copy`);
  }
  if (
    sync.onConflict !== undefined &&
    sync.onConflict !== "stop" &&
    sync.onConflict !== "prefer-canonical"
  ) {
    throw new Error(`${path}: sync.onConflict must be stop or prefer-canonical`);
  }
  assertOptionalFiniteNumber(git, "backupIntervalMs", path, "git");
  for (const key of ["enabled", "autoPush"] as const) {
    if (git[key] !== undefined && typeof git[key] !== "boolean") {
      throw new Error(`${path}: git.${key} must be a boolean`);
    }
  }
  for (const key of ["branch", "remote"] as const) {
    if (git[key] !== undefined && (typeof git[key] !== "string" || git[key].length === 0)) {
      throw new Error(`${path}: git.${key} must be a non-empty string`);
    }
  }
  return {
    ...defaults,
    ...(typeof parsed.controllerId === "string"
      ? { controllerId: parsed.controllerId }
      : {}),
    store: typeof parsed.store === "string" ? parsed.store : defaults.store,
    targets,
    sync: {
      debounceMs: numberOr(sync.debounceMs, defaults.sync.debounceMs),
      auditIntervalMs: numberOr(
        sync.auditIntervalMs,
        defaults.sync.auditIntervalMs,
      ),
      linkMode: sync.linkMode === "copy" ? "copy" : "symlink",
      onConflict:
        sync.onConflict === "prefer-canonical"
          ? "prefer-canonical"
          : "stop",
      backupRetention: numberOr(
        sync.backupRetention,
        defaults.sync.backupRetention,
      ),
    },
    git: {
      enabled: git.enabled === true,
      autoPush: git.autoPush === true,
      backupIntervalMs: numberOr(git.backupIntervalMs, defaults.git.backupIntervalMs),
      branch: stringOr(git.branch, defaults.git.branch),
      remote: stringOr(git.remote, defaults.git.remote),
    },
    // Conditional, so a config that never mentions carry is written back
    // unchanged; and `=== true`, so no truthy spelling ("true", "yes", 1) can
    // switch capture on by accident. A flag that opts IN to touching files
    // outside the store gets the strict compare.
    ...(isRecord(parsed.carry) ? { carry: { enabled: parsed.carry.enabled === true } } : {}),
  };
}

export async function writeProjectConfig(
  path: string,
  config: ProjectConfig,
): Promise<void> {
  await writeTextAtomic(path, stringifyYaml(config, { lineWidth: 0 }));
}

export function resolveStoreDir(configPath: string, config: ProjectConfig): string {
  return isAbsolute(config.store)
    ? config.store
    : resolve(dirname(configPath), config.store);
}

export function resolveTargetRoot(
  configPath: string,
  config: ProjectConfig,
  target: TargetName,
): string {
  const configured = config.targets[target].root;
  if (configured) {
    return isAbsolute(configured)
      ? configured
      : resolve(dirname(configPath), configured);
  }
  if (config.scope === "project") return dirname(configPath);

  switch (target) {
    case "claude":
      return join(homedir(), ".claude");
    case "codex":
      return join(homedir(), ".codex");
    case "antigravity":
      return join(homedir(), ".gemini");
  }
}

export async function loadHarness(storeDir: string): Promise<CanonicalHarness> {
  const path = join(storeDir, HARNESS_FILE_NAME);
  await assertRegularControlFile(path, "canonical manifest");
  const parsed: unknown = parseYaml(await readFile(path, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`${path}: expected schemaVersion: 1`);
  }
  return normalizeHarness(parsed, storeDir);
}

async function assertRegularControlFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${path}: ${label} must be a regular file, not a symlink`);
  }
}

export async function writeHarness(
  storeDir: string,
  harness: CanonicalHarness,
): Promise<void> {
  await writeTextAtomicInside(
    storeDir,
    join(storeDir, HARNESS_FILE_NAME),
    stringifyYaml(harness, { lineWidth: 0 }),
  );
}

export async function assertReadable(path: string): Promise<void> {
  await access(path);
}

function normalizeHarness(
  value: Record<string, unknown>,
  storeDir: string,
): CanonicalHarness {
  assertRequiredContainer(value, "metadata", isRecord, "an object");
  assertRequiredContainer(value, "instructions", isRecord, "an object");
  assertRequiredContainer(value, "rules", Array.isArray, "an array");
  assertRequiredContainer(value, "skills", Array.isArray, "an array");
  for (const key of [
    "commands",
    "agents",
    "mcpServers",
    "permissions",
    "hooks",
    "overlays",
  ] as const) {
    assertRequiredContainer(value, key, isRecord, "an object");
  }
  const fallback = defaultHarness(storeDir.split("/").at(-1) ?? "harness");
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const instructions = isRecord(value.instructions) ? value.instructions : {};
  const overlays = isRecord(value.overlays) ? value.overlays : {};
  if (typeof metadata.name !== "string") {
    throw new Error("Invalid harness.metadata.name: expected a string");
  }
  if (metadata.description !== undefined && typeof metadata.description !== "string") {
    throw new Error("Invalid harness.metadata.description: expected a string");
  }
  if (typeof instructions.root !== "string") {
    throw new Error("Invalid harness.instructions.root: expected a string");
  }
  for (const target of TARGET_NAMES) {
    // Type-check only. A store written by a binary that knows more targets must
    // still load here, so a MISSING overlay is defaulted below rather than
    // rejected; only a present-but-wrong-shape one is an error.
    if (overlays[target] !== undefined && !isRecord(overlays[target])) {
      throw new Error(`Invalid harness.overlays.${target}: expected an object`);
    }
  }
  return {
    ...fallback,
    metadata: {
      name: stringOr(metadata.name, fallback.metadata.name),
      ...(typeof metadata.description === "string"
        ? { description: metadata.description }
        : {}),
    },
    instructions: {
      root: stringOr(instructions.root, fallback.instructions.root),
    },
    rules: Array.isArray(value.rules)
      ? (value.rules as CanonicalHarness["rules"])
      : [],
    skills: Array.isArray(value.skills)
      ? (value.skills as CanonicalHarness["skills"])
      : [],
    commands: isRecord(value.commands)
      ? (value.commands as CanonicalHarness["commands"])
      : {},
    agents: isRecord(value.agents)
      ? (value.agents as CanonicalHarness["agents"])
      : {},
    mcpServers: isRecord(value.mcpServers)
      ? (value.mcpServers as CanonicalHarness["mcpServers"])
      : {},
    permissions: isRecord(value.permissions)
      ? (value.permissions as CanonicalHarness["permissions"])
      : {},
    hooks: isRecord(value.hooks)
      ? (value.hooks as CanonicalHarness["hooks"])
      : {},
    // Absent stays absent: writing `secretAllowlist: []` back would change the
    // canonical bytes of every store that never used the feature.
    ...(value.secretAllowlist === undefined
      ? {}
      : { secretAllowlist: normalizeSecretAllowlist(value.secretAllowlist) }),
    // Absent stays absent, exactly as secretAllowlist above. Without this the
    // key is erased on the first load->write cycle and the next apply prunes
    // every projected script — the feature would delete its own output.
    ...(value.hookScripts === undefined
      ? {}
      : { hookScripts: normalizeHookScripts(value.hookScripts) }),
    ...(value.outputStyles === undefined
      ? {}
      : { outputStyles: normalizeOutputStyles(value.outputStyles) }),
    ...(value.scripts === undefined ? {} : { scripts: normalizeScripts(value.scripts) }),
    ...(value.workflows === undefined ? {} : { workflows: normalizeWorkflows(value.workflows) }),
    ...(value.carry === undefined ? {} : { carry: normalizeCarry(value.carry) }),
    // The spread carries an overlay for a target this binary does not know
    // through a load/write cycle instead of deleting it; the TARGET_NAMES
    // rebuild keeps `Record<TargetName, TargetOverlay>` true at runtime, which
    // validate.ts dereferences without optional chaining. Do not re-hardcode
    // the three names here — that is what a fourth target would have to edit.
    overlays: {
      ...(overlays as Record<string, TargetOverlay>),
      ...Object.fromEntries(
        TARGET_NAMES.map((target) => [
          target,
          isRecord(overlays[target]) ? overlays[target] : {},
        ]),
      ),
    } as Record<TargetName, TargetOverlay>,
  };
}

function assertRequiredContainer(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
  expected: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(value, key) || !predicate(value[key])) {
    throw new Error(`Invalid harness.${key}: expected ${expected}`);
  }
}

function assertOptionalConfigType(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
  path: string,
): void {
  if (value[key] !== undefined && !predicate(value[key])) {
    throw new Error(`${path}: ${key} has an invalid type`);
  }
}

function assertOptionalFiniteNumber(
  value: Record<string, unknown>,
  key: string,
  path: string,
  section: string,
): void {
  const candidate = value[key];
  if (
    candidate !== undefined &&
    (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)
  ) {
    throw new Error(`${path}: ${section}.${key} must be a non-negative number`);
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
