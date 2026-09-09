# harness-syncd

Local-first, bidirectional harness synchronization for **Claude Code**, **Codex**, and **Google Antigravity**.

`harness-syncd` keeps one Git-friendly canonical store, exposes byte-identical artifacts such as skills through per-skill symlinks, and materializes settings that require schema translation. Edits to already-managed native outputs are detected by a file watcher plus periodic hash audit and can flow back into the canonical store; unmanaged local additions are never silently enrolled.

> **Status: v0.1 alpha.** Instructions, skills, rules, subagents, commands-as-skills, common MCP fields, target-native hook overlays, Claude migration, foreground watching, and personal Git sync work. Models, tool IDs, hooks, permissions, and undocumented settings stay target-specific unless a mapping is demonstrably safe.

## Why this exists

Generators solve “canonical config → several tools,” but they do not make this workflow live:

```text
Claude edits .claude/skills/review/SKILL.md
                    │ (directory symlink)
                    ▼
canonical store changes immediately
                    │ (same target)
        Codex and Antigravity see it
```

A virtual filesystem is unnecessary here. All three products still receive ordinary native files, so they work when the daemon is stopped. See [the architecture](docs/architecture.md) for the daemon/VFS trade-off and reconciliation design.

## Quick start

Requirements: Node.js 22.12+, pnpm, and Git.

```bash
git clone https://github.com/chphch/harness-syncd.git
cd harness-syncd
pnpm install
pnpm build
pnpm link --global
```

In a project that already has `.claude` configuration:

```bash
cd /path/to/project
harness-sync init

# Read-only inventory. This is the default.
harness-sync migrate claude

# Copy safe authored configuration into the canonical store.
harness-sync migrate claude --apply

# Preview projections before taking over native paths.
harness-sync apply --dry-run

# Existing paths are backed up, then links/projections are installed.
harness-sync apply --force

# One reconciliation or a foreground daemon.
harness-sync sync
harness-sync watch
```

You can combine the migration and installation after reviewing the plan:

```bash
harness-sync migrate claude --apply --install --force
```

`--apply` snapshots the selected native source surface, builds the capture in a sibling staging directory, validates it, and checks both the source and live canonical baselines before committing staged differences. With `--install`, every target writer is dry-run against that staged tree before the canonical commit, then each takeover of a source-native path covered by the snapshot is guarded by its captured path and content hashes. Backups are placed under `.harness-sync/backups/` and are ignored by the canonical Git store. No existing unmanaged path is replaced without `--force`.

When a forced takeover must rewrite an existing Claude settings file, Codex config, or Antigravity MCP config, its target-local base is also retained under `.harness-sync/.local/preserved/`. Later projections merge that machine-local base underneath canonical values, so unrelated native restrictions and settings survive repeated applies without entering Git.

## Personal/private Git sync

The source-code repository and your configuration repository are intentionally separate. For a private store, choose an external store when initializing the project:

```bash
harness-sync init --store /path/to/private-harness-store/my-project
harness-sync migrate claude --apply --install --force
harness-sync git init
harness-sync git connect git@github.com:you/private-harness.git
harness-sync git sync --push
```

Git operations use the system `git` executable with `shell: false`, so SSH agents and OS credential helpers work without the daemon storing tokens. A built-in secret scan checks every regular store file up to 2 MiB regardless of extension, blocks obvious credential literals unless explicitly overridden, and treats larger, unreadable, non-regular, or symlink entries as blocking findings. Explicit runtime/private roots are excluded, and those paths are refused by Git even if an existing `.gitignore` is wrong. Local changes are frozen with Git's staged-tree primitives, validated from that immutable candidate commit, and activated with an expected-parent ref update so a concurrent `HEAD` change cannot swap in an unreviewed tree.

Remote changes are fetch-only by default. Review them, then accept them explicitly:

```bash
harness-sync git sync
git -C /path/to/private-harness-store/my-project diff HEAD...<reviewCommit>
harness-sync git sync --accept-remote <reviewCommit>
harness-sync apply
```

The fetch-only result prints an immutable `reviewCommit` plus ready-to-run review/accept commands. `--accept-remote <commit>` accepts only that exact, already-fetched full commit ID; a later remote update remains pending for a separate review. Before the live store moves, the exact fast-forward tree—or the combined rebased tree—is checked in an isolated temporary worktree with canonical validation and the secret scanner. Accepted changes to already-linked instructions and skills become visible immediately, while translated/materialized settings remain pending until `apply` or `sync`. Git never force-pushes or hard-resets. On another machine, clone the private store first and point `harness-sync init --store ...` at that clone instead of creating an unrelated store history.

## Canonical store

```text
.harness-sync/
├── harness.yaml                 # portable IR + target overlays
├── instructions/root.md
├── rules/*.md
├── skills/<name>/
│   ├── SKILL.md
│   └── scripts|references|...   # preserved as a bundle
├── agents/<name>.md
└── commands/<name>.md
```

Runtime state, ownership hashes, machine-local preserved bases, backups, conflicts, and `.git/` metadata are excluded from store commits.

When an imported MCP entry depends on a target-only contract—such as Claude project approval/permissions, Codex project trust or per-tool approval, or Antigravity project trust/native OAuth—`harness.yaml` records a `requiredNativeFeatures` marker. Each marker is backed by retained post-redaction overlay data or evidence that the source target's native gate applies. A projection with the matching target and scope restores or relies on that contract; projections without both disable the portable server where their schema supports it, or omit it otherwise, and always warn instead of silently dropping trust, authentication, approval, or startup semantics. Project trust and project-MCP approval markers are project-only; Claude's per-project runtime disable marker and Antigravity's global settings permissions are user-only. Codex non-managed hook trust is bound to an exact definition hash in machine-local UI state, so restoring the hook file alone never satisfies a blocking-hook contract: its dependent MCP server remains disabled even on Codex, with a warning. Generated fail-closed outputs are recognized and never promoted into a matching contract during inverse capture.

