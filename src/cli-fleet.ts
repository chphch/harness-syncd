import type { WatchWarning } from "./core/daemon.js";
import type { FleetWatchEvent } from "./core/supervisor.js";

/**
 * The fleet events a person must see even when nobody reads the JSON event
 * stream on stdout: a controller restarting, a controller parked for good, and
 * a path the watcher gave up on. Each becomes one stderr line, which is where
 * launchd's log and a foreground terminal both put it. A path is reported once
 * per controller: chokidar stops retrying an unwatched path, but a restarted
 * controller would otherwise announce the same socket again on every attempt.
 */
export function createFleetNoticeWriter(
  write: (text: string) => void,
): (event: FleetWatchEvent) => void {
  const warned = new Set<string>();
  return (event) => {
    if (event.type === "restarting") {
      write(
        `harness-sync: controller ${event.id} restarting in ${formatDelay(event.delayMs)} ` +
          `(attempt ${event.attempt}): ${oneLine(event.error)}\n`,
      );
    } else if (event.type === "parked") {
      write(
        `harness-sync: controller ${event.id} parked (not retrying): ${oneLine(event.error)} ` +
          "— restart the daemon after fixing\n",
      );
    } else if (event.type === "warning") {
      const key = `${event.id}\0${event.path}`;
      if (warned.has(key)) return;
      warned.add(key);
      write(
        `harness-sync: controller ${event.id} is not watching ${event.path}: ` +
          `${oneLine(event.warning)} (the periodic audit still reconciles it)\n`,
      );
    }
  };
}

/** The single-controller `watch` counterpart of the fleet warning notice. */
export function createWarningNoticeWriter(
  write: (text: string) => void,
): (warning: WatchWarning) => void {
  const warned = new Set<string>();
  return (warning) => {
    if (warned.has(warning.path)) return;
    warned.add(warning.path);
    write(
      `harness-sync: not watching ${warning.path}: ${oneLine(warning.message)} ` +
        "(the periodic audit still reconciles it)\n",
    );
  };
}

export function formatDelay(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/gu, " ").trim();
}
