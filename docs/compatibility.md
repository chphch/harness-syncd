# Official structures and compatibility

Verified against official documentation on **2026-09-10**. Native formats evolve quickly; well-formed unknown keys are overlays, while malformed documented fields stop import.

## Path matrix

| Capability | Claude Code project | Codex project | Antigravity project |
|---|---|---|---|
| Instructions | `CLAUDE.md`, `.claude/CLAUDE.md`, nested `CLAUDE.md` | root-to-CWD `AGENTS.override.md` / `AGENTS.md` | `AGENTS.md` or `GEMINI.md` |
| Scoped rules | `.claude/rules/**/*.md` | `AGENTS.md` hierarchy; execution rules in `.codex/rules/*.rules` | `.agents/rules/*.md` |
| Skills | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| Subagents | `.claude/agents/**/*.md` | `.codex/agents/*.toml` | `.agents/agents/<name>.md` or `<name>/agent.md` |
| Commands | `.claude/commands/*.md` (legacy) | Prefer skills | Legacy workflows are migrating to skills |
| Settings | `.claude/settings.json` | `.codex/config.toml` | No stable repository-local general settings schema |
| MCP | `.mcp.json` | `mcp_servers` in `.codex/config.toml` | `.agents/mcp_config.json` |
| Hooks | `hooks` in `.claude/settings.json` | `.codex/config.toml` or `.codex/hooks.json` | `.agents/hooks.json` |

| Capability | Claude Code user | Codex user | Antigravity user |
|---|---|---|---|
| Instructions | `~/.claude/CLAUDE.md` | `$CODEX_HOME/AGENTS.override.md` or `AGENTS.md` | `~/.gemini/GEMINI.md` |
| Rules | `~/.claude/rules/**/*.md` | global `AGENTS.md`; execution rules under `$CODEX_HOME/rules` | No public global rule directory guarantee |
| Skills | `~/.claude/skills/<name>` | `~/.agents/skills/<name>` | see three-variant note below |
| Subagents | `~/.claude/agents/**/*.md` | `$CODEX_HOME/agents/*.toml` | `~/.gemini/config/agents/...` |
| Settings | `~/.claude/settings.json` | `~/.codex/config.toml` | `~/.gemini/antigravity-cli/settings.json`; 2.0 config is mostly opaque |
| MCP | `mcpServers` plus project disable membership in `~/.claude.json` | `mcp_servers` in config TOML | `~/.gemini/config/mcp_config.json` |
| Hooks | user settings JSON | `$CODEX_HOME/config.toml` or `$CODEX_HOME/hooks.json` | `~/.gemini/config/hooks.json` |

## Capability mapping

### Instructions

The root Markdown body is byte-shared. `CLAUDE.md` and `AGENTS.md` point to the same canonical file. Claude officially documents both `CLAUDE.md -> AGENTS.md` symlinks and `@AGENTS.md` imports. Codex concatenates one instruction file per directory from repository root to CWD, preferring `AGENTS.override.md`. Antigravity recognizes both `AGENTS.md` and `GEMINI.md`; the adapter manages one active name, retains a lone existing `GEMINI.md` fallback, and refuses an ambiguous pair unless `--force` backs up and retires the fallback.

v0.2 imports one root Claude instruction source (root `CLAUDE.md`, falling back to `.claude/CLAUDE.md`). The common official `CLAUDE.md` wrapper line `@AGENTS.md` is expanded during migration so projecting the result back to `AGENTS.md` cannot create a self-import. Other recursive/nested imports and instruction scopes are a planned artifact type rather than being flattened.

### Skills

This is the strongest common surface. All three use a directory bundle with `SKILL.md` plus optional supporting assets. Only `name` and `description` are treated as cross-client metadata guarantees. Extra frontmatter and regular-file assets remain byte-identical because the whole bundle is shared rather than reserialized, but each client may interpret them differently. Nested symlinks and embedded `.git` directories are rejected on import so external content cannot escape canonical hashing or become an unrecoverable gitlink. An unmanaged native source that itself resolves through a symlink outside the selected harness root is also rejected; the only external link accepted as an import source is an already-managed projection that resolves to its exact canonical artifact.

Claude and Codex explicitly follow symlinked skill folders. Antigravity's official paths share `.agents/skills` with Codex, and Google's official `agents-cli` setup uses per-skill links for Antigravity clients.

Antigravity global paths conflict across official surfaces:

