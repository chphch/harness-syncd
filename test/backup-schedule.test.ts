import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupCanonicalStore } from "../src/core/backup.js";
import { writeProjectConfig } from "../src/core/config.js";
import { watchProject } from "../src/core/daemon.js";
import type { GitSyncResult } from "../src/core/git.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import { reconcileOnce, type ReconcileResult } from "../src/core/reconcile.js";

/**
 * The daemon's backup tick against sync cycles and other backups. chokidar,
 * the cycle and the backup are stand-ins this test releases by hand, and only
 * setInterval is faked, so a tick fires exactly when the test moves the clock
 * while the debounce and the test's own polling run in real time.
 */
class FakeWatcher extends EventEmitter {
  unwatch(): this {
    return this;
  }

  async close(): Promise<void> {
    this.removeAllListeners();
  }
}

const fake = vi.hoisted(() => ({ watchers: [] as unknown[] }));

vi.mock("chokidar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chokidar")>();
  const watch = () => {
    const watcher = new FakeWatcher();
    fake.watchers.push(watcher);
    return watcher;
  };
  return { ...actual, default: { ...actual.default, watch }, watch };
});

vi.mock("../src/core/backup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/backup.js")>();
  return { ...actual, backupCanonicalStore: vi.fn() };
});

vi.mock("../src/core/reconcile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/reconcile.js")>();
  return { ...actual, reconcileOnce: vi.fn() };
});

/** The smallest interval the daemon accepts. */
const INTERVAL = 60_000;
const RESULT = { action: "noop" } as unknown as ReconcileResult;
const GIT_RESULT = {} as GitSyncResult;

const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.mocked(reconcileOnce).mockReset().mockResolvedValue(RESULT);
  vi.mocked(backupCanonicalStore).mockReset().mockResolvedValue(GIT_RESULT);
});

afterEach(async () => {
  vi.useRealTimers();
  fake.watchers.splice(0);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function backupController(): Promise<LoadedProject> {
  const root = await mkdtemp(join(tmpdir(), "hs-backup-"));
  roots.push(root);
  const project = await initializeProject(root, { controllerId: "backup" });
  for (const target of Object.values(project.config.targets)) target.enabled = false;
  project.config.git.enabled = true;
  project.config.git.backupIntervalMs = INTERVAL;
  // Far away, so moving the clock fires the backup tick and nothing else.
  project.config.sync.auditIntervalMs = 100 * INTERVAL;
  await writeProjectConfig(project.configPath, project.config);
  return project;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await sleep(5);
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/** A promise the test resolves when it chooses. */
function gate<T>(value: T) {
  let open!: () => void;
  const promise = new Promise<T>((resolvePromise) => {
    open = () => resolvePromise(value);
  });
  return { promise, open };
}

async function start(project: LoadedProject) {
  const abort = new AbortController();
  const errors: Array<[string, string]> = [];
  let results = 0;
  const outcome = watchProject(project, {
    signal: abort.signal,
    onResult: () => {
      results += 1;
    },
    onError: (error, during) => errors.push([during, error.message]),
  }).then(
    () => "resolved" as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  await until(() => fake.watchers.length > 0, "the watcher");
  const watcher = fake.watchers.at(-1) as FakeWatcher;
  watcher.emit("ready");
  // The intervals exist once the startup cycle has begun.
  await until(() => vi.mocked(reconcileOnce).mock.calls.length > 0, "the startup cycle");
  return { abort, errors, outcome, watcher, results: () => results };
}

const backups = () => vi.mocked(backupCanonicalStore).mock.calls.length;

describe("the backup tick", () => {
  it("backs up at once when nothing else is running", async () => {
    const project = await backupController();
    const run = await start(project);
    await until(() => run.results() === 1, "the startup cycle to end");

    vi.advanceTimersByTime(INTERVAL);
    expect(backups()).toBe(1);

    run.abort.abort();
    expect(await run.outcome).toBe("resolved");
  });

  it("waits for a running sync cycle and backs up the moment it ends", async () => {
    const cycle = gate(RESULT);
    vi.mocked(reconcileOnce).mockImplementationOnce(() => cycle.promise);
    const project = await backupController();
    const run = await start(project);

    vi.advanceTimersByTime(INTERVAL);
    await sleep(20);
    expect(backups()).toBe(0);

    cycle.open();
    await until(() => backups() === 1, "the backup that waited for the cycle");
    expect(run.results()).toBe(1);

    run.abort.abort();
    expect(await run.outcome).toBe("resolved");
  });

  it("does not make a sync cycle wait for a running backup", async () => {
    const held = gate(GIT_RESULT);
    vi.mocked(backupCanonicalStore).mockImplementationOnce(() => held.promise);
    const project = await backupController();
    const run = await start(project);
    await until(() => run.results() === 1, "the startup cycle to end");

    vi.advanceTimersByTime(INTERVAL);
    expect(backups()).toBe(1);
    run.watcher.emit("all", "change", join(project.storeDir, "harness.yaml"));
    await until(() => run.results() === 2, "a cycle during the backup");

    held.open();
    run.abort.abort();
    expect(await run.outcome).toBe("resolved");
  });

  it("does not make the next tick's backup wait for one still running", async () => {
    // A stalled push: nothing bounds how long it can hold on.
    const stalled = gate(GIT_RESULT);
    vi.mocked(backupCanonicalStore).mockImplementationOnce(() => stalled.promise);
    const project = await backupController();
    const run = await start(project);
    await until(() => run.results() === 1, "the startup cycle to end");

    vi.advanceTimersByTime(INTERVAL);
    vi.advanceTimersByTime(INTERVAL);
    expect(backups()).toBe(2);

    stalled.open();
    run.abort.abort();
    expect(await run.outcome).toBe("resolved");
  });

  it("reports a failed backup and still runs the next tick", async () => {
    vi.mocked(backupCanonicalStore).mockRejectedValueOnce(new Error("Secret scan blocked Git sync"));
    const project = await backupController();
    const run = await start(project);
    await until(() => run.results() === 1, "the startup cycle to end");

    vi.advanceTimersByTime(INTERVAL);
    await until(() => run.errors.length === 1, "the failure report");
    expect(run.errors).toEqual([["backup", "Secret scan blocked Git sync"]]);

    vi.advanceTimersByTime(INTERVAL);
    expect(backups()).toBe(2);

    run.abort.abort();
    expect(await run.outcome).toBe("resolved");
  });

  it("starts no backup after a stop, even one that was waiting for a cycle", async () => {
    const cycle = gate(RESULT);
    vi.mocked(reconcileOnce).mockImplementationOnce(() => cycle.promise);
    const project = await backupController();
    const run = await start(project);

    vi.advanceTimersByTime(INTERVAL);
    run.abort.abort();
    cycle.open();
    expect(await run.outcome).toBe("resolved");
    await sleep(20);
    expect(backups()).toBe(0);
  });
});
