# Architecture

This document describes both the v0.2 implementation and the intended production design. Sections marked **v0.2** exist in the repository today; sections marked **next** describe the compatibility-preserving evolution path.

## 1. Design constraints

The three harnesses overlap, but they are not alternate syntaxes for the same schema:

- Instructions and standard `SKILL.md` bundles are mostly content-identical.
- MCP has a portable core but different remote URL, timeout, enablement, and authentication fields.
- Subagent prompts are portable; models, tools, permission modes, and discovery metadata are not.
- Hook event names overlap while tool names and stdin/stdout decision schemas differ.
- Permission models are not isomorphic. A permissive “best effort” conversion can widen authority.
- General settings contain UI, model, organization, trust, and machine-local state that must not be flattened.

The architecture therefore separates byte identity, semantic portability, target-only fidelity, and local runtime state.

## 2. Why a daemon instead of a VFS

```text
native editor write ──► ordinary native file
                           │
                    watcher event (hint)
                           ▼
                    hash reconciliation
                           ▼
                  canonical store + adapters
```

A userspace filesystem would intercept every read/write, but it adds a kernel/FUSE dependency, mount lifecycle, editor rename edge cases, file-locking semantics, and poor Windows portability. It also makes each agent depend on the mount being healthy.

The daemon keeps native files on disk. If it stops, Claude Code, Codex, and Antigravity keep working with their latest projections. Chokidar events only trigger a scan; they are never treated as the source of truth. Startup and periodic full hashes catch dropped, coalesced, and atomic-rename events.

## 3. System boundaries

```text
 ┌──────────────────────── native surfaces ─────────────────────────┐
 │ Claude Code          Codex                  Antigravity           │
 │ JSON + Markdown      TOML + Markdown        JSONC + Markdown      │
 └──────────┬──────────────┬──────────────────────┬─────────────────┘
            │ parse/invert │                      │
            └──────────────┼──────────────────────┘
                           ▼
                    target adapters
              validate / normalize / render
                           ▼
             portable IR + target raw overlays
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
       Git-backed store          local runtime state
       authored artifacts        hashes/ownership/conflicts
```

The public application repository contains the daemon code. A user's optional private repository contains only the authored portion of the canonical store. Target-local takeover bases and original forced-replacement backups remain under ignored `.local/` and `backups/` runtime storage rather than the normal Git history. Credential redaction and scanning are defense in depth, not a guarantee—especially when the explicit `--allow-secrets` override is used—so even a private canonical repository must be treated as sensitive.

### 3.1 Multi-controller supervisor

Every project or user harness remains an independent controller with its own `harness-sync.yaml`, canonical store, state, and lock. A strict machine-local registry provides explicit enrollment and operational flags:

```text
machine registry
  ├── user controller (at most one enabled)
  ├── project controller A
  └── project controller B
          │
          ▼
stable config snapshots → topology validation → sorted all-lock barrier
          │
          ├── bounded parallel sync
          └── coordinated foreground watch loops
```

The marker plus registry entry form a two-factor membership rule: filesystem discovery alone never enrolls a project. Stable controller IDs prevent a moved path or stale entry from silently taking another controller's place. Topology validation compares physical and lexical claims for controller files, canonical stores, current adapter watch paths, and stale paths retained in `.managed.json`; it also retains the future target of a dangling managed symlink. Overlap, duplicate identity, a registry inside a managed surface, or more than one enabled user controller fails before mutation.

`sync --all` snapshots every enabled controller configuration, validates those exact loaded snapshots, acquires all selected store locks in sorted order, and verifies the snapshots again before any reconciliation. `watch --all` additionally establishes a watcher barrier on the registry and every enabled config before child loops start. A control-file change stops all children and releases all locks; an external service manager may then restart against a fresh plan. v0.2 deliberately uses fail-closed restart instead of live topology mutation.

## 4. Canonical model

`harness.yaml` holds stable IDs and paths; large authored content remains in separate files so ordinary Git merge tools work.

```yaml
schemaVersion: 1
metadata:
  name: example
instructions:
  root: instructions/root.md
skills:
  - name: reviewer
    path: skills/reviewer
agents:
  reviewer:
    description: Review correctness and security
    instructionsFile: agents/reviewer.md
mcpServers:
  docs:
    transport: http
    url: https://example.invalid/mcp
overlays:
  claude:
    settings: {}
  codex:
    settings: {}
  antigravity:
    settings: {}
```