The project controller is `harness-sync.yaml`:

```yaml
schemaVersion: 1
scope: project
store: .harness-sync
targets:
  claude: { enabled: true }
  codex: { enabled: true }
  antigravity: { enabled: true }
sync:
  debounceMs: 250
  auditIntervalMs: 30000
  linkMode: symlink
  onConflict: stop
git:
  enabled: false
  autoPush: false
  branch: main
  remote: origin
```

## Current compatibility

| Capability | Claude Code | Codex | Antigravity | Fidelity |
|---|---|---|---|---|
| Root instructions | `CLAUDE.md` | `AGENTS.md` | one of `AGENTS.md` / `GEMINI.md` | Exact body after safe wrapper expansion |
| Skills | `.claude/skills/*` | `.agents/skills/*` | `.agents/skills/*` | Shared bundle/symlink |
| Scoped rules | `.claude/rules/**/*.md` | Root instructions only in v0.1 | `.agents/rules/*.md` | Adapted |
| Subagents | Markdown/frontmatter | `.codex/agents/*.toml` | `.agents/agents/*.md` | Prompt/description + conservative target fallback; native capabilities stay in their source overlay |
| Legacy commands | `.claude/commands/*.md` | Skill projection | Skill projection | Adapted |
| MCP | `.mcp.json` + disable setting | `.codex/config.toml` | `.agents/mcp_config.json` | Common fields + fail-closed controls + raw overlay |
| Hooks | Claude settings | Codex `config.toml` / `hooks.json` | `.agents/hooks.json` | Target-only in v0.1 |
| Permissions | allow/ask/deny | sandbox + approval | Not projected in v0.1 | Same-target mapping; unsupported cross-target policy is warned and left target-local |
| General settings | JSON overlay | TOML overlay | Opaque overlay | Target-only |

For exact paths, scope rules, reload behavior, and documentation discrepancies, see [compatibility.md](docs/compatibility.md).

## Safety model

- Migration is read-only unless `--apply` is supplied.
- Applied migration is captured and validated in a temporary stage; native and canonical baselines are checked immediately before commit, and `--install` preflights every destination first. A native edit detected in the final post-commit check stops installation but intentionally leaves the already-validated canonical capture committed for review.
- Projection never replaces an unmanaged path unless `--force` is supplied.
- Forced replacement first moves the old path to an ignored backup; a relative symlink backup is rewritten so it still resolves to the original target from its deeper backup location. To restore it, recreate a link at the original path to that physical target rather than blindly moving the rewritten link text back.
- Target-only bases needed by rewritten settings/MCP files are kept under ignored `.local/preserved/` storage and merged on later projections.
- `.claude/settings.local.json`, interactive/UI/runtime trust and approval decisions, transcripts, caches, OAuth data, and Antigravity runtime state are never projected or Git-synced by default. The one conservative exception is Claude's documented per-project MCP disabled membership: user-scope migration records only that a captured server depends on this source-native gate so foreign projections stay disabled; it does not copy or rewrite the runtime state.
- `~/.claude.json` is never rewritten; user-scope migration inspects only its documented user MCP definitions and per-project MCP disabled membership.
- Concurrent edits from distinct materialized target files create a conflict record instead of using timestamps.
- Symlinked views are aliases of one canonical inode: edits are immediately shared, and truly simultaneous writes to aliases follow filesystem last-write-wins semantics.
- Deleting an unchanged canonical artifact prunes its managed projections with backups; deleting/replacing a managed link or copied path creates a conflict. Deleting inside a linked skill is a direct canonical deletion and fails validation until restored or explicitly removed from `harness.yaml`.
- New unmanaged native skills/settings remain local until an explicit `migrate --apply`.
- Remote Git changes are fetched for review and are not integrated without `--accept-remote`.
- A reviewed remote candidate is validated in an isolated worktree before it changes the live store.
- Local Git commits likewise validate the exact staged tree before an expected-parent ref update.
- Antigravity project permissions are not emitted because Google does not publish a stable repository-local schema.
- Target-native MCP trust, authentication, approval, and required-startup features are restored only where the target and scope have the matching contract; projections without one are disabled where representable or omitted otherwise.
- Canonical/import bundles must contain regular files and directories: nested symlinks, symlinked child directories, special files, and embedded `.git` metadata are rejected rather than followed, skipped, or silently converted to gitlinks. Unmanaged symlinked recursive-import roots are rejected as well.
- A regular-file source symlink is accepted only inside the selected harness boundary (or when it is an already-managed projection resolving to its exact canonical artifact), and its target bytes participate in migration preconditions. Individual importers may be stricter.

Read [SECURITY.md](SECURITY.md) before enabling hooks or syncing a store between machines.

## Documentation

- [Detailed architecture](docs/architecture.md)
- [Official structure and compatibility matrix](docs/compatibility.md)
- [Claude migration behavior](docs/migration.md)
- [Security policy](SECURITY.md)

## Development

```bash
pnpm check
pnpm test
pnpm build
```

MIT licensed. Contributions are welcome; the primary invariant is that a translation must never silently widen permissions or discard target-only fields.