- 2.0: `~/.gemini/config/skills`
- CLI: `~/.gemini/antigravity-cli/skills`
- IDE: `~/.gemini/antigravity/skills`

The user-scope adapter links each skill into all three without replacing any parent directory.

Some official Antigravity CLI material also shows standalone Markdown files directly under its skill root. The importer accepts both standalone files and `SKILL.md` bundles; canonical output is always the bundle form used by the 2.0/IDE documentation and Google's first-party link implementation.

### Rules

Claude rules support recursive Markdown and `paths:` activation. Antigravity rules support activation modes, but its complete stable frontmatter schema is not published. Canonical rule bodies are shared; target frontmatter is retained in overlays and path globs are adapted conservatively. Codex's `.rules` files are execution-policy programs, not Markdown instructions, so v0.2 does not translate instruction rules into them.

### Subagents

The portable core is name, description, and system-prompt body. Claude and Antigravity use Markdown/frontmatter; Codex uses TOML. Raw target fields are retained under `agents.<name>.targets.<target>`. Imported nested Claude paths and Antigravity file-versus-`<name>/agent.md` bundle layouts are retained in `nativePaths` so re-projection does not create a duplicate agent definition at a normalized path.

Model identifiers, reasoning levels, filesystem modes, tool identifiers, permission modes, and inline MCP declarations are target-specific. For example, Claude's `Bash` and Antigravity's `run_command` are never copied as though they were the same permission. They are restored only to the target from which their raw overlay came.

When an imported agent has no overlay for another enabled harness, the portable name/description/prompt is still projected with a conservative destination-native fallback and an explicit `agent-capabilities-conservative-fallback` warning:

- Claude receives `tools: [Read, Glob, Grep]` and `permissionMode: plan`.
- Codex receives `sandbox_mode: read-only`, `approval_policy: untrusted`, and `web_search: disabled`.
- Antigravity receives an explicit empty `tools` list.

An explicit destination overlay overrides that fallback. Generic canonical model/tool/filesystem fields are mapped only where the destination has a documented equivalent; Antigravity model and tool identifiers are not guessed. A target-native overlay containing a redacted credential is not emitted to a target that cannot expand it safely.

### Commands and workflows

Claude's `.claude/commands` format is legacy but supported. Codex and Antigravity prefer skills. The importer keeps a command prompt as a canonical artifact and emits a minimal `SKILL.md` bundle to the other two clients. Antigravity workflows are deprecated and scheduled to retire on 2026-11-01, so the tool does not generate new workflow files.

### MCP

The IR can retain stdio command/args/cwd/env, remote URL, headers, enabled state, tool filters, and timeouts. Each renderer emits only the fields documented for that target; unsupported fields remain target-only or produce a warning. Raw unknown per-server tables remain in target overlays for servers that still exist canonically.

- Claude project MCP uses `{ "mcpServers": ... }` in `.mcp.json`.
- Codex uses `[mcp_servers.<name>]` in TOML.
- Antigravity uses `{ "mcpServers": ... }`; current docs require `serverUrl` for remote transports.

A Claude remote entry must carry its explicit documented `type`; a URL-only entry is rejected because Claude otherwise interprets the missing type as stdio. Source import also enforces each native URL key: Claude and Codex require `url`, while Antigravity requires `serverUrl`; legacy/cross-client aliases are rejected rather than repaired into active servers. Claude supports HTTP, deprecated SSE, and WebSocket remote entries. Codex v0.2 projects only stdio and streamable HTTP. Antigravity uses `serverUrl` for remote transports: `wss://` unambiguously imports as WebSocket, while an HTTP(S) URL cannot prove SSE versus streamable HTTP from the published shape alone. That ambiguity is retained as an Antigravity-native transport contract until a user explicitly reclassifies it.

Environment templates are normalized only where their native meaning is documented. The canonical form is `${env:VAR}`. A standalone Claude `${VAR}` value in a supported environment field can be normalized; embedded/default Claude templates stay raw. A literal `${VAR}` in Codex or Antigravity is not treated as an environment reference, and a native-feature marker prevents a later Claude projection from accidentally interpreting it as one.

Claude's built-in-reserved MCP server names are rejected during Claude import. Claude itself skips those user definitions; importing one under the same name into another harness would otherwise turn an inert entry into an executable server.

