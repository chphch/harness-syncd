import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { watchProject, type WatchWarning } from "../src/core/daemon.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";

/**
 * chokidar replaced by a watcher this test drives by hand, so startup states a
 * real filesystem produces only by accident — "ready" never arriving, errors
 * interleaved with the initial scan — are deterministic here.
 */
class FakeWatcher extends EventEmitter {
  readonly unwatched: string[] = [];
  closed = false;

  unwatch(path: string): this {
    this.unwatched.push(path);
    return this;
  }

  async close(): Promise<void> {
    this.closed = true;
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

const roots: string[] = [];

afterEach(async () => {
  fake.watchers.splice(0);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function quietController(): Promise<LoadedProject> {
  const root = await mkdtemp(join(tmpdir(), "hs-startup-"));
  roots.push(root);
  const project = await initializeProject(root, { controllerId: "startup" });
  for (const target of Object.values(project.config.targets)) target.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  return project;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function currentWatcher(): Promise<FakeWatcher> {
  for (let attempt = 0; attempt < 200 && fake.watchers.length === 0; attempt += 1) {
    await sleep(5);
  }
  const watcher = fake.watchers.at(-1);
  if (!(watcher instanceof FakeWatcher)) throw new Error("watchProject never created a watcher");
  return watcher;
}

function start(project: LoadedProject) {
  const abort = new AbortController();
  const errors: string[] = [];
  const warnings: WatchWarning[] = [];
  let results = 0;
  const outcome = watchProject(project, {
    signal: abort.signal,
    onResult: () => {
      results += 1;
    },
    onError: (error) => errors.push(error.message),
    onWarning: (warning) => warnings.push(warning),
  }).then(
    () => "resolved" as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  return { abort, errors, warnings, outcome, results: () => results };
}

function watchError(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: unknown error, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

describe("watch startup", () => {
  it("resolves promptly when aborted during a startup that never becomes ready", async () => {
    const project = await quietController();
    const run = start(project);
    const watcher = await currentWatcher();
    await sleep(100);

    run.abort.abort();
    const settled = await Promise.race([
      run.outcome,
      sleep(1_000).then(() => "still pending 1s after abort"),
    ]);
    expect(settled).toBe("resolved");
    expect(watcher.closed).toBe(true);
  });

  it("skips path-scoped errors during the initial scan and still becomes ready", async () => {
    const project = await quietController();
    const run = start(project);
    const watcher = await currentWatcher();
    await sleep(20);

    // Two of them: a once-registered listener would be consumed by the first.
    watcher.emit("error", watchError("UNKNOWN", "watch", "/abs/SingletonSocket"));
    watcher.emit("error", watchError("EACCES", "watch", "/abs/private"));
    watcher.emit("ready");
    for (let attempt = 0; attempt < 200 && run.results() === 0; attempt += 1) await sleep(10);

    run.abort.abort();
    expect(await run.outcome).toBe("resolved");
    expect(run.results()).toBeGreaterThan(0);
    expect(run.errors).toEqual([]);
    expect(watcher.unwatched).toEqual(["/abs/SingletonSocket", "/abs/private"]);
    expect(run.warnings.map((warning) => warning.code)).toEqual(["UNKNOWN", "EACCES"]);
  });

  it("fails startup on a fatal error even after skipping a path-scoped one", async () => {
    const project = await quietController();
    const run = start(project);
    const watcher = await currentWatcher();
    await sleep(20);

    watcher.emit("error", watchError("UNKNOWN", "watch", "/abs/SingletonSocket"));
    watcher.emit("error", watchError("EMFILE", "watch", "/abs/one-too-many"));
    const settled = await Promise.race([
      run.outcome,
      sleep(1_000).then(() => "still pending 1s after a fatal error"),
    ]);
    expect(settled).toMatch(/^rejected: EMFILE/u);
    expect(run.errors).toEqual([expect.stringMatching(/^EMFILE/u)]);
    expect(watcher.closed).toBe(true);
  });
});
