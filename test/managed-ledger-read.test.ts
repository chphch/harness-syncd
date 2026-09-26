import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateFrom } from "../src/core/migrate.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import { readConflictRecord, reconcileOnce } from "../src/core/reconcile.js";
import { hashPaths } from "../src/core/fs.js";
import { fingerprintManagedTarget, ManagedWriter } from "../src/core/writer.js";

/**
 * Reading the ownership ledger (.managed.json) can fail for reasons that say
 * nothing about its content — descriptors exhausted, a permission change. A
 * read that swallowed those reported "no managed paths": every target then
 * looked changed (a spurious conflict), and a writer that loaded nothing would
 * save a ledger without the paths it could not read.
 */
const failing = vi.hoisted(() => ({ code: null as null | string }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFileHooked = (async (...args: Parameters<typeof actual.readFile>) => {
    const [path] = args;
    if (failing.code && typeof path === "string" && path.endsWith(".managed.json")) {
      throw Object.assign(new Error(`${failing.code}: too many open files, open '${path}'`), {
        code: failing.code,
        syscall: "open",
        path,
      });
    }
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile: readFileHooked }, readFile: readFileHooked };
});

const roots: string[] = [];

afterEach(async () => {
  failing.code = null;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<LoadedProject> {
  const root = await mkdtemp(join(tmpdir(), "hs-ledger-read-"));
  roots.push(root);
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
  await writeFile(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Read"] } }),
    "utf8",
  );
  const project = await initializeProject(root);
  project.config.sync.linkMode = "copy";
  await migrateFrom(project, "claude", {
    apply: true,
    install: true,
    includeLocal: false,
    force: true,
    excludeSkills: [],
  });
  expect((await reconcileOnce(project)).action).toBe("noop");
  return project;
}

describe("reading the ownership ledger", () => {
  it("fails a cycle on EMFILE instead of reporting every target as changed", async () => {
    const project = await fixture();
    const before = await fingerprintManagedTarget(project.storeDir, "claude");
    expect(before).not.toBe(await hashPaths([]));

    failing.code = "EMFILE";
    await expect(fingerprintManagedTarget(project.storeDir, "claude")).rejects.toThrow(/EMFILE/u);
    await expect(reconcileOnce(project)).rejects.toThrow(/EMFILE/u);
    expect(await readConflictRecord(project.storeDir)).toBeNull();

    failing.code = null;
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("does not let a writer that could not read the ledger save over it", async () => {
    const project = await fixture();
    const ledgerPath = join(project.storeDir, ".managed.json");
    const ledger = await readFile(ledgerPath, "utf8");

    failing.code = "EMFILE";
    const writer = new ManagedWriter({
      storeDir: project.storeDir,
      target: "claude",
      linkMode: "copy",
      dryRun: false,
      force: false,
    });
    await expect(writer.load()).rejects.toThrow(/EMFILE/u);
    failing.code = null;
    expect(await readFile(ledgerPath, "utf8")).toBe(ledger);
  });

  it("still reads a missing ledger as owning nothing", async () => {
    const project = await fixture();
    await rm(join(project.storeDir, ".managed.json"));
    expect(await fingerprintManagedTarget(project.storeDir, "claude")).toBe(await hashPaths([]));
  });
});
