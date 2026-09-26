import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { watchProject } from "../src/core/daemon.js";
import { pathExists } from "../src/core/fs.js";
import { addController } from "../src/core/registry.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import {
  watchAllControllers,
  type FleetWatchEvent,
  type RestartPolicy,
} from "../src/core/supervisor.js";

vi.mock("../src/core/daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/daemon.js")>();
  return { ...actual, watchProject: vi.fn(actual.watchProject) };
});

const actualDaemon = await vi.importActual<typeof import("../src/core/daemon.js")>(
  "../src/core/daemon.js",
);
const roots: string[] = [];

afterEach(async () => {
  vi.mocked(watchProject).mockReset();
  vi.mocked(watchProject).mockImplementation(actualDaemon.watchProject);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fastPolicy = { baseMs: 50, maxMs: 200, healthyAfterMs: 60_000 };

/** A watchProject stand-in that runs for `afterMs` and then fails. */
function failAfter(afterMs: number, message: string, code?: string) {
  return async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, afterMs));
    throw Object.assign(new Error(message), code === undefined ? {} : { code });
  };
}

interface Fleet {
  events: FleetWatchEvent[];
  abort: AbortController;
  outcome: Promise<string>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  count(type: FleetWatchEvent["type"], id: string): number;
}

function startFleet(
  registryPath: string,
  restartPolicy: Partial<RestartPolicy> = fastPolicy,
): Fleet {
  const events: FleetWatchEvent[] = [];
  const abort = new AbortController();
  let settled: string | undefined;
  const outcome = watchAllControllers({
    registryPath,
    signal: abort.signal,
    restartPolicy,
    onEvent: (event) => events.push(event),
  }).then(
    () => (settled = "resolved"),
    (error: unknown) =>
      (settled = `rejected: ${error instanceof Error ? error.message : String(error)}`),
  );
  return {
    events,
    abort,
    outcome,
    count: (type, id) => events.filter((event) => event.type === type && event.id === id).length,
    async waitFor(predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        // Fail with the fleet's own outcome rather than a bare timeout when the
        // whole fleet stopped underneath the condition being waited for.
        if (settled !== undefined) throw new Error(`fleet ended first: ${settled}`);
        if (Date.now() > deadline) throw new Error("timed out waiting for condition");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
    },
  };
}

