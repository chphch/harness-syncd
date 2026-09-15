#!/usr/bin/env node

import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  TARGET_NAMES,
  type ApplyResult,
  type CanonicalHarness,
  type LinkMode,
  type Scope,
  type TargetName,
} from "./types.js";
import { getAdapter } from "./adapters/index.js";
import {
  isControllerId,
  loadHarness,
  writeProjectConfig,
} from "./core/config.js";
import { assertSecretScan, canonicalGitPaths } from "./core/backup.js";
import { watchProject } from "./core/daemon.js";
import {
  connectRemote,
  getGitStatus,
  initStoreGit,
  syncGitStore,
} from "./core/git.js";
import { migrateFrom } from "./core/migrate.js";
import {
  adapterContext,
  applyHarness,
  createControllerId,
  enabledTargets,
  initializeProject,
  loadProject,
  type LoadedProject,
} from "./core/project.js";
import {
  addController,
  DEFAULT_REGISTRY_PATH,
  discoverControllers,
  listControllers,
  removeController,
  updateController,
} from "./core/registry.js";
import { establishBaseline, reconcileOnce } from "./core/reconcile.js";
import { scanStoreForSecrets } from "./core/secret-scan.js";
import {
  partitionByAllowlist,
  type AllowlistPartition,
  type SecretAllowlistEntry,
} from "./core/secret-allowlist.js";
import { hashCanonical, readState } from "./core/state.js";
import { acquireLock, pathExists } from "./core/fs.js";
import { driftedManagedPaths } from "./core/writer.js";
import { validateHarness } from "./core/validate.js";
import { CARRY_STORE_PREFIX } from "./core/carry-entry.js";
import { carrySummary, registerCarryCommands } from "./cli-carry.js";
import {
  statusAllControllers,
  syncAllControllers,
  watchAllControllers,
  type FleetWatchEvent,
} from "./core/supervisor.js";

const program = new Command();

program
  .name("harness-sync")
  .description(
    "Local-first harness sync for Claude Code, Codex, and Antigravity",
  )
  .version("0.2.0")
  .option("-C, --cwd <path>", "project directory", process.cwd())
  .option(
    "--registry <path>",
    "machine-local multi-controller registry",
    DEFAULT_REGISTRY_PATH,
  )
  .option("--json", "print machine-readable JSON");

program
  .command("init")
  .description("create a canonical harness store and project config")
  .addOption(
    new Option("--scope <scope>", "configuration scope")
      .choices(["project", "user"])
      .default("project"),
  )
  .option("--store <path>", "canonical store path")
  .option("--id <id>", "stable controller identity")
  .option("--register", "enroll this controller in the machine registry")
  .action(async (options: {
    scope: Scope;
    store?: string;
    id?: string;
    register?: boolean;
  }) => {
    const project = await initializeProject(cwd(), {
      scope: options.scope,
      ...(options.store ? { store: options.store } : {}),
      ...(options.id !== undefined ? { controllerId: options.id } : {}),
    });
    const controllerId = await ensureControllerIdentity(project, options.id);
    const registered = options.register
      ? await addController(project.configPath, {
          registryPath: registryPath(),
        })
      : undefined;
    print({
      initialized: true,
      config: project.configPath,
      store: project.storeDir,
      scope: project.config.scope,
      controllerId,
      ...(registered ? { registered } : {}),
    });
  });

const manage = program
  .command("manage")
  .description("manage the machine-local controller registry");

manage
  .command("add")
  .description("explicitly enroll an existing controller")
  .argument("[path]", "controller file or a directory below it")
  .option("--id <id>", "set an identity on a legacy controller before enrolling")
  .option("--disabled", "enroll without enabling fleet operations")
  .option("--no-watch", "exclude this controller from watch --all")
  .action(async (
    path: string | undefined,
    options: { id?: string; disabled?: boolean; watch: boolean },
  ) => {
    const project = await loadProject(path ? resolve(path) : cwd());
    await ensureControllerIdentity(project, options.id);
    const controller = await addController(project.configPath, {
      registryPath: registryPath(),
      enabled: options.disabled !== true,
      watch: options.watch,
    });
    print({ registered: true, controller, registry: registryPath() });
  });

