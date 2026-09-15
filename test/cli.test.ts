import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

describe("carry CLI", () => {
  /** Every carry verb resolves `~` through os.homedir(), so the CLI runs with
   * HOME pointed at the fixture — otherwise `carry add ~/Library/LaunchAgents`
   * in a test would read the developer's real launchd agents. */
  async function carryCli(home: string, arguments_: string[]): Promise<any> {
    const result = await execFile(
      process.execPath,
      ["--import", "tsx", cliPath, "--json", ...arguments_],
      { cwd: resolve("."), maxBuffer: 10 * 1024 * 1024, env: { ...process.env, HOME: home } },
    );
    return JSON.parse(result.stdout);
  }

  async function seed() {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-carry-cli-"));
    roots.push(root);
    const home = join(root, "home");
    const project = join(home, "project");
    const agents = join(home, "Library", "LaunchAgents");
    await mkdir(agents, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(agents, "com.example.job.plist"), "<plist/>\n", "utf8");
    await writeFile(join(agents, "com.other.vendor.plist"), "<plist/>\n", "utf8");
    await carryCli(home, ["-C", project, "init", "--id", "carrycli"]);
    return { home, project, agents };
  }

  it("previews without writing, and names what it did NOT match", async () => {
    // The unmatched list is MANDATORY output: it is how the author learns the
    // directory also holds files owned by somebody else, while they can still
    // act on it.
    const { home, project, agents } = await seed();

    const preview = await carryCli(home, [
      "-C", project, "carry", "add", agents,
      "--name", "launch-agents", "--include", "com.example.*.plist",
    ]);

    expect(preview.applied).toBe(false);
    expect(preview.declaration.destination).toBe("~/Library/LaunchAgents");
    expect(preview.matched.map((file: { name: string }) => file.name))
      .toEqual(["com.example.job.plist"]);
    expect(preview.unmatched).toEqual(["com.other.vendor.plist"]);
    expect(await carryCli(home, ["-C", project, "carry", "list"])).toMatchObject({ entries: [] });
  });

  it("refuses a directory with no include patterns", async () => {
    const { home, project, agents } = await seed();

    await expect(carryCli(home, ["-C", project, "carry", "add", agents, "--apply"]))
      .rejects.toThrow(/--include is required/u);
  });

  it("says capture is off rather than staying silent about it", async () => {
    const { home, project, agents } = await seed();
    await carryCli(home, [
      "-C", project, "carry", "add", agents, "--name", "launch-agents",
      "--include", "com.example.*.plist", "--apply",
    ]);

    const listed = await carryCli(home, ["-C", project, "carry", "list"]);

    expect(listed.enabled).toBe(false);
    expect(listed.warnings.map((item: { code: string }) => item.code))
      .toEqual(["carry-capture-disabled"]);
  });

  it("enables, captures, and leaves the destination alone", async () => {
    const { home, project, agents } = await seed();
    await carryCli(home, [
      "-C", project, "carry", "add", agents, "--name", "launch-agents",
      "--include", "com.example.*.plist", "--apply",
    ]);
    await carryCli(home, ["-C", project, "carry", "enable"]);

    const captured = await carryCli(home, ["-C", project, "carry", "capture"]);

    expect(captured.captured).toEqual(["carry/launch-agents/com.example.job.plist"]);
    expect((await readdir(agents)).sort())
      .toEqual(["com.example.job.plist", "com.other.vendor.plist"]);
    expect(await carryCli(home, ["-C", project, "status"]))
      .toMatchObject({ carry: { declared: 1, enabled: true } });
  });

  it("removes a declaration without deleting the copies it may be the last of", async () => {
    const { home, project, agents } = await seed();
    await carryCli(home, [
      "-C", project, "carry", "add", agents, "--name", "launch-agents",
      "--include", "com.example.*.plist", "--apply",
    ]);
    await carryCli(home, ["-C", project, "carry", "enable"]);
    await carryCli(home, ["-C", project, "carry", "capture"]);

    const removed = await carryCli(home, ["-C", project, "carry", "remove", "launch-agents"]);

    expect(removed.storeCopyKept).toBeTypeOf("string");
    expect(await readFile(
      join(project, ".harness-sync", "carry", "launch-agents", "com.example.job.plist"),
      "utf8",
    )).toBe("<plist/>\n");
    // The declaration is gone, and the key is erased rather than left as `[]`.
    expect(await readFile(join(project, ".harness-sync", "harness.yaml"), "utf8"))
      .not.toContain("carry:");
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
