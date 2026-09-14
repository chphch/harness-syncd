import type {
  ApplyResult,
  CanonicalHarness,
  CaptureResult,
  LinkMode,
  Scope,
  TargetName,
} from "../types.js";
import { dirname } from "node:path";

export interface AdapterContext {
  projectRoot: string;
  targetRoot: string;
  storeDir: string;
  scope: Scope;
  /** Original canonical store accepted when an isolated migration stage reads
   * an already-managed native symlink. */
  canonicalSourceStoreDir?: string;
}

export function captureBoundary(context: AdapterContext): string {
  return context.scope === "project"
    ? context.targetRoot
    : dirname(context.targetRoot);
}

export interface CaptureOptions {
  includeLocal: boolean;
  includeAssets: boolean;
  write: boolean;
  /** Restrict daemon inverse-capture to paths already owned by this target. */
  managedPaths?: readonly string[];
  /** Native skill directory names to drop before import opens them. Set only by
   * migrate; inverse-capture and doctor leave it undefined and are unaffected. */
  excludeSkills?: readonly string[];
}

export interface ApplyOptions {
  dryRun: boolean;
  force: boolean;
  linkMode: LinkMode;
  activeTargets?: readonly TargetName[];
  /** Round-trip verification renders only canonical state; takeover-only local
   * bases are cleared after a successful inverse capture. */
  ignoreLocalBase?: boolean;
  /** Compare native destinations with the migration-start snapshot before any
   * forced takeover. The shared consumed set permits intentional cross-target
   * ownership of one physical path. */
  nativePreconditions?: NativeWritePreconditions;
}

export interface NativeWritePreconditions {
  roots: readonly string[];
  hashes: ReadonlyMap<string, string>;
  /** Includes the bytes behind symlinked regular files. */
  contentHashes: ReadonlyMap<string, string>;
  /** Physical boundary within which symlink target bytes may be read. */
  symlinkContentRoot: string;
  missingHash: string;
  consumed: Set<string>;
}

/** Where a target keeps the executable files its hook commands run.
 *
 * No vendor documents such a directory today; `.claude/hooks/` is a convention
 * from Claude's own doc examples. A target that has no convention returns
 * `null`, which is a DECLARATION rather than an omission — the member is
 * required precisely so a new adapter cannot compile without deciding.
 */
export interface HookScriptLayout {
  /** Absolute native directory the scripts are projected into. */
  dir: string;
  /** The machine-independent text denoting `dir` inside a hook command, e.g.
   * `$CLAUDE_PROJECT_DIR/.claude/hooks`. WARNING-ONLY: nothing may expand this
   * or compare it against `dir` during a projection. Round-trip verification
   * re-projects into a temporary root while `$HOME` still expands to the real
   * home, so any such comparison fails there and turns an ordinary native edit
   * into a hard conflict. A wrong value here costs a warning, never a byte. */
  commandPrefix: string;
}

export interface HarnessAdapter {
  readonly name: TargetName;
  capture(
    current: CanonicalHarness,
    context: AdapterContext,
    options: CaptureOptions,
  ): Promise<CaptureResult>;
  apply(
    harness: CanonicalHarness,
    context: AdapterContext,
    options: ApplyOptions,
  ): Promise<ApplyResult>;
  fingerprint(context: AdapterContext): Promise<string>;
  watchPaths(context: AdapterContext): string[];
  /** `null` declares that this vendor documents no hook-script directory.
   *
   * Note on a future target: `adapters` in ./index.ts is a total
   * `Record<TargetName, HarnessAdapter>`, so a fourth vendor fails to compile
   * until it answers this. Enabling that vendor for existing controllers is a
   * separate problem — config.ts spreads the NEW binary's target defaults over
   * a stored config, so a newly shipped target arrives enabled and no CLI verb
   * disables it. Resolve that with the target, not here. */
  hookScripts(context: AdapterContext): HookScriptLayout | null;
}