manage
  .command("list")
  .description("list enrolled controllers, including offline entries")
  .action(async () => {
    const controllers = (await listControllers(registryPath())).map(
      serializeListedController,
    );
    print({ registry: registryPath(), controllers });
    if (
      controllers.some(
        (entry) =>
          entry.enabled && (entry.status === "missing" || entry.status === "invalid"),
      )
    ) {
      process.exitCode = 2;
    }
  });

manage
  .command("remove")
  .description("unenroll a controller without deleting its files or store")
  .argument("<id>", "controller identity")
  .action(async (id: string) => {
    const controller = await removeController(id, registryPath());
    print({ registered: false, controller, registry: registryPath() });
  });

manage
  .command("set")
  .description("change enabled/watch flags for an enrolled controller")
  .argument("<id>", "controller identity")
  .addOption(
    new Option("--enabled <value>", "participate in fleet operations")
      .choices(["true", "false"]),
  )
  .addOption(
    new Option("--watch <value>", "participate in watch --all")
      .choices(["true", "false"]),
  )
  .action(async (
    id: string,
    options: { enabled?: "true" | "false"; watch?: "true" | "false" },
  ) => {
    if (options.enabled === undefined && options.watch === undefined) {
      throw new Error("manage set requires --enabled and/or --watch");
    }
    const controller = await updateController(
      id,
      {
        ...(options.enabled !== undefined
          ? { enabled: options.enabled === "true" }
          : {}),
        ...(options.watch !== undefined
          ? { watch: options.watch === "true" }
          : {}),
      },
      registryPath(),
    );
    print({ updated: true, controller, registry: registryPath() });
  });

manage
  .command("discover")
  .description("find valid controller markers without enrolling them")
  .argument("[roots...]", "bounded roots to scan")
  .option("--max-depth <count>", "maximum directory depth", parseNonNegativeInteger)
  .option("--max-entries <count>", "maximum entries to inspect", parsePositiveInteger)
  .option("--max-results <count>", "maximum controllers to return", parsePositiveInteger)
  .action(async (
    roots: string[],
    options: { maxDepth?: number; maxEntries?: number; maxResults?: number },
  ) => {
    const controllers = await discoverControllers({
      registryPath: registryPath(),
      ...(roots.length > 0 ? { roots: roots.map((root) => resolve(root)) } : {}),
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(options.maxEntries !== undefined
        ? { maxEntries: options.maxEntries }
        : {}),
      ...(options.maxResults !== undefined
        ? { maxResults: options.maxResults }
        : {}),
    });
    print({ registry: registryPath(), mutated: false, controllers });
  });

program
  .command("migrate")
  .description("discover and import a native harness (dry-run by default)")
  .argument("<source>", "claude, codex, or antigravity")
  .option("--apply", "write the migration into the canonical store")
  .option("--install", "also install projections/links after --apply")
  .option("--force", "back up and replace occupied projection paths")
  .option("--include-local", "capture local-only settings as a non-projected overlay")
  .addOption(
    new Option(
      "--exclude-skill <name>",
      "drop a native skill directory from the import by name, before it is opened; repeatable",
    ).argParser((value: string, previous: string[] = []) => [...previous, value])
      .default([] as string[]),
  )
  .action(
    async (
      sourceValue: string,
      options: {
        apply?: boolean;
        install?: boolean;
        force?: boolean;
        includeLocal?: boolean;
        excludeSkill?: string[];
      },
    ) => {
      const source = parseTarget(sourceValue);
      const project = await loadProject(cwd());
      if (options.install && !options.apply) {
        throw new Error("--install requires --apply");
      }
      const release = options.apply
        ? await acquireLock(join(project.storeDir, ".lock"))
        : null;
      try {
        const result = await migrateFrom(project, source, {
          apply: options.apply === true,
          install: options.install === true,
          force: options.force === true,
          includeLocal: options.includeLocal === true,
          excludeSkills: options.excludeSkill ?? [],
        });
        print(result);
        if (result.projections.some((projection) => projection.skipped.length > 0)) {
          process.exitCode = 2;
        }
      } finally {
        if (release) await release();
      }
    },
  );

