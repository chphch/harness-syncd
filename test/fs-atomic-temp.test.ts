import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFileAtomic, writeTextAtomic } from "../src/core/fs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A destination that is a non-empty directory makes the final rename fail
 * after the temp file already exists — the cheapest REAL failure of the last
 * step. Every temp file these helpers leave lands in a watched tree.
 */
async function blockedDestination() {
  const root = await mkdtemp(join(tmpdir(), "fs-atomic-"));
  roots.push(root);
  const destination = join(root, "occupied");
  await mkdir(destination);
  await writeFile(join(destination, "keep"), "x");
  return { root, destination };
}

const temps = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

describe("atomic writes remove their temp file when they fail", () => {
  it("writeTextAtomic", async () => {
    const { root, destination } = await blockedDestination();
    await expect(writeTextAtomic(destination, "x")).rejects.toMatchObject({
      code: expect.stringMatching(/^E/u),
    });
    expect(await temps(root)).toEqual([]);
  });

  it("copyFileAtomic", async () => {
    const { root, destination } = await blockedDestination();
    await writeFile(join(root, "source"), "x");
    await expect(copyFileAtomic(join(root, "source"), destination)).rejects.toMatchObject({
      code: expect.stringMatching(/^E/u),
    });
    expect(await temps(root)).toEqual([]);
  });

  it("copyFileAtomic when the source is missing", async () => {
    const { root } = await blockedDestination();
    await expect(copyFileAtomic(join(root, "absent"), join(root, "copy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await temps(root)).toEqual([]);
  });
});
