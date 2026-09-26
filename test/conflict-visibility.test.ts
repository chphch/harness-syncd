import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHarness } from "../src/core/config.js";
import { pathExists } from "../src/core/fs.js";
import { migrateFrom } from "../src/core/migrate.js";
import { applyHarness, initializeProject, type LoadedProject } from "../src/core/project.js";
import { establishBaseline, reconcileOnce } from "../src/core/reconcile.js";
import { addController } from "../src/core/registry.js";
import { statusAllControllers } from "../src/core/supervisor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A controller whose next cycle is a genuine two-sided conflict: canonical and
 * Claude's materialized settings.json both changed since the last state.
 */
async function conflicted(): Promise<{
  project: LoadedProject;
  registryPath: string;
  restoreNative: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "hs-conflict-visibility-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".claude"), { recursive: true });
  await writeFile(join(projectRoot, "CLAUDE.md"), "Instructions\n", "utf8");
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] } }), "utf8");
  const project = await initializeProject(projectRoot, { controllerId: "visible" });
  await migrateFrom(project, "claude", {
    apply: true,
    install: true,
    includeLocal: false,
    force: true,
    excludeSkills: [],
  });
  expect((await reconcileOnce(project)).action).toBe("noop");
  const registryPath = join(root, "registry.yaml");
  await addController(project.configPath, { registryPath });

  const original = await readFile(settingsPath);
  await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Read", "Bash"] } }), "utf8");
  await writeFile(join(project.storeDir, "instructions", "root.md"), "Edited in the store\n", "utf8");
  return { project, registryPath, restoreNative: () => writeFile(settingsPath, original) };
}

const record = (project: LoadedProject) => join(project.storeDir, "conflicts", "current.json");

describe("the current conflict record", () => {
  it("is removed by the first cycle that no longer conflicts", async () => {
    const { project, restoreNative } = await conflicted();
    expect((await reconcileOnce(project)).action).toBe("conflict");
    expect(await pathExists(record(project))).toBe(true);

    await restoreNative();
    expect((await reconcileOnce(project)).action).toBe("projected-canonical");

    expect(await pathExists(record(project))).toBe(false);
  });

  it("is removed by an explicit re-baseline such as apply --force", async () => {
    const { project } = await conflicted();
    expect((await reconcileOnce(project)).action).toBe("conflict");

    const harness = await loadHarness(project.storeDir);
    await applyHarness(project, harness, { dryRun: false, force: true });
    await establishBaseline(project, harness);

    expect(await pathExists(record(project))).toBe(false);
  });

  it("marks the controller degraded in status --all until it is resolved", async () => {
    const { project, registryPath, restoreNative } = await conflicted();
    expect((await reconcileOnce(project)).action).toBe("conflict");

    const during = await statusAllControllers(registryPath);
    expect(during.summary.degraded).toBe(1);
    expect(during.controllers[0]).toMatchObject({
      id: "visible",
      status: "conflict",
      error: expect.stringMatching(/Concurrent canonical\/native/u),
    });

    await restoreNative();
    await reconcileOnce(project);
    const after = await statusAllControllers(registryPath);
    expect(after.summary.degraded).toBe(0);
    expect(after.controllers[0]?.status).toBe("ok");
  });
});
