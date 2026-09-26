/**
 * Child-process fixture for test/watcher-late-error.test.ts.
 *
 * chokidar keeps its own stat()/realpath() calls in flight after close(), and
 * close() strips every listener first. When one of those calls then fails with
 * anything but ENOENT/ENOTDIR, chokidar emits "error" on a watcher nobody
 * listens to any more, and Node ends the whole process with that unhandled
 * error. This fixture holds `stat(runtime/loop)` (a symlink loop, so it fails
 * with ELOOP) until just after the watcher was closed, which makes that window
 * deterministic.
 *
 * It must run in its own process: chokidar copies `stat` out of
 * node:fs/promises when it is first loaded, so the gate below has to be in
 * place before anything imports chokidar.
 *
 * Modes:
 *   fatal — two fleet controllers; a's watcher fails fatally (EMFILE from
 *           fs.watch) while its stat is held, so a is restarted; b must keep
 *           running.
 *   abort — one controller aborted (SIGTERM-like) during its initial scan
 *           while its stat is held.
 *
 * Prints one JSON line and exits 0 when the process survived.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

type StatFn = (path: fs.PathLike, ...rest: unknown[]) => Promise<fs.Stats>;
type WatchFn = (path: fs.PathLike, ...rest: unknown[]) => fs.FSWatcher;

const mode = process.argv[2] === "abort" ? "abort" : "fatal";
const require = createRequire(import.meta.url);
const fsp = require("node:fs/promises") as { stat: StatFn };
const originalStat = fsp.stat;
const originalWatch = fs.watch as unknown as WatchFn;

let releaseGate!: () => void;
const gate = new Promise<void>((resolvePromise) => {
  releaseGate = resolvePromise;
});
let heldStat = false;
let onStatHeld: (() => void) | undefined;
fsp.stat = async (path, ...rest) => {
  if (String(path).endsWith(`${"/"}runtime${"/"}loop`) && !heldStat) {
    heldStat = true;
    onStatHeld?.();
    await gate;
  }
  return originalStat(path, ...rest);
};
let fatalWatches = 0;
(fs as unknown as { watch: WatchFn }).watch = (path, ...rest) => {
  if (mode === "fatal" && String(path).endsWith(`${"/"}runtime${"/"}fatal`)) {
    fatalWatches += 1;
    // Let the held stat fail only once the watcher is being closed.
    setTimeout(() => releaseGate(), 30);
    throw Object.assign(new Error(`EMFILE: too many open files, watch '${String(path)}'`), {
      code: "EMFILE",
      errno: -24,
      syscall: "watch",
      path: String(path),
    });
  }
  return originalWatch(path, ...rest);
};
syncBuiltinESMExports();

const { writeProjectConfig } = await import("../../src/core/config.js");
const { initializeProject } = await import("../../src/core/project.js");
const { addController } = await import("../../src/core/registry.js");
const { watchProject } = await import("../../src/core/daemon.js");
const { watchAllControllers } = await import("../../src/core/supervisor.js");

const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
const roots: string[] = [];

async function claudeOnly(id: string) {
  const root = await mkdtemp(join(tmpdir(), `hs-late-${id}-`));
  roots.push(root);
  const project = await initializeProject(root, { controllerId: id });
  project.config.targets.codex.enabled = false;
  project.config.targets.antigravity.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  const runtime = join(root, ".claude", "skills", "runtime");
  await mkdir(runtime, { recursive: true });
  return { root, project, runtime };
}

try {
  if (mode === "fatal") {
    const a = await claudeOnly("a");
    const b = await claudeOnly("b");
    await writeFile(join(a.runtime, "fatal"), "x");
    await symlink("loop", join(a.runtime, "loop"));
    const registryPath = join(a.root, "registry.yaml");
    await addController(a.project.configPath, { registryPath });
    await addController(b.project.configPath, { registryPath });
    const events: Array<{ type: string; id: string }> = [];
    const abort = new AbortController();
    const outcome = watchAllControllers({
      registryPath,
      signal: abort.signal,
      restartPolicy: { baseMs: 100, maxMs: 100, healthyAfterMs: 60_000 },
      onEvent: (event) => events.push({ type: event.type, id: event.id }),
    }).then(
      () => "resolved",
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    await sleep(1_500);
    abort.abort();
    const fleet = await outcome;
    const count = (type: string, id: string) =>
      events.filter((event) => event.type === type && event.id === id).length;
    process.stdout.write(
      `${JSON.stringify({
        mode,
        heldStat,
        fatalWatches,
        fleet,
        restartingA: count("restarting", "a"),
        resultsB: count("result", "b"),
        restartingB: count("restarting", "b"),
        stoppedB: count("stopped", "b"),
      })}\n`,
    );
  } else {
    const a = await claudeOnly("a");
    await symlink("loop", join(a.runtime, "loop"));
    const held = new Promise<void>((resolvePromise) => {
      onStatHeld = resolvePromise;
    });
    const abort = new AbortController();
    const outcome = watchProject(a.project, { signal: abort.signal }).then(
      () => "resolved",
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    await held;
    abort.abort();
    const result = await outcome;
    // The watcher is closed by now; only then does the held stat fail.
    releaseGate();
    await sleep(300);
    process.stdout.write(`${JSON.stringify({ mode, heldStat, result })}\n`);
  }
} finally {
  releaseGate();
  for (const root of roots) execFileSync("rm", ["-rf", root]);
}
