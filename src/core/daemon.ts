import { join } from "node:path";
import chokidar from "chokidar";
import { getAdapter } from "../adapters/index.js";
import { acquireLock } from "./fs.js";
import { readTextIfExists } from "./fs.js";
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
}

export async function watchProject(
  project: LoadedProject,
  options: WatchOptions = {},
): Promise<void> {
  const release = await acquireLock(join(project.storeDir, ".lock"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRun: Promise<void> | null = null;
  let pending = false;
  let stopping = false;
  let stopWatcher: (() => void) | undefined;
  const initialConfig = await readTextIfExists(project.configPath);

  const paths = [
    project.configPath,
    project.storeDir,
    ...enabledTargets(project).flatMap((target) =>
      getAdapter(target).watchPaths(adapterContext(project, target)),
    ),
  ];
  const watcher = chokidar.watch([...new Set(paths)], {
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

  const run = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (activeRun) {
      pending = true;
      return activeRun;
    }
    activeRun = (async () => {
      try {
        if ((await readTextIfExists(project.configPath)) !== initialConfig) {
          throw new Error(
            `${project.configPath} changed; restart harness-sync watch to reload roots and policy`,
          );
        }
        const result = await reconcileOnce(project, { lock: false });
        options.onResult?.(result);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalized);
        if (normalized.message.includes("restart harness-sync watch")) {
          stopping = true;
          stopWatcher?.();
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

  const schedule = () => {
    if (stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), project.config.sync.debounceMs);
  };

  watcher.on("all", schedule);
  const audit = setInterval(
    () => void run(),
    Math.max(1_000, project.config.sync.auditIntervalMs),
  );

  try {
    await run();
    await new Promise<void>((resolvePromise) => {
      stopWatcher = resolvePromise;
      if (stopping || options.signal?.aborted) {
        resolvePromise();
        return;
      }
      options.signal?.addEventListener("abort", () => resolvePromise(), {
        once: true,
      });
    });
  } finally {
    stopping = true;
    clearInterval(audit);
    if (timer) clearTimeout(timer);
    await watcher.close();
    if (activeRun) await activeRun;
    await release();
  }
}