Claude does not document `enabled` or per-server tool filters inside `.mcp.json`. The adapter therefore omits those keys. Canonically disabled servers are added to Claude's documented `disabledMcpjsonServers` setting; a server with a tool allow/deny filter is disabled entirely with a warning because starting it without an enforceable filter would widen access. Claude's interactive `/mcp` state in `~/.claude.json` is not rewritten or copied verbatim. During user-scope import, documented per-project `disabledMcpServers` membership for a captured user server becomes a fail-closed Claude-native requirement so foreign projections cannot silently activate it. Authored project approval controls such as `enableAllProjectMcpServers` and `enabledMcpjsonServers` in `.claude/settings.json` are likewise retained as Claude-only contracts. Claude's documented per-server `timeout` is emitted as the MCP tool-call timeout. A distinct per-server startup timeout remains canonical and emits a warning because Claude exposes startup timeout control through the `MCP_TIMEOUT` process environment variable instead.

Antigravity documents `disabledTools` but not an `enabledTools` allowlist. A canonical server with `enabledTools` is therefore emitted disabled, with a warning, rather than started with a wider tool set. Existing target-local Antigravity MCP controls are retained in the ignored machine-local base and merged underneath canonical values on later projections.

Authentication, approval, policy, transport, and startup contracts that have no proven equivalent are target-native and fail closed. Claude contracts include `oauth`, `headersHelper`, `alwaysLoad: true`, authored project enable/allow/deny controls, inherent project-MCP approval/trust, restrictive MCP `ask`/`deny`/`plan`/`dontAsk` permissions, and MCP-matching `PreToolUse` or `PermissionRequest` hooks. Codex contracts include project trust, MCP-blocking hooks, authentication/OAuth/resource/scopes, header helpers, remote environment placement, `default_tools_approval_mode`, per-tool `approval_mode`, and `required: true`. Codex requires every non-managed hook's exact definition to be reviewed in machine-local UI state; harness-sync restores the definition but cannot sync that trust decision, so an MCP server dependent on the hook stays disabled on Codex with a warning. Antigravity contracts include project trust, ambiguous HTTP(S) remote transport, user MCP `ask`/`deny` permissions, global or MCP-matching `PreToolUse` hooks, and native authentication.

The canonical server carries a validated `requiredNativeFeatures` marker backed by retained post-redaction overlay data or evidence that the source target's native gate applies. A projection with the matching target and scope restores or relies on that contract. Project trust and project-MCP approval evidence is project-only; Claude's per-project runtime disable marker and Antigravity's global settings permissions are user-only in v0.2. A projection without the matching target and scope disables the server where representable, or omits it otherwise, and emits `mcp-target-feature-not-projected`; it never claims two similarly named gates are equivalent. Generated fail-closed output is excluded from inverse-capture promotion. Because Claude policies can merge across scopes and match expanded wildcard URLs/commands, v0.2 conservatively marks every imported server as policy-dependent whenever a nontrivial project allow/deny policy exists instead of attempting a weaker partial evaluator. Redacted values outside a target's documented expansion fields also disable the server even on the source target rather than leaving partial authentication active.

OAuth payloads and likely literal credentials are not projected across targets. Redaction and scanning are heuristic, so a private store still requires normal secret-scanning discipline. `~/.claude.json` mixes MCP with OAuth, trust, UI, and project state, so only user MCP definitions and their documented per-project disabled membership are inspected; the file is never rewritten.

### Hooks

Event names overlap but execution contracts differ. v0.2 keeps imported hooks in target-native raw overlays and does not project them across clients. MCP-relevant blocking hooks conservatively mark the captured MCP servers' native contracts so moving them cannot silently remove a restriction. For Codex, the raw hook is restored but its separate exact-hash trust decision remains machine-local, so a dependent server is not enabled automatically. A future dispatcher will normalize native stdin/tool names and translate decisions through:

```text
harness-sync hook dispatch <hook-id> --target <target>
```

Hooks fetched from Git must be treated as executable code. Remote integration is explicit, and materialized hook changes require a later `apply`/`sync`; already-linked skill scripts become visible as soon as a reviewed revision is accepted.

### Permissions

Permission translation is conservative and explicit:

- Claude: `allow`, `ask`, `deny`, plus permission modes.
- Codex: `approval_policy`, `sandbox_mode`, sandbox network settings, and executable rules.
- Antigravity: `deny > ask > allow` resource expressions, but no stable repository-local settings file is documented.

v0.2 maps Claude's arrays within Claude and Codex's sandbox/approval within Codex. It does not synthesize Antigravity project permissions or translate arbitrary shell/regex rules. Unsupported cross-target policy emits a fidelity warning instead of being presented as an equivalent restriction, while a pre-existing target-local policy is retained through takeover.

