import { join, resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { getAdapter } from "../adapters/index.js";
import { acquireLock, readTextIfExists } from "./fs.js";
import {
  adapterContext,
  enabledTargets,
  type LoadedProject,
} from "./project.js";
import { reconcileOnce, type ReconcileResult } from "./reconcile.js";

export interface WatchOptions {
  onResult?: (result: ReconcileResult) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  /** The supervisor may hold all selected store locks before starting. */
  lock?: boolean;
  /** Stable config bytes captured by a fleet preflight. */
  expectedConfigSnapshot?: string;
}

export async function watchProject(
  project: LoadedProject,
  options: WatchOptions = {},
): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let audit: ReturnType<typeof setInterval> | undefined;
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
      ],
    });

    const fail = (error: unknown) => {
      const normalized = normalizeError(error);
      options.onError?.(normalized);
      stopping = true;
      settleStop?.(normalized);
    };
    watcher.on("error", fail);

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

    await waitForReady(watcher);
    if ((await readTextIfExists(project.configPath)) !== initialConfig) {
      throw restartError(project.configPath, "changed during watch startup");
    }
    if (options.signal?.aborted) return;

    audit = setInterval(
      () => void run(),
      Math.max(1_000, project.config.sync.auditIntervalMs),
    );
    await run();
    const fatal = await stop;
    if (fatal) throw fatal;
  } finally {
    stopping = true;
    if (audit) clearInterval(audit);
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

function waitForReady(watcher: FSWatcher): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onReady = () => {
      watcher.off("error", onError);
      resolvePromise();
    };
    const onError = (error: unknown) => {
      watcher.off("ready", onReady);
      reject(normalizeError(error));
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
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
