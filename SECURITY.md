# Security

Harness configuration is executable configuration. Skills can instruct an agent to run commands, hooks execute commands directly, and MCP entries can launch local processes or send data to remote services. A store can also carry the hook scripts themselves — real executables, projected with their executable bit intact — so a synchronized store may contain code that runs without an agent ever deciding to run it. A store may also **carry** ordinary files that are not harness configuration at all — one home-directory destination each, copied verbatim. A carried file may be an executable, and its destination may be a `PATH` directory or one a service manager reads at login. harness-syncd never writes a carried file to a destination on any machine: carrying is a backup, and restoring is something you do yourself.

## Defaults

- Migration is dry-run by default.
- Unmanaged paths are never replaced without `--force`.
- Forced paths are backed up before replacement.
- Secret-like values are converted to environment references during import when a supported pattern is recognized.
- Applied native capture is built and validated in a sibling stage; source/canonical hashes are rechecked, and an installed migration preflights every destination before canonical differences are committed.
- Git sync runs a local secret scan, refuses tracked/staged runtime paths, and uses system Git without a shell. A local commit is created from the exact staged tree, validated in isolation, and activated only if the branch still has its expected parent.
- Remote changes are fetch-only until `--accept-remote` is explicit, and the accepted candidate is validated in an isolated temporary worktree before the live store moves.
- Git sync never force-pushes or hard-resets.
- Simultaneous changes to distinct materialized target files stop with a conflict. Symlink aliases share one inode and therefore keep normal filesystem last-writer behavior.
- Unsupported cross-target permission mappings are not synthesized as equivalents: they emit warnings, and existing target-local policies are retained through takeover.
- Target-native MCP trust, approval, restrictive permission/hook, authentication, remote-environment, and required/eager-startup contracts are used only where a matching target-and-scope contract exists; projections without one disable the whole server where supported or omit it otherwise instead of silently widening or changing its runtime behavior.
- Codex non-managed hook trust is machine-local and keyed to the exact hook definition. Syncing the hook file does not sync that review decision, so MCP servers that depend on such a hook remain disabled on Codex until the configuration is explicitly handled outside the portable contract.
- Fleet membership is explicit. Discovery never enrolls a controller, the registry is machine-local, and a registry identity must match the stable `controllerId` in the controller file.
- Fleet writes validate controller/store/native/managed-path separation, capture stable config bytes, acquire every selected store lock before the first mutation, and fail closed if control files change.

## Multi-controller boundary

Treat `~/.config/harness-sync/registry.yaml` as trusted machine policy. It selects which controller files and native surfaces a single supervisor may write. The loader rejects symlinked registry files, relative controller paths, duplicate physical controller files, unknown fields, and automatic-enrollment settings. Registry mutations use their own lock and atomic replacement.

Only one user-scope controller can be enabled. Project controllers may be added only when their controller files, stores, adapter watch paths, and retained `.managed.json` claims do not overlap another enabled controller. Both a symlink's native directory entry and its live or future target are claims; a dangling link cannot reserve an invisible path that later becomes another store.

Run a single `watch --all` process for each registry. It holds all selected store locks and stops the fleet when the registry or an enabled controller config changes. Standalone processes using different, unregistered stores cannot coordinate registry-wide claims, so do not run them concurrently against native surfaces supervised by the fleet.

The registry is not part of private Git synchronization. This prevents one machine's paths and enrollment choices from silently authorizing writes on another machine. Enroll controllers separately after cloning and reviewing their private canonical stores.

## Excluded sensitive state

Never point a canonical store at a complete `~/.claude`, `~/.codex`, or `~/.gemini` tree. The adapters select authored subtrees only. Credentials, OAuth tokens, transcripts, trust decisions, caches, browser state, and conversations are outside the Git-synchronized authored boundary; ignored takeover bases and backups are the local exceptions described below.

`~/.claude.json` is especially sensitive because it combines personal MCP data with authentication, trust, UI, and per-project state. The Claude adapter never rewrites it. During user-scope import, it inspects user MCP definitions and documented per-project `disabledMcpServers` membership only. That membership is not copied verbatim, but it can add a fail-closed source-native marker to a captured server so another target cannot silently activate it. Other interactive/UI/runtime MCP approval state remains machine-local; authored project approval settings such as `enableAllProjectMcpServers` and `enabledMcpjsonServers` in `.claude/settings.json` remain Claude-only but can be retained in the canonical overlay and Git-synced.

## Private Git stores

Use a private remote and protect it like source code with execution privileges. Review `HEAD...<reviewCommit>`, then pass that exact full ID to `--accept-remote <reviewCommit>`, especially for **carried files**, hook scripts, hooks, MCP commands, skills with scripts, and agents with broad permissions. Carried files lead that list because their content is arbitrary and their executable bit is invisible in a diff: the bit is part of the content hash, the store preserves the source mode, and Git records `100755`. setuid, setgid and sticky files are refused at capture instead, because a copy cannot preserve them — measured, copying a `4755` source yields `0755`, and both sides then hash equal, so nothing downstream would notice the downgrade. Accepting a commit that DELETES a carried file is refused by default, since the store copy may be the only one left; `--allow-carry-removal` is the deliberate override. A branch tip that moves afterward is not implicitly trusted. Accepted changes to symlinked instructions/skills are immediately visible; translated settings change only after a later apply/sync. Prefer SSH agents or an OS credential helper; credential-bearing remote URLs are rejected.

