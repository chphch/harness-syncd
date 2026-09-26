import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedWriter } from "../src/core/writer.js";

// Failure injection for the staging step only. Each flag names the helper that
// fails after it has created (part of) the `.prepared` staging copy.
const fault = vi.hoisted(() => ({ copyTree: false, hashPrepared: false }));

vi.mock("../src/core/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/fs.js")>();
  return {
    ...actual,
    copyTree: async (source: string, destination: string) => {
      if (!fault.copyTree) return actual.copyTree(source, destination);
      // What cp leaves behind when it dies part-way through a tree.
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "partial.md"), "half\n");
      throw Object.assign(new Error("EMFILE: too many open files, copyfile"), { code: "EMFILE" });
    },
    hashPath: async (path: string) => {
      if (fault.hashPrepared && path.endsWith(".prepared")) {
        throw Object.assign(new Error("EMFILE: too many open files, open"), { code: "EMFILE" });
      }
      return actual.hashPath(path);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  fault.copyTree = false;
  fault.hashPrepared = false;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "writer-staging-"));
  roots.push(root);
  const store = join(root, "store");
  const native = join(root, "native");
  const source = join(store, "skills", "planner");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: planner\n---\nbody\n");
  await mkdir(join(native, "skills"), { recursive: true });
  const writer = new ManagedWriter({
    storeDir: store,
    target: "claude",
    dryRun: false,
    force: false,
    linkMode: "copy",
    allowedRoot: native,
  });
  await writer.load();
  return { native, source, writer };
}

const staging = async (dir: string) =>
  (await readdir(dir)).filter((name) => name.endsWith(".prepared"));

describe("ManagedWriter never leaves a staging copy behind", () => {
  it("removes a partial directory copy when copyTree fails", async () => {
    const { native, source, writer } = await fixture();
    fault.copyTree = true;
    await expect(writer.directory(source, join(native, "skills", "planner")))
      .rejects.toThrow(/EMFILE/u);
    expect(await staging(join(native, "skills"))).toEqual([]);
  });

  it("removes the directory staging copy when hashing it fails", async () => {
    const { native, source, writer } = await fixture();
    fault.hashPrepared = true;
    await expect(writer.directory(source, join(native, "skills", "planner")))
      .rejects.toThrow(/EMFILE/u);
    expect(await staging(join(native, "skills"))).toEqual([]);
  });

  it("removes the file staging copy when hashing it fails", async () => {
    const { native, source, writer } = await fixture();
    fault.hashPrepared = true;
    await expect(
      writer.materialize(join(source, "SKILL.md"), join(native, "skills", "SKILL.md")),
    ).rejects.toThrow(/EMFILE/u);
    expect(await staging(join(native, "skills"))).toEqual([]);
  });

  it("removes the text staging copy when hashing it fails", async () => {
    const { native, writer } = await fixture();
    fault.hashPrepared = true;
    await expect(writer.text(join(native, "CLAUDE.md"), "x\n")).rejects.toThrow(/EMFILE/u);
    expect(await staging(native)).toEqual([]);
  });

  it("still installs normally when nothing fails", async () => {
    const { native, source, writer } = await fixture();
    await expect(writer.directory(source, join(native, "skills", "planner"))).resolves.toBe(true);
    await expect(writer.text(join(native, "CLAUDE.md"), "x\n")).resolves.toBe(true);
    expect(await staging(join(native, "skills"))).toEqual([]);
    expect(await staging(native)).toEqual([]);
  });
});
