import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { GENERATED_DIRECTORY_NAMES } from "./fs.js";

const MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const RESERVED_RUNTIME_PATHS = [
  ".state.json",
  ".managed.json",
  ".lock",
  ".local/",
  "backups/",
  "conflicts/",
] as const;

export interface GitStatus {
  initialized: boolean;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  clean: boolean;
}

export interface GitRemoteConnection {
  remote: string;
  created: boolean;
}

export interface GitSyncOptions {
  branch?: string;
  remote?: string;
  commitMessage?: string;
  fetch?: boolean;
  push?: boolean;
  /** Exact, previously fetched full commit ID the caller reviewed. */
  acceptRemote?: string;
  requiredPaths?: readonly string[];
  /** Validate the exact candidate tree in an isolated temporary worktree
   * before it can change the live canonical store. */
  validateCandidate?: (candidateStoreDir: string) => Promise<void>;
  afterIntegrate?: () => Promise<void>;
}

export interface GitSyncResult {
  branch: string;
  remote: string;
  committed: boolean;
  fetched: boolean;
  rebased: boolean;
  fastForwarded: boolean;
  pushed: boolean;
  remoteChangesPending: boolean;
  reviewRef?: string;
  reviewCommit?: string;
  commit?: string;
  status: GitStatus;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunGitOptions {
  allowFailure?: boolean;
  sensitiveValues?: readonly string[];
}

export class GitCommandError extends Error {
  readonly exitCode: number;

