import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetNoticeWriter, formatDelay } from "../src/cli-fleet.js";
import { writeProjectConfig } from "../src/core/config.js";
import { readFleetHealth, type FleetHealth } from "../src/core/fleet-health.js";
import { migrateFrom } from "../src/core/migrate.js";
import { initializeProject } from "../src/core/project.js";
import { reconcileOnce } from "../src/core/reconcile.js";
import { addController } from "../src/core/registry.js";
import {
  statusAllControllers,
  type FleetStatusResult,
  type FleetWatchEvent,
} from "../src/core/supervisor.js";
import type { ReconcileResult } from "../src/core/reconcile.js";

const roots: string[] = [];

afterEach(() => {
  // rm -rf: the end-to-end fixture is deeper than PATH_MAX.
  for (const root of roots.splice(0)) execFileSync("rm", ["-rf", root]);
});

async function waitForHealth(
  registryPath: string,
  predicate: (health: FleetHealth) => boolean,
): Promise<FleetHealth> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const health = await readFleetHealth(registryPath);
    if (health && predicate(health)) return health;
    if (Date.now() > deadline) throw new Error(`fleet health never matched: ${JSON.stringify(health)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

const T0 = Date.parse("2026-09-26T10:00:00.000Z");

function collect(repeatMs?: number) {
  const lines: string[] = [];
  let clock = T0;
  const notice = createFleetNoticeWriter((text) => lines.push(text), {
    now: () => new Date(clock),
    ...(repeatMs === undefined ? {} : { repeatMs }),
  });
  return {
    lines,
    notice,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const base = { id: "alpha", configPath: "/p/alpha/harness-sync.yaml" };
const STAMP = "2026-09-26T10:00:00.000Z harness-sync: ";

function result(action: ReconcileResult["action"], message?: string): ReconcileResult {
  return {
    action,
    changedTargets: [],
    applyResults: [],
    warnings: [],
    state: null,
    ...(message
      ? { conflict: { detectedAt: "x", canonicalChanged: true, changedTargets: ["claude"], message } }
      : {}),
  };
}

describe("fleet notices on stderr", () => {
  it("announces a restart with its delay and attempt on one dated line", () => {
    const { lines, notice } = collect();
    notice({
      type: "restarting",
      ...base,
      error: "EMFILE: too many open files, watch '/p/alpha/.claude'",
      attempt: 1,
      delayMs: 10_000,
    });
    expect(lines).toEqual([
      `${STAMP}controller alpha restarting in 10s (attempt 1): ` +
        "EMFILE: too many open files, watch '/p/alpha/.claude'\n",
    ]);
  });

  it("says a parked controller is not retried, how to restart it, and where it failed", () => {
    const { lines, notice } = collect();
    notice({
      type: "parked",
      ...base,
      error: "Cannot read properties of undefined\n  at x",
      since: "2026-09-26T09:59:00.000Z",
      stack: "TypeError: Cannot read properties of undefined\n    at watchPaths (a.js:1:2)\n    at run (b.js:3:4)",
    });
    notice({
      type: "parked",
      ...base,
      error: "Cannot read properties of undefined\n  at x",
      since: "2026-09-26T09:59:00.000Z",
      reminder: true,
    });
    expect(lines).toEqual([
      `${STAMP}controller alpha parked (not retrying): Cannot read properties of undefined at x ` +
        "— fix it, then restart the daemon through its service manager (a plain SIGTERM exits 0, " +
        "which a restart-on-failure service does not relaunch)\n",
      "    at watchPaths (a.js:1:2)\n",
      "    at run (b.js:3:4)\n",
      `${STAMP}controller alpha still parked since 2026-09-26T09:59:00.000Z (not retrying): ` +
        "Cannot read properties of undefined at x\n",
    ]);
  });

  it("prints the first warning per controller and path only", () => {
    const { lines, notice } = collect();
    const warning = (id: string, path: string): FleetWatchEvent => ({
      type: "warning",
      id,
      configPath: `/p/${id}/harness-sync.yaml`,
      path,
      code: "UNKNOWN",
      warning: `UNKNOWN: unknown error, watch '${path}'`,
    });
    notice(warning("alpha", "/p/alpha/SingletonSocket"));
    notice(warning("alpha", "/p/alpha/SingletonSocket"));
    notice(warning("alpha", "/p/alpha/other"));
    notice(warning("user", "/p/alpha/SingletonSocket"));
    expect(lines).toEqual([
      `${STAMP}controller alpha is not watching /p/alpha/SingletonSocket: ` +
        "UNKNOWN: unknown error, watch '/p/alpha/SingletonSocket' " +
        "(the periodic audit still reconciles it)\n",
      `${STAMP}controller alpha is not watching /p/alpha/other: ` +
        "UNKNOWN: unknown error, watch '/p/alpha/other' " +
        "(the periodic audit still reconciles it)\n",
      `${STAMP}controller user is not watching /p/alpha/SingletonSocket: ` +
        "UNKNOWN: unknown error, watch '/p/alpha/SingletonSocket' " +
        "(the periodic audit still reconciles it)\n",
    ]);
  });

  it("stays quiet for routine events and for watch-loop errors, which get their own notice", () => {
    const { lines, notice } = collect();
    notice({ type: "started", ...base });
    notice({ type: "result", ...base, result: result("noop") });
    notice({ type: "result", ...base, result: result("captured-native") });
    notice({ type: "error", ...base, error: "EMFILE: too many open files", during: "watch" });
    notice({ type: "stopped", ...base });
    expect(lines).toEqual([]);
  });

  it("reports a conflict when it starts, hourly while it lasts, and when it clears", () => {
    // The 2026-09-16 outage: the same conflict every 30s for ten days,
    // visible only on stdout.
    const { lines, notice, advance } = collect();
    const conflict = () =>
      notice({ type: "result", ...base, result: result("conflict", "Concurrent canonical/native edits") });
    conflict();
    for (let tick = 0; tick < 119; tick += 1) {
      advance(30_000);
      conflict();
    }
    advance(30_000);
    conflict();
    advance(30_000);
    notice({ type: "result", ...base, result: result("noop") });
    expect(lines).toEqual([
      `${STAMP}controller alpha sync conflict: Concurrent canonical/native edits\n`,
      "2026-09-26T11:00:00.000Z harness-sync: controller alpha still in conflict since " +
        "2026-09-26T10:00:00.000Z: Concurrent canonical/native edits\n",
      "2026-09-26T11:00:30.000Z harness-sync: controller alpha synced again (noop) after a " +
        "conflict since 2026-09-26T10:00:00.000Z\n",
    ]);
  });

  it("reports failing cycles and backups, and a changed message at once", () => {
    const { lines, notice } = collect();
    notice({ type: "error", ...base, error: "state was not advanced", during: "sync" });
    notice({ type: "error", ...base, error: "state was not advanced", during: "sync" });
    notice({ type: "error", ...base, error: "spawn EBADF", during: "backup" });
    notice({ type: "result", ...base, result: result("conflict", "Concurrent edits") });
    expect(lines).toEqual([
      `${STAMP}controller alpha sync failed: state was not advanced\n`,
      `${STAMP}controller alpha backup failed: spawn EBADF\n`,
      `${STAMP}controller alpha sync conflict: Concurrent edits\n`,
    ]);
  });

  it("formats backoff delays for people", () => {
    expect(formatDelay(50)).toBe("50ms");
    expect(formatDelay(1_500)).toBe("1.5s");
    expect(formatDelay(10_000)).toBe("10s");
    expect(formatDelay(80_000)).toBe("1m20s");
    expect(formatDelay(600_000)).toBe("10m");
  });
});

describe("watch --all", () => {
  it("writes a controller restart to stderr and keeps the JSON event on stdout", async () => {
    // A real environmental failure end to end: an entry deeper than PATH_MAX
    // fails the controller's initial scan with ENAMETOOLONG, which the
    // supervisor retries after the default 10s backoff.
    const root = await mkdtemp(join(tmpdir(), "hs-cli-fleet-"));
    roots.push(root);
    const registryPath = join(root, "registry.yaml");
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const project = await initializeProject(projectRoot, { controllerId: "deep" });
    project.config.targets.codex.enabled = false;
    project.config.targets.antigravity.enabled = false;
    await writeProjectConfig(project.configPath, project.config);
    await addController(project.configPath, { registryPath });
    const skill = join(projectRoot, ".claude", "skills", "runtime");
    await mkdir(skill, { recursive: true });
    const segment = "d".repeat(200);
    let depth = 0;
    while (skill.length + depth * (segment.length + 1) < 1_100) depth += 1;
    execFileSync("/bin/sh", [
      "-c",
      'cd "$1" && i=0 && while [ "$i" -lt "$2" ]; do mkdir "$3" && cd "$3" || exit 1; i=$((i+1)); done',
      "sh",
      skill,
      String(depth),
      segment,
    ]);

    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "--json", "--registry", registryPath, "watch", "--all"],
      { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolvePromise) =>
      child.once("exit", (code) => resolvePromise(code)),
    );
    let healthWhileRunning: FleetHealth | undefined;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no restart notice within 15s; stderr: ${stderr}`)),
          15_000,
        );
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          if (/restarting in/u.test(stderr)) {
            clearTimeout(timer);
            resolvePromise();
          }
        });
      });
      healthWhileRunning = await waitForHealth(registryPath, (health) =>
        health.controllers.deep?.state === "restarting");
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited).toBe(0);
    const stamp = "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z";
    expect(stderr).toMatch(new RegExp(
      `^${stamp} harness-sync: controller deep restarting in 10s \\(attempt 1\\): ENAMETOOLONG: `,
      "mu",
    ));
    expect(stderr).toMatch(new RegExp(
      `^${stamp} harness-sync: stopped by SIGTERM; exiting with status 0$`,
      "mu",
    ));
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "restarting",
        controller: "deep",
        attempt: 1,
        delayMs: 10_000,
        at: expect.stringMatching(new RegExp(`^${stamp}$`, "u")),
      }),
    );
    expect(healthWhileRunning).toMatchObject({
      pid: child.pid,
      controllers: { deep: { state: "restarting", attempt: 1, error: expect.stringMatching(/^ENAMETOOLONG/u) } },
    });
    const finalHealth = await readFleetHealth(registryPath);
    expect(finalHealth?.stoppedAt).toEqual(expect.any(String));
  }, 30_000);

  it("writes a persistent conflict to stderr once, and status --all reports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hs-cli-conflict-"));
    roots.push(root);
    const registryPath = join(root, "registry.yaml");
    const projectRoot = join(root, "project");
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await writeFile(join(projectRoot, "CLAUDE.md"), "Instructions\n", "utf8");
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] } }), "utf8");
    const project = await initializeProject(projectRoot, { controllerId: "stuck" });
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    expect((await reconcileOnce(project)).action).toBe("noop");
    project.config.sync.auditIntervalMs = 1_000;
    await writeProjectConfig(project.configPath, project.config);
    await addController(project.configPath, { registryPath });
    // Canonical and native both changed: a conflict on every cycle.
    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Read", "Bash"] } }), "utf8");
    await writeFile(join(project.storeDir, "instructions", "root.md"), "Edited in the store\n", "utf8");

    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "--json", "--registry", registryPath, "watch", "--all"],
      { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolvePromise) =>
      child.once("exit", (code) => resolvePromise(code)),
    );
    let status: FleetStatusResult | undefined;
    try {
      const deadline = Date.now() + 15_000;
      const conflicts = () => stdout.split("\n").filter((line) => line.includes('"action":"conflict"')).length;
      while (conflicts() < 3) {
        if (Date.now() > deadline) throw new Error(`fewer than 3 conflict cycles; stderr: ${stderr}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      status = await statusAllControllers(registryPath);
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited).toBe(0);
    expect(stderr.match(/controller stuck sync conflict: Concurrent canonical\/native/gu)).toHaveLength(1);
    expect(status?.daemon.running).toBe(true);
    expect(status?.summary.degraded).toBe(1);
    expect(status?.controllers[0]).toMatchObject({ id: "stuck", status: "conflict" });
  }, 30_000);
});
