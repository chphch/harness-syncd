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

`watch --all` selects controllers whose `enabled` and `watch` flags are both true. It uses the same topology preflight and all-lock barrier, runs the individual reconciliation loops under one abort signal, and watches the registry plus every enabled controller config. A control-file change — the registry, or any enabled controller's config — stops the whole fleet and returns a restart-required error. This fail-closed restart model avoids partially applying a changed topology; dynamic hot reload is intentionally not part of v0.2.

A controller config that is invalid or missing when the fleet starts is not a controller failure either: planning fails for the whole fleet and the command exits 1 before any controller starts, so no store runs under a half-valid topology. Under a service manager that restarts on failure this repeats at the manager's throttle interval until the config is fixed or the controller is disabled with `manage set <id> --enabled false`.

Every other failure stays inside the controller it happens in, and the rest of the fleet keeps syncing:

- **A watch error on one path** — an entry the watcher cannot watch, such as a permission error on a single file — is reported as a `warning` event and that path is skipped for the life of the process. The watcher only buys latency: the periodic audit (`sync.auditIntervalMs`) still reconciles the skipped path. Unix sockets, FIFOs and devices are skipped when the watcher discovers them; a socket used to raise such an error and a FIFO used to hang the process. One gap remains in chokidar 5.0.0: when a file that is already being watched is replaced by a FIFO under the same name (a rename over it), chokidar re-watches it without consulting the skip rule, and opening the FIFO blocks the whole daemon until something writes to it. Directory-read errors and descriptor exhaustion (`EMFILE`, `ENFILE`, `ENOSPC`) are not path-scoped: they fail the controller as below.
- **A failure with an errno code** (`EMFILE`, `ENOSPC`, `UNKNOWN`, ...) is treated as environmental: that controller alone restarts after a backoff that starts at 10 s, doubles per consecutive failure up to 10 min, and resets after a run of 10 min. Each attempt emits a `restarting` event with the attempt number and delay. A failure that never clears is retried every 10 min indefinitely.
- **A failure without an errno code** is a programming error, which retrying cannot fix. That controller is `parked`: it stays stopped, still holding its store lock (so a manual `sync` of that store is refused), and the `parked` event is repeated every hour with `reminder: true` until the daemon is restarted after the fix. When every controller is parked nothing is syncing, so the process exits 1 instead of idling.
- **A conflict or failure inside a reconciliation cycle** — the store is not stopped by it; the next cycle retries. It is reported as a `result` with `action: "conflict"` (and in `conflicts/current.json`) or as an `error` event with `during: "sync"`.

