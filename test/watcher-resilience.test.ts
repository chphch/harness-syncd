import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { isUnwatchableEntry, watchProject } from "../src/core/daemon.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  // `rm -rf`, not fs.rm: one fixture below builds a tree deeper than PATH_MAX,
  // which node's recursive rm cannot delete and BSD rm (fts) can.
  for (const root of roots.splice(0)) execFileSync("rm", ["-rf", root]);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hs-w-"));
  roots.push(root);
  return root;
}

/**
 * Bind a Unix socket at `dir/name` from a child process whose cwd is `dir`.
 * sun_path holds 104 bytes on macOS, and a relative bind sidesteps that limit
 * wherever the test's TMPDIR happens to live.
 */
async function bindSocket(dir: string, name: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(name)}, () => process.stdout.write("ready\\n"));`,
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  await new Promise<void>((resolvePromise, reject) => {
    child.stdout!.once("data", () => resolvePromise());
    child.once("exit", (code) => reject(new Error(`socket helper exited with ${code}`)));
  });
  return join(dir, name);
}

async function claudeOnlyController(root: string): Promise<LoadedProject> {
  const project = await initializeProject(root, { controllerId: "watched" });
  project.config.targets.codex.enabled = false;
  project.config.targets.antigravity.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  // A skill directory without SKILL.md: watched (it is under .claude/skills)
  // but never imported, so only the watcher ever looks at what lands here —
  // the same place a Chrome profile inside a skill's scripts/ directory sits.
  await mkdir(runtimeDir(root), { recursive: true });
  return project;
}

function runtimeDir(root: string): string {
  return join(root, ".claude", "skills", "runtime");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function runController(project: LoadedProject) {
  const abort = new AbortController();
  const errors: string[] = [];
  let results = 0;
  const outcome = watchProject(project, {
    signal: abort.signal,
    onResult: () => {
      results += 1;
    },
    onError: (error) => errors.push(error.message),
  }).then(
    () => "resolved" as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  return { abort, errors, outcome, results: () => results };
}

describe("isUnwatchableEntry", () => {
  it("keeps files, directories, symlinks, and entries without stats", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "file"), "x");
    await symlink("missing-target", join(root, "dangling"));
    // chokidar asks first without stats; "undecided" must never mean "skip".
    expect(isUnwatchableEntry(join(root, "x"), undefined)).toBe(false);
    expect(isUnwatchableEntry(root, await stat(root))).toBe(false);
    expect(isUnwatchableEntry(join(root, "file"), await stat(join(root, "file")))).toBe(false);
    // lstat stats of a symlink: the followed stats decide later, and the
    // daemon's own managed projections are symlinks.
    expect(isUnwatchableEntry(join(root, "dangling"), await lstat(join(root, "dangling"))))
      .toBe(false);
  });

  it.skipIf(process.platform === "win32")("skips sockets, FIFOs, and devices", async () => {
    const root = await tempRoot();
    const socket = await bindSocket(root, "sock");
    execFileSync("mkfifo", [join(root, "fifo")]);
    expect(isUnwatchableEntry(socket, await lstat(socket))).toBe(true);
    expect(isUnwatchableEntry(join(root, "fifo"), await lstat(join(root, "fifo")))).toBe(true);
    expect(isUnwatchableEntry("/dev/null", await stat("/dev/null"))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "watcher survives non-regular entries in a watched tree",
  () => {
    it("keeps reconciling after a Unix socket appears (Chrome SingletonSocket)", async () => {
      const root = await tempRoot();
      const project = await claudeOnlyController(root);
      const run = runController(project);
      await waitFor(() => run.results() >= 1);

      await bindSocket(runtimeDir(root), "SingletonSocket");
      // Long enough for the directory watcher to re-read and reach the socket.
      await sleep(600);
      expect(run.errors).toEqual([]);

      await writeFile(join(root, "CLAUDE.md"), "edited after the socket appeared\n");
      await waitFor(() => run.results() >= 2);
      run.abort.abort();
      expect(await run.outcome).toBe("resolved");
      expect(run.errors).toEqual([]);
    });

    it("starts while a socket already exists (restart while Chrome runs)", async () => {
      const root = await tempRoot();
      const project = await claudeOnlyController(root);
      await bindSocket(runtimeDir(root), "SingletonSocket");
      const run = runController(project);
      await waitFor(() => run.results() >= 1 || run.errors.length > 0);
      run.abort.abort();
      expect(await run.outcome).toBe("resolved");
      expect(run.errors).toEqual([]);
    });

    it("skips a symlink to a socket outside the tree, beside dangling links", async () => {
      // Chrome's real profile shape: SingletonSocket links to a socket under
      // /tmp, SingletonLock and SingletonCookie link to names that do not exist.
      const root = await tempRoot();
      const project = await claudeOnlyController(root);
      await mkdir(join(root, "outside"));
      const socket = await bindSocket(join(root, "outside"), "S");
      await symlink(socket, join(runtimeDir(root), "SingletonSocket"));
      await symlink("host-12345", join(runtimeDir(root), "SingletonLock"));
      await symlink("987654321", join(runtimeDir(root), "SingletonCookie"));
      const run = runController(project);
      await waitFor(() => run.results() >= 1 || run.errors.length > 0);
      run.abort.abort();
      expect(await run.outcome).toBe("resolved");
      expect(run.errors).toEqual([]);
    });

    it("does not block the event loop on a FIFO", async () => {
      const root = await tempRoot();
      const project = await claudeOnlyController(root);
      const fifo = join(runtimeDir(root), "pipe");
      execFileSync("mkfifo", [fifo]);
      // Safety valve: fs.watch opens a FIFO synchronously and blocks the whole
      // event loop until a writer appears. A child opens one after 3s, so a
      // regression FAILS on the elapsed-time assertion instead of hanging the
      // vitest worker forever.
      children.push(
        spawn(
          process.execPath,
          [
            "-e",
            `setTimeout(() => require("node:fs").open(${JSON.stringify(fifo)}, "w", () => {}), 3000);` +
              "setTimeout(() => process.exit(0), 6000);",
          ],
          { stdio: "ignore" },
        ),
      );
      const started = Date.now();
      const run = runController(project);
      await waitFor(() => run.results() >= 1, 8_000);
      const elapsed = Date.now() - started;
      run.abort.abort();
      expect(await run.outcome).toBe("resolved");
      expect(elapsed).toBeLessThan(2_000);
    }, 15_000);
  },
);