program
  .command("apply")
  .description("project the canonical harness into enabled native targets")
  .option("--dry-run", "show writes without changing native files")
  .option("--force", "back up and replace occupied native paths")
  .action(async (options: { dryRun?: boolean; force?: boolean }) => {
    const project = await loadProject(cwd());
    const release = await acquireLock(join(project.storeDir, ".lock"));
    try {
      const results = await runApply(project, {
        dryRun: options.dryRun === true,
        force: options.force === true,
      });
      print({ dryRun: options.dryRun === true, results });
      if (results.some((result) => result.skipped.length > 0)) process.exitCode = 2;
    } finally {
      await release();
    }
  });

program
  .command("link-mode")
  .description("read or change how the harness is projected: symlink or copy")
  .argument("[mode]", "symlink or copy; omit to read the current value")
  .option("--dry-run", "show the reprojection without writing the config")
  .option("--no-apply", "write the config but leave reprojection to the next apply")
  .option("--force", "back up and replace occupied native paths")
  .action(
    async (
      mode: string | undefined,
      options: { dryRun?: boolean; apply?: boolean; force?: boolean },
    ) => {
      const project = await loadProject(cwd());
      const previous = project.config.sync.linkMode;
      if (mode === undefined) {
        print({ linkMode: previous, config: project.configPath });
        return;
      }
      const next = parseLinkMode(mode);
      // The store lock doubles as the daemon gate: it is held for the daemon's
      // whole lifetime, so acquiring it fails while the fleet is up.
      const release = await acquireLock(join(project.storeDir, ".lock"));
      try {
        if (next === previous && options.force !== true) {
          print({ linkMode: next, previous, changed: false });
          return;
        }
        const conflict = join(project.storeDir, "conflicts", "current.json");
        if (await pathExists(conflict)) {
          throw new Error(
            `unresolved conflict at ${conflict}; run \`harness-sync sync\` before changing link mode`,
          );
        }
        if (options.force !== true) {
          const drifted = await driftedManagedPaths(project.storeDir);
          if (drifted.length > 0) {
            throw new Error(
              `managed projections changed outside harness-sync; reconcile or pass --force: ${drifted.join(", ")}`,
            );
          }
        }
        project.config.sync.linkMode = next;
        if (options.dryRun !== true) {
          await writeProjectConfig(project.configPath, project.config);
        }
        const results = options.apply === false
          ? []
          : await runApply(project, {
            dryRun: options.dryRun === true,
            force: options.force === true,
          });
        print({
          linkMode: next,
          previous,
          changed: true,
          dryRun: options.dryRun === true,
          results,
        });
        if (results.some((result) => result.skipped.length > 0)) process.exitCode = 2;
      } finally {
        await release();
      }
    },
  );

program
  .command("sync")
  .description("perform one hash-based bidirectional reconciliation")
  .option("--all", "reconcile every enabled registered controller")
  .option("--concurrency <count>", "maximum parallel controllers", parsePositiveInteger)
  .action(async (options: { all?: boolean; concurrency?: number }) => {
    if (options.all) {
      assertNoCwdWithAll();
      const result = await syncAllControllers(registryPath(), {
        ...(options.concurrency !== undefined
          ? { concurrency: options.concurrency }
          : {}),
      });
      print(result);
      if (result.summary.errors > 0) process.exitCode = 1;
      else if (result.summary.conflicts > 0) process.exitCode = 2;
      return;
    }
    if (options.concurrency !== undefined) {
      throw new Error("--concurrency requires --all");
    }
    const result = await reconcileOnce(await loadProject(cwd()));
    print(result);
    if (result.action === "conflict") process.exitCode = 2;
  });

program
  .command("watch")
  .description("run the foreground reconciliation daemon")
  .option("--all", "watch every enabled registered controller with watch enabled")
  .action(async (options: { all?: boolean }) => {
    if (options.all) assertNoCwdWithAll();
    const signals = processAbortController();
    try {
      if (options.all) {
        printEvent({ watching: "all", registry: registryPath() });
        await watchAllControllers({
          registryPath: registryPath(),
          signal: signals.controller.signal,
          onEvent: (event) => {
            if (event.type !== "result" || event.result.action !== "noop") {
              printFleetWatchEvent(event);
            }
          },
        });
        return;
      }
      const project = await loadProject(cwd());
      print({
        watching: project.projectRoot,
        auditIntervalMs: project.config.sync.auditIntervalMs,
      });
      await watchProject(project, {
        signal: signals.controller.signal,
        onResult: (result) => {
          if (result.action !== "noop") print(result);
        },
        onError: (error) => process.stderr.write(`${error.message}\n`),
      });
    } finally {
      signals.dispose();
    }
  });

