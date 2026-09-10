# User and project fleet management

`harness-syncd` can supervise one user-level harness and multiple project harnesses in a single foreground process. Each harness keeps its own controller file, canonical store, reconciliation state, conflicts, and optional private Git remote. The registry only records which controllers this machine has explicitly enrolled.

## Controller and registry roles

The portable controller marker lives with its project (or in a dedicated directory for user scope):

```yaml
schemaVersion: 1
controllerId: web-app-4f19a27c
scope: project
store: .harness-sync
targets:
  claude: { enabled: true }
  codex: { enabled: true }
  antigravity: { enabled: true }
```

`controllerId` is generated at `init` and remains stable when the project moves. Legacy markers without an ID remain readable for single-controller commands; `manage add` assigns and persists an ID before enrollment.

The default machine-local registry is `~/.config/harness-sync/registry.yaml`:

```yaml
schemaVersion: 1
controllers:
  - id: personal-12ab34cd
    config: /Users/me/.config/harness-sync/user/harness-sync.yaml
    enabled: true
    watch: true
  - id: web-app-4f19a27c
    config: /Users/me/Projects/web-app/harness-sync.yaml
    enabled: true
    watch: true
discovery:
  roots:
    - /Users/me/Projects
  ignore:
    - "**/.git/**"
    - "**/node_modules/**"
  autoEnroll: false
```

Registry paths are absolute and normalized through existing filesystem ancestors. The file is intentionally not Git-synchronized: project locations, mounts, and enabled/watch choices are machine-local. Pass `--registry /another/path.yaml` before the command to use an alternate registry.

## Enrolling controllers

Create and enroll a project controller:

```bash
harness-sync -C /path/to/project init --register
```

Enroll an existing controller:

```bash
harness-sync manage add /path/to/project
```

Create the single user-scope controller. Its controller directory and canonical store should be separate from all native harness roots:

```bash
harness-sync -C ~/.config/harness-sync/user init \
  --scope user \
  --store ~/.local/share/harness-sync/user \
  --register

harness-sync -C ~/.config/harness-sync/user migrate claude
harness-sync -C ~/.config/harness-sync/user migrate claude --apply --install --force
```

User scope targets the authored surfaces below `~/.claude`, `~/.codex`, and `~/.gemini`; it does not make those complete directories canonical. Only one user-scope controller may be enabled because two would claim the same native surface.

Discovery is read-only and bounded:

```bash
harness-sync manage discover ~/Projects --max-depth 6
```

It ignores symlinked directories, `.git`, and `node_modules`, accepts only valid `harness-sync.yaml` markers, and never mutates the registry. Enrollment always requires a separate `manage add` or `init --register` command.

## Fleet operations

```bash
harness-sync manage list
harness-sync status --all
harness-sync sync --all --concurrency 4
harness-sync watch --all
```

`sync --all` performs a complete preflight before the first reconciliation. It requires every enabled controller to be online, validates exact byte-stable config snapshots and all known path claims, then acquires all selected store locks in sorted physical-path order. A failed preflight or lock acquisition leaves every controller untouched. Once execution starts, outcomes are reported in registry order; one controller conflict does not hide results from the others.

`watch --all` selects controllers whose `enabled` and `watch` flags are both true. It uses the same topology preflight and all-lock barrier, runs the individual reconciliation loops under one abort signal, and watches the registry plus every enabled controller config. A control-file change stops the whole fleet and returns a restart-required error. This fail-closed restart model avoids partially applying a changed topology; dynamic hot reload is intentionally not part of v0.2.

`status --all` includes disabled, missing, and invalid entries. Exit status 2 means an enabled controller or the fleet topology is degraded. `sync --all` uses exit status 2 for reconciliation conflicts and 1 for operational errors.

`-C/--cwd` cannot be combined with `--all`: fleet membership comes only from the registry.

## Local lifecycle and recovery

```bash
harness-sync manage set web-app-4f19a27c --watch false
harness-sync manage set web-app-4f19a27c --enabled false
harness-sync manage remove web-app-4f19a27c
```

Disabling or removing an entry changes only the machine registry. It does not delete the controller, canonical store, projections, backups, or Git history. Missing and invalid entries can always be disabled or removed; re-enabling requires the controller to be online and the full topology to validate.

Run one `watch --all` supervisor per registry. Store locks prevent a second managed writer from operating on the same canonical store, but separate unregistered processes with disjoint store locks cannot know about each other's registry-wide path claims.

For a login service, run the foreground command under the OS service manager and let that manager restart it after a control-file change. Do not configure immediate unlimited restart loops: a persistently invalid registry or controller should remain stopped for inspection.

## Private Git synchronization

Git remains explicit and controller-local:

```bash
harness-sync -C /path/to/project git init
harness-sync -C /path/to/project git connect git@github.com:me/private-harness.git
harness-sync -C /path/to/project git sync --push
```

For the user controller, use its controller directory with `-C`. Remote changes stay fetch-only until accepted by exact commit ID. Fleet reconciliation never pushes Git automatically, and registry metadata never enters the canonical store. If several controllers need remotes, use independent canonical Git repositories; sharing one enclosing worktree would bypass the per-store locking boundary.