Every mapped field has one of these conceptual fidelity grades:

| Grade | Meaning | Write policy |
|---|---|---|
| `exact` | Same bytes and meaning | Symlink when safe |
| `compatible` | Meaning preserved through a deterministic adapter | Materialized atomic projection |
| `target-only` | No cross-target equivalent | Preserve in raw overlay |
| `unsupported` | Unsafe or undocumented | Report; do not emit |

Unknown imported settings and agent frontmatter are kept under target overlays. Agent name, description, and prompt body form the portable core; source-native models, tools, and permission fields stay in the source overlay. Cross-target renderers use conservative destination-native capability fallbacks and warn rather than relabeling source capabilities. Likely secrets are replaced with environment references such as `${env:GITHUB_TOKEN}` when the target documents that mechanism, or omitted from projections with a warning. This is defense in depth, not proof that a store is secret-free.

Target-native MCP contracts use a second invariant. `requiredNativeFeatures.<target>` names semantics backed either by a matching raw overlay or by evidence that the target's native trust/approval gate applies. Validation rejects an orphan marker. A projection is safe only when its target and scope provide the matching contract; otherwise it warns and disables the whole server where representable, or omits it. Project trust and project-MCP approval evidence applies only in project scope; Claude's per-project runtime disable evidence and Antigravity's global settings permissions apply only in user scope. Codex non-managed hook trust is machine-local and tied to the exact hook hash, so a synchronized hook definition does not make its MCP gate available; dependent servers remain disabled on Codex as well. This covers restrictive MCP permissions and blocking hooks, authentication helpers/OAuth, tool-approval controls, remote execution placement, and required/eager startup behavior without pretending that similarly named fields are equivalent. Inverse capture recognizes generated fail-closed projections and does not promote them into a new matching contract.

## 5. Symlink plane

Skills are linked **one directory at a time**, not by replacing `.claude`, `.agents`, or an entire skills root:

```text
.harness-sync/skills/reviewer/       # real canonical directory
├── SKILL.md
└── scripts/check.sh

.claude/skills/reviewer  ───────────► canonical directory
.agents/skills/reviewer  ───────────► canonical directory
```

This has four important properties:

1. Claude editing `SKILL.md` writes through to the canonical file immediately.
2. Codex and Antigravity use the same project `.agents/skills` projection.
3. Native/private skills can coexist beside managed links.
4. Temp-file-plus-rename editors replace files *inside* the linked directory rather than replacing the link itself.

Claude and Codex explicitly document symlinked skill folders. Google uses the same per-skill link strategy in its official `agents-cli` Antigravity setup implementation. Where links are unavailable, or where the native tree is committed to Git and a link pointing outside the repository would be useless to anyone else, `linkMode: copy` materializes files and the watcher reconciles them. `harness-sync link-mode <symlink|copy>` switches an existing controller in either direction: a projection the tool already owns is replaced in place, proven by the ledger, so no `--force` is needed.

The links created by the writer point from a native leaf to its exact canonical artifact. In the opposite direction, unmanaged directory symlinks at recursive import roots and imports that resolve outside the selected harness root are rejected. Accepted regular-file source links are content-hashed within that boundary. Nested symlinks and embedded `.git` metadata are rejected inside imported or canonical bundles, so external content cannot escape hashing or become a Git submodule entry by accident.

Settings, MCP, hooks, and agent declarations are materialized instead. Those applications may rewrite a whole JSON/TOML file atomically, which would replace a file-level symlink.

## 6. Adapter contract

Each adapter implements:

```ts
interface HarnessAdapter {
  capture(current, context, options): Promise<CaptureResult>;
  apply(harness, context, options): Promise<ApplyResult>;
  fingerprint(context): Promise<string>;
  watchPaths(context): string[];
}
```

`capture` is an inverse adapter. It updates portable fields only when a safe mapping exists, records the native remainder as an overlay, and attaches native-feature requirements when dropping that remainder would alter authentication, approval, or startup behavior. `apply` builds a write plan through `ManagedWriter`; it cannot overwrite an unowned changed path unless force was explicitly requested. Generated fail-closed disablement is recognized during inverse capture and is not mistaken for an authored canonical `enabled: false`.