program
  .command("status")
  .description("show configured targets and the latest reconciliation state")
  .option("--all", "show every registered controller, including offline entries")
  .action(async (options: { all?: boolean }) => {
    if (options.all) {
      assertNoCwdWithAll();
      const result = await statusAllControllers(registryPath());
      print(result);
      if (result.summary.degraded > 0) process.exitCode = 2;
      return;
    }
    const project = await loadProject(cwd());
    const targets = await Promise.all(
      enabledTargets(project).map(async (target) => ({
        target,
        root: adapterContext(project, target).targetRoot,
        fingerprint: await getAdapter(target).fingerprint(
          adapterContext(project, target),
        ),
      })),
    );
    print({
      config: project.configPath,
      store: project.storeDir,
      scope: project.config.scope,
      targets,
      state: await readState(project.storeDir),
      git: await getGitStatus(project.storeDir),
      carry: await carrySummary(project),
    });
  });

registerCarryCommands(program, { cwd, print });

const git = program.command("git").description("manage the personal Git-backed canonical store");

git
  .command("init")
  .description("initialize the canonical store as an independent Git repository")
  .option("--branch <name>", "sync branch")
  .action(async (options: { branch?: string }) => {
    const project = await loadProject(cwd());
    const release = await acquireLock(join(project.storeDir, ".lock"));
    try {
      const branch = options.branch ?? project.config.git.branch;
      const status = await initStoreGit(project.storeDir, branch);
      project.config.git.enabled = true;
      project.config.git.branch = branch;
      await writeProjectConfig(project.configPath, project.config);
      print(status);
    } finally {
      await release();
    }
  });

git
  .command("connect")
  .description("connect the canonical store to a personal/private Git remote")
  .argument("<url>", "SSH or HTTPS Git remote URL")
  .option("--remote <name>", "remote name")
  .action(async (url: string, options: { remote?: string }) => {
    const project = await loadProject(cwd());
    const release = await acquireLock(join(project.storeDir, ".lock"));
    try {
      const remote = options.remote ?? project.config.git.remote;
      const result = await connectRemote(project.storeDir, url, remote);
      project.config.git.enabled = true;
      project.config.git.remote = remote;
      await writeProjectConfig(project.configPath, project.config);
      print(result);
    } finally {
      await release();
    }
  });

git
  .command("status")
  .description("show canonical store Git status")
  .action(async () => {
    const project = await loadProject(cwd());
    print(await getGitStatus(project.storeDir));
  });