describe("fleet isolates a failing controller", () => {
  it("keeps the other controllers running and restarts the failed one", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const first = await makeQuietController(join(root, "first"), "first");
    const second = await makeQuietController(join(root, "second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });
    // Registry order: "first" makes the first watchProject call.
    vi.mocked(watchProject).mockImplementationOnce(
      failAfter(20, "EMFILE: too many open files, watch '/x'", "EMFILE"),
    );

    const fleet = startFleet(registryPath);
    await fleet.waitFor(() => fleet.count("result", "first") >= 1);
    await fleet.waitFor(() => fleet.count("result", "second") >= 1);
    const secondBefore = fleet.count("result", "second");
    await writeFile(join(second.storeDir, "instructions", "root.md"), "edited\n");
    await fleet.waitFor(() => fleet.count("result", "second") > secondBefore);
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    expect(fleet.events).toContainEqual(
      expect.objectContaining({
        type: "restarting",
        id: "first",
        attempt: 1,
        delayMs: 50,
        error: expect.stringMatching(/^EMFILE/u),
      }),
    );
    expect(fleet.count("started", "first")).toBe(2);
    expect(fleet.count("started", "second")).toBe(1);
    expect(fleet.count("restarting", "second")).toBe(0);
    expect(fleet.count("stopped", "first")).toBe(1);
    expect(fleet.count("stopped", "second")).toBe(1);
    expect(await pathExists(join(first.storeDir, ".lock"))).toBe(false);
    expect(await pathExists(join(second.storeDir, ".lock"))).toBe(false);
  });

  it("backs off exponentially up to the cap", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const only = await makeQuietController(join(root, "only"), "only");
    await addController(only.configPath, { registryPath });
    for (let index = 0; index < 4; index += 1) {
      vi.mocked(watchProject).mockImplementationOnce(
        failAfter(5, `EMFILE: too many open files (${index})`, "EMFILE"),
      );
    }

    const fleet = startFleet(registryPath);
    await fleet.waitFor(() => fleet.count("result", "only") >= 1);
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    const restarts = fleet.events.flatMap((event) =>
      event.type === "restarting" ? [[event.attempt, event.delayMs]] : [],
    );
    expect(restarts).toEqual([[1, 50], [2, 100], [3, 200], [4, 200]]);
    expect(fleet.count("started", "only")).toBe(5);
  });

  it("resets the backoff after a run that stayed healthy", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const only = await makeQuietController(join(root, "only"), "only");
    await addController(only.configPath, { registryPath });
    vi.mocked(watchProject)
      .mockImplementationOnce(failAfter(5, "UNKNOWN: unknown error, watch", "UNKNOWN"))
      .mockImplementationOnce(failAfter(5, "UNKNOWN: unknown error, watch", "UNKNOWN"))
      // Outlives healthyAfterMs below, so the next failure starts over.
      .mockImplementationOnce(failAfter(150, "UNKNOWN: unknown error, watch", "UNKNOWN"));

    const fleet = startFleet(registryPath, { baseMs: 50, maxMs: 1_000, healthyAfterMs: 100 });
    await fleet.waitFor(() => fleet.count("result", "only") >= 1);
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    const delays = fleet.events.flatMap((event) =>
      event.type === "restarting" ? [event.delayMs] : [],
    );
    expect(delays).toEqual([50, 100, 50]);
  });

  it("parks a controller whose failure carries no errno code, and only that one", async () => {
    // A code-less failure is a programming error or an invalid controller:
    // retrying cannot fix it, so it stays stopped for inspection while the
    // rest of the fleet keeps syncing.
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const first = await makeQuietController(join(root, "first"), "first");
    const second = await makeQuietController(join(root, "second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });
    vi.mocked(watchProject).mockImplementationOnce(
      failAfter(20, "Cannot read properties of undefined (reading 'x')"),
    );

    const fleet = startFleet(registryPath);
    await fleet.waitFor(() => fleet.count("parked", "first") === 1);
    await fleet.waitFor(() => fleet.count("result", "second") >= 1);
    const secondBefore = fleet.count("result", "second");
    await writeFile(join(second.storeDir, "instructions", "root.md"), "edited\n");
    await fleet.waitFor(() => fleet.count("result", "second") > secondBefore);
    // Well past every backoff in fastPolicy: a parked controller is not retried.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    expect(fleet.events).toContainEqual(
      expect.objectContaining({
        type: "parked",
        id: "first",
        configPath: first.configPath,
        error: "Cannot read properties of undefined (reading 'x')",
      }),
    );
    expect(fleet.count("started", "first")).toBe(1);
    expect(fleet.count("restarting", "first")).toBe(0);
    expect(fleet.count("result", "first")).toBe(0);
    expect(await pathExists(join(first.storeDir, ".lock"))).toBe(false);
    expect(await pathExists(join(second.storeDir, ".lock"))).toBe(false);
  });

  it("keeps reminding that a controller is parked, with the stack on the first notice", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const first = await makeQuietController(join(root, "first"), "first");
    const second = await makeQuietController(join(root, "second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });
    vi.mocked(watchProject).mockImplementationOnce(
      failAfter(5, "Cannot read properties of undefined (reading 'x')"),
    );

    const fleet = startFleet(registryPath, { ...fastPolicy, parkedReminderMs: 40 });
    await fleet.waitFor(() => fleet.count("parked", "first") >= 3);
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    const parked = fleet.events.filter(
      (event): event is Extract<FleetWatchEvent, { type: "parked" }> =>
        event.type === "parked" && event.id === "first",
    );
    expect(parked[0]).toMatchObject({ error: "Cannot read properties of undefined (reading 'x')" });
    expect(parked[0]?.reminder).toBeUndefined();
    expect(parked[0]?.stack).toMatch(/Cannot read properties/u);
    expect(Date.parse(parked[0]!.since)).not.toBeNaN();
    for (const reminder of parked.slice(1)) {
      expect(reminder).toMatchObject({ reminder: true, since: parked[0]!.since });
      expect(reminder.stack).toBeUndefined();
    }
  });

  it("stops the fleet with an error once every controller is parked", async () => {
    // Nothing is syncing any more: staying up would look healthy to a service
    // manager while doing nothing, so the process must end nonzero instead.
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const first = await makeQuietController(join(root, "first"), "first");
    const second = await makeQuietController(join(root, "second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });
    vi.mocked(watchProject).mockImplementation(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    });

    const fleet = startFleet(registryPath);
    const settled = await Promise.race([
      fleet.outcome,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000, "still running")),
    ]);
    fleet.abort.abort();

    expect(settled).toMatch(/^rejected: every controller is parked.*first.*second/su);
    expect(await pathExists(join(first.storeDir, ".lock"))).toBe(false);
    expect(await pathExists(join(second.storeDir, ".lock"))).toBe(false);
  });

  it("reports every controller stopped at shutdown, parked and backing off included", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const parked = await makeQuietController(join(root, "parked"), "parked");
    const waiting = await makeQuietController(join(root, "waiting"), "waiting");
    const healthy = await makeQuietController(join(root, "healthy"), "healthy");
    for (const project of [parked, waiting, healthy]) {
      await addController(project.configPath, { registryPath });
    }
    vi.mocked(watchProject)
      .mockImplementationOnce(failAfter(5, "Cannot read properties of undefined"))
      .mockImplementationOnce(failAfter(5, "EMFILE: too many open files", "EMFILE"));

    const fleet = startFleet(registryPath, { ...fastPolicy, baseMs: 60_000, maxMs: 60_000 });
    await fleet.waitFor(() => fleet.count("parked", "parked") === 1);
    await fleet.waitFor(() => fleet.count("restarting", "waiting") === 1);
    await fleet.waitFor(() => fleet.count("result", "healthy") >= 1);
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    for (const id of ["parked", "waiting", "healthy"]) {
      expect(fleet.count("stopped", id)).toBe(1);
      expect(fleet.events.filter((event) => event.id === id).at(-1)?.type).toBe("stopped");
    }
  });

  it("still stops the fleet when a controller needs its config reloaded", async () => {
    // Guard: this is the one controller failure that must keep today's
    // fleet-wide semantics, since only a fresh plan can load new roots/policy.
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const only = await makeQuietController(join(root, "only"), "only");
    const other = await makeQuietController(join(root, "other"), "other");
    await addController(only.configPath, { registryPath });
    await addController(other.configPath, { registryPath });
    vi.mocked(watchProject).mockImplementationOnce(
      failAfter(
        20,
        `${only.configPath} changed; restart harness-sync watch to reload roots and policy`,
      ),
    );

    await expect(
      watchAllControllers({ registryPath, restartPolicy: fastPolicy }),
    ).rejects.toThrow(/controller only stopped: .*restart harness-sync watch/u);
    expect(await pathExists(join(only.storeDir, ".lock"))).toBe(false);
    expect(await pathExists(join(other.storeDir, ".lock"))).toBe(false);
  });

  it("reports a controller's skipped path as a fleet warning", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const only = await makeQuietController(join(root, "only"), "only");
    await addController(only.configPath, { registryPath });
    vi.mocked(watchProject).mockImplementationOnce(async (project, options) => {
      options?.onWarning?.({
        path: "/abs/SingletonSocket",
        code: "UNKNOWN",
        message: "UNKNOWN: unknown error, watch '/abs/SingletonSocket'",
      });
      return actualDaemon.watchProject(project, options);
    });

    const fleet = startFleet(registryPath);
    await fleet.waitFor(() => fleet.count("result", "only") >= 1);
    fleet.abort.abort();

    expect(await fleet.outcome).toBe("resolved");
    expect(fleet.events).toContainEqual({
      type: "warning",
      id: "only",
      configPath: only.configPath,
      path: "/abs/SingletonSocket",
      code: "UNKNOWN",
      warning: "UNKNOWN: unknown error, watch '/abs/SingletonSocket'",
    });
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-isolation-"));
  roots.push(root);
  return root;
}

async function makeQuietController(root: string, controllerId: string): Promise<LoadedProject> {
  await mkdir(root, { recursive: true });
  const project = await initializeProject(root, { controllerId });
  for (const target of Object.values(project.config.targets)) target.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  return project;
}
