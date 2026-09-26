import chokidar, { type FSWatcher } from "chokidar";
import { join, resolve } from "node:path";
import { getAdapter } from "../adapters/index.js";
import type { Scope, SyncConflict, TargetName } from "../types.js";
import {
  acquireLock,
  readTextIfExists,
  resolvePhysicalPath,
} from "./fs.js";
import { getGitStatus } from "./git.js";
import {
  controllerHealthProblem,
  fleetDaemonProblem,
  fleetHealthIsLive,
  readFleetHealth,
  type ControllerHealth,
  type FleetExit,
} from "./fleet-health.js";
import {
  inspectControllers,
  loadRegistry,
  validateLoadedControllerTopology,
  validateControllerTopology,
  type ControllerRegistry,
  type ListedController,
  type RegistryController,
} from "./registry.js";
import {
  adapterContext,
  enabledTargets,
  loadProject,
  type LoadedProject,
} from "./project.js";
import {
  readConflictRecord,
  reconcileOnce,
  type ReconcileResult,
} from "./reconcile.js";
import { readState } from "./state.js";
import {
  closeWatcher,
  leaveWatcherOpen,
  watchProject,
  type WatchErrorKind,
} from "./daemon.js";

export type ControllerPlanIntent = "sync" | "watch";

export interface PlannedController {
  id: string;
  configPath: string;
  project: LoadedProject;
  configSnapshot: string;
}

export interface ControllerPlan {
  registryPath: string;
  registrySnapshot: string | null;
  registry: ControllerRegistry;
  configObservations: Array<{
    id: string;
    configPath: string;
    snapshot: string | null;
  }>;
  controllers: PlannedController[];
}

export type ControllerOutcome<T> =
  | {
      id: string;
      configPath: string;
      status: "ok";
      value: T;
    }
  | {
      id: string;
      configPath: string;
      status: "conflict" | "error" | "missing" | "invalid" | "disabled";
      error?: string;
      value?: T;
    };

export interface FleetSyncResult {
  registry: string;
  controllers: Array<ControllerOutcome<ReconcileResult>>;
  summary: {
    total: number;
    ok: number;
    conflicts: number;
    errors: number;
  };
}

export interface ProjectStatusValue {
  scope: Scope;
  store: string;
  watch: boolean;
  targets: Array<{
    target: TargetName;
    root: string;
    fingerprint: string;
  }>;
  state: Awaited<ReturnType<typeof readState>>;
  /** The unresolved conflict, if the last reconciliation ended in one. */
  conflict: SyncConflict | null;
  /**
   * What the `watch --all` daemon last recorded for it. `daemon.running` on
   * the fleet result says whether that daemon is still running.
   */
  daemon?: ControllerHealth;
  git: Awaited<ReturnType<typeof getGitStatus>>;
}

export interface FleetStatusResult {
  registry: string;
  /** Whether a `watch --all` supervisor for this registry is running now. */
  daemon: {
    running: boolean;
    pid?: number;
    startedAt?: string;
    updatedAt?: string;
    stoppedAt?: string;
    exit?: FleetExit;
    /** Why the daemon itself counts as degraded: it failed, or it crashed. */
    problem?: string;
  };
  topologyError?: string;
  controllers: Array<ControllerOutcome<ProjectStatusValue>>;
  summary: {
    total: number;
    enabled: number;
    degraded: number;
  };
}

export type FleetWatchEvent =
  | {
      type: "started" | "stopped";
      id: string;
      configPath: string;
    }
  | {
      type: "result";
      id: string;
      configPath: string;
      result: ReconcileResult;
    }
  | {
      type: "error";
      id: string;
      configPath: string;
      error: string;
      /**
       * What failed: a reconciliation cycle, a Git backup, or the controller's
       * watch loop itself (a restarting/parked event follows that one).
       */
      during?: WatchErrorKind;
    }
  | {
      /** One path this controller's watcher skipped; the audit still covers it. */
      type: "warning";
      id: string;
      configPath: string;
      path: string;
      code?: string;
      warning: string;
    }
  | {
      /** An environmental (errno) failure; this controller restarts after delayMs. */
      type: "restarting";
      id: string;
      configPath: string;
      error: string;
      attempt: number;
      delayMs: number;
    }
  | {
      /**
       * A failure retrying cannot fix; this controller stays stopped. Sent
       * again every parkedReminderMs, with `reminder: true`, for as long as it
       * stays parked, so the log keeps saying so.
       */
      type: "parked";
      id: string;
      configPath: string;
      error: string;
      /** When the controller was parked. */
      since: string;
      /** Only on the first notice. */
      stack?: string;
      reminder?: true;
    };

