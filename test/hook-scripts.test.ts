import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadHarness, writeHarness } from "../src/core/config.js";
import { pathExists } from "../src/core/fs.js";
import { migrateFrom } from "../src/core/migrate.js";
import { adapterContext, applyHarness, initializeProject } from "../src/core/project.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { reconcileOnce } from "../src/core/reconcile.js";
import { assertHookScriptName, normalizeHookScripts } from "../src/core/hook-scripts.js";
import { allAdapters } from "../src/adapters/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A project whose .claude/hooks holds one wired script plus a helper that no
 * command names — the shape that breaks a reference-driven importer. */
async function seedNativeProject(prefix: string): Promise<string> {
  const root = await tempRoot(prefix);
  await mkdir(join(root, ".claude", "hooks", "usage-gate"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
  await writeFile(
    join(root, ".claude", "hooks", "guard.sh"),
    "#!/bin/bash\nsource \"$(dirname \"$0\")/hook-common.sh\"\n",
    "utf8",
  );
  await chmod(join(root, ".claude", "hooks", "guard.sh"), 0o755);
  await writeFile(join(root, ".claude", "hooks", "hook-common.sh"), "shared() { :; }\n", "utf8");
  await writeFile(
    join(root, ".claude", "hooks", "usage-gate", "model-gate.js"),
    "module.exports = {};\n",
    "utf8",
  );
  await writeFile(
    join(root, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "bash $CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

const migrateOptions = {
  apply: true,
  install: true,
  includeLocal: false,
  force: true,
  excludeSkills: [],
};

describe("hook script sync", () => {
  it("carries a hook script to a second machine with its executable bit", async () => {
    const source = await seedNativeProject("hook-scripts-source-");
    const sourceProject = await initializeProject(source);
    await migrateFrom(sourceProject, "claude", migrateOptions);

    const harness = await loadHarness(sourceProject.storeDir);
    expect(harness.hookScripts?.map((entry) => entry.name).sort()).toEqual([
      "guard.sh",
      "hook-common.sh",
      "usage-gate/model-gate.js",
    ]);

    // Simulate the second machine the way Git actually delivers the store: copy
    // the committed content and drop the runtime files .gitignore excludes, so
    // the fresh checkout owns nothing yet.
    const second = await tempRoot("hook-scripts-target-");
    const secondStore = join(second, ".harness-sync");
    await cp(sourceProject.storeDir, secondStore, { recursive: true });
    for (const runtime of [".state.json", ".managed.json", ".lock", "backups", "conflicts"]) {
      await rm(join(secondStore, runtime), { recursive: true, force: true });
    }
    const secondProject = await initializeProject(second, { store: secondStore });
    await applyHarness(secondProject, await loadHarness(secondStore), {
      dryRun: false,
      force: true,
    });

    const projected = join(second, ".claude", "hooks", "guard.sh");
    expect(await pathExists(projected)).toBe(true);
    expect((await stat(projected)).mode & 0o111).not.toBe(0);
    expect(await readFile(projected, "utf8")).toContain("hook-common.sh");
    // The helper no command names must travel too, or the wired hook dies here.
    expect(await pathExists(join(second, ".claude", "hooks", "hook-common.sh"))).toBe(true);
    expect(
      await pathExists(join(second, ".claude", "hooks", "usage-gate", "model-gate.js")),
    ).toBe(true);
  });

  it("leaves the scripts in the store after the capture stage is removed", async () => {
    const root = await seedNativeProject("hook-scripts-stage-");
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", migrateOptions);

    // Asserted AFTER migrate deletes its stage. hashCanonicalContent hashes the
    // same list that decides what commitCaptureStage moves out, so a missing
    // entry there reports SUCCESS and leaves a store declaring files it lacks.
    const harness = await loadHarness(project.storeDir);
    for (const entry of harness.hookScripts ?? []) {
      expect(await pathExists(join(project.storeDir, entry.path))).toBe(true);
    }
    expect(harness.hookScripts?.length).toBe(3);
  });

  it("does not empty the declared list when the native directory is absent", async () => {
    const source = await seedNativeProject("hook-scripts-guard-source-");
    const sourceProject = await initializeProject(source);
    await migrateFrom(sourceProject, "claude", migrateOptions);
    const harness = await loadHarness(sourceProject.storeDir);
    expect(harness.hookScripts?.length).toBe(3);

    // A freshly cloned machine that has not applied yet has no native hooks
    // directory. If capture overwrote the list with [], the next apply would
    // prune every script the clone was supposed to install.
    const second = await tempRoot("hook-scripts-guard-target-");
    const secondStore = join(second, ".harness-sync");
    await cp(sourceProject.storeDir, secondStore, { recursive: true });
    for (const runtime of [".state.json", ".managed.json", ".lock", "backups", "conflicts"]) {
      await rm(join(secondStore, runtime), { recursive: true, force: true });
    }
    await writeFile(join(second, "CLAUDE.md"), "# Instructions\n", "utf8");
    const secondProject = await initializeProject(second, { store: secondStore });
    expect(await pathExists(join(second, ".claude", "hooks"))).toBe(false);

    const captured = await new ClaudeAdapter().capture(
      harness,
      adapterContext(secondProject, "claude"),
      { includeLocal: false, includeAssets: true, write: false },
    );
    expect(captured.harness.hookScripts?.length).toBe(3);

    // And a harness that never declared any must not GAIN an empty list, which
    // writeHarness would persist and the next apply would read as "own nothing".
    const pristine = await loadHarness(secondStore);
    delete pristine.hookScripts;
    const fromPristine = await new ClaudeAdapter().capture(
      pristine,
      adapterContext(secondProject, "claude"),
      { includeLocal: false, includeAssets: true, write: false },
    );
    expect(fromPristine.harness.hookScripts).toBeUndefined();
  });

  it("never imports generated, hidden, or non-regular entries", async () => {
    const root = await seedNativeProject("hook-scripts-filter-");
    const hooks = join(root, ".claude", "hooks");
    await mkdir(join(hooks, "__pycache__"), { recursive: true });
    await writeFile(join(hooks, "__pycache__", "x.pyc"), "cache\n", "utf8");
    await mkdir(join(hooks, ".claude", "logs"), { recursive: true });
    await writeFile(join(hooks, ".claude", "logs", "run.log"), "log\n", "utf8");
    const outside = join(root, "outside-secret");
    await writeFile(outside, "private\n", "utf8");
    await symlink(outside, join(hooks, "leak.sh"));

    const project = await initializeProject(root);
    const migrated = await migrateFrom(project, "claude", migrateOptions);
    const harness = await loadHarness(project.storeDir);
    const names = harness.hookScripts?.map((entry) => entry.name) ?? [];

    expect(names).not.toContain("leak.sh");
    expect(names.some((name) => name.includes("__pycache__"))).toBe(false);
    expect(names.some((name) => name.includes(".claude"))).toBe(false);
    expect(await pathExists(join(project.storeDir, "hook-scripts", "leak.sh"))).toBe(false);
    expect(migrated.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "hook-script-generated-path-excluded",
        "hook-script-hidden-path-excluded",
        "hook-script-non-regular-path-skipped",
      ]),
    );
  });

  it("leaves an unmanaged sibling hook untouched", async () => {
    const root = await seedNativeProject("hook-scripts-sibling-");
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", migrateOptions);

    const mine = join(root, ".claude", "hooks", "mine.sh");
    await writeFile(mine, "# hand written\n", "utf8");
    const harness = await loadHarness(project.storeDir);
    await applyHarness(project, harness, { dryRun: false, force: false });

    // Per-entry projection: owning the parent directory would have replaced it.
    expect(await readFile(mine, "utf8")).toBe("# hand written\n");
  });

  it("captures a natively edited hook script back into the store", async () => {
    const root = await seedNativeProject("hook-scripts-inverse-");
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", migrateOptions);

    await writeFile(
      join(root, ".claude", "hooks", "guard.sh"),
      "#!/bin/bash\necho changed\n",
      "utf8",
    );
    expect((await reconcileOnce(project)).action).toBe("captured-native");
    expect(
      await readFile(join(project.storeDir, "hook-scripts", "guard.sh"), "utf8"),
    ).toContain("echo changed");
  });

  it("projects hook scripts as real files even under symlink link mode", async () => {
    const root = await seedNativeProject("hook-scripts-linkmode-");
    const project = await initializeProject(root);
    expect(project.config.sync.linkMode).toBe("symlink");
    await migrateFrom(project, "claude", migrateOptions);

    const projected = join(root, ".claude", "hooks", "guard.sh");
    expect((await lstat(projected)).isSymbolicLink()).toBe(false);
    expect((await lstat(projected)).isFile()).toBe(true);
  });

  it("keeps a store that never used the feature byte-identical", async () => {
    const root = await tempRoot("hook-scripts-absent-");
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    const before = await readFile(join(project.storeDir, "harness.yaml"), "utf8");

    await writeHarness(project.storeDir, await loadHarness(project.storeDir));

    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8")).toBe(before);
    expect(before).not.toContain("hookScripts");
  });

  it("warns instead of writing on targets that declare no script directory", async () => {
    const root = await seedNativeProject("hook-scripts-foreign-");
    const project = await initializeProject(root);
    const migrated = await migrateFrom(project, "claude", migrateOptions);

    for (const target of ["codex", "antigravity"] as const) {
      const projection = migrated.projections.find((entry) => entry.target === target);
      expect(projection?.warnings.map((warning) => warning.code)).toContain(
        "hook-scripts-not-projected",
      );
    }
  });

  it("every adapter declares whether it has a hook-script directory", () => {
    const context = {
      projectRoot: "/tmp/project",
      targetRoot: "/tmp/project",
      storeDir: "/tmp/project/.harness-sync",
      scope: "project" as const,
    };
    for (const adapter of allAdapters()) {
      const layout = adapter.hookScripts(context);
      expect(layout === null || typeof layout.dir === "string").toBe(true);
      if (layout) expect(layout.commandPrefix).not.toBe("");
    }
  });

  it("accepts nested and underscore-led names and rejects escapes", () => {
    expect(() => assertHookScriptName("usage-gate/model-gate.js")).not.toThrow();
    expect(() => assertHookScriptName("_cache_io.py")).not.toThrow();
    for (const bad of ["", "/abs.sh", "a/", "../escape.sh", "a/b/c/d/e.sh", "con.sh"]) {
      expect(() => assertHookScriptName(bad)).toThrow(/Invalid hook script name/u);
    }
  });

  it("rejects a declared path that does not match its name", () => {
    expect(() =>
      normalizeHookScripts([{ name: "guard.sh", path: "hook-scripts/other.sh" }]),
    ).toThrow(/expected "hook-scripts\/guard\.sh"/u);
    expect(() => normalizeHookScripts([{ name: "guard.sh", path: "hook-scripts/guard.sh" }]))
      .not.toThrow();
  });
});

describe("output style sync", () => {
  async function seedWithStyle(prefix: string): Promise<string> {
    const root = await tempRoot(prefix);
    await mkdir(join(root, ".claude", "output-styles"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "output-styles", "custom.md"),
      "---\nname: Custom\ndescription: A style\n---\n\nBe brief.\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({ outputStyle: "Custom" }, null, 2)}\n`,
      "utf8",
    );
    return root;
  }

  it("carries the style file alongside the setting that selects it", async () => {
    const source = await seedWithStyle("output-styles-source-");
    const sourceProject = await initializeProject(source);
    await migrateFrom(sourceProject, "claude", migrateOptions);

    const harness = await loadHarness(sourceProject.storeDir);
    expect(harness.outputStyles?.map((e) => e.name)).toEqual(["custom.md"]);
    // The setting travels in the settings passthrough; without the file beside
    // it the second machine selects a style that does not exist there.
    expect(harness.overlays.claude.settings?.outputStyle).toBe("Custom");

    const second = await tempRoot("output-styles-target-");
    const secondStore = join(second, ".harness-sync");
    await cp(sourceProject.storeDir, secondStore, { recursive: true });
    for (const runtime of [".state.json", ".managed.json", ".lock", "backups", "conflicts"]) {
      await rm(join(secondStore, runtime), { recursive: true, force: true });
    }
    const secondProject = await initializeProject(second, { store: secondStore });
    await applyHarness(secondProject, await loadHarness(secondStore), {
      dryRun: false,
      force: true,
    });

    const projected = join(second, ".claude", "output-styles", "custom.md");
    expect(await pathExists(projected)).toBe(true);
    expect(await readFile(projected, "utf8")).toContain("name: Custom");
  });

  it("takes only Markdown from the directory", async () => {
    const root = await seedWithStyle("output-styles-filter-");
    await writeFile(join(root, ".claude", "output-styles", "notes.txt"), "scratch\n", "utf8");
    await mkdir(join(root, ".claude", "output-styles", "sub"), { recursive: true });

    const project = await initializeProject(root);
    await migrateFrom(project, "claude", migrateOptions);
    const names = (await loadHarness(project.storeDir)).outputStyles?.map((e) => e.name) ?? [];
    expect(names).toEqual(["custom.md"]);
  });

  it("keeps a store that never used the feature byte-identical", async () => {
    const root = await tempRoot("output-styles-absent-");
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    const before = await readFile(join(project.storeDir, "harness.yaml"), "utf8");
    await writeHarness(project.storeDir, await loadHarness(project.storeDir));
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8")).toBe(before);
    expect(before).not.toContain("outputStyles");
  });
});

describe("scripts and workflows sync", () => {
  it("carries the helper a hook requires from outside the hooks directory", async () => {
    const source = await tempRoot("code-dirs-source-");
    await mkdir(join(source, ".claude", "hooks"), { recursive: true });
    await mkdir(join(source, ".claude", "scripts", "lib"), { recursive: true });
    await mkdir(join(source, ".claude", "workflows"), { recursive: true });
    await writeFile(join(source, "CLAUDE.md"), "# Instructions\n", "utf8");
    // The shape that broke on a second machine: a wired hook requiring UP and
    // OUT of its own directory, into scripts/.
    await writeFile(
      join(source, ".claude", "hooks", "session-start.js"),
      "require('../scripts/lib/helper');\n",
      "utf8",
    );
    await writeFile(join(source, ".claude", "scripts", "lib", "helper.js"), "module.exports={};\n", "utf8");
    await writeFile(join(source, ".claude", "scripts", "run.sh"), "#!/bin/bash\necho hi\n", "utf8");
    await chmod(join(source, ".claude", "scripts", "run.sh"), 0o755);
    await writeFile(join(source, ".claude", "workflows", "e2e.js"), "// workflow\n", "utf8");
    // Generated bytes must not enter the store, as for hook scripts.
    await mkdir(join(source, ".claude", "scripts", "__pycache__"), { recursive: true });
    await writeFile(join(source, ".claude", "scripts", "__pycache__", "x.pyc"), "c\n", "utf8");

    const sourceProject = await initializeProject(source);
    await migrateFrom(sourceProject, "claude", migrateOptions);
    const harness = await loadHarness(sourceProject.storeDir);
    expect(harness.scripts?.map((e) => e.name).sort()).toEqual(["lib/helper.js", "run.sh"]);
    expect(harness.workflows?.map((e) => e.name)).toEqual(["e2e.js"]);

    const second = await tempRoot("code-dirs-target-");
    const secondStore = join(second, ".harness-sync");
    await cp(sourceProject.storeDir, secondStore, { recursive: true });
    for (const runtime of [".state.json", ".managed.json", ".lock", "backups", "conflicts"]) {
      await rm(join(secondStore, runtime), { recursive: true, force: true });
    }
    const secondProject = await initializeProject(second, { store: secondStore });
    await applyHarness(secondProject, await loadHarness(secondStore), {
      dryRun: false,
      force: true,
    });

    // Both halves must land: the hook and the helper it requires.
    expect(await pathExists(join(second, ".claude", "hooks", "session-start.js"))).toBe(true);
    expect(await pathExists(join(second, ".claude", "scripts", "lib", "helper.js"))).toBe(true);
    expect(await pathExists(join(second, ".claude", "workflows", "e2e.js"))).toBe(true);
    expect((await stat(join(second, ".claude", "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    expect(await pathExists(join(second, ".claude", "scripts", "__pycache__"))).toBe(false);
  });
});
