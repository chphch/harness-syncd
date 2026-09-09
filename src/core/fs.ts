import {
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NativeWritePreconditions } from "../adapters/adapter.js";

const MISSING_PATH_HASH = createHash("sha256").update("missing:").digest("hex");

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve every existing path component through the filesystem while keeping
 * a not-yet-created suffix. This makes overlap checks resistant to symlink
 * aliases without requiring the destination itself to exist. */
export async function resolvePhysicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;

      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error(`path contains a broken symlink: ${current}`);
        }
      } catch (probeError) {
        if (!(isNodeError(probeError) && probeError.code === "ENOENT")) {
          throw probeError;
        }
      }

      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Refuse a native import that resolves outside the harness boundary. A
 * managed projection may resolve directly to its exact canonical destination,
 * including when that store is intentionally on another filesystem path. */
export async function assertNativeImportPath(
  path: string,
  nativeRoot: string,
  canonicalEquivalent?: string | readonly string[],
): Promise<void> {
  if (!(await pathExists(path))) return;
  const pathInfo = await lstat(path);
  const targetInfo = pathInfo.isSymbolicLink() ? await stat(path) : pathInfo;
  if (!targetInfo.isFile() && !targetInfo.isDirectory()) {
    throw new Error(`native import contains a non-regular path: ${path}`);
  }
  const physicalPath = await resolvePhysicalPath(path);
  const equivalents = typeof canonicalEquivalent === "string"
    ? [canonicalEquivalent]
    : canonicalEquivalent ?? [];
  for (const equivalent of equivalents) {
    if (physicalPath === (await resolvePhysicalPath(equivalent))) return;
  }
  if (pathInfo.isSymbolicLink() && targetInfo.isDirectory()) {
    throw new Error(
      `native import contains an unmanaged symlinked directory: ${path} -> ${physicalPath}`,
    );
  }
  const physicalRoot = await resolvePhysicalPath(nativeRoot);
  const remainder = relative(physicalRoot, physicalPath);
  if (
    remainder === ".." ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  ) {
    throw new Error(
      `native import resolves outside allowed root ${physicalRoot}: ${path} -> ${physicalPath}`,
    );
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Refuse traversal through a symlink below a trusted storage root. Lexical
 * containment alone is insufficient for writes because mkdir/open/rename all
 * follow symlinked parent directories. The root itself may be an explicitly
 * configured alias, but every descendant that already exists must be real.
 */
export async function assertSafeStorePath(
  storeDir: string,
  path: string,
): Promise<void> {
  const root = resolve(storeDir);
  const candidate = resolve(path);
  const remainder = relative(root, candidate);
  if (
    remainder === ".." ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  ) {
    throw new Error(`store path escapes canonical root ${root}: ${candidate}`);
  }
  if (remainder === "") return;

  let current = root;
  const components = remainder.split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`canonical store path contains a symlink: ${current}`);
      }
      if (index < components.length - 1 && !info.isDirectory()) {
        throw new Error(`canonical store path has a non-directory ancestor: ${current}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") break;
      throw error;
    }
  }
}

export async function writeTextAtomicInside(
  storeDir: string,
  path: string,
  value: string,
): Promise<void> {
  await assertSafeStorePath(storeDir, path);
  await mkdir(dirname(path), { recursive: true });
  await assertSafeStorePath(storeDir, dirname(path));
  await writeTextAtomic(path, value);
  await assertSafeStorePath(storeDir, path);
}

export async function writeJsonAtomicInside(
  storeDir: string,
  path: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomicInside(
    storeDir,
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });
}

/**
 * Copy an imported bundle as regular files. Native harnesses may already point
 * at the canonical bundle through a symlink, so compare real paths first and
 * never copy a symlink back onto its own target.
 */
export async function copyTreeForImport(
  source: string,
  destination: string,
): Promise<"copied" | "same"> {
  const sourceReal = await realpath(source);
  if (await pathExists(destination)) {
    const destinationReal = await realpath(destination);
    if (sourceReal === destinationReal) return "same";
  }
  const absoluteDestination = resolve(destination);
  const destinationFromSource = relative(sourceReal, absoluteDestination);
  const sourceFromDestination = relative(absoluteDestination, sourceReal);
  if (
    isContainedRelative(destinationFromSource) ||
    isContainedRelative(sourceFromDestination)
  ) {
    throw new Error(
      `refusing to copy overlapping import trees: ${source} -> ${destination}`,
    );
  }
  await assertSafeImportTree(sourceReal, sourceReal);
  await mkdir(dirname(destination), { recursive: true });
  const staging = join(dirname(destination), `.${randomUUID()}.import`);
  const displaced = join(dirname(destination), `.${randomUUID()}.previous`);
  try {
    await cp(sourceReal, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const hadDestination = await pathExists(destination);
    if (hadDestination) await rename(destination, displaced);
    try {
      await rename(staging, destination);
    } catch (error) {
      if (hadDestination && (await pathExists(displaced))) {
        await rename(displaced, destination);
      }
      throw error;
    }
    if (hadDestination) await rm(displaced, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return "copied";
}

export async function copyTreeForImportInside(
  storeDir: string,
  source: string,
  destination: string,
): Promise<"copied" | "same"> {
  await assertSafeStorePath(storeDir, destination);
  await mkdir(dirname(destination), { recursive: true });
  await assertSafeStorePath(storeDir, dirname(destination));
  const result = await copyTreeForImport(source, destination);
  await assertSafeStorePath(storeDir, destination);
  return result;
}

function isContainedRelative(value: string): boolean {
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function assertSafeImportTree(root: string, current: string): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = join(current, entry.name);
    if (entry.name.toLowerCase() === ".git") {
      throw new Error(`import bundle contains nested Git metadata: ${candidate}`);
    }
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new Error(`import bundle contains a nested symlink: ${candidate}`);
    }
    if (info.isDirectory()) {
      await assertSafeImportTree(root, candidate);
    } else if (!info.isFile()) {
      throw new Error(`import bundle contains a non-regular file: ${candidate}`);
    }
  }
}

export async function copyFileAtomic(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temp = join(dirname(destination), `.${randomUUID()}.tmp`);
  await copyFile(source, temp);
  await rename(temp, destination);
}

export async function copyFileAtomicInside(
  storeDir: string,
  source: string,
  destination: string,
): Promise<void> {
  await assertSafeStorePath(storeDir, destination);
  await mkdir(dirname(destination), { recursive: true });
  await assertSafeStorePath(storeDir, dirname(destination));
  await copyFileAtomic(source, destination);
  await assertSafeStorePath(storeDir, destination);
}

export async function ensureRelativeSymlink(
  source: string,
  destination: string,
): Promise<"linked" | "unchanged" | "occupied"> {
  const absoluteSource = resolve(source);
  await mkdir(dirname(destination), { recursive: true });
  const linkTarget = relative(dirname(destination), absoluteSource) || ".";

  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink()) return "occupied";
    const existing = await readlink(destination);
    if (resolve(dirname(destination), existing) === absoluteSource) {
      return "unchanged";
    }
    return "occupied";
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }

  await symlink(linkTarget, destination);
  return "linked";
}

export async function symlinkPointsTo(
  destination: string,
  source: string,
): Promise<boolean> {
  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink()) return false;
    const existing = await readlink(destination);
    return resolve(dirname(destination), existing) === resolve(source);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function hashPath(path: string): Promise<string> {
  const digest = createHash("sha256");
  await appendPathHash(digest, path, "");
  return digest.digest("hex");
}

export async function hashNativePath(
  path: string,
  symlinkContentRoot?: string,
): Promise<string> {
  const digest = createHash("sha256");
  const realSymlinkContentRoot = symlinkContentRoot
    ? await realpath(symlinkContentRoot)
    : undefined;
  await appendPathHash(digest, path, "", realSymlinkContentRoot);
  return digest.digest("hex");
}

export async function hashPaths(
  paths: string[],
  options: { symlinkContentRoot?: string } = {},
): Promise<string> {
  const digest = createHash("sha256");
  const realSymlinkContentRoot = options.symlinkContentRoot
    ? await realpath(options.symlinkContentRoot)
    : undefined;
  for (const path of [...paths].sort()) {
    digest.update(path);
    await appendPathHash(
      digest,
      path,
      "",
      realSymlinkContentRoot,
    );
  }
  return digest.digest("hex");
}

/** Capture content hashes for every currently present path under the native
 * roots. ManagedWriter uses these as compare-and-swap preconditions during an
 * explicit migration takeover. */
export async function snapshotNativePaths(
  paths: readonly string[],
  symlinkContentRoot: string,
): Promise<NativeWritePreconditions & { fingerprint: string }> {
  const roots = [...new Set(paths.map((path) => resolve(path)))].sort();
  const physicalContentRoot = await realpath(symlinkContentRoot);
  const before = await hashPaths(roots, {
    symlinkContentRoot: physicalContentRoot,
  });
  const hashes = new Map<string, string>();
  const contentHashes = new Map<string, string>();
  for (const root of roots) {
    await snapshotNativePath(
      root,
      hashes,
      contentHashes,
      physicalContentRoot,
    );
  }
  const after = await hashPaths(roots, {
    symlinkContentRoot: physicalContentRoot,
  });
  if (after !== before) {
    throw new Error(
      "native migration source changed while its initial snapshot was collected",
    );
  }
  return {
    roots,
    hashes,
    contentHashes,
    symlinkContentRoot: physicalContentRoot,
    missingHash: MISSING_PATH_HASH,
    consumed: new Set<string>(),
    fingerprint: after,
  };
}

async function snapshotNativePath(
  path: string,
  hashes: Map<string, string>,
  contentHashes: Map<string, string>,
  symlinkContentRoot: string,
): Promise<void> {
  const absolute = resolve(path);
  hashes.set(absolute, await hashPath(absolute));
  contentHashes.set(
    absolute,
    await hashNativePath(absolute, symlinkContentRoot),
  );
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    await snapshotNativePath(
      join(absolute, entry.name),
      hashes,
      contentHashes,
      symlinkContentRoot,
    );
  }
}

export function resolveInside(base: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`artifact path must be relative: ${relativePath}`);
  }
  const absoluteBase = resolve(base);
  const candidate = resolve(absoluteBase, relativePath);
  const remainder = relative(absoluteBase, candidate);
  if (remainder === ".." || remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`artifact path escapes the canonical store: ${relativePath}`);
  }
  return candidate;
}

export async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function listFilesRecursive(path: string): Promise<string[]> {
  const output: string[] = [];
  await walk(path, "", output);
  return output.sort();
}

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const openLock = () => open(path, "wx", 0o600);
  let handle;
  try {
    handle = await openLock();
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
    const owner = await readTextIfExists(path);
    const pid = owner ? Number(owner.split(":", 1)[0]) : Number.NaN;
    const stale = Number.isInteger(pid) && pid > 0 && !processIsAlive(pid);
    throw new Error(
      stale
        ? `stale harness-sync lock at ${path}; verify no process is running, then remove this exact lock file manually`
        : `another harness-sync process holds ${path}`,
    );
  }
  await handle.writeFile(`${token}\n`, "utf8");
  return async () => {
    await handle.close();
    if ((await readTextIfExists(path))?.trim() === token) {
      await rm(path, { force: true });
    }
  };
}

async function walk(base: string, current: string, output: string[]): Promise<void> {
  const absolute = join(base, current);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const next = join(current, entry.name);
    if (entry.name.toLowerCase() === ".git") {
      throw new Error(`native import contains nested Git metadata: ${join(base, next)}`);
    }
    if (entry.isDirectory()) {
      await walk(base, next, output);
      continue;
    }
    if (entry.isFile()) {
      output.push(next);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await stat(join(base, next));
      if (target.isFile()) output.push(next);
      else if (target.isDirectory()) {
        throw new Error(
          `native import contains a symlinked directory: ${join(base, next)}`,
        );
      } else {
        throw new Error(`native import contains a non-regular file: ${join(base, next)}`);
      }
      continue;
    }
    throw new Error(`native import contains a non-regular file: ${join(base, next)}`);
  }
}

async function appendPathHash(
  digest: ReturnType<typeof createHash>,
  path: string,
  relativePath: string,
  realSymlinkContentRoot?: string,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      digest.update(`missing:${relativePath}`);
      return;
    }
    throw error;
  }

  if (info.isSymbolicLink()) {
    digest.update(`link:${relativePath}:${await readlink(path)}`);
    if (realSymlinkContentRoot) {
      try {
        const targetPath = await realpath(path);
        const remainder = relative(realSymlinkContentRoot, targetPath);
        if (
          remainder === ".." ||
          remainder.startsWith(`..${sep}`) ||
          isAbsolute(remainder)
        ) {
          digest.update(":target-outside-boundary");
          return;
        }
        const target = await lstat(targetPath);
        if (target.isFile()) {
          digest.update(":target-file:");
          await appendFileBytes(digest, targetPath);
        } else if (target.isDirectory()) {
          digest.update(":target-directory");
        } else {
          digest.update(":target-special");
        }
      } catch (error) {
        if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
        digest.update(":broken");
      }
    }
    return;
  }
  if (info.isFile()) {
    digest.update(`file:${relativePath}:executable=${String((info.mode & 0o111) !== 0)}:`);
    await appendFileBytes(digest, path);
    return;
  }
  if (!info.isDirectory()) return;

  digest.update(`dir:${relativePath}`);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await appendPathHash(
      digest,
      join(path, entry.name),
      join(relativePath, entry.name),
      realSymlinkContentRoot,
    );
  }
}

async function appendFileBytes(
  digest: ReturnType<typeof createHash>,
  path: string,
): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}