export interface RestartPolicy {
  /** Delay before the first restart; it doubles per consecutive failure. */
  baseMs: number;
  /** Ceiling for the doubled delay. */
  maxMs: number;
  /** A run at least this long counts as healthy and resets the backoff. */
  healthyAfterMs: number;
  /** How often a parked controller is reported again. */
  parkedReminderMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseMs: 10_000,
  maxMs: 600_000,
  healthyAfterMs: 600_000,
  parkedReminderMs: 3_600_000,
};

export interface WatchAllOptions {
  registryPath: string;
  signal?: AbortSignal;
  onEvent?: (event: FleetWatchEvent) => void;
  /** Overrides for DEFAULT_RESTART_POLICY; tests shrink the delays. */
  restartPolicy?: Partial<RestartPolicy>;
  /**
   * Leave every watcher open when the fleet stops and hand its close here
   * instead (daemon.ts leaveWatcherOpen): for a caller that exits right after,
   * so that a stop finishes in milliseconds rather than tens of seconds.
   */
  deferWatcherClose?: (close: () => Promise<void>) => void;
}

/**
 * The marker daemon.ts restartError() writes when a controller's config
 * changed. Only a fresh plan can load new roots and policy, so this failure
 * still stops the whole fleet for the service manager to restart.
 */
const FLEET_RESTART_MARKER = "restart harness-sync watch";

/**
 * An errno-style code (EMFILE, ENOSPC, UNKNOWN, ...) marks an environmental
 * failure that may clear by itself, so it is retried. Node's own `ERR_*`
 * codes are programming errors and are not.
 */