git
  .command("sync")
  .description("commit and fetch; optionally accept remote changes and push")
  .option("--push", "push after a successful reviewed sync")
  .option(
    "--accept-remote <commit>",
    "integrate one exact, previously fetched and reviewed commit",
  )
  .option("-m, --message <message>", "commit message")
  .option("--allow-secrets", "override the built-in secret scan")
  .option(
    "--allow-carry-removal",
    "accept a reviewed commit that deletes carried files that may be their only copy",
  )
  .action(
    async (options: {
      push?: boolean;
      message?: string;
      allowSecrets?: boolean;
      acceptRemote?: string;
      allowCarryRemoval?: boolean;
    }) => {
      const project = await loadProject(cwd());
      const release = await acquireLock(join(project.storeDir, ".lock"));
      try {
        const existingState = await readState(project.storeDir);
        const before = existingState
          ? await reconcileOnce(project, { lock: false })
          : null;
        if (before?.action === "conflict") {
          throw new Error("Native/canonical conflict must be resolved before Git sync");
        }
        const localHarness = await loadHarness(project.storeDir);
        await validateHarness(project.storeDir, localHarness);
        const allowlist = localHarness.secretAllowlist ?? [];
        const secretScan = await assertSecretScan(
          project.storeDir,
          options.allowSecrets === true,
          allowlist,
        );
        const validateGitCandidate = async (candidateStoreDir: string) => {
          const candidateHarness = await loadHarness(candidateStoreDir);
          await validateHarness(candidateStoreDir, candidateHarness);
          // Deliberately the LIVE allowlist, not the candidate's: a fetched
          // commit must not be able to carry both a new secret and its own
          // approval for it.
          await assertSecretScan(
            candidateStoreDir,
            options.allowSecrets === true,
            allowlist,
          );
        };
        const gitResult = await syncGitStore(project.storeDir, {
          branch: project.config.git.branch,
          remote: project.config.git.remote,
          push: options.push === true || project.config.git.autoPush,
          ...(options.acceptRemote ? { acceptRemote: options.acceptRemote } : {}),
          requiredPaths: canonicalGitPaths(localHarness),
          // carry is NOT in requiredPaths — see the comment on canonicalGitPaths.
          // It is protected on the way IN instead: a reviewed commit that drops
          // a carried file is refused, because Git applies that deletion
          // silently and the store copy may be the only one.
          ...(localHarness.carry === undefined || localHarness.carry.length === 0
            ? {}
            : {
              protectedPathPrefixes: [CARRY_STORE_PREFIX],
              ...(options.allowCarryRemoval === true ? { allowProtectedRemoval: true } : {}),
            }),
          validateCandidate: validateGitCandidate,
          afterIntegrate: () => validateGitCandidate(project.storeDir),
          ...(options.message ? { commitMessage: options.message } : {}),
        });
        print({
          git: gitResult,
          secretScan: {
            blocked: secretScan.blocking.length,
            allowlisted: secretScan.allowed.length,
            staleEntries: secretScan.stale,
            ...(options.allowSecrets === true && secretScan.blocking.length > 0
              ? { bypassedByFlag: secretScan.blocking }
              : {}),
          },
          reconcileBefore: before,
          projectionPending: gitResult.fastForwarded || gitResult.rebased,
          reviewCommand: gitResult.remoteChangesPending && gitResult.reviewCommit
            ? `git -C ${shellArgument(project.storeDir)} diff HEAD...${gitResult.reviewCommit}`
            : undefined,
          acceptCommand: gitResult.remoteChangesPending && gitResult.reviewCommit
            ? `harness-sync -C ${shellArgument(project.projectRoot)} git sync --accept-remote ${gitResult.reviewCommit}`
            : undefined,
        });
      } finally {
        await release();
      }
    },
  );

