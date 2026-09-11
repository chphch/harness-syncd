# Claude auto-import and migration

Migration follows `discover → plan → stage → validate → install preflight → source/canonical checks → commit → project`. Discovery and plan are always read-only; the install preflight and projection phases run only when requested.

```bash
harness-sync migrate claude
harness-sync migrate claude --apply
harness-sync apply --dry-run
harness-sync apply --force
```

Or, after reviewing the plan:

```bash
harness-sync migrate claude --apply --install --force
```

## Imported in project scope

| Source | Canonical destination | Policy |
|---|---|---|
| `CLAUDE.md` | `instructions/root.md` | `.claude/CLAUDE.md` is the fallback; `@AGENTS.md` wrapper is safely expanded |
| `.claude/rules/**/*.md` | `rules/**` | body portable, raw frontmatter retained |
| `.claude/skills/*/` | `skills/*/` | regular-file bundle copied, then optionally linked; nested symlinks, special files, and `.git` rejected |
| `.claude/agents/**/*.md` | `agents/*.md` + manifest | name/description/body portable; native capability frontmatter and original nested path retained for Claude |
| `.claude/commands/*.md` | `commands/*.md` + manifest | projected as skills to Codex/Antigravity |
| `.claude/settings.json` | portable permissions + target-only raw hooks/settings overlay | likely secrets redacted |
| `.mcp.json` | MCP IR + Claude raw server overlay | likely secrets redacted |

`.claude/settings.local.json` is excluded unless `--include-local` is explicit. Even then it is marked local-only and is never projected by the adapter.


`--exclude-skill <name>` drops one native skill directory from the import,
matched by exact directory name and repeatable. The name is read from the
directory entry, so the skill is never opened — which is what lets a migration
proceed past a skill that is itself a symlink to another project, or one whose
bundle contains a nested symlink such as a vendored `node_modules`. An excluded
skill stays unmanaged in the native tree and is not projected; it is not
deleted, and if a skill of that name is already in the canonical harness it
stays there untouched. There is no way to import a bundle while pruning part of
it — exclusion is whole-skill, because a per-entry filter would have to reach
inside the bundle integrity check.

## User scope

User migration reads authored files under `~/.claude` when the project controller uses `scope: user`. Within `~/.claude.json`, it inspects user `mcpServers` plus documented per-project `disabledMcpServers` membership for those captured servers. A disabled membership becomes only a fail-closed source-native requirement so another target cannot start the server without that gate. The file and the rest of its sign-in, OAuth, trust, UI, and project state are never copied or rewritten.

## Redaction

Keys matching token, secret, password, API key, credential, or private key patterns are replaced with environment references:

```yaml
env:
  GITHUB_TOKEN: ${env:GITHUB_TOKEN}
```

The scanner also blocks common high-confidence credential formats before `git sync`. It examines every regular file in the canonical store up to 2 MiB regardless of filename extension. Files over that limit and unreadable, non-regular, symlink, or NUL-containing (binary) entries are blocking findings rather than silent exclusions. Only the root runtime/private paths `.local/`, `backups/`, `conflicts/`, `.state.json`, `.managed.json`, and `.lock`, plus Git metadata directories, are excluded. Redaction is intentionally conservative and is not a substitute for a dedicated secret scanner in CI.

## Takeover and rollback

`--apply` writes only the canonical store unless `--install` is also supplied. Capture happens in a sibling temporary directory; the selected source surface is hash-snapshotted, the staged harness is validated, and both native-source and live-canonical hashes are rechecked before only changed artifacts are committed. With `--install`, every native adapter first runs as a dry projection against the staged store, catching unsafe destination topology before canonical commit. The real projection then applies captured path and content preconditions to each covered source-native path so an edit made after capture stops takeover. Other-target destinations receive the normal ownership/preflight protections but are outside the source snapshot. A later standalone `apply` creates native projections without migration-source preconditions.

Occupied paths are skipped unless `--force` is supplied. A forced takeover moves each old path into the store's ignored `backups/` tree before installing the new file/link. That safety move must stay on one filesystem; a cross-filesystem takeover stops and asks for a manual move instead of falling back to copy-then-delete. A backed-up relative symlink is rewritten so its target remains the same after moving into the deeper backup tree. Recovery should recreate a link at the original location to that physical target; moving the rewritten backup link back verbatim would change its resolution base.

Materialized configuration needs an additional safeguard because rewriting a whole native file could otherwise erase unrelated local policy. Before taking over an unmanaged Claude settings file, Codex config, or Antigravity MCP config, the adapter stores its parsed target-local base under `.harness-sync/.local/preserved/`. Canonical values win when the base is merged on future projections; the base remains machine-local and Git-ignored. An installed migration clears the source target's base after a complete baseline is established, because supported source fields have by then moved into the canonical model or source overlay.

Imported skill bundles may contain only regular files and directories. Nested symlinks, symlinked child directories, FIFOs/devices/other special entries, and embedded `.git` metadata are rejected rather than silently accepted. A skill named by `--exclude-skill` is dropped by directory name before the bundle is opened, so it is never stat'ed, walked, or copied and nothing inside it is inspected or followed; every bundle that IS imported passes the same checks as before. Recursive rules/agents roots may not themselves be unmanaged directory symlinks, and every single-file input is type-checked before reading so a FIFO or device cannot block migration. A symlinked regular-file source is accepted only when it remains inside the selected harness boundary or is an existing managed projection resolving to the exact canonical destination; its target bytes are included in the migration snapshot. Some layouts, including Claude commands and Antigravity agents, reject source symlinks entirely. Known malformed JSON/JSONC/TOML/frontmatter fields fail the staged import. In particular, a Claude remote MCP entry with a URL but no explicit transport `type` is not repaired into an active server.

The daemon never interprets a missing managed link or copied artifact as a deletion; it creates a conflict. Removing shared configuration requires an explicit canonical edit. On apply, an unchanged managed projection is backed up and pruned; an externally changed stale projection is retained and reported. A file removed *inside* a linked skill was removed from the canonical bundle itself, so validation stops rather than creating a separate native-deletion conflict; restore it from Git/backup or remove that skill from `harness.yaml` intentionally.

## Idempotence

After installation, exact artifacts are directory/file links and settings are owned projections recorded by hash. Re-running migration updates canonical content; reconciliation then updates other targets. The daemon inverse-captures only already-owned paths, so a new private skill beside a managed link remains local until another explicit migration.

Import first builds and validates a complete sibling stage, so malformed native configuration or an invalid artifact does not partially update the live canonical store. Commit still replaces changed artifacts one at a time with precondition hashes and recoverable backups; v0.2 does not yet provide an operation-wide journaled rollback for an I/O failure midway through that final commit or native projection. There is also a deliberate boundary after commit: if the source changes during that narrow interval, installation stops while the validated canonical capture remains committed. Review it, rerun migration against the new source, and keep the canonical store in Git before large migrations.