function hasErrnoCode(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^(?:E[A-Z0-9]+|UNKNOWN)$/u.test(code);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) {
      resolvePromise();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePromise();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function planControllers(
  registryPath: string,
  intent: ControllerPlanIntent,
): Promise<ControllerPlan> {
  const absoluteRegistry = resolve(registryPath);
  const registrySnapshot = await readTextIfExists(absoluteRegistry);
  const registry = await loadRegistry(absoluteRegistry);
  if ((await readTextIfExists(absoluteRegistry)) !== registrySnapshot) {
    throw new Error(`controller registry changed while being read: ${absoluteRegistry}`);
  }

  const selectedIds = new Set(
    registry.controllers
      .filter((entry) => entry.enabled && (intent !== "watch" || entry.watch))
      .map((entry) => entry.id),
  );
  if (selectedIds.size === 0) {
    throw new Error(
      intent === "watch"
        ? `no enabled, watchable controllers in ${absoluteRegistry}`
        : `no enabled controllers in ${absoluteRegistry}`,
    );
  }
  const configObservations: ControllerPlan["configObservations"] = [];
  const enabledControllers: Array<{
    registration: RegistryController;
    planned: PlannedController;
  }> = [];
  const unavailable: string[] = [];
  for (const entry of registry.controllers.filter((candidate) => candidate.enabled)) {
    const before = await readTextIfExists(entry.config);
    configObservations.push({
      id: entry.id,
      configPath: entry.config,
      snapshot: before,
    });
    if (before === null) {
      if (selectedIds.has(entry.id)) {
        unavailable.push(`${entry.id} (missing): ${entry.config}`);
      }
      continue;
    }
    let project: LoadedProject;
    try {
      project = await loadProject(entry.config);
    } catch (error) {
      throw new Error(
        `enabled registry controller is invalid: ${entry.id}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const after = await readTextIfExists(entry.config);
    if (before !== after) {
      throw new Error(`controller config changed while being read: ${entry.config}`);
    }
    if (!project.config.controllerId) {
      throw new Error(
        `${entry.config}: controllerId is required for fleet operations; re-add this controller`,
      );
    }
    if (project.config.controllerId !== entry.id) {
      throw new Error(
        `registry id ${entry.id} does not match controllerId ${project.config.controllerId} ` +
          `in ${entry.config}`,
      );
    }
    enabledControllers.push({
      registration: entry,
      planned: {
        id: entry.id,
        configPath: project.configPath,
        project,
        configSnapshot: after,
      },
    });
  }
  if (unavailable.length > 0) {
    throw new Error(`selected controllers are unavailable: ${unavailable.join("; ")}`);
  }

  await validateLoadedControllerTopology(
    enabledControllers.map(({ registration, planned }) => ({
      controller: registration,
      project: planned.project,
    })),
    { registryPath: absoluteRegistry },
  );
  const plan: ControllerPlan = {
    registryPath: absoluteRegistry,
    registrySnapshot,
    registry,
    configObservations,
    controllers: enabledControllers
      .filter(({ registration }) => selectedIds.has(registration.id))
      .map(({ planned }) => planned),
  };
  await assertPlanUnchanged(plan);
  return plan;
}

export async function syncAllControllers(
  registryPath: string,
  options: { concurrency?: number } = {},
): Promise<FleetSyncResult> {
  const plan = await planControllers(registryPath, "sync");
  const release = await acquireControllerLocks(plan.controllers);
  try {
    await assertPlanUnchanged(plan);
    const controllers = await mapWithConcurrency(
      plan.controllers,
      normalizeConcurrency(options.concurrency),
      async (controller): Promise<ControllerOutcome<ReconcileResult>> => {
        try {
          await assertControllerUnchanged(controller);
          const value = await reconcileOnce(controller.project, { lock: false });
          if (value.action === "conflict") {
            return {
              id: controller.id,
              configPath: controller.configPath,
              status: "conflict",
              value,
              error: value.conflict?.message ?? "native/canonical conflict",
            };
          }
          return {
            id: controller.id,
            configPath: controller.configPath,
            status: "ok",
            value,
          };
        } catch (error) {
          return {
            id: controller.id,
            configPath: controller.configPath,
            status: "error",
            error: errorMessage(error),
          };
        }
      },
    );
    await assertPlanUnchanged(plan);
    return {
      registry: plan.registryPath,
      controllers,
      summary: {
        total: controllers.length,
        ok: controllers.filter((entry) => entry.status === "ok").length,
        conflicts: controllers.filter((entry) => entry.status === "conflict").length,
        errors: controllers.filter((entry) => entry.status === "error").length,
      },
    };
  } finally {
    await release();
  }
}

export async function statusAllControllers(
  registryPath: string,
): Promise<FleetStatusResult> {
  const absoluteRegistry = resolve(registryPath);
  const registry = await loadRegistry(absoluteRegistry);
  const listed = await inspectControllers(registry);
  const health = await readFleetHealth(absoluteRegistry);
  const daemonRunning = health !== null && fleetHealthIsLive(health);
  const daemonProblem = health === null ? null : fleetDaemonProblem(health, daemonRunning);
  let topologyError: string | undefined;
  try {
    await validateControllerTopology(registry, { registryPath: absoluteRegistry });
  } catch (error) {
    topologyError = errorMessage(error);
  }

  const controllers = await mapWithConcurrency(
    listed,
    4,
    async (entry): Promise<ControllerOutcome<ProjectStatusValue>> => {
      if (entry.status !== "online") {
        return {
          id: entry.id,
          configPath: entry.config,
          status: entry.status,
          error: entry.error,
        };
      }
      if (!entry.project.config.controllerId) {
        return {
          id: entry.id,
          configPath: entry.config,
          status: "invalid",
          error: "controllerId is missing from the controller config",
        };
      }
      try {
        if (!entry.enabled) {
          return {
            id: entry.id,
            configPath: entry.config,
            status: "disabled",
            value: await buildProjectStatus(entry),
          };
        }
        const daemon = health?.controllers[entry.id];
        const value = {
          ...(await buildProjectStatus(entry)),
          ...(daemon ? { daemon } : {}),
        };
        if (value.conflict) {
          return {
            id: entry.id,
            configPath: entry.config,
            status: "conflict",
            error: value.conflict.message,
            value,
          };
        }
        const problem = daemon ? controllerHealthProblem(daemon) : null;
        if (problem) {
          return {
            id: entry.id,
            configPath: entry.config,
            status: "error",
            error: daemonRunning
              ? problem
              : `${problem} (last recorded by watch --all pid ${health?.pid}, which is not running)`,
            value,
          };
        }
        return {
          id: entry.id,
          configPath: entry.config,
          status: "ok",
          value,
        };
      } catch (error) {
        return {
          id: entry.id,
          configPath: entry.config,
          status: "error",
          error: errorMessage(error),
        };
      }
    },
  );
  const degraded = controllers.filter((entry, index) => {
    const registered = registry.controllers[index];
    return registered?.enabled === true && entry.status !== "ok";
  }).length + (topologyError ? 1 : 0) + (daemonProblem ? 1 : 0);
  return {
    registry: absoluteRegistry,
    daemon: health
      ? {
          running: daemonRunning,
          pid: health.pid,
          startedAt: health.startedAt,
          updatedAt: health.updatedAt,
          ...(health.stoppedAt ? { stoppedAt: health.stoppedAt } : {}),
          ...(health.exit ? { exit: health.exit } : {}),
          ...(daemonProblem ? { problem: daemonProblem } : {}),
        }
      : { running: false },
    ...(topologyError ? { topologyError } : {}),
    controllers,
    summary: {
      total: controllers.length,
      enabled: registry.controllers.filter((entry) => entry.enabled).length,
      degraded,
    },
  };
}

export async function watchAllControllers(
  options: WatchAllOptions,
): Promise<void> {
  if (options.signal?.aborted) return;
  const plan = await planControllers(options.registryPath, "watch");
  const childController = new AbortController();
  let release: (() => Promise<void>) | null = null;
  let controlWatcher: FSWatcher | null = null;

  type StopReason =
    | { kind: "signal" }
    | { kind: "registry" }
    | { kind: "config"; id: string; configPath: string }
    | { kind: "watcher-error"; error: string }
    | { kind: "controller"; id: string; error?: string }
    | { kind: "all-parked" };
  let settleStop: ((reason: StopReason) => void) | undefined;
  let settled = false;
  const stopped = new Promise<StopReason>((resolvePromise) => {
    settleStop = (reason) => {
      if (settled) return;
      settled = true;
      resolvePromise(reason);
    };
  });
  const onExternalAbort = () => {
    childController.abort();
    settleStop?.({ kind: "signal" });
  };

  const children: Promise<void>[] = [];
  try {
    release = await acquireControllerLocks(plan.controllers);
    if (options.signal?.aborted) return;
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const controlPaths = [
      plan.registryPath,
      ...plan.configObservations.map((entry) => entry.configPath),
    ];
    controlWatcher = chokidar.watch([...new Set(controlPaths)], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    controlWatcher.on("all", (_event, changedPath) => {
      const absolute = resolve(changedPath);
      if (absolute === plan.registryPath) {
        settleStop?.({ kind: "registry" });
        return;
      }
      const observation = plan.configObservations.find(
        (entry) => entry.configPath === absolute,
      );
      if (observation) {
        settleStop?.({
          kind: "config",
          id: observation.id,
          configPath: observation.configPath,
        });
      }
    });
    controlWatcher.on("error", (error) =>
      settleStop?.({ kind: "watcher-error", error: errorMessage(error) }),
    );

    await waitForWatcherReady(controlWatcher);
    if (options.signal?.aborted) return;
    if (settled) {
      throw new Error(
        "controller registry or config changed during watch startup; restart " +
          "harness-sync watch --all",
      );
    }
    await assertPlanUnchanged(plan);
    if (options.signal?.aborted) return;
    if (settled) {
      throw new Error(
        "controller registry or config changed during watch startup; restart " +
          "harness-sync watch --all",
      );
    }
    const policy: RestartPolicy = { ...DEFAULT_RESTART_POLICY, ...options.restartPolicy };
    const parkedErrors = new Map<string, string>();
    // Each controller runs in its own loop, so one failure no longer stops the
    // other stores. It used to: every controller error settled the fleet, the
    // process exited 1 and launchd respawned it — a socket in ONE project's
    // tree took every store down daily, and every exit was one more chance
    // for the respawn itself to fail.
    const superviseController = async (controller: PlannedController): Promise<void> => {
      const base = { id: controller.id, configPath: controller.configPath };
      let attempt = 0;
      let started = false;
      try {
        while (!childController.signal.aborted) {
          options.onEvent?.({ type: "started", ...base });
          started = true;
          const startedAt = Date.now();
          let reportedError: string | undefined;
          let reloadRequired: string | undefined;
          let failure: unknown;
          try {
            await watchProject(controller.project, {
              lock: false,
              signal: childController.signal,
              expectedConfigSnapshot: controller.configSnapshot,
              ...(options.deferWatcherClose
                ? { deferWatcherClose: options.deferWatcherClose }
                : {}),
              onResult: (result) => options.onEvent?.({ type: "result", ...base, result }),
              onWarning: (warning) =>
                options.onEvent?.({
                  type: "warning",
                  ...base,
                  path: warning.path,
                  ...(warning.code ? { code: warning.code } : {}),
                  warning: warning.message,
                }),
              onError: (error, during) => {
                reportedError = error.message;
                options.onEvent?.({
                  type: "error",
                  ...base,
                  error: error.message,
                  ...(during ? { during } : {}),
                });
                if (error.message.includes(FLEET_RESTART_MARKER)) reloadRequired = error.message;
              },
            });
            if (childController.signal.aborted) return;
            // watchProject resolves only when aborted; anything else is a bug.
            failure = new Error(reloadRequired ?? "watch loop ended without being stopped");
          } catch (error) {
            failure = error;
            const message = errorMessage(error);
            if (reportedError !== message) {
              options.onEvent?.({ type: "error", ...base, error: message, during: "watch" });
            }
            if (childController.signal.aborted) return;
          }
          const message = errorMessage(failure);
          if (reloadRequired !== undefined || message.includes(FLEET_RESTART_MARKER)) {
            settleStop?.({ kind: "controller", id: controller.id, error: reloadRequired ?? message });
            return;
          }
          if (!hasErrnoCode(failure)) {
            // Retrying cannot fix a programming error. Leave it stopped for
            // inspection while the other controllers keep going — but keep
            // saying so, since a parked controller emits nothing else.
            const since = new Date().toISOString();
            const stack = failure instanceof Error ? failure.stack : undefined;
            options.onEvent?.({
              type: "parked",
              ...base,
              error: message,
              since,
              ...(stack ? { stack } : {}),
            });
            parkedErrors.set(controller.id, message);
            if (parkedErrors.size === plan.controllers.length) {
              // Nothing syncs any more. Staying up would look healthy to the
              // service manager, so end the process nonzero instead.
              settleStop?.({ kind: "all-parked" });
              return;
            }
            while (!childController.signal.aborted) {
              await abortableDelay(policy.parkedReminderMs, childController.signal);
              if (childController.signal.aborted) break;
              options.onEvent?.({ type: "parked", ...base, error: message, since, reminder: true });
            }
            return;
          }
          if (Date.now() - startedAt >= policy.healthyAfterMs) attempt = 0;
          const delayMs = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
          attempt += 1;
          options.onEvent?.({ type: "restarting", ...base, error: message, attempt, delayMs });
          await abortableDelay(delayMs, childController.signal);
        }
      } finally {
        // Exactly one "stopped" per controller, whether it was running, parked
        // or waiting out a backoff when the fleet stopped.
        if (started) options.onEvent?.({ type: "stopped", ...base });
      }
    };
    for (const controller of plan.controllers) {
      if (options.signal?.aborted) break;
      children.push(superviseController(controller));
    }

    if (options.signal?.aborted) onExternalAbort();
    const reason = await stopped;
    childController.abort();
    await Promise.allSettled(children);
    if (reason.kind === "signal") return;
    if (reason.kind === "registry") {
      throw new Error(
        `${plan.registryPath} changed; restart harness-sync watch --all to load the new registry`,
      );
    }
    if (reason.kind === "config") {
      throw new Error(
        `${reason.configPath} changed; restart harness-sync watch --all to ` +
          `reload controller ${reason.id}`,
      );
    }
    if (reason.kind === "watcher-error") {
      throw new Error(`controller control watcher failed: ${reason.error}`);
    }
    if (reason.kind === "all-parked") {
      throw new Error(
        "every controller is parked, so nothing is being synced: " +
          [...parkedErrors].map(([id, error]) => `${id}: ${error}`).join("; "),
      );
    }
    throw new Error(
      `controller ${reason.id} stopped${reason.error ? `: ${reason.error}` : " unexpectedly"}`,
    );
  } finally {
    childController.abort();
    await Promise.allSettled(children);
    options.signal?.removeEventListener("abort", onExternalAbort);
    try {
      if (controlWatcher) {
        // Cheap on its own, but every close rebuilds the FSEvents stream from
        // all paths still open, including the controllers' deferred ones.
        if (options.deferWatcherClose) options.deferWatcherClose(leaveWatcherOpen(controlWatcher));
        else await closeWatcher(controlWatcher);
      }
    } finally {
      if (release) await release();
    }
  }
}

async function buildProjectStatus(
  entry: Extract<ListedController, { status: "online" }>,
): Promise<ProjectStatusValue> {
  const targets = await Promise.all(
    enabledTargets(entry.project).map(async (target) => ({
      target,
      root: adapterContext(entry.project, target).targetRoot,
      fingerprint: await getAdapter(target).fingerprint(
        adapterContext(entry.project, target),
      ),
    })),
  );
  return {
    scope: entry.project.config.scope,
    store: entry.project.storeDir,
    watch: entry.watch,
    targets,
    state: await readState(entry.project.storeDir),
    conflict: await readConflictRecord(entry.project.storeDir),
    git: await getGitStatus(entry.project.storeDir),
  };
}

async function acquireControllerLocks(
  controllers: readonly PlannedController[],
): Promise<() => Promise<void>> {
  const stores = await Promise.all(
    controllers.map(async (controller) => ({
      id: controller.id,
      store: await resolvePhysicalPath(controller.project.storeDir),
    })),
  );
  stores.sort((left, right) => left.store.localeCompare(right.store));
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const entry of stores) {
      releases.push(await acquireLock(join(entry.store, ".lock")));
    }
  } catch (error) {
    await releaseLocks(releases);
    throw error;
  }
  return () => releaseLocks(releases);
}

async function releaseLocks(
  releases: readonly (() => Promise<void>)[],
): Promise<void> {
  let firstError: unknown;
  for (const release of [...releases].reverse()) {
    try {
      await release();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function assertPlanUnchanged(plan: ControllerPlan): Promise<void> {
  if ((await readTextIfExists(plan.registryPath)) !== plan.registrySnapshot) {
    throw new Error(`controller registry changed after preflight: ${plan.registryPath}`);
  }
  await Promise.all(
    plan.configObservations.map(async (observation) => {
      if (
        (await readTextIfExists(observation.configPath)) !== observation.snapshot
      ) {
        throw new Error(
          `controller config changed after preflight: ${observation.configPath}`,
        );
      }
    }),
  );
}

async function assertControllerUnchanged(
  controller: PlannedController,
): Promise<void> {
  if ((await readTextIfExists(controller.configPath)) !== controller.configSnapshot) {
    throw new Error(`controller config changed after preflight: ${controller.configPath}`);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
}

function waitForWatcherReady(watcher: FSWatcher): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onReady = () => {
      watcher.off("error", onError);
      resolvePromise();
    };
    const onError = (error: unknown) => {
      watcher.off("ready", onReady);
      reject(new Error(`controller control watcher failed: ${errorMessage(error)}`));
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
}

function normalizeConcurrency(value: number | undefined): number {
  const concurrency = value ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("concurrency must be an integer between 1 and 32");
  }
  return concurrency;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
