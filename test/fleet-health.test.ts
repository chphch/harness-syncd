import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import {
  createFleetHealthRecorder,
  fleetHealthPath,
  type FleetHealth,
} from "../src/core/fleet-health.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import type { ReconcileResult } from "../src/core/reconcile.js";
import { addController } from "../src/core/registry.js";
import { statusAllControllers, type FleetWatchEvent } from "../src/core/supervisor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hs-fleet-health-"));
  roots.push(root);
  return root;
}

async function quietController(root: string, controllerId: string): Promise<LoadedProject> {
  await mkdir(root, { recursive: true });
  const project = await initializeProject(root, { controllerId });
  for (const target of Object.values(project.config.targets)) target.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  return project;
}

function result(action: ReconcileResult["action"], message?: string): ReconcileResult {
  return {
    action,
    changedTargets: [],
    applyResults: [],
    warnings: [],
    state: null,
    ...(message
      ? {
          conflict: {
            detectedAt: "2026-09-26T00:00:00.000Z",
            canonicalChanged: true,
            changedTargets: ["claude"],
            message,
          },
        }
      : {}),
  };
}

async function readHealth(path: string): Promise<FleetHealth> {
  return JSON.parse(await readFile(path, "utf8")) as FleetHealth;
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  return child.pid!;
}

describe("fleet health recorder", () => {
  it("records each controller's watch state and its latest failing cycle", async () => {
    const root = await tempRoot();
    const path = fleetHealthPath(join(root, "registry.yaml"));
    expect(path).toBe(join(root, "registry.health.json"));
    let clock = Date.parse("2026-09-26T10:00:00.000Z");
    const recorder = createFleetHealthRecorder(path, { now: () => new Date(clock), pid: 4242 });
    const base = { id: "alpha", configPath: "/p/alpha/harness-sync.yaml" };
    const observe = (event: FleetWatchEvent) => recorder.observe(event);

    observe({ type: "started", ...base });
    observe({ type: "result", ...base, result: result("conflict", "Concurrent edits") });
    await recorder.flush();
    expect(await readHealth(path)).toMatchObject({
      schemaVersion: 1,
      pid: 4242,
      startedAt: "2026-09-26T10:00:00.000Z",
      controllers: {
        alpha: {
          state: "running",
          cycle: { outcome: "conflict", message: "Concurrent edits", since: "2026-09-26T10:00:00.000Z" },
        },
      },
    });

    clock += 60_000;
    observe({ type: "result", ...base, result: result("conflict", "Concurrent edits") });
    observe({ type: "error", ...base, error: "EBADF: spawn", during: "backup" });
    await recorder.flush();
    // Same conflict again: its start time is kept, and a backup error is not a cycle.
    expect((await readHealth(path)).controllers.alpha?.cycle?.since).toBe("2026-09-26T10:00:00.000Z");

    observe({ type: "error", ...base, error: "state was not advanced", during: "sync" });
    await recorder.flush();
    expect((await readHealth(path)).controllers.alpha?.cycle).toEqual({
      outcome: "error",
      message: "state was not advanced",
      since: "2026-09-26T10:01:00.000Z",
    });

    observe({ type: "result", ...base, result: result("noop") });
    observe({ type: "error", ...base, error: "EMFILE: too many open files", during: "watch" });
    observe({
      type: "restarting",
      ...base,
      error: "EMFILE: too many open files",
      attempt: 2,
      delayMs: 20_000,
    });
    await recorder.flush();
    expect((await readHealth(path)).controllers.alpha).toEqual({
      state: "restarting",
      since: "2026-09-26T10:01:00.000Z",
      error: "EMFILE: too many open files",
      attempt: 2,
      retryAt: "2026-09-26T10:01:20.000Z",
    });

    observe({ type: "parked", ...base, error: "TypeError: x", since: "2026-09-26T10:01:30.000Z" });
    await recorder.flush();
    const parked = await readHealth(path);
    expect(parked.controllers.alpha).toEqual({
      state: "parked",
      since: "2026-09-26T10:01:30.000Z",
      error: "TypeError: x",
    });

    clock += 3_600_000;
    observe({
      type: "parked",
      ...base,
      error: "TypeError: x",
      since: "2026-09-26T10:01:30.000Z",
      reminder: true,
    });
    await recorder.flush();
    // A reminder changes nothing, so nothing is rewritten.
    expect((await readHealth(path)).updatedAt).toBe(parked.updatedAt);

    await recorder.close();
    expect((await readHealth(path)).stoppedAt).toBe("2026-09-26T11:01:00.000Z");
  });

  it("reports a write failure once and keeps observing", async () => {
    const root = await tempRoot();
    // A directory where the file should go makes every write fail.
    const path = join(root, "registry.health.json");
    await mkdir(path);
    const failures: string[] = [];
    const recorder = createFleetHealthRecorder(path, {
      onWriteError: (error) => failures.push(error.message),
    });
    const base = { id: "alpha", configPath: "/p/alpha/harness-sync.yaml" };
    recorder.observe({ type: "started", ...base });
    await recorder.flush();
    recorder.observe({ type: "result", ...base, result: result("conflict", "x") });
    await recorder.flush();
    await recorder.close();
    expect(failures).toHaveLength(1);
  });
});

