import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { GENERATED_DIRECTORY_NAMES, hashPath, pathExists } from "../src/core/fs.js";
import { migrateFrom } from "../src/core/migrate.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import { nativePathsEquivalent, reconcileOnce } from "../src/core/reconcile.js";
import type { LinkMode } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const SKILL = "---\nname: planner\ndescription: Plan a project\n---\n";

/** What running the skill's script leaves behind: CPython's bytecode cache. */
async function runScript(skillDir: string, bytes = "bytecode-v1"): Promise<void> {
  const cache = join(skillDir, "scripts", "__pycache__");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "planner.cpython-313.pyc"), bytes);
}

/** A claude-only project whose skill `planner` ships a Python script. */
async function skillProject(
  prefix: string,
  linkMode: LinkMode,
): Promise<{ project: LoadedProject; native: string; canonical: string }> {
  const root = await tempRoot(prefix);
  const native = join(root, ".claude", "skills", "planner");
  await mkdir(join(native, "scripts"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
  await writeFile(join(native, "SKILL.md"), `${SKILL}Version one.\n`);
  await writeFile(join(native, "scripts", "planner.py"), "print('planner')\n");
  const project = await initializeProject(root);
  project.config.sync.linkMode = linkMode;
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
  expect((await reconcileOnce(project)).action).toBe("noop");
  return { project, native, canonical: join(project.storeDir, "skills", "planner") };
}

describe("generated directories are not content", () => {
  it("compares two trees that differ only in generated directories as equivalent", async () => {
    const root = await tempRoot("hs-generated-equiv-");
    const left = join(root, "left");
    await mkdir(join(left, "scripts"), { recursive: true });
    await writeFile(join(left, "SKILL.md"), `${SKILL}Body\n`);
    await writeFile(join(left, "scripts", "tool.py"), "print(1)\n");
    const right = join(root, "right");
    await cp(left, right, { recursive: true });
    for (const name of GENERATED_DIRECTORY_NAMES) {
      await mkdir(join(left, "scripts", name), { recursive: true });
      await writeFile(join(left, "scripts", name, "artifact"), "generated");
    }

    expect(await nativePathsEquivalent(left, right, "claude")).toBe(true);
    expect(await nativePathsEquivalent(right, left, "claude")).toBe(true);
    // …and an authored difference beside them is still a difference.
    await writeFile(join(left, "scripts", "extra.py"), "print(2)\n");
    expect(await nativePathsEquivalent(left, right, "claude")).toBe(false);
  });

  it("hashes a tree the same with or without generated directories in it", async () => {
    const root = await tempRoot("hs-generated-hash-");
    const tree = join(root, "skill");
    await mkdir(join(tree, "scripts"), { recursive: true });
    await writeFile(join(tree, "scripts", "tool.py"), "print(1)\n");
    const before = await hashPath(tree);
    for (const name of GENERATED_DIRECTORY_NAMES) {
      await mkdir(join(tree, "scripts", name), { recursive: true });
      await writeFile(join(tree, "scripts", name, "artifact"), "generated");
    }

    expect(await hashPath(tree)).toBe(before);
    await writeFile(join(tree, "scripts", "tool.py"), "print(2)\n");
    expect(await hashPath(tree)).not.toBe(before);
  });

  it("captures an edit to a copied skill whose script left a __pycache__", async () => {
    // Seen live on 2026-09-26: every cycle reported "claude edits were only
    // partially representable (…/skills/planner); staged data was discarded".
    const { project, native, canonical } = await skillProject("hs-pycache-edit-", "copy");
    await runScript(native);
    await writeFile(join(native, "SKILL.md"), `${SKILL}Version two.\n`);

    const result = await reconcileOnce(project);

    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("captured-native");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(`${SKILL}Version two.\n`);
    // The cache never enters the store, and the native one is left alone.
    expect(await pathExists(join(canonical, "scripts", "__pycache__"))).toBe(false);
    expect(await pathExists(join(native, "scripts", "__pycache__"))).toBe(true);
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("does nothing when running a copied skill's script creates or rewrites its cache", async () => {
    const { project, native } = await skillProject("hs-pycache-copy-", "copy");

    await runScript(native);
    let result = await reconcileOnce(project);
    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("noop");

    await runScript(native, "bytecode-v2");
    await mkdir(join(native, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(native, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    result = await reconcileOnce(project);
    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("noop");
  });

  it("does nothing when a linked skill's script writes its cache into the store", async () => {
    // Through a link projection the interpreter writes beside the canonical
    // script, so the cache appears inside the store itself.
    const { project, canonical } = await skillProject("hs-pycache-link-", "symlink");

    await runScript(canonical);
    const result = await reconcileOnce(project);

    expect(result.conflict?.message).toBeUndefined();
    expect(result.action).toBe("noop");
  });
});