Migration snapshots the source target before capture and rechecks it before canonical commit and native installation. `migrate --apply --install` also dry-runs all target writers against the staged canonical tree before committing it. The real takeover then compares each covered native destination with its captured precondition before the first write to that path.

The implementation uses custom adapters in v0.2 so every write and loss boundary is visible. Rulesync remains a useful future translation oracle: run a pinned version only in a scratch tree, compare its output with golden fixtures, and feed an approved `WritePlan` into this safety layer. It must not receive direct write access to a live project.

## 7. Reconciliation

### v0.2 algorithm

The state file records the last canonical hash and each target fingerprint. Target fingerprints contain only paths already owned by the synchronizer; watcher events for unmanaged/private siblings cause an audit but do not enroll them.

```text
canonical changed?   changed native targets   action
────────────────────────────────────────────────────────────
no                   none                     no-op
yes                  none                     project canonical
no                   exactly one managed target inverse-capture, project others
yes                  one or more              conflict (or explicit canonical policy)
no                   two or more              conflict
```

This target-level gate is intentionally conservative. An explicit canonical deletion removes only unchanged managed projections (after backing them up). Deleting or replacing a managed link/copy, or changing a stale copied output, becomes a conflict rather than an inferred deletion. Distinct materialized writers never use timestamps. JSON, JSONC, and TOML fingerprints compare parsed target semantics, so formatting-only rewrites do not create false conflicts. Symlinked native views are aliases of the canonical inode, however, so edits through two aliases are canonical writes and truly simultaneous writes obey filesystem last-write-wins semantics. Deleting a file inside a linked skill likewise deletes canonical content directly; validation stops reconciliation until the file is restored or the manifest is edited explicitly. The current conflict is written to `conflicts/current.json` and ignored by Git.

### Artifact-level three-way merge (next)

The production state model keeps, for every artifact/target pair:

```text
B_c = canonical semantic snapshot at last successful projection
B_t = target semantic snapshot rendered from B_c
C   = current canonical value
N_t = current parsed native value
```

Adapters produce semantic JSON-pointer changes. Disjoint paths merge automatically; the same path and same value converge; the same path with different values becomes a conflict. Target-only edits update only that target's overlay. Permission changes additionally pass a monotonicity check so a merge cannot grant more authority than either input.

The transaction sequence is:

1. Acquire a project lock.
2. Debounce and stable-read all candidate paths.
3. Re-check precondition hashes.
4. Parse, merge, render, and validate every output.
5. Record a write-ahead journal entry.
6. Write a mode-0600 temporary file, `fsync`, and atomic-rename.
7. Commit new semantic bases and output hashes.
8. Ignore watcher events whose hashes match the committed projection.

v0.2 implements locking, watcher debounce, atomic per-file writes, managed hashes, pre/post snapshot checks, startup/audit scans, conflict records, and a validated sibling stage for native capture/migration. The staged canonical commit and native projection still replace artifacts one at a time; a mid-commit I/O failure can leave some outputs updated while state remains at the prior revision. A write-ahead journal and operation-wide rollback are the next durability milestone.

## 8. Ownership and backups

`.managed.json` stores hashes and per-target owners for paths created by the tool. A path is writable when it is absent, is the expected managed link, or still has its last managed hash. Shared Codex/Antigravity paths keep all active owners; one target dropping the path relinquishes only its ownership and cannot prune another active target's projection. `--force` moves an occupied path into `backups/<timestamp>/<target>/` before replacement. The move is rename-based and intentionally refuses a cross-filesystem takeover; place the canonical store on the same filesystem or move the native path manually when a backup cannot be atomic. When the occupied path is a relative symlink, its backup link text is rewritten relative to the backup directory so it still names the original physical target. Restoring it means creating a new link at the original location to that target, not moving the rewritten text back unchanged. Runtime ownership and backups are never committed by the store's generated `.gitignore`.

