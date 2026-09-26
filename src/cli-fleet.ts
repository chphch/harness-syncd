import {
  problemKey,
  type FleetExit,
  type FleetHealthRecorder,
} from "./core/fleet-health.js";
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
 * announce the same socket again on every attempt.
 */
export function createFleetNoticeWriter(
  write: (text: string) => void,
  options: NoticeOptions = {},
): (event: FleetWatchEvent) => void {
  const now = options.now ?? (() => new Date());
  const repeatMs = options.repeatMs ?? DEFAULT_NOTICE_REPEAT_MS;
  const warned = new Set<string>();
  const problems = new Map<string, Problem>();
  const line = (text: string) => write(formatNotice(now(), text));

  const problem = (
    event: { id: string },
    channel: "sync" | "backup",
    kind: Problem["kind"],
    message: string,
  ) => {
    const key = `${event.id}\0${channel}`;
    const at = now().getTime();
    const current = problems.get(key);
    const [label, stillLabel] = PROBLEM_LABELS[`${channel} ${kind}`];
    // Compared without per-attempt temp names: see problemKey.
    if (!current || current.kind !== kind || current.key !== problemKey(message)) {
      problems.set(key, { kind, key: problemKey(message), since: at, lastNotice: at });
      line(`controller ${event.id} ${label}: ${oneLine(message)}`);
      return;
    }
    if (at - current.lastNotice < repeatMs) return;
    current.lastNotice = at;
    line(
      `controller ${event.id} ${stillLabel} since ` +
        `${new Date(current.since).toISOString()}: ${oneLine(message)}`,
    );
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
        if (event.result.action === "conflict") {
          problem(event, "sync", "conflict", event.result.conflict?.message ?? "native/canonical conflict");
          return;
        }
        const key = `${event.id}\0sync`;
        const current = problems.get(key);
        if (!current) return;
        problems.delete(key);
        line(
          `controller ${event.id} synced again (${event.result.action}) after a ` +
            `${current.kind === "conflict" ? "conflict" : "failure"} since ` +
            new Date(current.since).toISOString(),
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

interface Problem {
  kind: "conflict" | "error";
  /** problemKey of the message. */
  key: string;
  since: number;
  lastNotice: number;
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
