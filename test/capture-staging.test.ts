import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHarness, writeHarness, writeProjectConfig } from "../src/core/config.js";
import { initializeProject } from "../src/core/project.js";
import { commitCaptureStage, createCaptureStage } from "../src/core/reconcile.js";
import { hashCanonical } from "../src/core/state.js";

// Fail the copy into a `.capture` staging entry AFTER it has created that entry
// (or part of it) — the shape of an EMFILE or ENOSPC half-way through.
const fault = vi.hoisted(() => ({ file: false, tree: false }));

vi.mock("../src/core/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/fs.js")>();
  const emfile = () =>
    Object.assign(new Error("EMFILE: too many open files, copyfile"), { code: "EMFILE" });
  return {
    ...actual,
    copyFileAtomicInside: async (storeDir: string, source: string, destination: string) => {
      await actual.copyFileAtomicInside(storeDir, source, destination);
      if (fault.file && destination.endsWith(".capture")) throw emfile();
    },
    copyTreeForImportInside: async (storeDir: string, source: string, destination: string) => {
      if (!(fault.tree && destination.endsWith(".capture"))) {
        return actual.copyTreeForImportInside(storeDir, source, destination);
      }
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "partial.md"), "half\n");
      throw emfile();
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  fault.file = false;
  fault.tree = false;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "capture-staging-"));
  roots.push(root);
  const project = await initializeProject(root, { controllerId: "staging" });
  for (const target of Object.values(project.config.targets)) target.enabled = false;
  await writeProjectConfig(project.configPath, project.config);
  await mkdir(join(project.storeDir, "skills", "demo"), { recursive: true });
  await writeFile(join(project.storeDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nv1\n");
  const initial = await loadHarness(project.storeDir);
  initial.skills.push({ name: "demo", path: "skills/demo" });
  await writeHarness(project.storeDir, initial);
  const harness = await loadHarness(project.storeDir);
  const stage = await createCaptureStage(project.storeDir, harness);
  roots.push(stage);
  return { project, harness, stage, expected: await hashCanonical(project, harness) };
}

const captureEntries = async (dir: string) =>
  (await readdir(dir)).filter((name) => name.endsWith(".capture"));

describe("commitCaptureStage never leaves a .capture staging entry behind", () => {
  it("when copying a file artifact into staging fails", async () => {
    const { project, harness, stage, expected } = await fixture();
    await writeFile(join(stage, "instructions", "root.md"), "captured\n");
    fault.file = true;

    await expect(commitCaptureStage(project, harness, harness, stage, expected))
      .rejects.toThrow(/EMFILE/u);
    expect(await captureEntries(join(project.storeDir, "instructions"))).toEqual([]);
    // Nothing was moved aside, so the canonical file is still in place.
    expect(await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"))
      .not.toBe("captured\n");
  });

  it("when copying a directory artifact into staging fails part-way", async () => {
    const { project, harness, stage, expected } = await fixture();
    await writeFile(join(stage, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nv2\n");
    fault.tree = true;

    await expect(commitCaptureStage(project, harness, harness, stage, expected))
      .rejects.toThrow(/EMFILE/u);
    expect(await captureEntries(join(project.storeDir, "skills"))).toEqual([]);
    expect(await readFile(join(project.storeDir, "skills", "demo", "SKILL.md"), "utf8"))
      .toContain("v1");
  });
});