  constructor(action: string, exitCode: number, output: string, sensitiveValues: readonly string[]) {
    const detail = redactCredentials(output, sensitiveValues).trim();
    super(`git ${action} failed (exit ${exitCode})${detail ? `: ${detail}` : ""}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
  }
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runGit(process.cwd(), ["--version"], "version", { allowFailure: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function initStoreGit(
  storeDir: string,
  branch = DEFAULT_BRANCH,
): Promise<GitStatus> {
  validateBranch(branch);
  await mkdir(storeDir, { recursive: true });

  if (!(await isRepositoryRoot(storeDir))) {
    await runGit(storeDir, ["init", "--quiet", "."], "init");
  }

  const head = await runGit(
    storeDir,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "read current branch",
    { allowFailure: true },
  );
  const currentBranch = head.exitCode === 0 ? head.stdout.trim() : undefined;
  const hasHead = await hasCommit(storeDir);

  if (!hasHead) {
    await runGit(
      storeDir,
      ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
      "set initial branch",
    );
  } else if (currentBranch !== branch) {
    throw new Error(
      currentBranch
        ? `Git store is already on branch ${currentBranch}; refusing to rename it to ${branch}`
        : `Git store has a detached HEAD; refusing to move it to ${branch}`,
    );
  }

  return getGitStatus(storeDir);
}

export async function connectRemote(
  storeDir: string,
  url: string,
  remote = DEFAULT_REMOTE,
): Promise<GitRemoteConnection> {
  validateRemote(remote);
  validateRemoteUrl(url);
  await assertRepositoryRoot(storeDir);

  const exists = await remoteExists(storeDir, remote);
  if (exists) {
    await runGit(storeDir, ["remote", "set-url", remote, url], "update remote", {
      sensitiveValues: [url],
    });
  } else {
    await runGit(storeDir, ["remote", "add", remote, url], "add remote", {
      sensitiveValues: [url],
    });
  }

  return { remote, created: !exists };
}

export async function getGitStatus(storeDir: string): Promise<GitStatus> {
  if (!(await isRepositoryRoot(storeDir))) return emptyStatus();

  const result = await runGit(
    storeDir,
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    "status",
  );
  return parseStatus(result.stdout);
}

export async function syncGitStore(
  storeDir: string,
  options: GitSyncOptions = {},
): Promise<GitSyncResult> {
  await assertRepositoryRoot(storeDir);
  const initialStatus = await getGitStatus(storeDir);
  if (initialStatus.conflicted > 0) {
    throw new Error("Git store has unresolved conflicts; resolve them before syncing");
  }
  if (await hasOperationInProgress(storeDir)) {
    throw new Error("Git store already has a merge, rebase, or cherry-pick in progress");
  }

  const branch = options.branch ?? initialStatus.branch ?? DEFAULT_BRANCH;
  const remote = options.remote ?? DEFAULT_REMOTE;
  validateBranch(branch);
  validateRemote(remote);
  if (options.acceptRemote) {
    validateCommitId(options.acceptRemote);
    const available = await runGit(
      storeDir,
      ["cat-file", "-e", `${options.acceptRemote}^{commit}`],
      "verify reviewed commit",
      { allowFailure: true },
    );
    if (available.exitCode !== 0) {
      throw new Error(
        `Reviewed commit ${options.acceptRemote} is not available locally; run fetch-only git sync and review that exact commit first`,
      );
    }
    await assertNoRuntimePathsInCommit(storeDir, options.acceptRemote);
  }

  if (initialStatus.detached) {
    throw new Error("Git store has a detached HEAD; check out the sync branch before syncing");
  }
  if (initialStatus.branch && initialStatus.branch !== branch) {
    throw new Error(
      `Git store is on branch ${initialStatus.branch}; refusing to sync configured branch ${branch}`,
    );
  }

  await assertNoTrackedRuntimePaths(storeDir);
  await stageStoreChanges(storeDir, options.requiredPaths ?? []);
  const stagedPaths = await listGitPaths(
    storeDir,
    ["diff", "--cached", "--name-only", "-z"],
  );
  const stagedRuntime = stagedPaths.filter(isReservedRuntimePath);
  if (stagedRuntime.length > 0) {
    throw new Error(
      `Refusing Git sync because runtime/private paths are staged: ${stagedRuntime.join(", ")}`,
    );
  }
  const staged = await runGit(
    storeDir,
    ["diff", "--cached", "--quiet", "--exit-code"],
    "inspect staged changes",
    { allowFailure: true },
  );
  if (staged.exitCode !== 0 && staged.exitCode !== 1) {
    throw new GitCommandError(
      "inspect staged changes",
      staged.exitCode,
      staged.stderr || staged.stdout,
      [],
    );
  }

  let committed = false;
  if (staged.exitCode === 1) {
    const message = options.commitMessage?.trim() || defaultCommitMessage();
    const tree = (
      await runGit(storeDir, ["write-tree"], "freeze staged store tree")
    ).stdout.trim();
    const parent = await currentCommit(storeDir);
    const commitArgs = [
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      message,
    ];
    const candidateCommit = (
      await runGit(storeDir, commitArgs, "create staged store commit")
    ).stdout.trim();

    // The callback validates the exact immutable tree that will become HEAD,
    // not a working tree that a concurrent editor can change after scanning.
    await validateCandidateCommit(
      storeDir,
      candidateCommit,
      options.validateCandidate,
      [],
    );
    const currentParent = await currentCommit(storeDir);
    if (currentParent !== parent) {
      throw new Error(
        "Git HEAD changed while the staged store candidate was validated; no ref was updated",
      );
    }
    await runGit(
      storeDir,
      [
        "update-ref",
        "-m",
        "harness-sync commit",
        `refs/heads/${branch}`,
        candidateCommit,
        parent ?? "",
      ],
      "activate validated store commit",
    );
    committed = true;
  }

  const hasRemote = await remoteExists(storeDir, remote);
  if (!hasRemote && options.push) {
    throw new Error(`Git remote ${remote} is not configured; connect it before pushing`);
  }

  let fetched = false;
  let rebased = false;
  let fastForwarded = false;
  let remoteBranchExists = false;
  let remoteChangesPending = false;
  let reviewRef: string | undefined;
  let reviewCommit: string | undefined;
  let sensitiveValues: string[] = [];
  let validatedHead = committed ? await currentCommit(storeDir) : undefined;

  if (hasRemote) {
    const remoteUrl = await getRemoteUrl(storeDir, remote);
    sensitiveValues = remoteUrl ? [remoteUrl] : [];
  }

  if (hasRemote && options.fetch !== false) {
    const branchProbe = await runGit(
      storeDir,
      ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`],
      "inspect remote branch",
      { allowFailure: true, sensitiveValues },
    );
    if (branchProbe.exitCode !== 0 && branchProbe.exitCode !== 2) {
      throw new GitCommandError(
        "inspect remote branch",
        branchProbe.exitCode,
        branchProbe.stderr || branchProbe.stdout,
        sensitiveValues,
      );
    }
    remoteBranchExists = branchProbe.exitCode === 0 && branchProbe.stdout.trim().length > 0;

