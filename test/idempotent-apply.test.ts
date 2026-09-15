import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadHarness } from "../src/core/config.js";
import { pathExists } from "../src/core/fs.js";
import { migrateFrom } from "../src/core/migrate.js";
import { applyHarness, initializeProject } from "../src/core/project.js";
import { pruneBackups } from "../src/core/writer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const migrateOptions = {
  apply: true,
  install: true,
  includeLocal: false,
  force: true,
  excludeSkills: [],
};

async function countBackups(storeDir: string): Promise<number> {
  const dir = join(storeDir, "backups");
  if (!(await pathExists(dir))) return 0;
  return (await readdir(dir)).length;
}

/** Only the per-write backups the cap governs; migration leaves a capture-*
 * directory behind that `pruneBackups` deliberately never counts. */
async function countStampedBackups(storeDir: string): Promise<number> {
  const dir = join(storeDir, "backups");
  if (!(await pathExists(dir))) return 0;
  return (await readdir(dir)).filter((name) => /^\d{4}-/.test(name)).length;
}

describe("repeated apply", () => {
  // The daemon re-applies on every watched change, and a replacement both moves
  // the live path into backups/ and stages its successor inside the watched
  // directory — so an apply that rewrote unchanged paths scheduled the next one
  // and never stopped.
  it.each(["copy", "symlink"] as const)(
    "leaves managed paths alone when nothing changed (%s mode)",
    async (linkMode) => {
      const root = await mkdtemp(join(tmpdir(), `idempotent-apply-${linkMode}-`));
      roots.push(root);
      await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
      const project = await initializeProject(root);
      project.config.sync.linkMode = linkMode;
      await migrateFrom(project, "claude", migrateOptions);
      const harness = await loadHarness(project.storeDir);

      await applyHarness(project, harness, { dryRun: false, force: false });
      const settled = await countBackups(project.storeDir);
      await applyHarness(project, harness, { dryRun: false, force: false });
      await applyHarness(project, harness, { dryRun: false, force: false });

      expect(await countBackups(project.storeDir)).toBe(settled);
    },
  );
});

describe("backup grouping", () => {
  // The directory name used to be built inside backup(), once per replaced
  // path, so one apply looked like as many backups as it touched files and no
  // retention count could mean "the last N applies".
  it("puts every target's replaced paths under one directory per apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "backup-grouping-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    project.config.sync.backupRetention = 50;
    await migrateFrom(project, "claude", migrateOptions);
    const harness = await loadHarness(project.storeDir);
    await applyHarness(project, harness, { dryRun: false, force: false });

    const dir = join(project.storeDir, "backups");
    const stamped = async () =>
      (await readdir(dir)).filter((name) => /^\d{4}-/.test(name));
    const before = await stamped();

    // Hand-edit the native side of two different targets, which is what
    // backups exist for and what a per-call stamp used to split apart.
    const edited = ["CLAUDE.md", "AGENTS.md"];
    for (const rel of edited) {
      expect(await pathExists(join(root, rel))).toBe(true);
      await writeFile(join(root, rel), "# Edited by hand\n", "utf8");
    }
    await applyHarness(project, harness, { dryRun: false, force: true });

    const fresh = (await stamped()).filter((name) => !before.includes(name));
    expect(fresh).toHaveLength(1);
    // Two writers, one directory: the assertion that fails on a per-call stamp.
    const targets = await readdir(join(dir, fresh[0]!));
    expect(targets.length).toBeGreaterThanOrEqual(2);
  });
});

describe("backup retention", () => {
  it("keeps the newest N stamped directories and never prunes a capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "backup-retention-"));
    roots.push(root);
    const backups = join(root, "backups");
    const stamps = Array.from(
      { length: 6 },
      (_, index) => `2026-09-15T04-33-3${index}.000Z`,
    );
    for (const name of [...stamps, "capture-2026-09-10T06-25-02.850Z-abc", "notes.txt"]) {
      await mkdir(join(backups, name), { recursive: true });
    }

    const removed = await pruneBackups(root, 2);

    expect(removed).toHaveLength(4);
    expect((await readdir(backups)).sort()).toEqual([
      "2026-09-15T04-33-34.000Z",
      "2026-09-15T04-33-35.000Z",
      "capture-2026-09-10T06-25-02.850Z-abc",
      "notes.txt",
    ]);
  });

  it("applies the cap through applyHarness, not just when called directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "backup-retention-apply-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.backupRetention = 3;
    await migrateFrom(project, "claude", migrateOptions);
    const harness = await loadHarness(project.storeDir);

    // Stand in for a backlog an earlier runaway left behind: one apply has to
    // bring it down to the cap, so a prune that is never reached fails here.
    for (let index = 0; index < 9; index += 1) {
      await mkdir(join(project.storeDir, "backups", `2026-09-15T04-33-3${index}.000Z`), {
        recursive: true,
      });
    }
    expect(await countStampedBackups(project.storeDir)).toBeGreaterThan(3);

    await applyHarness(project, harness, { dryRun: false, force: false });

    expect(await countStampedBackups(project.storeDir)).toBe(3);
  });

  it("leaves the backlog alone on a dry run", async () => {
    const root = await mkdtemp(join(tmpdir(), "backup-retention-dry-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.backupRetention = 1;
    await migrateFrom(project, "claude", migrateOptions);
    const harness = await loadHarness(project.storeDir);
    for (let index = 0; index < 4; index += 1) {
      await mkdir(join(project.storeDir, "backups", `2026-09-15T04-33-3${index}.000Z`), {
        recursive: true,
      });
    }

    const before = await countStampedBackups(project.storeDir);
    await applyHarness(project, harness, { dryRun: true, force: false });

    expect(await countStampedBackups(project.storeDir)).toBe(before);
    expect(before).toBeGreaterThan(1);
  });

  it("rejects a retention that cannot bound anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "backup-retention-invalid-"));
    roots.push(root);
    await initializeProject(root);
    await writeFile(
      join(root, "harness-sync.yaml"),
      "schemaVersion: 1\nsync:\n  backupRetention: 0\n",
      "utf8",
    );
    await expect(initializeProject(root)).rejects.toThrow(/backupRetention/);
  });
});
