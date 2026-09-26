import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectConfig } from "../src/core/config.js";
import { migrateFrom } from "../src/core/migrate.js";
import { initializeProject } from "../src/core/project.js";
import { nativePathsEquivalent, reconcileOnce } from "../src/core/reconcile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// Claude Code accepts this; strict YAML does not ("Nested mappings are not
// allowed in compact mappings"), because of the second colon.
const INVALID_SKILL =
  "---\nname: signal\ndescription: Use when: the user asks for today's orders\n---\n";

describe("nativePathsEquivalent", () => {
  it("treats byte-identical files it cannot parse as equivalent", async () => {
    const root = await tempRoot("hs-equiv-");
    const write = async (name: string, text: string) => {
      await writeFile(join(root, name), text);
      return join(root, name);
    };
    const left = await write("left.md", `${INVALID_SKILL}Body\n`);
    const same = await write("same.md", `${INVALID_SKILL}Body\n`);
    const edited = await write("edited.md", `${INVALID_SKILL}Edited body\n`);
    const valid = await write("valid.md", "---\nname: signal\n---\nBody\n");
    expect(await nativePathsEquivalent(left, same, "claude")).toBe(true);
    expect(await nativePathsEquivalent(left, edited, "claude")).toBe(false);
    expect(await nativePathsEquivalent(left, valid, "claude")).toBe(false);

    const brokenJson = await write("a.json", "{ \"permissions\": ");
    const brokenJsonCopy = await write("b.json", "{ \"permissions\": ");
    const otherJson = await write("c.json", "{ \"permissions\": [");
    expect(await nativePathsEquivalent(brokenJson, brokenJsonCopy, "claude")).toBe(true);
    expect(await nativePathsEquivalent(brokenJson, otherJson, "claude")).toBe(false);
  });
});

describe("a skill whose SKILL.md frontmatter is not valid YAML", () => {
  it("captures native edits instead of recording a permanent conflict", async () => {
    const root = await tempRoot("hs-invalid-yaml-");
    const skill = join(root, ".claude", "skills", "signal");
    await mkdir(skill, { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
    await writeFile(join(skill, "SKILL.md"), `${INVALID_SKILL}Version one.\n`);
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
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

    for (const version of ["Version two.", "Version three."]) {
      await writeFile(join(skill, "SKILL.md"), `${INVALID_SKILL}${version}\n`);
      const result = await reconcileOnce(project);
      expect(result.conflict?.message).toBeUndefined();
      expect(result.action).toBe("captured-native");
      expect(await readFile(join(project.storeDir, "skills", "signal", "SKILL.md"), "utf8"))
        .toBe(`${INVALID_SKILL}${version}\n`);
    }
    expect((await reconcileOnce(project)).action).toBe("noop");
  });
});
