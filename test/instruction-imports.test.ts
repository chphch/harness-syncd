import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import {
  collapseInstructionImports,
  renderInstructionImports,
} from "../src/core/instruction-imports.js";
import { migrateFrom } from "../src/core/migrate.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import { reconcileOnce } from "../src/core/reconcile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const INSTRUCTIONS = "# Instructions\n\n@REQUIREMENTS.md\n\nKeep it short.\n";
const REQUIREMENTS = "# Requirements\n\n- The user's attention is the budget.\n";

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A copy-mode project whose CLAUDE.md imports REQUIREMENTS.md, projected to
 * all three targets. Codex and Antigravity both read the project AGENTS.md. */
async function importingProject(): Promise<{ root: string; project: LoadedProject }> {
  const root = await scratch("instruction-imports-");
  await writeFile(join(root, "CLAUDE.md"), INSTRUCTIONS, "utf8");
  await writeFile(join(root, "REQUIREMENTS.md"), REQUIREMENTS, "utf8");
  const project = await initializeProject(root);
  project.config.sync.linkMode = "copy";
  for (const target of ["claude", "codex", "antigravity"] as const) {
    project.config.targets[target].enabled = true;
  }
  await writeProjectConfig(project.configPath, project.config);
  await migrateFrom(project, "claude", {
    apply: true,
    install: true,
    includeLocal: false,
    force: true,
    excludeSkills: [],
  });
  return { root, project };
}

describe("renderInstructionImports", () => {
  it("expands a whole-line import and leaves prose mentions alone", async () => {
    const root = await scratch("render-imports-");
    await writeFile(join(root, "REQUIREMENTS.md"), REQUIREMENTS, "utf8");
    const input = "Ask @user first.\n\n@REQUIREMENTS.md\n\n```\n@REQUIREMENTS.md\n```\n";
    const rendered = await renderInstructionImports(input, root);
    expect(rendered.text).toBe(
      "Ask @user first.\n\n" +
        "<!-- harness-sync:import REQUIREMENTS.md -->\n" +
        REQUIREMENTS.trimEnd() +
        "\n<!-- harness-sync:end-import REQUIREMENTS.md -->\n\n```\n@REQUIREMENTS.md\n```\n",
    );
    expect(rendered.dependencies).toEqual([join(root, "REQUIREMENTS.md")]);
    expect(collapseInstructionImports(rendered.text)).toBe(input);
  });

  it("follows nested imports, stops at a cycle and keeps a missing file's line", async () => {
    const root = await scratch("render-nested-");
    await writeFile(join(root, "a.md"), "A\n@b.md\n", "utf8");
    await writeFile(join(root, "b.md"), "B\n@a.md\n", "utf8");
    const rendered = await renderInstructionImports("@a.md\n@missing.md\n", root);
    expect(rendered.text).toContain("A\n<!-- harness-sync:import b.md -->\nB\n@a.md\n");
    expect(rendered.text).toContain("\n@missing.md\n");
    expect(rendered.dependencies).toEqual(
      [join(root, "a.md"), join(root, "b.md"), join(root, "missing.md")].sort(),
    );
    expect(collapseInstructionImports(rendered.text)).toBe("@a.md\n@missing.md\n");
  });

  it("never hashes a directory named by an import", async () => {
    const root = await scratch("render-directory-");
    const rendered = await renderInstructionImports("@.\n", root);
    expect(rendered).toEqual({ text: "@.\n", dependencies: [] });
  });
});

describe("projecting instructions that import a file", () => {
  it("renders the import for Codex and Antigravity but leaves Claude's line", async () => {
    const { root, project } = await importingProject();
    expect((await reconcileOnce(project)).action).toBe("noop");

    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(INSTRUCTIONS);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("- The user's attention is the budget.");
    expect(agents).not.toMatch(/^@REQUIREMENTS\.md$/mu);
    expect((await lstat(join(root, "AGENTS.md"))).isSymbolicLink()).toBe(false);
    // Canonical keeps Claude's syntax.
    expect(await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"))
      .toBe(INSTRUCTIONS);
  });

  it("re-renders when only the imported file changes", async () => {
    const { root, project } = await importingProject();
    await writeFile(join(root, "REQUIREMENTS.md"), "# Requirements\n\n- Conclusion first.\n", "utf8");

    expect((await reconcileOnce(project)).action).toBe("projected-canonical");
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("- Conclusion first.");
    expect(agents).not.toContain("attention is the budget");
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("captures an edit outside the rendered block back as the import line", async () => {
    const { root, project } = await importingProject();
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    await writeFile(join(root, "AGENTS.md"), agents.replace("Keep it short.", "Keep it very short."), "utf8");

    expect((await reconcileOnce(project)).action).toBe("captured-native");
    expect(await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"))
      .toBe(INSTRUCTIONS.replace("Keep it short.", "Keep it very short."));
    expect(await readFile(join(root, "REQUIREMENTS.md"), "utf8")).toBe(REQUIREMENTS);
  });

  it("refuses an edit inside the rendered block instead of dropping it", async () => {
    const { root, project } = await importingProject();
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    await writeFile(
      join(root, "AGENTS.md"),
      agents.replace("attention is the budget", "attention is the only budget"),
      "utf8",
    );

    expect((await reconcileOnce(project)).action).toBe("conflict");
    expect(await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"))
      .toBe(INSTRUCTIONS);
  });

  it("keeps a plain link when the instructions import nothing", async () => {
    const root = await scratch("instruction-no-imports-");
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.linkMode = "symlink";
    for (const target of ["claude", "codex", "antigravity"] as const) {
      project.config.targets[target].enabled = true;
    }
    await writeProjectConfig(project.configPath, project.config);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    expect((await lstat(join(root, "AGENTS.md"))).isSymbolicLink()).toBe(true);
    expect((await reconcileOnce(project)).action).toBe("noop");
  });
});
