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
}