    if (remoteBranchExists) {
      const remoteRef = `refs/remotes/${remote}/${branch}`;
      reviewRef = `${remote}/${branch}`;
      await runGit(
        storeDir,
        ["fetch", "--no-tags", remote, `refs/heads/${branch}:${remoteRef}`],
        "fetch remote branch",
        { sensitiveValues },
      );
      fetched = true;
      reviewCommit = await resolveCommit(storeDir, remoteRef);
      const integrationRef = options.acceptRemote ?? remoteRef;
      if (
        options.acceptRemote &&
        !(await isAncestor(storeDir, options.acceptRemote, remoteRef))
      ) {
        throw new Error(
          `Reviewed commit ${options.acceptRemote} is not reachable from the freshly fetched ${remoteRef}; it was not integrated`,
        );
      }

      if (!(await hasCommit(storeDir))) {
        if (options.acceptRemote) {
          const expectedHead = await currentCommit(storeDir);
          await validateCandidateCommit(
            storeDir,
            integrationRef,
            options.validateCandidate,
            sensitiveValues,
          );
          await activateValidatedCandidate(
            storeDir,
            branch,
            integrationRef,
            expectedHead,
            sensitiveValues,
          );
          validatedHead = integrationRef;
          fastForwarded = true;
        } else {
          remoteChangesPending = true;
        }
      } else if (options.acceptRemote && !(await isAncestor(storeDir, integrationRef, "HEAD"))) {
        if (await isAncestor(storeDir, "HEAD", integrationRef)) {
          const expectedHead = await currentCommit(storeDir);
          await validateCandidateCommit(
            storeDir,
            integrationRef,
            options.validateCandidate,
            sensitiveValues,
          );
          await activateValidatedCandidate(
            storeDir,
            branch,
            integrationRef,
            expectedHead,
            sensitiveValues,
          );
          validatedHead = integrationRef;
          fastForwarded = true;
        } else {
          validatedHead = await prepareAndActivateRebase(
            storeDir,
            branch,
            integrationRef,
            options.validateCandidate,
            sensitiveValues,
          );
          rebased = true;
        }
      } else if (!options.acceptRemote && !(await isAncestor(storeDir, remoteRef, "HEAD"))) {
        remoteChangesPending = true;
      }

      if (
        options.acceptRemote &&
        (await hasCommit(storeDir)) &&
        !(await isAncestor(storeDir, remoteRef, "HEAD"))
      ) {
        remoteChangesPending = true;
      }
    }
  }
  if (options.acceptRemote && (!hasRemote || !remoteBranchExists)) {
    throw new Error("Cannot accept a reviewed commit without a configured remote branch");
  }

  if (fastForwarded || rebased) {
    await assertNoTrackedRuntimePaths(storeDir);
    if (options.afterIntegrate) await options.afterIntegrate();
  }

