import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultProjectConfig,
  loadProjectConfig,
  PROJECT_CONFIG_NAME,
  writeProjectConfig,
} from "../src/core/config.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const cliPath = resolve("src/cli.ts");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("multi-controller CLI", () => {
  it("registers, discovers, syncs, reports, and updates multiple controllers", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-cli-"));
    roots.push(root);
    const registry = join(root, "registry.yaml");
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);

    const firstInit = await runCli([
      "--registry", registry,
      "-C", first,
      "init", "--id", "first", "--register",
    ]);
    const secondInit = await runCli([
      "--registry", registry,
      "-C", second,
      "init", "--id", "second", "--register",
    ]);
    expect(firstInit).toMatchObject({ controllerId: "first", registered: { id: "first" } });
    expect(secondInit).toMatchObject({ controllerId: "second", registered: { id: "second" } });

    const listed = await runCli(["--registry", registry, "manage", "list"]);
    expect(listed.controllers.map((entry: { id: string }) => entry.id)).toEqual([
      "first",
      "second",
    ]);
    const discovered = await runCli([
      "--registry", registry,
      "manage", "discover", root,
    ]);
    expect(discovered).toMatchObject({ mutated: false });
    expect(discovered.controllers).toHaveLength(2);

    const synced = await runCli([
      "--registry", registry,
      "sync", "--all", "--concurrency", "2",
    ]);
    expect(synced.summary).toEqual({ total: 2, ok: 2, conflicts: 0, errors: 0 });
    const status = await runCli(["--registry", registry, "status", "--all"]);
    expect(status.summary).toEqual({ total: 2, enabled: 2, degraded: 0 });

    const updated = await runCli([
      "--registry", registry,
      "manage", "set", "second", "--watch", "false",
    ]);
    expect(updated.controller).toMatchObject({ id: "second", watch: false });

    await expect(
      runCli(["--registry", registry, "-C", first, "sync", "--all"]),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/cannot be combined with --all/u),
    });
  });

  it("persists an identity before enrolling a legacy controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-cli-legacy-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const configPath = join(projectRoot, PROJECT_CONFIG_NAME);
    const registry = join(root, "registry.yaml");
    await mkdir(projectRoot);
    const config = defaultProjectConfig();
    for (const target of Object.values(config.targets)) target.enabled = false;
    await writeProjectConfig(configPath, config);

    const result = await runCli([
      "--registry", registry,
      "manage", "add", projectRoot,
      "--id", "legacy-controller",
      "--disabled",
    ]);

    expect(result.controller).toMatchObject({
      id: "legacy-controller",
      enabled: false,
    });
    expect((await loadProjectConfig(configPath)).controllerId).toBe(
      "legacy-controller",
    );
  });
});

async function runCli(arguments_: string[]): Promise<any> {
  const result = await execFile(
    process.execPath,
    ["--import", "tsx", cliPath, "--json", ...arguments_],
    { cwd: resolve("."), maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

describe("link-mode CLI", () => {
  it("reads, switches, refuses an unknown value, and no-ops on the same mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-linkmode-cli-"));
    roots.push(root);
    const project = join(root, "proj");
    await mkdir(project);
    await runCli(["-C", project, "init", "--id", "lmcli"]);
    await runCli(["-C", project, "apply"]);

    expect(await runCli(["-C", project, "link-mode"])).toMatchObject({
      linkMode: "symlink",
    });

    const preview = await runCli(["-C", project, "link-mode", "copy", "--dry-run"]);
    expect(preview).toMatchObject({ linkMode: "copy", dryRun: true, changed: true });
    expect(
      (await loadProjectConfig(join(project, PROJECT_CONFIG_NAME))).sync.linkMode,
    ).toBe("symlink");

    const switched = await runCli(["-C", project, "link-mode", "copy"]);
    expect(switched).toMatchObject({ linkMode: "copy", previous: "symlink", changed: true });
    expect(
      (await loadProjectConfig(join(project, PROJECT_CONFIG_NAME))).sync.linkMode,
    ).toBe("copy");

    expect(await runCli(["-C", project, "link-mode", "copy"])).toMatchObject({
      changed: false,
    });

    await expect(runCli(["-C", project, "link-mode", "sideways"])).rejects.toThrow();
  });
});
