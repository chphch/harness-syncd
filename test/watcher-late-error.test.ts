import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A watcher error that arrives after close() must not end the process. The
 * scenario runs in a child process (see test/fixtures/late-watch-error.ts for
 * why it cannot run in this one); an unhandled late error shows up here as a
 * nonzero exit with chokidar's "Emitted 'error' event on FSWatcher" trace.
 */
async function runFixture(mode: "fatal" | "abort") {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("test/fixtures/late-watch-error.ts"), mode],
    { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolvePromise) =>
    child.once("exit", (exitCode) => resolvePromise(exitCode)),
  );
  return { code, stdout, stderr };
}

describe("a watcher error after close()", () => {
  it("does not take down the other controllers when one controller's watcher fails", async () => {
    const run = await runFixture("fatal");
    expect(run.stderr).not.toMatch(/Emitted 'error' event/u);
    expect(run.code).toBe(0);
    const summary = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(summary).toMatchObject({ heldStat: true, fleet: "resolved", restartingB: 0, stoppedB: 1 });
    expect(summary.fatalWatches).toBeGreaterThan(0);
    expect(summary.restartingA).toBeGreaterThan(0);
    expect(summary.resultsB).toBeGreaterThan(0);
  }, 30_000);

  it("does not crash when the controller is stopped during its initial scan", async () => {
    const run = await runFixture("abort");
    expect(run.stderr).not.toMatch(/Emitted 'error' event/u);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({ mode: "abort", heldStat: true, result: "resolved" });
  }, 30_000);
});