  let pushed = false;
  if (options.push) {
    if (remoteChangesPending) {
      throw new Error(
        `Remote changes are pending at ${reviewRef ?? `${remote}/${branch}`}; review them and rerun with acceptRemote before pushing`,
      );
    }
    const pushCommit = validatedHead ?? await currentCommit(storeDir);
    if (!pushCommit) {
      throw new Error("Cannot push a Git store without a commit");
    }
    if (!validatedHead) {
      await validateCandidateCommit(
        storeDir,
        pushCommit,
        options.validateCandidate,
        sensitiveValues,
      );
    }
    await runGit(
      storeDir,
      ["push", "--set-upstream", remote, `${pushCommit}:refs/heads/${branch}`],
      "push store branch",
      { sensitiveValues },
    );
    await runGit(
      storeDir,
      ["branch", "--set-upstream-to", `${remote}/${branch}`, branch],
      "record store upstream",
      { sensitiveValues },
    );
    pushed = true;
  }

  const commit = await currentCommit(storeDir);
  const status = await getGitStatus(storeDir);
  return {
    branch,
    remote,
    committed,
    fetched,
    rebased,
    fastForwarded,
    pushed,
    remoteChangesPending,
    ...(reviewRef ? { reviewRef } : {}),
    ...(reviewCommit ? { reviewCommit } : {}),
    ...(commit ? { commit } : {}),
    status,
  };
}

async function validateCandidateCommit(
  storeDir: string,
  commit: string,
  validateCandidate: GitSyncOptions["validateCandidate"],
  sensitiveValues: readonly string[],
): Promise<void> {
  if (!validateCandidate) return;
  await withTemporaryWorktree(
    storeDir,
    commit,
    sensitiveValues,
    async (candidateStoreDir) => {
      await assertNoTrackedRuntimePaths(candidateStoreDir);
      await validateCandidate(candidateStoreDir);
    },
  );
}

async function prepareAndActivateRebase(
  storeDir: string,
  branch: string,
  integrationRef: string,
  validateCandidate: GitSyncOptions["validateCandidate"],
  sensitiveValues: readonly string[],
): Promise<string> {
  const expectedHead = await currentCommit(storeDir);
  if (!expectedHead) {
    throw new Error("Cannot rebase a Git store without a local commit");
  }
  return withTemporaryWorktree(
    storeDir,
    "HEAD",
    sensitiveValues,
    async (candidateStoreDir) => {
      const rebase = await runGit(
        candidateStoreDir,
        ["rebase", integrationRef],
        "prepare reviewed rebase",
        { allowFailure: true, sensitiveValues },
      );
      if (rebase.exitCode !== 0) {
        await runGit(
          candidateStoreDir,
          ["rebase", "--abort"],
          "abort candidate rebase",
          { allowFailure: true },
        );
        const detail = redactCredentials(
          rebase.stderr || rebase.stdout,
          sensitiveValues,
        ).trim();
        throw new Error(
          `Git histories diverged and could not be rebased. The temporary rebase was rolled back and the live store was left unchanged.${
            detail ? ` ${detail}` : ""
          }`,
        );
      }

      await assertNoTrackedRuntimePaths(candidateStoreDir);
      if (validateCandidate) await validateCandidate(candidateStoreDir);
      const candidateHead = await resolveCommit(candidateStoreDir, "HEAD");
      await activateValidatedCandidate(
        storeDir,
        branch,
        candidateHead,
        expectedHead,
        sensitiveValues,
      );
      return candidateHead;
    },
  );
}

