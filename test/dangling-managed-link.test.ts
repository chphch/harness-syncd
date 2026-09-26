import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadHarness, writeHarness, writeProjectConfig } from "../src/core/config.js";
import { pathExists } from "../src/core/fs.js";
import { migrateFrom } from "../src/core/migrate.js";
import { applyHarness, initializeProject, type LoadedProject } from "../src/core/project.js";
import { reconcileOnce } from "../src/core/reconcile.js";

const execFile = promisify(execFileCallback);
const cliPath = resolve("src/cli.ts");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A claude-only project in link mode: the skill `draw-inline` and the rule
 * `style.md` are projected as symlinks into the canonical store, the shape
 * that stranded the user store on 2026-09-26 once canonical removed one.
 */
async function linkedProject(prefix: string): Promise<{ root: string; project: LoadedProject }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const skill = join(root, ".claude", "skills", "draw-inline");
  await mkdir(skill, { recursive: true });
  await mkdir(join(root, ".claude", "rules"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: draw-inline\ndescription: Draw inline\n---\nDraw.\n",
    "utf8",
  );
  await writeFile(join(root, ".claude", "rules", "style.md"), "Keep it short.\n", "utf8");
  await writeFile(join(root, ".claude", "rules", "other.md"), "Other rule.\n", "utf8");
  const project = await initializeProject(root);
  project.config.sync.linkMode = "symlink";
  project.config.targets.codex.enabled = false;
  project.config.targets.antigravity.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  await migrateFrom(project, "claude", {
    apply: true,
    install: true,
    includeLocal: false,
    force: true,
    excludeSkills: [],
  });
  expect((await lstat(join(root, ".claude", "skills", "draw-inline"))).isSymbolicLink())
    .toBe(true);
  expect((await lstat(join(root, ".claude", "rules", "style.md"))).isSymbolicLink())
    .toBe(true);
  expect((await reconcileOnce(project)).action).toBe("noop");
  return { root, project };
}

/** What the session did: delete the canonical directory and its manifest entry. */
async function removeCanonicalSkill(project: LoadedProject, name: string): Promise<void> {
  await rm(join(project.storeDir, "skills", name), { recursive: true, force: true });
  const harness = await loadHarness(project.storeDir);
  harness.skills = harness.skills.filter((skill) => skill.name !== name);
  await writeHarness(project.storeDir, harness);
}

async function removeCanonicalRule(project: LoadedProject, path: string): Promise<void> {
  await rm(join(project.storeDir, path), { force: true });
  const harness = await loadHarness(project.storeDir);
  harness.rules = harness.rules.filter((rule) => rule.path !== path);
  await writeHarness(project.storeDir, harness);
}

/** Every backed-up symlink under `backups/`, as [path, link text]. */
async function backedUpLinks(storeDir: string): Promise<Array<[string, string]>> {
  const found: Array<[string, string]> = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) found.push([path, await readlink(path)]);
      else if (entry.isDirectory()) await visit(path);
    }
  };
  const backups = join(storeDir, "backups");
  if (await pathExists(backups)) await visit(backups);
  return found;
}