### General settings

There is no universal settings schema. Known portable fields are normalized; everything else imported from the source stays in `overlays.<target>.settings`. Project-local, machine-local, user, managed, and CLI scopes are never flattened because their precedence and trust behavior differ.

If projection must take over an unmanaged Claude settings file, Codex config, or Antigravity MCP config, its parsed target-local base is stored under `.local/preserved/`, excluded from Git, and merged underneath canonical/overlay values on subsequent projections. Lifecycle-managed agent declarations are excluded from the Codex base so deleting a canonical agent can still prune its declaration. After an installed migration successfully establishes the source target's baseline, that source's temporary base is cleared because its supported content has been captured into the canonical model and source overlay.

JSON/TOML projections are semantic, not formatting-preserving in v0.2: comments, key order, and trailing-comma style can be normalized. Reconciliation parses Antigravity JSONC semantically, so a comment-only rewrite is a no-op. Malformed JSON/JSONC/TOML, malformed frontmatter, conflicting aliases, and wrong types for documented MCP controls stop the operation instead of accepting a partial parse.

## Explicitly out of scope in v0.2

- Recursive nested instruction scopes and Codex `AGENTS.override.md`
- Claude `CLAUDE.local.md`, output styles, worktree include files, plugin registries, and agent-memory directories
- Antigravity legacy `.agent`/`_agent` roots, project discovery manifests, plugins/registries, and `.antigravityignore`
- Cross-client hook execution, model/tool-ID translation, and operation-wide transactional rollback

## Reload behavior

| Surface | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Skill `SKILL.md` | Existing skills roots hot-reload | Re-read by native discovery/session behavior | Client-dependent; native files remain valid |
| Root instructions | Next session; Claude re-reads after compaction | New run/session | Client-dependent |
| Settings | Most Claude settings hot-reload | Some settings require a new run | Client-dependent |
| Subagents | Existing Claude agent roots hot-reload | New session/config load | Client-dependent |
| MCP/hooks | Reload guarantees vary | Reload guarantees vary | MCP UI supports manual reload |

The daemon reports filesystem convergence, not that an already-running model context was retroactively changed.

## Never-synced state

```text
~/.claude/.credentials.json
~/.claude/projects/ and transcripts/history/cache
~/.claude.json as a whole (only user MCP definitions and per-project disabled membership are inspected)
.claude/settings.local.json by default
Claude interactive/UI/runtime trust and MCP approval state (only disabled membership evidence for captured user MCP servers can become a fail-closed marker)
Codex non-managed hook review/trust decisions

~/.gemini/**/brain, conversations, cache, logs
~/.gemini/antigravity/mcp_oauth_tokens.json
~/.gemini/config/projects (opaque/read-only in v0.2)
installation IDs, generated worktrees, OAuth tokens
```

## Official sources

Claude Code:

- [Explore the `.claude` directory](https://code.claude.com/docs/en/claude-directory)
- [Memory, `CLAUDE.md`, rules, imports, and symlinks](https://code.claude.com/docs/en/memory)
- [Skills and skill-folder symlinks](https://code.claude.com/docs/en/skills)
- [Settings scopes and precedence](https://code.claude.com/docs/en/settings)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Managed MCP allowlists and denylists](https://code.claude.com/docs/en/managed-mcp)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Hooks](https://code.claude.com/docs/en/hooks)

Codex:

- [AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md)
- [Skills and official locations](https://developers.openai.com/codex/skills)
- [Subagents and `.codex/agents/*.toml`](https://developers.openai.com/codex/subagents)
- [MCP](https://developers.openai.com/codex/mcp)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [`config.toml` reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Current `config.toml` schema source](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [Current `config.toml` parser source](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs)

Google Antigravity:

- [Skills](https://antigravity.google/docs/skills/)
- [Rules and workflows](https://antigravity.google/docs/rules-workflows)
- [Subagents](https://antigravity.google/docs/subagents)
- [MCP](https://antigravity.google/docs/mcp)
- [Hooks](https://antigravity.google/docs/hooks)
- [Permissions](https://antigravity.google/docs/permissions/)
- [CLI project trust](https://antigravity.google/docs/cli-getting-started)
- [Official `agents-cli` Antigravity link implementation](https://github.com/google/agents-cli/blob/main/src/google/agents/cli/setup/_antigravity.py)
