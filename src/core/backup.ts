import { loadHarness } from "./config.js";
import { syncGitStore, type GitSyncResult } from "./git.js";
import type { LoadedProject } from "./project.js";
import { canonicalArtifactPaths } from "./artifacts.js";
import { CARRY_STORE_PREFIX } from "./carry-entry.js";
import { validateHarness } from "./validate.js";
import { partitionByAllowlist, type AllowlistPartition, type SecretAllowlistEntry } from "./secret-allowlist.js";
import { scanStoreForSecrets } from "./secret-scan.js";

/** The force-staged set: everything `canonicalArtifactPaths` names, plus the
 * two store-runtime files that are not artifacts but must be committed. Kept
 * beside the sync so the CLI and the daemon cannot drift apart on it.
 *
 * `carry/` is DELIBERATELY ABSENT, and the next reader will want to add it.
 * Two measurements say not to. `git add --force -- harness.yaml carry/nope`
 * exits 128 on the absent path and stages NOTHING — harness.yaml included,
 * since they share one chunk — so `backupCanonicalStore` would throw on every
 * run and the daemon's timer discards that by design: backups stop, silently.
 * An empty `carry/x` force-stages rc=0 and then trips the staged-set assertion
 * instead. Both states are reachable, and under capture-only both are sticky.
 * And the force-stage buys nothing: `requiredPaths` exists to defeat
 * .gitignore, `carry/` is not in the store's required ignore lines, and the
 * ordinary staging pass already lists and stages a new carried file with its
 * exec bit intact. */
export function canonicalGitPaths(
  harness: Awaited<ReturnType<typeof loadHarness>>,
): string[] {
  return [...new Set([".gitignore", "harness.yaml", ...canonicalArtifactPaths(harness)])];
}

/**
 * Commit (and optionally push) the canonical store, through the same gates the
 * `git sync` command uses: the harness must validate, the secret scan must
 * pass, and a fetched candidate is re-validated against the LIVE allowlist so
 * a remote commit cannot carry both a new secret and its own approval.
 *
 * The caller must already hold the store lock — the daemon does, for its whole
 * lifetime, which is exactly why it is the only thing that can run this on a
 * schedule.
 */
export async function backupCanonicalStore(
  project: LoadedProject,
  options: { push: boolean; message?: string },
): Promise<GitSyncResult> {
  const harness = await loadHarness(project.storeDir);
  await validateHarness(project.storeDir, harness);
  const allowlist = harness.secretAllowlist ?? [];
  await assertSecretScan(project.storeDir, false, allowlist);
  const validateCandidate = async (candidateStoreDir: string) => {
    const candidate = await loadHarness(candidateStoreDir);
    await validateHarness(candidateStoreDir, candidate);
    await assertSecretScan(candidateStoreDir, false, allowlist);
  };
  return syncGitStore(project.storeDir, {
    branch: project.config.git.branch,
    remote: project.config.git.remote,
    push: options.push,
    requiredPaths: canonicalGitPaths(harness),
    // A carried file may be the only copy of itself, and a reviewed remote
    // commit that drops one is applied by `read-tree -m -u` with no refusal.
    // Refuse it here instead; `--allow-carry-removal` is the deliberate override.
    ...(harness.carry === undefined || harness.carry.length === 0
      ? {}
      : { protectedPathPrefixes: [CARRY_STORE_PREFIX] }),
    validateCandidate,
    afterIntegrate: () => validateCandidate(project.storeDir),
    ...(options.message ? { commitMessage: options.message } : {}),
  });
}

/** Shared by the `git sync` command and the daemon's backup timer, so a
 * scheduled backup cannot bypass a gate an interactive one enforces. */
export async function assertSecretScan(
  storeDir: string,
  allowSecrets: boolean,
  allowlist: readonly SecretAllowlistEntry[] = [],
): Promise<AllowlistPartition> {
  const findings = await scanStoreForSecrets(storeDir);
  const partition = partitionByAllowlist(findings, allowlist);
  if (partition.blocking.length === 0 || allowSecrets) return partition;
  throw new Error(
    `Secret scan blocked Git sync: ${partition.blocking
      .map((finding) =>
        `${finding.path}:${finding.line} (${finding.rule}` +
        `${finding.lineHash === undefined ? "" : `, lineHash ${finding.lineHash}`})`)
      .join(", ")}. Replace literals with environment references, add a reviewed ` +
      "harness.yaml secretAllowlist entry for that exact lineHash, or pass --allow-secrets " +
      `explicitly. Approved by the allowlist this run: ${partition.allowed.length}.` +
      (partition.stale.length > 0
        ? ` Stale allowlist entries that match nothing: ${partition.stale.length}.`
        : ""),
  );
}
