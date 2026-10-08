import type { ApplyResult } from "./types.js";
import {
  problemKey,
  type FleetExit,
  type FleetHealthRecorder,
} from "./core/fleet-health.js";
import {
  STALE_CAPTURE_DIR_NOT_REMOVED,
  STALE_CAPTURE_DIR_REMOVED,
  type ReconcileResult,
} from "./core/reconcile.js";
import {
  watchAllControllers,
  type FleetWatchEvent,
  type RestartPolicy,
} from "./core/supervisor.js";

/**
 * `watch --all` without the process plumbing: run the supervisor, feed every
 * event to the health recorder, and record how the supervisor ended. The exit
 * is what lets `status --all` tell a daemon that keeps failing — all parked,
 * then respawned by the service manager, then parked again — from one that an
 * operator stopped: for almost all of such a loop no daemon is running.
 */
export async function superviseFleet(options: {
  registryPath: string;
  signal: AbortSignal;
  health: FleetHealthRecorder;
  onEvent: (event: FleetWatchEvent) => void;
  restartPolicy?: Partial<RestartPolicy>;
  deferWatcherClose?: (close: () => Promise<void>) => void;
}): Promise<void> {
  let exit: FleetExit = { code: 1, error: "watch --all ended without an outcome" };
  try {
    await watchAllControllers({
      registryPath: options.registryPath,
      signal: options.signal,
      ...(options.restartPolicy ? { restartPolicy: options.restartPolicy } : {}),
      ...(options.deferWatcherClose ? { deferWatcherClose: options.deferWatcherClose } : {}),
      onEvent: (event) => {
        options.health.observe(event);
        options.onEvent(event);
      },
    });
    const reason: unknown = options.signal.reason;
    exit = options.signal.aborted && typeof reason === "string"
      ? { code: 0, signal: reason }
      : { code: 0 };
  } catch (error) {
    exit = { code: 1, error: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    await options.health.close(exit);
  }
}

export interface NoticeOptions {
  now?: () => Date;
  /** How often a problem that persists unchanged is reported again. */
  repeatMs?: number;
}

export const DEFAULT_NOTICE_REPEAT_MS = 3_600_000;

/**
 * The fleet events a person must see even when nobody reads the JSON event
 * stream on stdout, one timestamped stderr line each — which is where
 * launchd's log and a foreground terminal both put it:
 *
 * - a controller restarting, parked for good (again every hour from the
 *   supervisor while it stays parked), or skipping a path it cannot watch;
 * - a controller whose reconciliation cycles conflict or fail, or whose Git
 *   backup fails. These used to reach stdout only: on 2026-09-16 a store
 *   recorded the same conflict every 30 seconds for ten days, and stderr —
 *   where the fleet docs tell operators to look — stayed empty. A problem is
 *   written when it starts or changes, again every `repeatMs` while it
 *   persists, and once more when the next cycle succeeds.
 *
 * A path warning is written once per controller and path: chokidar stops
 * retrying an unwatched path, but a restarted controller would otherwise
 * announce the same socket again on every attempt. So is a capture directory
 * that an interrupted run left beside a store and a cycle removed — or could
 * not remove, which every cycle would otherwise report again.
 */
export function createFleetNoticeWriter(
  write: (text: string) => void,
  options: NoticeOptions = {},
): (event: FleetWatchEvent) => void {
  const now = options.now ?? (() => new Date());
  const warned = new Set<string>();
  const problems = createProblemTracker(now, options.repeatMs ?? DEFAULT_NOTICE_REPEAT_MS);
  const line = (text: string) => write(formatNotice(now(), text));

  const problem = (
    event: { id: string },
    channel: ProblemChannel,
    kind: Problem["kind"],
    message: string,
  ) => {
    const verdict = problems.report(event.id, channel, kind, message);
    const [label, stillLabel] = PROBLEM_LABELS[`${channel} ${kind}`];
    if (verdict.write === "first") {
      line(`controller ${event.id} ${label}: ${oneLine(message)}`);
    } else if (verdict.write === "reminder") {
      line(
        `controller ${event.id} ${stillLabel} since ` +
          `${new Date(verdict.since).toISOString()}: ${oneLine(message)}`,
      );
    }
  };

  return (event) => {
    switch (event.type) {
      case "restarting":
        line(
          `controller ${event.id} restarting in ${formatDelay(event.delayMs)} ` +
            `(attempt ${event.attempt}): ${oneLine(event.error)}`,
        );
        return;
      case "parked":
        if (event.reminder) {
          line(
            `controller ${event.id} still parked since ${event.since} (not retrying): ` +
              oneLine(event.error),
          );
          return;
        }
        line(
          `controller ${event.id} parked (not retrying): ${oneLine(event.error)} — fix it, then ` +
            "restart the daemon through its service manager (a plain SIGTERM exits 0, which a " +
            "restart-on-failure service does not relaunch)",
        );
        for (const frame of stackFrames(event.stack)) write(`    ${frame}\n`);
        return;
      case "warning": {
        const key = `${event.id}\0${event.path}`;
        if (warned.has(key)) return;
        warned.add(key);
        line(
          `controller ${event.id} is not watching ${event.path}: ` +
            `${oneLine(event.warning)} (the periodic audit still reconciles it)`,
        );
        return;
      }
      case "result": {
        for (const warning of event.result.warnings) {
          if (warning.code !== STALE_CAPTURE_DIR_REMOVED && warning.code !== STALE_CAPTURE_DIR_NOT_REMOVED) {
            continue;
          }
          const key = `${event.id}\0${warning.code}\0${warning.path ?? warning.message}`;
          if (warned.has(key)) continue;
          warned.add(key);
          line(`controller ${event.id} ${oneLine(warning.message)}`);
        }
        if (event.result.action === "conflict") {
          problem(event, "sync", "conflict", conflictMessage(event.result));
          return;
        }
        const ended = problems.end(event.id, "sync");
        if (!ended) return;
        line(
          `controller ${event.id} synced again (${event.result.action}) after a ` +
            `${ended.kind === "conflict" ? "conflict" : "failure"} since ` +
            new Date(ended.since).toISOString(),
        );
        return;
      }
      case "error":
        // A watch-loop failure is followed by its own restarting/parked notice.
        if (event.during === "sync") problem(event, "sync", "error", event.error);
        else if (event.during === "backup") problem(event, "backup", "error", event.error);
        return;
      case "started":
      case "stopped":
        return;
    }
  };
}

/**
 * Whether an event goes on the stdout event stream. Noop results stay out, and
 * a conflicting or failing cycle follows the rule of its stderr notice: it is
 * written when it starts or changes, again every `repeatMs` while it
 * persists, and the cycle that ends it is written even when it is a noop, so
 * the stream shows the end too. Every other event is written.
 *
 * Every cycle that was not a noop used to be written, so a store stuck in one
 * conflict wrote the same ~1 KB result on every 30 s audit tick: by
 * 2026-10-08, 103,037 of the 133,749 lines (101 of 121 MB) in the daemon's
 * stdout log repeated the conflict before them.
 */
export function createEventStreamFilter(
  options: NoticeOptions = {},
): (event: FleetWatchEvent) => boolean {
  const problems = createProblemTracker(
    options.now ?? (() => new Date()),
    options.repeatMs ?? DEFAULT_NOTICE_REPEAT_MS,
  );
  return (event) => {
    switch (event.type) {
      case "result":
        if (event.result.action === "conflict") {
          return problems.report(event.id, "sync", "conflict", conflictMessage(event.result))
            .write !== "none";
        }
        // `end` first: a noop that ends a problem has to end it here too.
        return problems.end(event.id, "sync") !== undefined || event.result.action !== "noop";
      case "error":
        return event.during === "sync" || event.during === "backup"
          ? problems.report(event.id, event.during, "error", event.error).write !== "none"
          : true;
      default:
        return true;
    }
  };
}

/** An applyResults entry as the event stream writes it: see compactResultForStream. */
export interface StreamApplyResult {
  target: ApplyResult["target"];
  written: number;
  linked: number;
  removed: string[];
  skipped: string[];
  warnings: number;
}

/**
 * A result as the event stream writes it, with `written`, `linked` and
 * `warnings` of each applyResults entry given as counts. The two path lists
 * name every path the projection accounts for, unchanged ones included (see
 * the writer's adoptAlreadyMatching): hundreds for a store of skills and
 * rules, which made each of its projections a ~42 KB line. The warnings are
 * repeated in `result.warnings`. `removed` and `skipped` name only paths that
 * something happened to, and stay in full.
 */
export function compactResultForStream(
  result: ReconcileResult,
): Omit<ReconcileResult, "applyResults"> & { applyResults: StreamApplyResult[] } {
  return {
    ...result,
    applyResults: result.applyResults.map((applied) => ({
      target: applied.target,
      written: applied.written.length,
      linked: applied.linked.length,
      removed: applied.removed,
      skipped: applied.skipped,
      warnings: applied.warnings.length,
    })),
  };
}

function conflictMessage(result: ReconcileResult): string {
  return result.conflict?.message ?? "native/canonical conflict";
}

interface Problem {
  kind: "conflict" | "error";
  /** problemKey of the message. */
  key: string;
  since: number;
  lastNotice: number;
}

type ProblemChannel = "sync" | "backup";

/**
 * Each controller's current sync and backup problem, shared by the stderr
 * notices and the stdout stream so both apply one rule. `report` says whether
 * to write a problem now: `first` when it starts or changes to a different
 * one, `reminder` every `repeatMs` while it persists, otherwise `none`.
 * Messages are compared without per-attempt temp names: see problemKey. `end`
 * forgets the problem a successful cycle ended, and returns it.
 */
function createProblemTracker(now: () => Date, repeatMs: number) {
  const problems = new Map<string, Problem>();
  return {
    report(
      id: string,
      channel: ProblemChannel,
      kind: Problem["kind"],
      message: string,
    ): { write: "first" | "none" } | { write: "reminder"; since: number } {
      const key = `${id}\0${channel}`;
      const at = now().getTime();
      const current = problems.get(key);
      if (!current || current.kind !== kind || current.key !== problemKey(message)) {
        problems.set(key, { kind, key: problemKey(message), since: at, lastNotice: at });
        return { write: "first" };
      }
      if (at - current.lastNotice < repeatMs) return { write: "none" };
      current.lastNotice = at;
      return { write: "reminder", since: current.since };
    },
    end(id: string, channel: ProblemChannel): Problem | undefined {
      const key = `${id}\0${channel}`;
      const current = problems.get(key);
      problems.delete(key);
      return current;
    },
  };
}

/** [first notice, repeat notice] per channel and kind. */
const PROBLEM_LABELS: Record<`${"sync" | "backup"} ${Problem["kind"]}`, [string, string]> = {
  "sync conflict": ["sync conflict", "still in conflict"],
  "sync error": ["sync failed", "still failing to sync"],
  "backup conflict": ["backup conflict", "backup still in conflict"],
  "backup error": ["backup failed", "backup still failing"],
};

/** One stderr line: an ISO-8601 time, so a line can be dated without context. */
export function formatNotice(at: Date, text: string): string {
  return `${at.toISOString()} harness-sync: ${text}\n`;
}

export function formatDelay(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/** The "at …" lines of a stack; the first line repeats the message. */
function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split(/\r?\n/u)
    .slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0);
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/gu, " ").trim();
}
