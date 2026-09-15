export const TARGET_NAMES = ["claude", "codex", "antigravity"] as const;

export type TargetName = (typeof TARGET_NAMES)[number];
export type Scope = "project" | "user";
export type LinkMode = "symlink" | "copy";
export type Fidelity = "exact" | "compatible" | "target-only" | "unsupported";

export interface TargetConfig {
  enabled: boolean;
  root?: string;
}

export interface SyncPolicy {
  debounceMs: number;
  auditIntervalMs: number;
  linkMode: LinkMode;
  onConflict: "stop" | "prefer-canonical";
  /** How many applies' worth of `backups/` to keep — one apply writes one
   * timestamped directory holding every path it replaced, across all targets.
   * There is deliberately no value meaning "unbounded". Migration `capture-*`
   * directories are not counted and never pruned. */
  backupRetention: number;
}

export interface GitPolicy {
  enabled: boolean;
  /** How often the daemon commits (and, with autoPush, pushes) the store.
   * 0 disables it — the daemon then never touches Git and the store is only
   * backed up when a human runs `git sync`. The daemon is the only thing that
   * CAN do this on a schedule: it holds the store lock for its whole lifetime,
   * so an external timer calling `git sync` would be refused every time. */
  backupIntervalMs: number;
  autoPush: boolean;
  branch: string;
  remote: string;
}

export interface ProjectConfig {
  schemaVersion: 1;
  /** Stable logical identity used by the machine-local controller registry. */
  controllerId?: string;
  scope: Scope;
  store: string;
  targets: Record<TargetName, TargetConfig>;
  sync: SyncPolicy;
  git: GitPolicy;
  /** Machine-local: whether THIS machine captures the carried files the store
   * declares. Optional, so an existing harness-sync.yaml round-trips
   * byte-identically, and off unless a machine says otherwise — a fresh clone
   * must not become an authority on a payload it has never seen. */
  carry?: { enabled: boolean };
}

export interface McpServer {
  transport: "stdio" | "http" | "sse" | "ws";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Name of the environment variable containing a remote Bearer token. */
  bearerTokenEnvVar?: string;
  enabled?: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
  /** Native-only features that must be restored by a matching target adapter. */
  requiredNativeFeatures?: Partial<Record<TargetName, string[]>>;
}

export interface PortablePermissions {
  filesystem?: "read-only" | "workspace-write" | "full-access";
  network?: "deny" | "prompt" | "allow";
  approval?: "untrusted" | "on-request" | "never";
  commandAllow?: string[];
  commandDeny?: string[];
  commandAsk?: string[];
}

export interface HookHandler {
  type: "command" | "http" | "prompt" | "agent" | "mcp";
  command?: string;
  url?: string;
  prompt?: string;
  timeoutSeconds?: number;
  async?: boolean;
  extra?: Record<string, unknown>;
}

export interface HookGroup {
  matcher?: string;
  handlers: HookHandler[];
}

export interface AgentDefinition {
  description: string;
  instructionsFile: string;
  model?: string;
  reasoningEffort?: string;
  filesystem?: PortablePermissions["filesystem"];
  tools?: string[];
  disallowedTools?: string[];
  targets?: Partial<Record<TargetName, Record<string, unknown>>>;
  /** Relative native agent file retained to avoid duplicate normalized layouts. */
  nativePaths?: Partial<Record<TargetName, string>>;
}

export interface CommandDefinition {
  description?: string;
  promptFile: string;
  argumentHint?: string;
  targets?: Partial<Record<TargetName, Record<string, unknown>>>;
}

export interface TargetOverlay {
  settings?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

import type { SecretAllowlistEntry } from "./core/secret-allowlist.js";
import type { HookScriptEntry } from "./core/hook-scripts.js";
import type { OutputStyleEntry } from "./core/output-styles.js";
import type { NamedFileEntry } from "./core/named-files.js";
import type { CarryEntry } from "./core/carry-entry.js";

export interface CanonicalHarness {
  schemaVersion: 1;
  metadata: {
    name: string;
    description?: string;
  };
  instructions: {
    root: string;
  };
  rules: Array<{
    path: string;
    globs?: string[];
    portable?: boolean;
    targets?: Partial<Record<TargetName, Record<string, unknown>>>;
  }>;
  skills: Array<{
    name: string;
    path: string;
  }>;
  commands: Record<string, CommandDefinition>;
  agents: Record<string, AgentDefinition>;
  mcpServers: Record<string, McpServer>;
  permissions: PortablePermissions;
  hooks: Record<string, HookGroup[]>;
  /** Reviewed, committed approvals of individual scanned lines. Optional so an
   * existing store's harness.yaml keeps parsing and is not rewritten. */
  secretAllowlist?: SecretAllowlistEntry[];
  /** Executable files a hook command runs, one entry per real file. `name` is
   * the path relative to the target's script directory and may contain `/`.
   * Optional for the same reason as `secretAllowlist`: writing `hookScripts: []`
   * back would change the canonical bytes of every store that never used the
   * feature — and an empty list is what makes `writer.finish` prune the
   * projected scripts. */
  hookScripts?: HookScriptEntry[];
  /** Claude output styles: Markdown files whose frontmatter `name` is what the
   * `outputStyle` setting selects. The setting travels in the settings
   * passthrough already, so without these the projected store names a style
   * whose file was never carried. Optional for the same reason as the two
   * fields above. */
  outputStyles?: OutputStyleEntry[];
  /** Helper programs Claude's hooks and commands invoke (`scripts/`), and its
   * workflow scripts (`workflows/`). Executable code, so they travel like hook
   * scripts. Without `scripts/` a hook that requires from it dies on a second
   * machine — measured: session-start.js does exactly that. */
  scripts?: NamedFileEntry[];
  workflows?: NamedFileEntry[];
  /** Ordinary files the store keeps a copy of because keeping them beside the
   * harness is convenient — a launchd plist, a hand-written CLI, a plugin
   * manifest. The ONLY kind whose destination is not derived from a target root
   * and the only one with no adapter, which is why nothing projects it: carry
   * is capture-only, and restoring a carried file is something you do yourself.
   * Optional for the same reason as the fields above — absent stays absent. */
  carry?: CarryEntry[];
  overlays: Record<TargetName, TargetOverlay>;
}

export interface AdapterWarning {
  code: string;
  message: string;
  path?: string;
  fidelity?: Fidelity;
}

export interface CaptureResult {
  harness: CanonicalHarness;
  warnings: AdapterWarning[];
  imported: string[];
}

export interface ApplyResult {
  target: TargetName;
  written: string[];
  linked: string[];
  removed: string[];
  skipped: string[];
  warnings: AdapterWarning[];
}

export interface ProjectionState {
  schemaVersion: 1;
  revision: number;
  canonicalHash: string;
  targetHashes: Partial<Record<TargetName, string>>;
  updatedAt: string;
  lastWriter?: "canonical" | TargetName;
}

export interface SyncConflict {
  detectedAt: string;
  canonicalChanged: boolean;
  changedTargets: TargetName[];
  message: string;
}
