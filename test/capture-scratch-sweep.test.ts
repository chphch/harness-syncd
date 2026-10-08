import {
  chmod,
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { pathExists } from "../src/core/fs.js";
import { initializeProject } from "../src/core/project.js";
import {
  reconcileOnce,
  STALE_CAPTURE_DIR_NOT_REMOVED,
  STALE_CAPTURE_DIR_REMOVED,
  STALE_CAPTURE_SCRATCH_MS,
  sweepStaleCaptureScratch,
} from "../src/core/reconcile.js";

const roots: string[] = [];
const locked: string[] = [];

afterEach(async () => {
  for (const path of locked.splice(0)) await chmod(path, 0o700);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "capture-sweep-"));
  roots.push(root);
  return root;
}

/** A directory the way an interrupted capture leaves it, last touched `ageMs` ago. */
async function leftover(path: string, ageMs: number): Promise<void> {
  await mkdir(join(path, "skills", "demo"), { recursive: true });
  await writeFile(join(path, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
  await writeFile(join(path, "harness.yaml"), "schemaVersion: 1\n");
  await age(path, ageMs);
}

async function age(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

const STALE = STALE_CAPTURE_SCRATCH_MS + 60_000;

describe("sweepStaleCaptureScratch", () => {
  it("removes stale capture stages and round-trip containers beside the store, and nothing else", async () => {
    const root = await scratchRoot();
    const parent = join(root, "project");
    const storeDir = join(parent, ".harness-sync");
    await mkdir(storeDir, { recursive: true });
    await leftover(join(parent, ".harness-sync-capture-PUBOTs"), STALE);
    await leftover(join(parent, ".harness-sync-roundtrip-fgHRFS"), STALE);
    // In flight: a capture of another process sharing this directory.
    await leftover(join(parent, ".harness-sync-capture-m8mxPn"), 60_000);
    // Not ours: another name, a plain file, and a symlink whose target is stale.
    await leftover(join(parent, ".harness-sync-other"), STALE);
    await writeFile(join(parent, ".harness-sync-capture-notdir"), "x");
    await age(join(parent, ".harness-sync-capture-notdir"), STALE);
    const target = join(root, "elsewhere");
    await leftover(target, STALE);
    await symlink(target, join(parent, ".harness-sync-capture-linked"));
    const old = new Date(Date.now() - STALE);
    await lutimes(join(parent, ".harness-sync-capture-linked"), old, old);
    await age(storeDir, STALE);

    const warnings = await sweepStaleCaptureScratch(storeDir);

    expect(warnings).toEqual([
      {
        code: STALE_CAPTURE_DIR_REMOVED,
        path: join(parent, ".harness-sync-capture-PUBOTs"),
        message: expect.stringMatching(
          /^removed .*\.harness-sync-capture-PUBOTs, left by an interrupted capture \(last modified \d{4}-\d\d-\d\dT/u,
        ),
      },
      {
        code: STALE_CAPTURE_DIR_REMOVED,
        path: join(parent, ".harness-sync-roundtrip-fgHRFS"),
        message: expect.stringContaining("left by an interrupted capture"),
      },
    ]);
    expect((await readdir(parent)).sort()).toEqual([
      ".harness-sync",
      ".harness-sync-capture-linked",
      ".harness-sync-capture-m8mxPn",
      ".harness-sync-capture-notdir",
      ".harness-sync-other",
    ]);
    expect(await pathExists(join(target, "skills", "demo", "SKILL.md"))).toBe(true);
    expect(await sweepStaleCaptureScratch(storeDir)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a stale directory it cannot remove instead of failing",
    async () => {
      const root = await scratchRoot();
      const storeDir = join(root, ".harness-sync");
      await mkdir(storeDir);
      const stage = join(root, ".harness-sync-capture-6KOJZB");
      await leftover(stage, 0);
      // Unlinking the file needs write permission on its directory.
      await chmod(join(stage, "skills", "demo"), 0o500);
      locked.push(join(stage, "skills", "demo"));
      await age(stage, STALE);

      const warnings = await sweepStaleCaptureScratch(storeDir);

      expect(warnings).toEqual([
        {
          code: STALE_CAPTURE_DIR_NOT_REMOVED,
          path: stage,
          message: expect.stringMatching(/^could not remove .*6KOJZB, left by an interrupted capture: EACCES/u),
        },
      ]);
      expect(await pathExists(stage)).toBe(true);
    },
  );
});

describe("a reconciliation cycle", () => {
  it("removes an interrupted capture's leftovers and reports them, keeping one still in flight", async () => {
    const root = await scratchRoot();
    const project = await initializeProject(root, { controllerId: "sweep" });
    for (const target of Object.values(project.config.targets)) target.enabled = false;
    await writeProjectConfig(project.configPath, project.config);
    expect((await reconcileOnce(project)).action).toBe("baseline");
    // The project root, as the store sees it (tmpdir may be behind a symlink).
    const parent = dirname(project.storeDir);
    const stale = join(parent, ".harness-sync-capture-hSmeV4");
    const roundTrip = join(parent, ".harness-sync-roundtrip-9rIbfK");
    const fresh = join(parent, ".harness-sync-capture-cAy1yQ");
    await leftover(stale, STALE);
    await leftover(roundTrip, STALE);
    await leftover(fresh, 1_000);

    const result = await reconcileOnce(project);

    expect(result.action).toBe("noop");
    expect(result.warnings.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: STALE_CAPTURE_DIR_REMOVED, path: stale },
      { code: STALE_CAPTURE_DIR_REMOVED, path: roundTrip },
    ]);
    expect(await pathExists(stale)).toBe(false);
    expect(await pathExists(roundTrip)).toBe(false);
    expect(await pathExists(fresh)).toBe(true);
    expect((await reconcileOnce(project)).warnings).toEqual([]);
  });
});
