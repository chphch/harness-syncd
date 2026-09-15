import { loadHarness } from "./config.js";
import { syncGitStore, type GitSyncResult } from "./git.js";
import type { LoadedProject } from "./project.js";
import { canonicalArtifactPaths } from "./artifacts.js";
import { validateHarness } from "./validate.js";
import { partitionByAllowlist, type AllowlistPartition, type SecretAllowlistEntry } from "./secret-allowlist.js";
import { scanStoreForSecrets } from "./secret-scan.js";

/** The force-staged set: everything `canonicalArtifactPaths` names, plus the
 * two store-runtime files that are not artifacts but must be committed. Kept
 * beside the sync so the CLI and the daemon cannot drift apart on it. */
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
