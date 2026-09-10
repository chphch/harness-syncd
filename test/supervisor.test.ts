import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { watchProject } from "../src/core/daemon.js";
import { acquireLock, pathExists } from "../src/core/fs.js";
import {
  addController,
  defaultRegistry,
  loadRegistry,
  writeRegistry,
} from "../src/core/registry.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import {
  planControllers,
  statusAllControllers,
  syncAllControllers,
  watchAllControllers,
  type FleetWatchEvent,
} from "../src/core/supervisor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("multi-controller supervisor", () => {
  it("reconciles disjoint controllers concurrently and preserves registry order", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "machine", "registry.yaml");
    const first = await makeQuietController(join(root, "first"), "first");
    const second = await makeQuietController(join(root, "second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });

    const initial = await syncAllControllers(registryPath, { concurrency: 2 });
    expect(initial.controllers.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(initial.controllers.map((entry) => entry.status)).toEqual(["ok", "ok"]);
    expect(initial.controllers.map((entry) => entry.value?.action)).toEqual([
      "baseline",
      "baseline",
    ]);
    expect(initial.summary).toEqual({ total: 2, ok: 2, conflicts: 0, errors: 0 });

    const repeated = await syncAllControllers(registryPath);
    expect(repeated.controllers.map((entry) => entry.value?.action)).toEqual([
      "noop",
      "noop",
    ]);
    const status = await statusAllControllers(registryPath);
    expect(status.summary).toEqual({ total: 2, enabled: 2, degraded: 0 });
    expect(status.controllers.map((entry) => entry.status)).toEqual(["ok", "ok"]);
  });

  it("supervises a user controller and project controller together", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const user = await initializeProject(join(root, "user-controller"), {
      scope: "user",
      store: join(root, "user-store"),
      controllerId: "user",
    });
    for (const [target, config] of Object.entries(user.config.targets)) {
      config.root = join(root, "user-native", target);
    }
    await writeProjectConfig(user.configPath, user.config);
    const project = await makeQuietController(join(root, "project"), "project");
    await addController(user.configPath, { registryPath });
    await addController(project.configPath, { registryPath });

    const result = await syncAllControllers(registryPath, { concurrency: 2 });
    expect(result.controllers.map((entry) => entry.status)).toEqual(["ok", "ok"]);
    const status = await statusAllControllers(registryPath);
    expect(status.controllers.map((entry) => entry.value?.scope)).toEqual([
      "user",
      "project",
    ]);
  });

  it("acquires every store lock before allowing the first mutation", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const first = await makeQuietController(join(root, "a-first"), "first");
    const second = await makeQuietController(join(root, "z-second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });
    const releaseSecond = await acquireLock(join(second.storeDir, ".lock"));

    try {
      await expect(syncAllControllers(registryPath)).rejects.toThrow(
        /another harness-sync process holds/u,
      );
      expect(await pathExists(join(first.storeDir, ".state.json"))).toBe(false);
      expect(await pathExists(join(second.storeDir, ".state.json"))).toBe(false);
      expect(await pathExists(join(first.storeDir, ".lock"))).toBe(false);
      expect(await pathExists(join(second.storeDir, ".lock"))).toBe(true);
    } finally {
      await releaseSecond();
    }
  });

  it("blocks a mutating plan when an enabled controller is offline", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const online = await makeQuietController(join(root, "online"), "online");
    await addController(online.configPath, { registryPath });
    const registry = await loadRegistry(registryPath);
    registry.controllers.push({
      id: "offline",
      config: join(root, "missing", "harness-sync.yaml"),
      enabled: true,
      watch: true,
    });
    await writeRegistry(registry, registryPath);

    await expect(planControllers(registryPath, "sync")).rejects.toThrow(
      /unavailable|offline/u,
    );
    expect(await pathExists(join(online.storeDir, ".state.json"))).toBe(false);
    const status = await statusAllControllers(registryPath);
    expect(status.controllers).toContainEqual(
      expect.objectContaining({ id: "offline", status: "missing" }),
    );
    expect(status.summary.degraded).toBeGreaterThan(0);
  });

  it("runs and cleanly stops all watch loops under one abort signal", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const first = await makeQuietController(join(root, "first"), "first");
    const second = await makeQuietController(join(root, "second"), "second");
    await addController(first.configPath, { registryPath });
    await addController(second.configPath, { registryPath });
    const abort = new AbortController();
    const events: FleetWatchEvent[] = [];
    const timeout = setTimeout(() => abort.abort(), 2_000);

    try {
      await watchAllControllers({
        registryPath,
        signal: abort.signal,
        onEvent: (event) => {
          events.push(event);
          const baselined = new Set(
            events
              .filter(
                (candidate) =>
                  candidate.type === "result" &&
                  candidate.result.action === "baseline",
              )
              .map((candidate) => candidate.id),
          );
          if (baselined.size === 2) abort.abort();
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    expect(events.filter((event) => event.type === "started")).toHaveLength(2);
    expect(await pathExists(join(first.storeDir, ".lock"))).toBe(false);
    expect(await pathExists(join(second.storeDir, ".lock"))).toBe(false);
  });

  it("stops the fleet instead of continuing with a changed registry", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const project = await makeQuietController(join(root, "project"), "project");
    await addController(project.configPath, { registryPath });
    let changed = false;

    await expect(
      watchAllControllers({
        registryPath,
        onEvent: (event) => {
          if (changed || event.type !== "result") return;
          changed = true;
          void (async () => {
            const registry = await loadRegistry(registryPath);
            registry.discovery.roots = [join(root, "projects")];
            await writeRegistry(registry, registryPath);
          })();
        },
      }),
    ).rejects.toThrow(/registry.*changed|restart harness-sync watch --all/u);
    expect(await pathExists(join(project.storeDir, ".lock"))).toBe(false);
  });

  it("stops the fleet when a controller config changes", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const project = await makeQuietController(join(root, "project"), "project");
    await addController(project.configPath, { registryPath });
    let changed = false;

    await expect(
      watchAllControllers({
        registryPath,
        onEvent: (event) => {
          if (changed || event.type !== "result") return;
          changed = true;
          project.config.sync.debounceMs += 1;
          void writeProjectConfig(project.configPath, project.config);
        },
      }),
    ).rejects.toThrow(/config.*changed|restart harness-sync watch/u);
    expect(await pathExists(join(project.storeDir, ".lock"))).toBe(false);
  });

  it("releases an individual store lock when watch startup fails", async () => {
    const root = await tempRoot();
    const project = await makeQuietController(join(root, "project"), "project");
    await rm(project.configPath);

    await expect(watchProject(project)).rejects.toThrow(/config is missing/u);
    expect(await pathExists(join(project.storeDir, ".lock"))).toBe(false);
  });

  it("reports a registry path that overlaps a controller store", async () => {
    const root = await tempRoot();
    const project = await makeQuietController(join(root, "project"), "project");
    const registryPath = join(project.storeDir, "registry.yaml");
    const registry = defaultRegistry();
    registry.controllers.push({
      id: "project",
      config: project.configPath,
      enabled: true,
      watch: true,
    });
    await writeRegistry(registry, registryPath);

    const status = await statusAllControllers(registryPath);
    expect(status.topologyError).toMatch(/registry.*overlaps.*canonical store/u);
    expect(status.summary.degraded).toBeGreaterThan(0);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-supervisor-"));
  roots.push(root);
  return root;
}

async function makeQuietController(
  root: string,
  controllerId: string,
): Promise<LoadedProject> {
  await mkdir(root, { recursive: true });
  const project = await initializeProject(root, { controllerId });
  for (const target of Object.values(project.config.targets)) {
    target.enabled = false;
  }
  await writeProjectConfig(project.configPath, project.config);
  return project;
}
