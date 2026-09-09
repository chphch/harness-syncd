#!/usr/bin/env node

import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  TARGET_NAMES,
  type CanonicalHarness,
  type Scope,
  type TargetName,
} from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { loadHarness, writeProjectConfig } from "./core/config.js";
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
  enabledTargets,
  initializeProject,
  loadProject,
} from "./core/project.js";
import { establishBaseline, reconcileOnce } from "./core/reconcile.js";
import { scanStoreForSecrets } from "./core/secret-scan.js";
import { hashCanonical, readState } from "./core/state.js";
import { acquireLock } from "./core/fs.js";
import { validateHarness } from "./core/validate.js";

const program = new Command();

program
  .name("harness-sync")
  .description(
    "Local-first harness sync for Claude Code, Codex, and Antigravity",
  )
  .version("0.1.0")
  .option("-C, --cwd <path>", "project directory", process.cwd())
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
  .action(async (options: { scope: Scope; store?: string }) => {
    const project = await initializeProject(cwd(), {
      scope: options.scope,
      ...(options.store ? { store: options.store } : {}),
    });
    print({
      initialized: true,
      config: project.configPath,
      store: project.storeDir,
      scope: project.config.scope,
    });
  });

program
  .command("migrate")
  .description("discover and import a native harness (dry-run by default)")
  .argument("<source>", "claude, codex, or antigravity")
  .option("--apply", "write the migration into the canonical store")
  .option("--install", "also install projections/links after --apply")
  .option("--force", "back up and replace occupied projection paths")
  .option("--include-local", "capture local-only settings as a non-projected overlay")
  .action(
    async (
      sourceValue: string,
      options: {
        apply?: boolean;
        install?: boolean;
        force?: boolean;
        includeLocal?: boolean;
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
      const harness = await loadHarness(project.storeDir);
      const expectedCanonicalHash = await hashCanonical(project, harness);
      const results = await applyHarness(project, harness, {
        dryRun: options.dryRun === true,
        force: options.force === true,
      });
      if (
        !options.dryRun &&
        results.every((result) => result.skipped.length === 0)
      ) {
        await establishBaseline(
          project,
          harness,
          "canonical",
          expectedCanonicalHash,
        );
      }
      print({ dryRun: options.dryRun === true, results });
      if (results.some((result) => result.skipped.length > 0)) process.exitCode = 2;
    } finally {
      await release();
    }
  });

program
  .command("sync")
  .description("perform one hash-based bidirectional reconciliation")
  .action(async () => {
    const result = await reconcileOnce(await loadProject(cwd()));
    print(result);
    if (result.action === "conflict") process.exitCode = 2;
  });

program
  .command("watch")
  .description("run the foreground reconciliation daemon")
  .action(async () => {
    const project = await loadProject(cwd());
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    print({ watching: project.projectRoot, auditIntervalMs: project.config.sync.auditIntervalMs });
    await watchProject(project, {
      signal: controller.signal,
      onResult: (result) => {
        if (result.action !== "noop") print(result);
      },
      onError: (error) => process.stderr.write(`${error.message}\n`),
    });
  });

program
  .command("status")
  .description("show configured targets and the latest reconciliation state")
  .action(async () => {
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
    });
  });

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
  .action(
    async (options: {
      push?: boolean;
      message?: string;
      allowSecrets?: boolean;
      acceptRemote?: string;
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
        await assertSecretScan(project.storeDir, options.allowSecrets === true);
        const validateGitCandidate = async (candidateStoreDir: string) => {
          const candidateHarness = await loadHarness(candidateStoreDir);
          await validateHarness(candidateStoreDir, candidateHarness);
          await assertSecretScan(
            candidateStoreDir,
            options.allowSecrets === true,
          );
        };
        const gitResult = await syncGitStore(project.storeDir, {
          branch: project.config.git.branch,
          remote: project.config.git.remote,
          push: options.push === true || project.config.git.autoPush,
          ...(options.acceptRemote ? { acceptRemote: options.acceptRemote } : {}),
          requiredPaths: canonicalGitPaths(localHarness),
          validateCandidate: validateGitCandidate,
          afterIntegrate: () => validateGitCandidate(project.storeDir),
          ...(options.message ? { commitMessage: options.message } : {}),
        });
        print({
          git: gitResult,
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
    print({
      ok: findings.length === 0 && nativeOk,
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
      secretFindings: findings,
    });
    if (findings.length > 0 || !nativeOk) process.exitCode = 2;
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`harness-sync: ${message}\n`);
  process.exitCode = 1;
});

function cwd(): string {
  return resolve(program.opts<{ cwd: string }>().cwd);
}

function shellArgument(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function canonicalGitPaths(harness: CanonicalHarness): string[] {
  return [...new Set([
    ".gitignore",
    "harness.yaml",
    harness.instructions.root,
    ...harness.rules.map((rule) => rule.path),
    ...harness.skills.map((skill) => skill.path),
    ...Object.values(harness.commands).map((command) => command.promptFile),
    ...Object.values(harness.agents).map((agent) => agent.instructionsFile),
  ])];
}

function parseTarget(value: string): TargetName {
  if ((TARGET_NAMES as readonly string[]).includes(value)) {
    return value as TargetName;
  }
  throw new Error(`Unknown target ${value}; expected ${TARGET_NAMES.join(", ")}`);
}

function print(value: unknown): void {
  const asJson = program.opts<{ json?: boolean }>().json === true;
  if (asJson || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

async function assertSecretScan(storeDir: string, allowSecrets: boolean): Promise<void> {
  const findings = await scanStoreForSecrets(storeDir);
  if (findings.length === 0 || allowSecrets) return;
  throw new Error(
    `Secret scan blocked Git sync: ${findings
      .map((finding) => `${finding.path}:${finding.line} (${finding.rule})`)
      .join(", ")}. Replace literals with environment references or pass --allow-secrets explicitly.`,
  );
}
