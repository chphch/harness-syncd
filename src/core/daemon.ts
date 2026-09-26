import type { Stats } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { getAdapter } from "../adapters/index.js";
import { acquireLock, isGeneratedDirectory, readTextIfExists } from "./fs.js";
import { backupCanonicalStore } from "./backup.js";
import {
  adapterContext,
  enabledTargets,
  type LoadedProject,
} from "./project.js";
import { reconcileOnce, type ReconcileResult } from "./reconcile.js";

export interface WatchOptions {
  onResult?: (result: ReconcileResult) => void;
  onError?: (error: Error) => void;
  /**
   * One path the watcher could not watch and now skips. The controller keeps
   * running: the watcher only buys latency, and the audit tick still
   * reconciles that path.
   */
  onWarning?: (warning: WatchWarning) => void;
  signal?: AbortSignal;
  /** The supervisor may hold all selected store locks before starting. */
  lock?: boolean;
  /** Stable config bytes captured by a fleet preflight. */
  expectedConfigSnapshot?: string;
}

export interface WatchWarning {
  path: string;
  code?: string;
  message: string;
}

/**
 * Whether any segment of a path names a generated directory. Exported so the
 * property the daemon depends on can be asserted directly: chokidar 4 removed
 * glob support from `ignored`, so a double-star glob naming node_modules there
 * is matched as a LITERAL path and silently ignores nothing — a failure that
 * looks exactly like having no rule at all.
 */
export function isGeneratedWatchPath(candidate: string): boolean {
  return candidate.split(sep).some((segment) => isGeneratedDirectory(segment));
}

/**
 * Whether chokidar's stats say this entry can never be watched: a socket, a
 * FIFO, or a device. chokidar calls `ignored` up to three times per entry —
 * without stats, with the lstat stats readdirp produced, and with FOLLOWED
 * stats just before it calls fs.watch — so `undefined` means "not decidable
 * yet", never "skip". A symlink is kept at the lstat stage because the daemon's
 * own managed projections are symlinks; the followed stats then decide what
 * the link points at.
 *
 * Measured on macOS (node 26): fs.watch on a socket throws
 * `UNKNOWN: unknown error, watch` (errno -102, EOPNOTSUPP, which libuv has no
 * name for), and on a FIFO it blocks the whole event loop in open() until a
 * writer appears — a hang with no error at all.
 */
export function isUnwatchableEntry(_candidate: string, stats?: Stats): boolean {
  if (stats === undefined) return false;
  return !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink();
}

/**
 * Error codes that can name one entry the watcher cannot watch. Resource
 * exhaustion (EMFILE, ENFILE, ENOSPC) is deliberately absent: skipping paths
 * then would silently shrink coverage, so it stays fatal to the controller.
 */
const PATH_SCOPED_WATCH_CODES = new Set([
  "UNKNOWN",
  "EOPNOTSUPP",
  "ENOTSUP",
  "ENXIO",
  "ENODEV",
  "EINVAL",
  "ELOOP",
  "ENAMETOOLONG",
  "EACCES",
  "EPERM",
]);

/** Only the syscalls chokidar issues against ONE entry it is about to watch. */
const PATH_SCOPED_WATCH_SYSCALLS = new Set(["watch", "stat", "realpath"]);

/**
 * Whether a watcher error is confined to one path ("path": skip it and keep
 * running) or means the watcher itself can no longer be trusted ("fatal").
 *
 * Everything not provably path-scoped is fatal. In particular readdirp's
 * lstat/scandir errors destroy that directory's stream, so chokidar never
 * finishes the directory and may never emit "ready": treating ENAMETOOLONG
 * from lstat as skippable turned a startup failure into a silent hang. An
 * async FSWatcher error carries the path it was created with, which may be
 * relative, and unwatch() would resolve that against the process cwd.
 */
export function classifyWatchError(error: unknown): "path" | "fatal" {
  if (!(error instanceof Error)) return "fatal";
  const { code, path, syscall } = error as NodeJS.ErrnoException;
  if (typeof path !== "string" || !isAbsolute(path)) return "fatal";
  if (typeof syscall !== "string" || !PATH_SCOPED_WATCH_SYSCALLS.has(syscall)) return "fatal";
  return typeof code === "string" && PATH_SCOPED_WATCH_CODES.has(code) ? "path" : "fatal";
}

