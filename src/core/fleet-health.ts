import { basename, dirname, extname, join } from "node:path";
import { readTextIfExists, writeJsonAtomic } from "./fs.js";
import type { FleetWatchEvent } from "./supervisor.js";

/**
 * What `watch --all` knows and `status --all` cannot see on its own: whether
 * each controller's watch loop is running, waiting out a restart backoff, or
 * parked, and whether its reconciliation cycles keep failing. A parked
 * controller and a store that conflicts on every cycle both used to leave the
 * daemon looking healthy everywhere — status included — for as long as nobody
 * read its logs.
 *
 * One file next to the registry, written by the one supervisor that runs per
 * registry, and only when something changes (a noop cycle every audit tick
 * writes nothing). It is outside every canonical store, so no watcher, Git
 * backup or secret scan ever sees it.
 */
export interface ControllerHealth {
  state: "running" | "restarting" | "parked" | "stopped";
  /** When the controller entered this state. */
  since: string;
  /** restarting/parked: the failure. */
  error?: string;
  /** restarting: consecutive failures so far, and when the next try is due. */
  attempt?: number;
  retryAt?: string;
  /** Present while the controller's latest reconciliation cycle did not succeed. */
  cycle?: {
    outcome: "conflict" | "error";
    message: string;
    since: string;
  };
}

export interface FleetHealth {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** Set when the supervisor ended; its entries are history from then on. */
  stoppedAt?: string;
  controllers: Record<string, ControllerHealth>;
}

export interface FleetHealthRecorder {
  observe(event: FleetWatchEvent): void;
  /** Resolves once every change observed so far is on disk (or failed). */
  flush(): Promise<void>;
  /** Record the stop and flush. */
  close(): Promise<void>;
}

/** `registry.yaml` → `registry.health.json`, beside it. */
export function fleetHealthPath(registryPath: string): string {
  const name = basename(registryPath, extname(registryPath));
  return join(dirname(registryPath), `${name}.health.json`);
}

export function createFleetHealthRecorder(
  path: string,
  options: {
    now?: () => Date;
    pid?: number;
    /** Called for the first failed write only; later ones retry silently. */
    onWriteError?: (error: Error) => void;
  } = {},
): FleetHealthRecorder {
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const health: FleetHealth = {
    schemaVersion: 1,
    pid: options.pid ?? process.pid,
    startedAt: now(),
    updatedAt: now(),
    controllers: {},
  };
  let dirty = false;
  let writing: Promise<void> | null = null;
  let reported = false;
  // Nothing is written until a controller actually started under this
  // process. A second `watch --all` that fails on the store locks must not
  // overwrite the running daemon's record with a stop of its own.
  let observed = false;

  const drain = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      health.updatedAt = now();
      try {
        await writeJsonAtomic(path, health);
      } catch (error) {
        // Health is reporting, never a reason to stop syncing.
        if (!reported) {
          reported = true;
          options.onWriteError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    writing = null;
  };
  const schedule = () => {
    dirty = true;
    writing ??= drain();
  };

  return {
    observe(event) {
      const before = JSON.stringify(health.controllers[event.id] ?? null);
      const next = nextControllerHealth(health.controllers[event.id], event, now());
      if (next === undefined) return;
      observed = true;
      health.controllers[event.id] = next;
      if (JSON.stringify(next) !== before) schedule();
    },
    async flush() {
      await writing;
    },
    async close() {
      if (!observed) return;
      health.stoppedAt = now();
      schedule();
      await writing;
    },
  };
}

function nextControllerHealth(
  current: ControllerHealth | undefined,
  event: FleetWatchEvent,
  at: string,
): ControllerHealth | undefined {
  const cycle = current?.cycle;
  const keepCycle = cycle ? { cycle } : {};
  switch (event.type) {
    case "started":
      return { state: "running", since: at, ...keepCycle };
    case "restarting":
      return {
        state: "restarting",
        since: at,
        error: event.error,
        attempt: event.attempt,
        retryAt: new Date(Date.parse(at) + event.delayMs).toISOString(),
        ...keepCycle,
      };
    case "parked":
      if (event.reminder) return current;
      return { state: "parked", since: event.since, error: event.error, ...keepCycle };
    case "stopped":
      return { state: "stopped", since: at, ...keepCycle };
    case "result": {
      const base = current ?? { state: "running" as const, since: at };
      if (event.result.action !== "conflict") {
        const { cycle: _cleared, ...rest } = base;
        return rest;
      }
      const message = event.result.conflict?.message ?? "native/canonical conflict";
      return { ...base, cycle: sameProblem(cycle, "conflict", message, at) };
    }
    case "error": {
      if (event.during !== "sync") return current;
      const base = current ?? { state: "running" as const, since: at };
      return { ...base, cycle: sameProblem(cycle, "error", event.error, at) };
    }
    case "warning":
      return current;
  }
}

/** Keep the original start time while the same problem repeats. */
function sameProblem(
  cycle: ControllerHealth["cycle"],
  outcome: "conflict" | "error",
  message: string,
  at: string,
): NonNullable<ControllerHealth["cycle"]> {
  return cycle?.outcome === outcome && cycle.message === message
    ? cycle
    : { outcome, message, since: at };
}

export async function readFleetHealth(registryPath: string): Promise<FleetHealth | null> {
  const text = await readTextIfExists(fleetHealthPath(registryPath));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<FleetHealth> | null;
    if (
      parsed?.schemaVersion !== 1 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.controllers !== "object" ||
      parsed.controllers === null
    ) {
      return null;
    }
    return parsed as FleetHealth;
  } catch {
    return null;
  }
}

/**
 * Whether the supervisor that wrote this file is still running. A clean stop
 * is recorded in the file; a crash is not, so the pid decides then. (A reused
 * pid would read as alive; the next write by a real daemon corrects it.)
 */
export function fleetHealthIsLive(health: FleetHealth): boolean {
  if (health.stoppedAt !== undefined) return false;
  try {
    process.kill(health.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The reason a live daemon's controller counts as degraded, if it does. */
export function controllerHealthProblem(health: ControllerHealth): string | null {
  if (health.state === "parked") {
    return `parked since ${health.since} (not retrying): ${health.error ?? "unknown error"}`;
  }
  if (health.state === "restarting") {
    return `restarting (attempt ${health.attempt ?? "?"}, next try at ${health.retryAt ?? "?"}): ` +
      (health.error ?? "unknown error");
  }
  if (health.cycle?.outcome === "error") {
    return `reconciliation failing since ${health.cycle.since}: ${health.cycle.message}`;
  }
  return null;
}