async function activateValidatedCandidate(
  storeDir: string,
  branch: string,
  candidate: string,
  expectedHead: string | undefined,
  sensitiveValues: readonly string[],
): Promise<void> {
  const observedHead = await currentCommit(storeDir);
  if (observedHead !== expectedHead) {
    throw new Error(
      "Git HEAD changed while the reviewed candidate was validated; the candidate was not activated",
    );
  }
  const status = await getGitStatus(storeDir);
  if (!status.clean) {
    throw new Error(
      "Git working tree changed while the reviewed candidate was validated; the candidate was not activated",
    );
  }

  const ref = `refs/heads/${branch}`;
  const update = await runGit(
    storeDir,
    ["update-ref", "-m", "harness-sync activate", ref, candidate, expectedHead ?? ""],
    "activate validated candidate",
    { allowFailure: true, sensitiveValues },
  );
  if (update.exitCode !== 0) {
    throw new Error(
      "Git HEAD changed while the reviewed candidate was activated; no ref was overwritten",
    );
  }

  try {
    await runGit(
      storeDir,
      expectedHead
        ? ["read-tree", "-m", "-u", expectedHead, candidate]
        : ["read-tree", "--reset", "-u", candidate],
      "materialize validated candidate",
      { sensitiveValues },
    );
  } catch (error) {
    const activeHead = await currentCommit(storeDir);
    if (activeHead === candidate) {
      if (expectedHead) {
        await runGit(
          storeDir,
          ["update-ref", "-m", "harness-sync activation rollback", ref, expectedHead, candidate],
          "roll back candidate ref",
          { allowFailure: true, sensitiveValues },
        );
      } else {
        await runGit(
          storeDir,
          ["update-ref", "-d", ref, candidate],
          "roll back candidate ref",
          { allowFailure: true, sensitiveValues },
        );
      }
    }
    throw error;
  }

  if ((await currentCommit(storeDir)) !== candidate) {
    throw new Error(
      "Git HEAD changed while the reviewed candidate was materialized; refusing to report it as activated",
    );
  }
}