export async function watchProject(
  project: LoadedProject,
  options: WatchOptions = {},
): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let audit: ReturnType<typeof setInterval> | undefined;
  let backup: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | null = null;
  let pending = false;
  let stopping = false;
  let settleStop: ((error: Error | null) => void) | undefined;
  let stopped = false;
  const stop = new Promise<Error | null>((resolvePromise) => {
    settleStop = (error) => {
      if (stopped) return;
      stopped = true;
      resolvePromise(error);
    };
  });
  const onAbort = () => settleStop?.(null);

  try {
    release = options.lock === false
      ? null
      : await acquireLock(join(project.storeDir, ".lock"));
    if (options.signal?.aborted) return;

    const observedConfig = await readTextIfExists(project.configPath);
    if (observedConfig === null) {
      throw new Error(`controller config is missing: ${project.configPath}`);
    }
    const initialConfig = options.expectedConfigSnapshot ?? observedConfig;
    if (observedConfig !== initialConfig) {
      throw restartError(project.configPath, "changed before watch startup");
    }

    // Carried destinations are deliberately NOT watched. ~/.local/bin is
    // 267 MB and ~/Library/LaunchAgents is written by other vendors' updaters,
    // so watching them would cost far more than it saves. Capture therefore
    // runs on the audit tick (sync.auditIntervalMs, default 30s) and on any
    // explicit sync — costing up to one audit interval of latency before a new
    // plist is captured. Weigh that before adding them here.
    const paths = [
      project.configPath,
      project.storeDir,
      ...enabledTargets(project).flatMap((target) =>
        getAdapter(target).watchPaths(adapterContext(project, target)),
      ),
    ];
    watcher = chokidar.watch([...new Set(paths)], {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(100, project.config.sync.debounceMs),
        pollInterval: 50,
      },
      ignored: [
        join(project.storeDir, ".state.json"),
        join(project.storeDir, ".managed.json"),
        join(project.storeDir, ".lock"),
        join(project.storeDir, "backups"),
        join(project.storeDir, "conflicts"),
        join(project.storeDir, ".git"),
        // The machine-local carry ledger. Narrowly scoped rather than ignoring
        // all of .local/, which would change existing behaviour for
        // .local/preserved/. It is rewritten only when a capture actually
        // changed something, so this is convergence hygiene rather than
        // correctness — it removes one spurious reconcile per capture.
        join(project.storeDir, ".local", "carry"),
        // Generated directories, at ANY depth under any watched root. The
        // importer has skipped these since 7058a88; the WATCHER did not, and
        // that asymmetry is expensive: chokidar opens a descriptor per
        // directory and launchd gives a job 256 of them by default. Measured on
        // this box — one skill's node_modules is 705 directories, the skills
        // tree is projected to five native roots plus the store, and the whole
        // user controller therefore wanted 6,265 descriptors. It died with
        // EMFILE on every start while the other fourteen controllers kept
        // running, so the daemon looked alive and one store silently stopped
        // syncing.
        //
        // A FUNCTION, not a glob: chokidar 4 removed glob support from
        // `ignored`, so `**/node_modules/**` is matched as a literal path and
        // silently ignores nothing.
        isGeneratedWatchPath,
        // Sockets, FIFOs, devices: see isUnwatchableEntry. A Chrome profile in
        // a skill's scripts/ directory put a SingletonSocket here every day at
        // 20:00, and the resulting watch error stopped the whole fleet.
        isUnwatchableEntry,
      ],
    });

    const liveWatcher = watcher;
    const fail = (error: unknown) => {
      const normalized = normalizeError(error);
      options.onError?.(normalized);
      stopping = true;
      settleStop?.(normalized);
    };
    // One entry the watcher cannot watch must not stop the controller: the
    // watcher is latency only (the audit tick reconciles regardless), so skip
    // that path, say so, and keep going. unwatch() also stops chokidar from
    // retrying it on every re-read of the parent directory.
    watcher.on("error", (error: unknown) => {
      if (classifyWatchError(error) === "path") {
        const { path, code, message } = error as NodeJS.ErrnoException & { path: string };
        liveWatcher.unwatch(path);
        options.onWarning?.({ path, ...(code ? { code } : {}), message });
        return;
      }
      fail(error);
    });

    const schedule = () => {
      if (stopping) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), project.config.sync.debounceMs);
    };

    const run = (): Promise<void> => {
      if (stopping) return Promise.resolve();
      if (activeRun) {
        pending = true;
        return activeRun;
      }
      activeRun = (async () => {
        try {
          if ((await readTextIfExists(project.configPath)) !== initialConfig) {
            throw restartError(project.configPath, "changed");
          }
          const result = await reconcileOnce(project, { lock: false });
          options.onResult?.(result);
        } catch (error) {
          const normalized = normalizeError(error);
          options.onError?.(normalized);
          if (normalized.message.includes("restart harness-sync watch")) {
            stopping = true;
            settleStop?.(normalized);
          }
        } finally {
          activeRun = null;
          if (pending && !stopping) {
            pending = false;
            schedule();
          }
        }
      })();
      return activeRun;
    };

    watcher.on("all", (_event, changedPath) => {
      if (resolve(changedPath) === resolve(project.configPath)) {
        fail(restartError(project.configPath, "changed"));
        return;
      }
      schedule();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // An abort that landed during the awaits above fires no event.
    if (options.signal?.aborted) onAbort();

    // Raced against the stop signal: a startup that never becomes ready must
    // still end when the supervisor aborts, or shutdown waits on it forever.
    const ready = await Promise.race([
      waitForReady(watcher).then(() => true),
      stop.then(() => false),
    ]);
    if (!ready) {
      const fatal = await stop;
      if (fatal) throw fatal;
      return;
    }
    if ((await readTextIfExists(project.configPath)) !== initialConfig) {
      throw restartError(project.configPath, "changed during watch startup");
    }
    if (options.signal?.aborted) return;

    audit = setInterval(
      () => void run(),
      Math.max(1_000, project.config.sync.auditIntervalMs),
    );
    // The daemon holds the store lock for its whole lifetime, so a cron calling
    // `harness-sync git sync` would be refused on every run. Backing up has to
    // happen in here or not at all.
    if (project.config.git.enabled && project.config.git.backupIntervalMs > 0) {
      backup = setInterval(() => {
        void (async () => {
          if (stopping || activeRun) return;
          try {
            await backupCanonicalStore(project, {
              push: project.config.git.autoPush,
              message: `harness-sync backup ${new Date().toISOString().slice(0, 10)}`,
            });
          } catch (error) {
            // A failed backup must not stop the watcher: projection is the
            // daemon's job and it still works. Report and keep watching.
            options.onError?.(normalizeError(error));
          }
        })();
      }, Math.max(60_000, project.config.git.backupIntervalMs));
    }
    await run();
    const fatal = await stop;
    if (fatal) throw fatal;
  } finally {
    stopping = true;
    if (audit) clearInterval(audit);
    if (backup) clearInterval(backup);
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    try {
      if (watcher) await watcher.close();
      if (activeRun) await activeRun;
    } finally {
      if (release) await release();
    }
  }
}

/**
 * Resolve on "ready", reject on the first FATAL watcher error. Path-scoped
 * errors during the initial scan are the controller's error listener's to
 * skip and report; `on`, not `once`, so a skipped path does not consume the
 * listener and let a later fatal error go unnoticed until "ready".
 */
function waitForReady(watcher: FSWatcher): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onReady = () => {
      watcher.off("error", onError);
      resolvePromise();
    };
    const onError = (error: unknown) => {
      if (classifyWatchError(error) === "path") return;
      watcher.off("ready", onReady);
      watcher.off("error", onError);
      reject(normalizeError(error));
    };
    watcher.once("ready", onReady);
    watcher.on("error", onError);
  });
}

function restartError(configPath: string, detail: string): Error {
  return new Error(
    `${configPath} ${detail}; restart harness-sync watch to reload roots and policy`,
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