The built-in scanner catches common patterns but cannot prove that a tree is secret-free. A line the scanner flags can be pre-approved by a reviewed `secretAllowlist` entry in `harness.yaml`, keyed on the path, the rule, and a hash of that line's bytes — edit the line and the approval lapses, so an approval cannot widen to cover a credential that arrives later. Whole-file findings (oversized, unreadable, non-regular, symlink, binary) carry no line to pin and cannot be pre-approved at all; their only escape remains the one-shot `--allow-secrets`, which now reports what it let through. It scans every regular file up to 2 MiB regardless of extension; an oversized, unreadable, non-regular, symlink, or NUL-containing (binary) entry is a blocking finding rather than silently skipped. It intentionally does not stage or scan the root `.local/`, `backups/`, `conflicts/`, `.state.json`, `.managed.json`, or `.lock` runtime paths, and it skips `.git` metadata and `__pycache__` directories at any depth. Git path checks separately refuse runtime/private paths even if ignore rules are wrong. Run an established secret scanner in the private repository's pre-commit/CI workflow as an additional layer.

Migration redacts likely credentials from the canonical store. Installing a translated projection may therefore omit a secret-bearing native field until the documented environment variable or a machine-local native overlay is configured. Keep the forced-takeover backup until the migrated harness is verified.

Forced takeover of an existing Claude settings file, Codex config, or Antigravity MCP config may retain its parsed target-local base under `.local/preserved/` so later whole-file rewrites do not discard unrelated restrictions or settings. These bases and forced-replacement backups can contain the original native values: both are machine-local, excluded from scanning and Git, and must be protected or removed like other credential-bearing local configuration.

Imported and canonical bundles must contain regular files and directories. Nested symlinks, symlinked child directories, special files, embedded `.git` metadata, unmanaged directory symlinks at recursive import roots, and native import paths that resolve outside the selected harness root are rejected. Accepted regular-file source links are content-hashed only inside the selected boundary. Forced backups preserve the physical target of relative symlinks after relocation; recovery must recreate the link for its original location rather than move the rewritten link text back verbatim. Name-based import exclusion narrows what is read and never relaxes these checks: an excluded path is not opened, and no check is skipped for a path that is imported. Do not replace those checks with unrestricted symlink following when handling untrusted configuration.

## Carried files

A carried file is captured, never projected. There is no code path in this version that writes or deletes anything outside the canonical store on behalf of `carry`: no `applyCarry`, no managed-writer participation, no `mkdir`, `unlink` or `rename` outside the store. Every carried byte is written through the store-bounded copy helpers, which re-assert containment before and after the write. The worst case for your data is that a capture reports something and writes nothing.

Four rules bound what can be captured:

- **Destinations are `~/`-rooted and physically contained in `$HOME`**, resolved through symlinks rather than compared lexically. A destination that overlaps the store, the controller file, a target root, or any path an adapter watches or already claims in `.managed.json` is refused — including for a target that is currently disabled. `~/.claude/plugins` is carryable today only because no adapter claims it; the day one does, the guard refuses it automatically.
- **A directory entry must list include patterns.** There is no "everything in the directory" default. Patterns are basename-only globs (`*` and `?`), compiled with every other character escaped and both ends anchored, so a pattern arriving from a remote cannot be a regular expression.
- **Every selected file passes a per-file gate before it is copied**: regular files only (a per-file copy dereferences a symlink), never a denied basename such as `.env` or `id_rsa`, under the 2 MiB scan limit, no NUL bytes, no setuid/setgid/sticky, and no blocking secret finding. A file that fails is refused *into* the store with a warning, and the previous store copy is kept — the opposite direction would trade one file for every future backup of the whole store.
- **Capture is machine-local and off by default.** `carry.enabled` lives in `harness-sync.yaml`, is never written by Git, and must be the literal boolean `true`; `"true"`, `"yes"` and `1` all leave it off. A fresh clone therefore never becomes an authority on a payload it has never seen. The record of what this machine has captured lives in `.local/carry/ledger.json`, and carry refuses to write it unless the store's `.gitignore` excludes `/.local/`.

The secret scanner reads carried files like any other store file, and one rule exists specifically for them: a plist writes `<key>NAME</key>` and `<string>VALUE</string>` on two lines, which every single-line rule missed. A compound quoted JSON key such as `"api_token"` is still not matched, so review what a plist's `EnvironmentVariables` dict holds — `carry add` prints the selection, but that is a prompt for a person, not a gate.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for the repository. Do not open a public issue containing credentials, private harness content, or an exploit that would put existing users at risk.