async function withTemporaryWorktree<T>(
  storeDir: string,
  commit: string,
  sensitiveValues: readonly string[],
  action: (candidateStoreDir: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "harness-sync-review-"));
  const candidateStoreDir = join(temporaryRoot, "store");
  let added = false;
  try {
    await runGit(
      storeDir,
      ["worktree", "add", "--quiet", "--detach", candidateStoreDir, commit],
      "create isolated review worktree",
      { sensitiveValues },
    );
    added = true;
    return await action(candidateStoreDir);
  } finally {
    if (added) {
      await runGit(
        storeDir,
        ["worktree", "remove", "--force", candidateStoreDir],
        "remove isolated review worktree",
        { allowFailure: true },
      );
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function listGitPaths(storeDir: string, args: string[]): Promise<string[]> {
  const result = await runGit(storeDir, args, "inspect Git paths");
  return result.stdout.split("\0").filter(Boolean);
}

async function resolveCommit(storeDir: string, reference: string): Promise<string> {
  const result = await runGit(
    storeDir,
    ["rev-parse", "--verify", `${reference}^{commit}`],
    "resolve fetched commit",
  );
  return result.stdout.trim();
}

/** A canonical skill is staged as a whole directory with --force, so an
 * interpreter cache or vendored dependency tree that grew inside it would be
 * committed even though .gitignore names it. These are never canonical. */
const GENERATED_PATH_EXCLUSIONS = GENERATED_DIRECTORY_NAMES.map(
  (name) => `:(exclude)**/${name}/**`,
);

async function stageStoreChanges(
  storeDir: string,
  requiredPaths: readonly string[],
): Promise<void> {
  // Updating the tracked set cannot accidentally add ignored runtime files and
  // still records deletions. Discover new files separately through Git's own
  // exclude engine; this also avoids `git add .` tripping over the live lock.
  const tracked = await listGitPaths(storeDir, ["ls-files", "-z"]);
  for (let index = 0; index < tracked.length; index += 200) {
    const chunk = tracked.slice(index, index + 200).map((path) => `./${path}`);
    await runGit(
      storeDir,
      ["add", "--update", "--", ...chunk],
      "stage tracked changes",
    );
  }
  const untracked = await listGitPaths(storeDir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const unsafe = untracked.filter(isReservedRuntimePath);
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing Git sync because runtime/private path aliases are untracked: ${unsafe.join(", ")}`,
    );
  }
  for (let index = 0; index < untracked.length; index += 200) {
    const chunk = untracked.slice(index, index + 200).map((path) => `./${path}`);
    if (chunk.length > 0) {
      await runGit(storeDir, ["add", "--", ...chunk], "stage new store files");
    }
  }
  const required = [...new Set(requiredPaths)].map((path) =>
    validateRequiredStorePath(storeDir, path),
  );
  for (let index = 0; index < required.length; index += 100) {
    const chunk = required.slice(index, index + 100).map((path) => `./${path}`);
    if (chunk.length > 0) {
      await runGit(
        storeDir,
        ["add", "--force", "--", ...chunk, ...GENERATED_PATH_EXCLUSIONS],
        "stage required canonical files",
      );
    }
  }
  for (const path of required) {
    const tracked = await listGitPaths(storeDir, [
      "ls-files",
      "-z",
      "--",
      `./${path}`,
    ]);
    if (tracked.length === 0) {
      throw new Error(`Required canonical artifact was not staged: ${path}`);
    }
  }
}

function validateRequiredStorePath(storeDir: string, path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || isAbsolute(path) || isReservedRuntimePath(normalized)) {
    throw new Error(`Invalid required canonical Git path: ${path}`);
  }
  const remainder = relative(resolve(storeDir), resolve(storeDir, normalized));
  if (remainder === ".." || remainder.startsWith(`..${sep}`)) {
    throw new Error(`Required canonical Git path escapes the store: ${path}`);
  }
  return normalized;
}

function isReservedRuntimePath(path: string): boolean {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .toLowerCase();
  return RESERVED_RUNTIME_PATHS.some((reserved) =>
    normalized === reserved.replace(/\/$/u, "") ||
    normalized.startsWith(`${reserved.replace(/\/$/u, "")}/`),
  );
}

async function assertNoTrackedRuntimePaths(storeDir: string): Promise<void> {
  const tracked = await listGitPaths(storeDir, ["ls-files", "-z"]);
  const trackedRuntime = tracked.filter(isReservedRuntimePath);
  if (trackedRuntime.length > 0) {
    throw new Error(
      `Refusing Git sync because runtime/private paths are tracked: ${trackedRuntime.join(", ")}. Remove them from the index before syncing.`,
    );
  }
}

async function assertNoRuntimePathsInCommit(
  storeDir: string,
  commit: string,
): Promise<void> {
  const paths = await listGitPaths(storeDir, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
  ]);
  const runtime = paths.filter(isReservedRuntimePath);
  if (runtime.length > 0) {
    throw new Error(
      `Reviewed commit contains runtime/private paths and was not integrated: ${runtime.join(", ")}`,
    );
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  action: string,
  options: RunGitOptions = {},
): Promise<GitCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...args], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(
        new Error(
          `Unable to run git for ${action}: ${redactCredentials(error.message, options.sensitiveValues)}`,
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        rejectPromise(
          new GitCommandError(
            action,
            exitCode,
            stderr || stdout,
            options.sensitiveValues ?? [],
          ),
        );
        return;
      }
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

async function isRepositoryRoot(storeDir: string): Promise<boolean> {
  const probe = await runGit(
    storeDir,
    ["rev-parse", "--show-toplevel"],
    "locate repository",
    { allowFailure: true },
  );
  if (probe.exitCode !== 0) return false;

  try {
    const [actualStore, topLevel] = await Promise.all([
      realpath(storeDir),
      realpath(probe.stdout.trim()),
    ]);
    return actualStore === topLevel;
  } catch {
    return resolve(storeDir) === resolve(probe.stdout.trim());
  }
}

async function assertRepositoryRoot(storeDir: string): Promise<void> {
  if (!(await isRepositoryRoot(storeDir))) {
    throw new Error(`Git store is not initialized at ${resolve(storeDir)}`);
  }
}

async function remoteExists(storeDir: string, remote: string): Promise<boolean> {
  const result = await runGit(storeDir, ["remote", "get-url", remote], "inspect remote", {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function getRemoteUrl(storeDir: string, remote: string): Promise<string | undefined> {
  const result = await runGit(storeDir, ["remote", "get-url", remote], "read remote URL", {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function hasCommit(storeDir: string): Promise<boolean> {
  const result = await runGit(
    storeDir,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    "inspect HEAD",
    { allowFailure: true },
  );
  return result.exitCode === 0;
}

async function currentCommit(storeDir: string): Promise<string | undefined> {
  const result = await runGit(storeDir, ["rev-parse", "--verify", "HEAD"], "read HEAD", {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function isAncestor(storeDir: string, older: string, newer: string): Promise<boolean> {
  const result = await runGit(
    storeDir,
    ["merge-base", "--is-ancestor", older, newer],
    "compare histories",
    { allowFailure: true },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitCommandError(
    "compare histories",
    result.exitCode,
    result.stderr || result.stdout,
    [],
  );
}

async function hasOperationInProgress(storeDir: string): Promise<boolean> {
  for (const ref of ["REBASE_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const result = await runGit(
      storeDir,
      ["rev-parse", "--verify", "--quiet", ref],
      "inspect repository operation",
      { allowFailure: true },
    );
    if (result.exitCode === 0) return true;
  }
  return false;
}

function parseStatus(output: string): GitStatus {
  let branch: string | undefined;
  let detached = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      detached = head === "(detached)";
      if (!detached && head !== "(unknown)") branch = head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || undefined;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      untracked += 1;
      continue;
    }
    if (line.startsWith("u ")) {
      conflicted += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") staged += 1;
      if (xy[1] !== ".") unstaged += 1;
    }
  }

  return {
    initialized: true,
    ...(branch ? { branch } : {}),
    detached,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: staged + unstaged + untracked + conflicted === 0,
  };
}

function emptyStatus(): GitStatus {
  return {
    initialized: false,
    detached: false,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
  };
}

function validateBranch(branch: string): void {
  if (
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\u0000-\u0020~^:?*[\\]/u.test(branch) ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`Invalid Git branch name: ${redactCredentials(branch)}`);
  }
}

function validateRemote(remote: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) {
    throw new Error("Invalid Git remote name");
  }
}

function validateCommitId(commit: string): void {
  if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/iu.test(commit)) {
    throw new Error("--accept-remote requires a full 40- or 64-character reviewed commit ID");
  }
}

function validateRemoteUrl(url: string): void {
  if (!url.trim() || url.startsWith("-") || /[\u0000\r\n]/u.test(url)) {
    throw new Error("Invalid Git remote URL");
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid Git remote URL");
    }
    const sshLike = parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:";
    if (parsed.password || (parsed.username && !sshLike)) {
      throw new Error(
        "Refusing a Git remote with embedded credentials; use a credential helper or SSH agent",
      );
    }
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:access[_-]?token|api[_-]?key|key|password|secret|token)$/iu.test(key)) {
        throw new Error(
          "Refusing a Git remote with credential-like query parameters",
        );
      }
    }
  }
}

function defaultCommitMessage(): string {
  return `harness-sync: update ${new Date().toISOString()}`;
}

function appendBounded(current: string, next: string): string {
  if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  const remaining = MAX_CAPTURED_OUTPUT_BYTES - current.length;
  return current + next.slice(0, remaining);
}

function redactCredentials(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = value;
  for (const sensitive of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(sensitive).join("[REDACTED_REMOTE_URL]");
  }
  redacted = redacted.replace(
    /([a-z][a-z\d+.-]*:\/\/)([^/@\s]+)@/giu,
    "$1[REDACTED]@",
  );
  redacted = redacted.replace(
    /([?&](?:access_token|api_key|key|password|secret|token)=)[^&\s]+/giu,
    "$1[REDACTED]",
  );
  return redacted;
}