Each stderr notice is one line starting with an ISO-8601 time (a parked controller's stack frames follow it, indented). The daemon writes one when:

- a controller restarts or is parked (the first park notice includes the stack; a reminder follows hourly);
- a path is skipped, once per controller and path;
- a cycle removes a capture directory that an interrupted run left beside the store, or cannot remove one, once per directory;
- a controller's cycles start to conflict or fail, or change to a different conflict or error — repeated hourly while it persists, with a closing line when a cycle succeeds again; a failed Git backup is reported the same way;
- the process stops: the fatal error, or `stopped by SIGTERM; exiting with status 0` on a signal.

stdout keeps the event stream, one JSON object per line with the global `--json` flag; noop results are left out. Every event carries `at`, `controller` and `config`:

| `type` | Extra fields | Meaning |
|---|---|---|
| `started` | — | A watch loop for the controller is starting (again after each restart). |
| `result` | `result` | One reconciliation cycle finished; `result.action` is `conflict` when it did not apply. |
| `error` | `error`, `during` | `sync`: one cycle failed. `backup`: a Git backup failed. `watch`: the watch loop is stopping; `restarting`, `parked` or a fleet stop follows. |
| `warning` | `path`, `code`, `warning` | The watcher skips this path; the audit still reconciles it. |
| `restarting` | `error`, `attempt`, `delayMs` | Environmental failure; the controller restarts after `delayMs`. |
| `parked` | `error`, `since`, `stack` (first only), `reminder` (repeats) | Not retried until the daemon restarts. |
| `stopped` | — | Sent exactly once per controller when the fleet stops, whether it was running, parked or waiting to restart. |

`status --all` includes disabled, missing, and invalid entries. Exit status 2 means an enabled controller, the fleet topology, or the `watch --all` daemon is degraded. A controller counts as degraded when its config is missing or invalid, when it has an unresolved conflict (`conflicts/current.json`, which the first cycle that no longer conflicts removes), and when the daemon's last report for it shows it parked, waiting to restart, or failing every cycle. That report outlives the daemon: a controller that was parked or restarting when the daemon stopped keeps it as `last`, and still counts, because it is the last thing known about that store until a daemon runs it again. The daemon itself counts as degraded when it is not running and either exited with a failure (`daemon.exit` — every controller parked, say, which a service manager then respawns into the same failure) or ended without recording a stop at all, i.e. it was killed or crashed; `daemon.problem` says which. A daemon stopped by a signal is not degraded by itself. The daemon keeps its report in `<registry name>.health.json` beside the registry (for the default registry, `~/.config/harness-sync/registry.health.json`), rewriting it only when a controller's state changes, and `status --all` shows whether it is running. `sync --all` uses exit status 2 for reconciliation conflicts and 1 for operational errors.

`-C/--cwd` cannot be combined with `--all`: fleet membership comes only from the registry.

## Local lifecycle and recovery

```bash
harness-sync manage set web-app-4f19a27c --watch false
harness-sync manage set web-app-4f19a27c --enabled false
harness-sync manage remove web-app-4f19a27c
```

Disabling or removing an entry changes only the machine registry. It does not delete the controller, canonical store, projections, backups, or Git history. Missing and invalid entries can always be disabled or removed; re-enabling requires the controller to be online and the full topology to validate.

Run one `watch --all` supervisor per registry. Store locks prevent a second managed writer from operating on the same canonical store, but separate unregistered processes with disjoint store locks cannot know about each other's registry-wide path claims.

For a login service, run the foreground command under the OS service manager with restart on failure. The command exits 1 on a control-file change and on every fleet-level failure — an invalid or missing controller config, a topology error, a store lock another process holds, a failed control watcher, or every controller parked — so the manager starts it again against a fresh plan. A single failing controller does not end the process: it is restarted in-process or parked. To notice one, read the daemon's stderr or run `status --all` (exit 2 when degraded); the exit status alone will not show it.

A signal is the only way the command exits 0, and it says so on stderr. The stop takes milliseconds: an in-flight cycle finishes, every controller reports `stopped`, the stop is recorded in the health file and the store locks are released, and then the process exits without closing its file watchers. Closing them costs O(n²) in watched directories on macOS (about 8 s for 1,000 directories and 29 s for the user store), longer than launchd's default 5 s exit timeout, and a daemon SIGKILLed partway through its stop recorded nothing. A manager that restarts only on failure — launchd `KeepAlive` with `SuccessfulExit` false, systemd `Restart=on-failure` — therefore does not relaunch a daemon stopped with a plain `kill`. Restart it through the manager instead: `launchctl kickstart -k gui/$(id -u)/<label>` or `systemctl --user restart <unit>`. A persistently invalid config makes the manager restart the daemon at its throttle interval (launchd `ThrottleInterval`, default 10 s; systemd `RestartSec`), writing one error line each time; choose an interval you are willing to see repeated until the config is fixed.

## Private Git synchronization

Git remains explicit and controller-local:

```bash
harness-sync -C /path/to/project git init
harness-sync -C /path/to/project git connect git@github.com:me/private-harness.git
harness-sync -C /path/to/project git sync --push
```

For the user controller, use its controller directory with `-C`. Remote changes stay fetch-only until accepted by exact commit ID. Fleet reconciliation never pushes Git automatically, and registry metadata never enters the canonical store. If several controllers need remotes, use independent canonical Git repositories; sharing one enclosing worktree would bypass the per-store locking boundary.