For whole-file Claude settings, Codex config, and Antigravity MCP takeovers, the adapter also saves the parsed unmanaged base under `.local/preserved/` and merges it beneath future canonical projections. This preserves unrelated local restrictions and settings across repeated applies while keeping them out of Git. Lifecycle-managed Codex agent declarations are deliberately excluded so canonical deletion can still prune them.

This protects a native file edited while the daemon was stopped: the next projection skips it and asks for migration/reconciliation instead of silently overwriting it.

## 9. Git protocol

The canonical store is an independent Git repository. The daemon delegates transport and credentials to system Git:

```text
flush managed native changes
  → validate + secret scan
  → stage authored paths (runtime paths are rejected)
  → freeze tree + create candidate commit
  → validate exact candidate in an isolated worktree
  → compare-and-swap branch ref from the expected parent
  → fetch remote branch without checkout
  → record immutable fetched commit ID
  → user reviews HEAD...<commit>
  → explicit --accept-remote <commit> fast-forward/rebase
  → validate + secret scan again
  → optional normal push
  → explicit apply/sync for materialized projections
```

There is no shell interpolation, forced update, hard reset, or embedded token storage. Credential-bearing URL forms are rejected. A failed rebase is aborted. Remote URLs are redacted from surfaced errors. Remote integration is opt-in with an exact, already-fetched `--accept-remote <commit>`; normal push is separately opt-in.

Before staging local changes and before activating a reviewed candidate, the built-in scanner reads every regular store file up to 2 MiB, independent of extension. After staging, the exact tree returned by `git write-tree` is wrapped with `git commit-tree`, validated again from a detached temporary worktree, then made visible with `git update-ref <new> <expected-old>`. Oversized, unreadable, non-regular, and symlink entries block by default. The scanner excludes only explicit root runtime/private paths and `.git` metadata; Git path checks separately refuse those runtime paths even if ignore rules were altered.

Remote hooks, MCP commands, and scripts are executable configuration. Fetch-only is the default so they can be reviewed first. The accepted commit is immutable: if the branch advances between review and acceptance, only the supplied commit is integrated and the newer tip remains pending. The exact fast-forward candidate, or the result of replaying local commits over that candidate, is first constructed and validated in an isolated temporary worktree. Only a valid candidate moves the live branch; a conflicting temporary rebase leaves the live store unchanged. Because exact artifacts are symlinked, accepted instruction/skill changes are visible immediately after that validation even before materialized settings are applied.

## 10. Scope model

Three scopes must remain distinct even if one UI later presents them together:

- **Project/team:** authored files safe to keep in the project repository.
- **Personal:** canonical files synced through a user's private Git remote.
- **Machine-local:** paths, local permissions, secrets, OAuth, trust, UI state, and runtime data.

`settings.local.json`, raw Claude trust/UI/runtime data, Codex hook-review decisions, and Antigravity project/runtime state never move into the personal store automatically. Narrow fail-closed evidence is the exception: authored Claude project MCP approval settings can remain in its target overlay, and user `disabledMcpServers` membership can add a server marker without copying the project-state object. Managed enterprise configuration is observable for diagnostics but never writable.

## 11. Antigravity variants

Antigravity currently exposes 2.0, CLI, and IDE surfaces whose official global skill paths disagree:

```text
~/.gemini/config/skills             # 2.0 current docs
~/.gemini/antigravity-cli/skills    # CLI docs
~/.gemini/antigravity/skills        # IDE docs
```

Project scope is stable at `.agents/skills`. In user scope the adapter creates per-skill links at all three documented locations without replacing their parent directories. Future configuration will expose `antigravity-2`, `antigravity-cli`, and `antigravity-ide` as independently selectable variants.

## 12. Failure behavior

- Daemon unavailable: agents keep using the last native files.
- Watch event lost: periodic audit finds the changed hash.
- Native parse error: transaction stops; last valid other-target files remain.
- Concurrent distinct materialized writers: conflict record, no overwrite; shared symlink aliases retain normal filesystem write semantics.
- Git divergence: rebase if clean; abort and report if conflicting.
- Missing symlink privilege, or a native tree tracked in Git: `harness-sync link-mode copy`.
- Unknown native field: retain it in a target overlay or classify unsupported.
- Literal secret: redact during import and block Git sync if later detected.
- Controller config changed while watching: stop and require a daemon restart so roots/policy are reloaded coherently.