describe("status --all with a running daemon", () => {
  async function fleetWithHealth(health: (pid: number) => Omit<FleetHealth, "pid">, pid: number) {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const parked = await quietController(join(root, "parked"), "parked");
    const fine = await quietController(join(root, "fine"), "fine");
    await addController(parked.configPath, { registryPath });
    await addController(fine.configPath, { registryPath });
    await writeFile(
      fleetHealthPath(registryPath),
      JSON.stringify({ ...health(pid), pid }),
      "utf8",
    );
    return registryPath;
  }

  const parkedFleet = (): Omit<FleetHealth, "pid"> => ({
    schemaVersion: 1,
    startedAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:05:00.000Z",
    controllers: {
      parked: { state: "parked", since: "2026-09-26T10:05:00.000Z", error: "TypeError: x" },
      fine: {
        state: "running",
        since: "2026-09-26T10:00:00.000Z",
      },
    },
  });

  it("counts a parked controller as degraded", async () => {
    const registryPath = await fleetWithHealth(parkedFleet, process.pid);
    const status = await statusAllControllers(registryPath);

    expect(status.daemon).toMatchObject({ running: true, pid: process.pid });
    expect(status.summary.degraded).toBe(1);
    const parked = status.controllers.find((entry) => entry.id === "parked");
    expect(parked).toMatchObject({ status: "error", error: expect.stringMatching(/parked since .*TypeError: x/u) });
    expect(parked?.value?.daemon?.state).toBe("parked");
    expect(status.controllers.find((entry) => entry.id === "fine")?.status).toBe("ok");
  });

  it("counts a controller whose cycles keep failing, or that is restarting, as degraded", async () => {
    const registryPath = await fleetWithHealth(() => ({
      schemaVersion: 1,
      startedAt: "2026-09-26T10:00:00.000Z",
      updatedAt: "2026-09-26T10:05:00.000Z",
      controllers: {
        parked: {
          state: "restarting",
          since: "2026-09-26T10:05:00.000Z",
          error: "EMFILE: too many open files",
          attempt: 3,
          retryAt: "2026-09-26T10:05:40.000Z",
        },
        fine: {
          state: "running",
          since: "2026-09-26T10:00:00.000Z",
          cycle: { outcome: "error", message: "spawn EBADF", since: "2026-09-26T10:01:00.000Z" },
        },
      },
    }), process.pid);
    const status = await statusAllControllers(registryPath);

    expect(status.summary.degraded).toBe(2);
    expect(status.controllers.find((entry) => entry.id === "parked"))
      .toMatchObject({ status: "error", error: expect.stringMatching(/restarting \(attempt 3/u) });
    expect(status.controllers.find((entry) => entry.id === "fine"))
      .toMatchObject({ status: "error", error: expect.stringMatching(/spawn EBADF/u) });
  });

  it("ignores the health of a daemon that is no longer running", async () => {
    const registryPath = await fleetWithHealth(parkedFleet, await deadPid());
    const status = await statusAllControllers(registryPath);

    expect(status.daemon.running).toBe(false);
    expect(status.summary.degraded).toBe(0);
  });

  it("ignores the health of a daemon that recorded a clean stop", async () => {
    const registryPath = await fleetWithHealth(
      () => ({ ...parkedFleet(), stoppedAt: "2026-09-26T10:06:00.000Z" }),
      process.pid,
    );
    const status = await statusAllControllers(registryPath);

    expect(status.daemon.running).toBe(false);
    expect(status.summary.degraded).toBe(0);
  });
});