program
  .command("doctor")
  .description("validate the canonical store and native adapter inputs")
  .action(async () => {
    const project = await loadProject(cwd());
    const harness = await loadHarness(project.storeDir);
    await validateHarness(project.storeDir, harness);
    const findings = await scanStoreForSecrets(project.storeDir);
    const nativeChecks = await Promise.all(
      enabledTargets(project).map(async (target) => {
        try {
          const context = adapterContext(project, target);
          const captured = await getAdapter(target).capture(
            harness,
            {
              ...context,
              canonicalSourceStoreDir: project.storeDir,
            },
            {
              includeLocal: false,
              includeAssets: true,
              write: false,
            },
          );
          return { target, ok: true, warnings: captured.warnings };
        } catch (error) {
          return {
            target,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const nativeOk = nativeChecks.every((check) => check.ok);
    const carry = await carrySummary(project);
    // A legitimately disabled second machine reports `enabled: false` WITHOUT
    // failing doctor — otherwise every second machine fails forever and the
    // signal stops meaning anything. Only a refusal or an unresolved conflict
    // is a failure.
    const carryOk = !isCarryFailing(carry);
    // Findings stay reported in full — an approval changes the verdict, never
    // what the diagnostic shows. A stale entry is its own red flag.
    const partition = partitionByAllowlist(findings, harness.secretAllowlist ?? []);
    print({
      ok: partition.blocking.length === 0 && partition.stale.length === 0 && nativeOk && carryOk,
      node: process.version,
      config: project.configPath,
      store: project.storeDir,
      harness: {
        name: harness.metadata.name,
        skills: harness.skills.length,
        agents: Object.keys(harness.agents).length,
        mcpServers: Object.keys(harness.mcpServers).length,
      },
      nativeChecks,
      carry,
      secretFindings: findings,
      secretAllowlisted: partition.allowed.length,
      secretAllowlistStale: partition.stale,
    });
    if (partition.blocking.length > 0 || partition.stale.length > 0 || !nativeOk || !carryOk) {
      process.exitCode = 2;
    }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`harness-sync: ${message}\n`);
  process.exitCode = 1;
});

function cwd(): string {
  return resolve(program.opts<{ cwd: string }>().cwd);
}

function registryPath(): string {
  return resolve(program.opts<{ registry: string }>().registry);
}

function assertNoCwdWithAll(): void {
  if (program.getOptionValueSource("cwd") === "cli") {
    throw new Error("-C/--cwd cannot be combined with --all; registry enrollment selects controllers");
  }
}

async function ensureControllerIdentity(
  project: LoadedProject,
  requestedId?: string,
): Promise<string> {
  if (requestedId !== undefined && !isControllerId(requestedId)) {
    throw new Error(
      "controller id must be 1-128 characters using letters, numbers, dot, underscore, or hyphen",
    );
  }
  const proposedId =
    requestedId ??
    project.config.controllerId ??
    createControllerId(project.projectRoot);
  const release = await acquireLock(`${project.configPath}.init.lock`);
  try {
    const latest = await loadProject(project.configPath);
    if (latest.config.controllerId) {
      if (
        requestedId !== undefined &&
        latest.config.controllerId !== requestedId
      ) {
        throw new Error(
          `controller identity changed concurrently to ${latest.config.controllerId}`,
        );
      }
      project.config.controllerId = latest.config.controllerId;
      return latest.config.controllerId;
    }
    latest.config.controllerId = proposedId;
    await writeProjectConfig(latest.configPath, latest.config);
    project.config.controllerId = proposedId;
    return proposedId;
  } finally {
    await release();
  }
}

function serializeListedController(
  entry: Awaited<ReturnType<typeof listControllers>>[number],
) {
  if (entry.status !== "online") {
    return {
      id: entry.id,
      config: entry.config,
      enabled: entry.enabled,
      watch: entry.watch,
      status: entry.status,
      error: entry.error,
    };
  }
  return {
    id: entry.id,
    config: entry.config,
    enabled: entry.enabled,
    watch: entry.watch,
    status: entry.status,
    scope: entry.project.config.scope,
    store: entry.project.storeDir,
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("expected a positive integer");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("expected a non-negative integer");
  }
  return parsed;
}

function processAbortController(): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    controller,
    dispose: () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    },
  };
}

function printFleetWatchEvent(event: FleetWatchEvent): void {
  printEvent({ controller: event.id, config: event.configPath, ...event });
}

function printEvent(value: unknown): void {
  if (program.opts<{ json?: boolean }>().json === true) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else {
    print(value);
  }
}

function shellArgument(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}



/** The apply pipeline shared by `apply` and `link-mode`. The caller owns the
 * store lock — acquireLock is not re-entrant. */
async function runApply(
  project: LoadedProject,
  options: { dryRun: boolean; force: boolean },
): Promise<ApplyResult[]> {
  const harness = await loadHarness(project.storeDir);
  const expectedCanonicalHash = await hashCanonical(project, harness);
  const results = await applyHarness(project, harness, options);
  if (!options.dryRun && results.every((result) => result.skipped.length === 0)) {
    await establishBaseline(project, harness, "canonical", expectedCanonicalHash);
  }
  return results;
}

function parseLinkMode(value: string): LinkMode {
  if (value === "symlink" || value === "copy") return value;
  throw new Error(`Unknown link mode ${value}; expected symlink, copy`);
}

function parseTarget(value: string): TargetName {
  if ((TARGET_NAMES as readonly string[]).includes(value)) {
    return value as TargetName;
  }
  throw new Error(`Unknown target ${value}; expected ${TARGET_NAMES.join(", ")}`);
}

function isCarryFailing(summary: unknown): boolean {
  if (typeof summary !== "object" || summary === null) return false;
  const record = summary as {
    states?: Record<string, number>;
    warnings?: Array<{ code?: string }>;
  };
  if ((record.states?.conflict ?? 0) > 0) return true;
  return (record.warnings ?? []).some((warning) =>
    warning.code === "carry-entry-refused" ||
    warning.code === "carry-file-refused" ||
    warning.code === "carry-capture-failed");
}

function print(value: unknown): void {
  const asJson = program.opts<{ json?: boolean }>().json === true;
  if (asJson || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

