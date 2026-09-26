import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFleetNoticeWriter,
  createWarningNoticeWriter,
  formatDelay,
} from "../src/cli-fleet.js";
import { writeProjectConfig } from "../src/core/config.js";
import { initializeProject } from "../src/core/project.js";
import { addController } from "../src/core/registry.js";
import type { FleetWatchEvent } from "../src/core/supervisor.js";

const roots: string[] = [];

afterEach(() => {
  // rm -rf: the end-to-end fixture is deeper than PATH_MAX.
  for (const root of roots.splice(0)) execFileSync("rm", ["-rf", root]);
});

function collect() {
  const lines: string[] = [];
  const notice = createFleetNoticeWriter((text) => lines.push(text));
  return { lines, notice };
}

const base = { id: "alpha", configPath: "/p/alpha/harness-sync.yaml" };

describe("fleet notices on stderr", () => {
  it("announces a restart with its delay and attempt on one line", () => {
    const { lines, notice } = collect();
    notice({
      type: "restarting",
      ...base,
      error: "EMFILE: too many open files, watch '/p/alpha/.claude'",
      attempt: 1,
      delayMs: 10_000,
    });
    expect(lines).toEqual([
      "harness-sync: controller alpha restarting in 10s (attempt 1): " +
        "EMFILE: too many open files, watch '/p/alpha/.claude'\n",
    ]);
  });

  it("says a parked controller is not retried and what to do about it", () => {
    const { lines, notice } = collect();
    notice({ type: "parked", ...base, error: "Cannot read properties of undefined\n  at x" });
    expect(lines).toEqual([
      "harness-sync: controller alpha parked (not retrying): " +
        "Cannot read properties of undefined at x — restart the daemon after fixing\n",
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
      "harness-sync: controller alpha is not watching /p/alpha/SingletonSocket: " +
        "UNKNOWN: unknown error, watch '/p/alpha/SingletonSocket' " +
        "(the periodic audit still reconciles it)\n",
      "harness-sync: controller alpha is not watching /p/alpha/other: " +
        "UNKNOWN: unknown error, watch '/p/alpha/other' " +
        "(the periodic audit still reconciles it)\n",
      "harness-sync: controller user is not watching /p/alpha/SingletonSocket: " +
        "UNKNOWN: unknown error, watch '/p/alpha/SingletonSocket' " +
        "(the periodic audit still reconciles it)\n",
    ]);
  });

  it("stays quiet for routine events, which stdout already carries", () => {
    const { lines, notice } = collect();
    notice({ type: "started", ...base });
    notice({ type: "stopped", ...base });
    notice({ type: "error", ...base, error: "conflict" });
    expect(lines).toEqual([]);
  });

  it("dedupes single-controller warnings per path", () => {
    const lines: string[] = [];
    const notice = createWarningNoticeWriter((text) => lines.push(text));
    notice({ path: "/p/sock", code: "UNKNOWN", message: "UNKNOWN: unknown error, watch" });
    notice({ path: "/p/sock", code: "UNKNOWN", message: "UNKNOWN: unknown error, watch" });
    expect(lines).toEqual([
      "harness-sync: not watching /p/sock: UNKNOWN: unknown error, watch " +
        "(the periodic audit still reconciles it)\n",
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
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited).toBe(0);
    expect(stderr).toMatch(
      /^harness-sync: controller deep restarting in 10s \(attempt 1\): ENAMETOOLONG: /mu,
    );
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "restarting", controller: "deep", attempt: 1, delayMs: 10_000 }),
    );
  }, 30_000);
});