describe("canonical removes a link-projected artifact", () => {
  it("projects the removal of a linked skill, and the next cycle is a no-op", async () => {
    const { root, project } = await linkedProject("hs-dangling-skill-");
    const native = join(root, ".claude", "skills", "draw-inline");
    await removeCanonicalSkill(project, "draw-inline");
    // The link now dangles: its target left with the canonical directory.
    expect((await lstat(native)).isSymbolicLink()).toBe(true);

    const result = await reconcileOnce(project);

    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("projected-canonical");
    expect(await pathExists(native)).toBe(false);
    expect(result.applyResults.flatMap((entry) => entry.removed)).toContain(native);
    // Backed up like any other pruned projection, and still recognisably the
    // link it was: relocated so it names the same canonical directory.
    const links = await backedUpLinks(project.storeDir);
    expect(links).toHaveLength(1);
    expect(resolve(dirname(links[0]![0]), links[0]![1]))
      .toBe(join(project.storeDir, "skills", "draw-inline"));
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("projects the removal of a linked file (a rule), and the next cycle is a no-op", async () => {
    const { root, project } = await linkedProject("hs-dangling-rule-");
    const native = join(root, ".claude", "rules", "style.md");
    await removeCanonicalRule(project, "rules/style.md");
    expect((await lstat(native)).isSymbolicLink()).toBe(true);

    const result = await reconcileOnce(project);

    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("projected-canonical");
    expect(await pathExists(native)).toBe(false);
    expect((await lstat(join(root, ".claude", "rules", "other.md"))).isSymbolicLink())
      .toBe(true);
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("lets `apply --force` recover the same situation", async () => {
    // The recovery path the user had: it used to fail with the same ENOENT.
    // Another canonical edit rides along, as it did in the incident, so the
    // apply has other writes to make before it reaches the removed skill.
    const { root, project } = await linkedProject("hs-dangling-force-");
    const native = join(root, ".claude", "skills", "draw-inline");
    await removeCanonicalSkill(project, "draw-inline");
    await writeFile(join(project.storeDir, "rules", "other.md"), "Other rule, edited.\n", "utf8");

    const { stdout } = await execFile(
      process.execPath,
      ["--import", "tsx", cliPath, "--json", "-C", root, "apply", "--force"],
      {
        cwd: resolve("."),
        maxBuffer: 10 * 1024 * 1024,
        // Never the developer's real home, whatever the CLI resolves through it.
        env: { ...process.env, HOME: root },
      },
    );
    const output = JSON.parse(stdout) as {
      results: Array<{ removed: string[]; skipped: string[] }>;
    };

    expect(output.results.flatMap((entry) => entry.skipped)).toEqual([]);
    expect(output.results.flatMap((entry) => entry.removed)).toContain(native);
    expect(await pathExists(native)).toBe(false);
    const result = await reconcileOnce(project);
    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("noop");
  });

  it("re-points a linked skill whose canonical directory moved, without --force", async () => {
    // The skill stays declared under the same name, so the native link is still
    // wanted — but its old target is gone. The ledger proves the link is ours,
    // exactly as it does for a managed copy.
    const { root, project } = await linkedProject("hs-dangling-moved-");
    const native = join(root, ".claude", "skills", "draw-inline");
    const { rename } = await import("node:fs/promises");
    await rename(
      join(project.storeDir, "skills", "draw-inline"),
      join(project.storeDir, "skills", "draw-inline-v2"),
    );
    const harness = await loadHarness(project.storeDir);
    harness.skills = harness.skills.map((skill) =>
      skill.name === "draw-inline" ? { ...skill, path: "skills/draw-inline-v2" } : skill,
    );
    await writeHarness(project.storeDir, harness);

    // A dry run has to predict the same thing the real run does.
    const preview = await applyHarness(project, await loadHarness(project.storeDir), {
      dryRun: true,
      force: false,
    });
    expect(preview.flatMap((entry) => entry.skipped)).toEqual([]);
    const result = await reconcileOnce(project);

    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("projected-canonical");
    expect(resolve(dirname(native), await readlink(native)))
      .toBe(join(project.storeDir, "skills", "draw-inline-v2"));
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("lets a migration run while a removed rule's link still dangles", async () => {
    // The stranded store's conflict message recommends an explicit migration.
    // The native walk used to stat() the dangling link and throw ENOENT.
    const { root, project } = await linkedProject("hs-dangling-migrate-");
    const native = join(root, ".claude", "rules", "style.md");
    await removeCanonicalRule(project, "rules/style.md");

    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    expect(await pathExists(native)).toBe(false);
    expect((await loadHarness(project.storeDir)).rules.map((rule) => rule.path))
      .toEqual(["rules/other.md"]);
    expect((await reconcileOnce(project)).action).toBe("noop");
  });
});
