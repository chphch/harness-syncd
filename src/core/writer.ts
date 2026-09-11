import { createHash, randomUUID } from "node:crypto";
import {
  link as hardLink,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LinkMode, TargetName } from "../types.js";
import type { NativeWritePreconditions } from "../adapters/adapter.js";
import {
  copyFileAtomic,
  copyTree,
  assertSafeStorePath,
  ensureRelativeSymlink,
  hashPath,
  hashNativePath,
  hashPaths,
  isNodeError,
  pathExists,
  resolvePhysicalPath,
  symlinkPointsTo,
  writeJsonAtomicInside,
  writeTextAtomic,
} from "./fs.js";

interface ManagedRegistry {
  schemaVersion: 1;
  files: Record<string, string>;
  links: Record<string, string>;
  kinds?: Record<string, "file" | "directory">;
  owners?: Record<string, TargetName | TargetName[]>;
}

export interface WriterOptions {
  storeDir: string;
  target: TargetName;
  dryRun: boolean;
  force: boolean;
  linkMode: LinkMode;
  allowedRoot?: string;
  activeTargets?: readonly TargetName[];
  nativePreconditions?: NativeWritePreconditions;
}

export class ManagedWriter {
  readonly written: string[] = [];
  readonly linked: string[] = [];
  readonly removed: string[] = [];
  readonly skipped: string[] = [];
  readonly warnings: string[] = [];
  private readonly retained = new Set<string>();
  private registry: ManagedRegistry = {
    schemaVersion: 1,
    files: {},
    links: {},
  };
  private readonly registryPath: string;

  constructor(private readonly options: WriterOptions) {
    this.registryPath = join(options.storeDir, ".managed.json");
  }

  async load(): Promise<void> {
    await assertSafeStorePath(this.options.storeDir, this.registryPath);
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, "utf8")) as ManagedRegistry;
      if (parsed.schemaVersion === 1) this.registry = parsed;
    } catch {
      // A missing or malformed registry means every existing destination is unowned.
    }
  }

  owns(path: string): boolean {
    return ownerList(this.registry.owners?.[path]).includes(this.options.target);
  }

  async adopt(path: string): Promise<void> {
    await this.assertSafeDestination(path);
    if (!(await pathExists(path))) return;
    const info = await lstat(path);
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error(`cannot adopt a non-file, non-directory managed path: ${path}`);
    }
    this.registry.files[path] = await hashPath(path);
    this.registry.kinds ??= {};
    this.registry.kinds[path] = info.isDirectory() ? "directory" : "file";
    this.setOwner(path);
    await this.flush();
  }

  retain(path: string): void {
    this.retained.add(path);
  }

  /** Explicitly retire a native path that would otherwise remain an active,
   * conflicting harness source. Unmanaged paths require --force and are always
   * moved to the backup tree rather than deleted. */
  async retire(path: string, reason: string): Promise<boolean> {
    await this.assertSafeDestination(path);
    if (!(await pathExists(path))) {
      await this.assertNativePrecondition(path, null);
      return true;
    }
    if (!this.options.force) {
      this.retain(path);
      this.skip(path, `${reason}; use --force to back it up and retire it`);
      return false;
    }

    const otherOwners = ownerList(this.registry.owners?.[path]).filter(
      (owner) =>
        owner !== this.options.target &&
        (this.options.activeTargets?.includes(owner) ?? true),
    );
    if (otherOwners.length > 0) {
      this.retain(path);
      this.skip(path, `${reason}; path is also owned by ${otherOwners.join(", ")}`);
      return false;
    }

    this.removed.push(path);
    const observed = await hashPath(path);
    await this.assertNativePrecondition(path, observed);
    if (this.options.dryRun) return true;
    await this.backup(path, observed);
    if (await pathExists(path)) {
      throw new Error(`destination reappeared while retiring managed output: ${path}`);
    }
    delete this.registry.files[path];
    delete this.registry.links[path];
    delete this.registry.kinds?.[path];
    delete this.registry.owners?.[path];
    this.consumeNativePrecondition(path);
    await this.flush();
    return true;
  }

  /** Remove outputs this target owned on the previous projection but did not
   * declare during this one. Changed paths are retained and reported. */
  async finish(): Promise<void> {
    const desired = new Set([
      ...this.written,
      ...this.linked,
      ...this.retained,
    ]);
    const previouslyOwned = ownedPaths(this.registry, this.options.target);
    for (const path of previouslyOwned) {
      if (desired.has(path)) continue;
      const remainingOwners = ownerList(this.registry.owners?.[path]).filter(
        (owner) =>
          owner !== this.options.target &&
          (this.options.activeTargets?.includes(owner) ?? true),
      );
      if (remainingOwners.length > 0) {
        if (!this.options.dryRun) this.registry.owners![path] = remainingOwners;
        continue;
      }
      const existsBeforePrune = await pathExists(path);
      const observedBeforePrune = existsBeforePrune
        ? await hashPath(path)
        : null;
      await this.assertNativePrecondition(path, observedBeforePrune);
      let unchanged = false;
      let expectedHash: string | undefined;
      if (path in this.registry.links) {
        unchanged = await symlinkPointsTo(path, this.registry.links[path]!);
        if (unchanged) {
          expectedHash = await hashPath(path);
          unchanged = await symlinkPointsTo(path, this.registry.links[path]!);
        }
      } else if (path in this.registry.files && (await pathExists(path))) {
        expectedHash = this.registry.files[path]!;
        unchanged = expectedHash === (await hashPath(path));
      } else if (!(await pathExists(path))) {
        unchanged = true;
      }
      if (!unchanged) {
        this.skip(path, "stale managed output changed outside harness-sync; not removed");
        continue;
      }
      this.removed.push(path);
      if (this.options.dryRun) continue;
      if (await pathExists(path)) {
        await this.assertSafeDestination(path);
        await this.backup(path, expectedHash);
        if (await pathExists(path)) {
          throw new Error(`destination reappeared while pruning managed output: ${path}`);
        }
      }
      delete this.registry.files[path];
      delete this.registry.links[path];
      delete this.registry.kinds?.[path];
      delete this.registry.owners?.[path];
      this.consumeNativePrecondition(path);
    }
    await this.flush();
  }

  async text(path: string, value: string): Promise<boolean> {
    await this.assertSafeDestination(path);
    if (!(await this.canReplace(path))) return false;
    const observed = (await pathExists(path)) ? await hashPath(path) : null;
    await this.assertNativePrecondition(path, observed);
    if (!this.acceptObservedHash(path, observed)) return false;
    this.written.push(path);
    if (this.options.dryRun) return true;
    const prepared = this.preparedPath(path);
    await writeTextAtomic(prepared, value);
    const intended = await hashPath(prepared);
    try {
      if (observed !== null) await this.backup(path, observed);
      await this.installPreparedFile(prepared, path);
    } finally {
      await rm(prepared, { recursive: true, force: true });
    }
    if ((await hashPath(path)) !== intended) {
      throw new Error(`managed file changed immediately after installation: ${path}`);
    }
    this.registry.files[path] = intended;
    this.registry.kinds ??= {};
    this.registry.kinds[path] = "file";
    delete this.registry.links[path];
    this.setOwner(path);
    this.consumeNativePrecondition(path);
    await this.flush();
    return true;
  }

  async json(path: string, value: unknown): Promise<boolean> {
    return this.text(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async file(source: string, destination: string): Promise<boolean> {
    if (this.options.linkMode === "symlink") {
      return this.link(source, destination);
    }
    // allowExistingTargetLink: in a symlink→copy switch the destination still
    // resolves to the source, which would otherwise read as the same path.
    await this.assertDistinctSourceAndDestination(source, destination, true);
    await this.assertSafeDestination(destination);
    if (!(await this.canReplace(destination))) return false;
    const wasManagedLink = await this.clearManagedLink(source, destination);
    const observed = !wasManagedLink && (await pathExists(destination))
      ? await hashPath(destination)
      : null;
    await this.assertNativePrecondition(destination, observed);
    if (!this.acceptObservedHash(destination, observed)) return false;
    this.written.push(destination);
    if (this.options.dryRun) return true;
    const prepared = this.preparedPath(destination);
    await copyFileAtomic(source, prepared);
    const intended = await hashPath(prepared);
    try {
      if (observed !== null) await this.backup(destination, observed);
      await this.installPreparedFile(prepared, destination);
    } finally {
      await rm(prepared, { recursive: true, force: true });
    }
    if ((await hashPath(destination)) !== intended) {
      throw new Error(`managed file changed immediately after installation: ${destination}`);
    }
    this.registry.files[destination] = intended;
    this.registry.kinds ??= {};
    this.registry.kinds[destination] = "file";
    delete this.registry.links[destination];
    this.setOwner(destination);
    this.consumeNativePrecondition(destination);
    await this.flush();
    return true;
  }

  async directory(source: string, destination: string): Promise<boolean> {
    if (this.options.linkMode === "symlink") {
      return this.link(source, destination);
    }
    await this.assertDistinctSourceAndDestination(source, destination, true);
    await this.assertSafeDestination(destination);
    if (!(await this.canReplace(destination))) return false;
    const wasManagedLink = await this.clearManagedLink(source, destination);
    const observed = !wasManagedLink && (await pathExists(destination))
      ? await hashPath(destination)
      : null;
    await this.assertNativePrecondition(destination, observed);
    if (!this.acceptObservedHash(destination, observed)) return false;
    this.written.push(destination);
    if (this.options.dryRun) return true;
    const prepared = this.preparedPath(destination);
    await copyTree(source, prepared);
    const intended = await hashPath(prepared);
    try {
      if (observed !== null) await this.backup(destination, observed);
      if (await pathExists(destination)) {
        throw new Error(`destination reappeared during managed directory replacement: ${destination}`);
      }
      await rename(prepared, destination);
    } finally {
      await rm(prepared, { recursive: true, force: true });
    }
    if ((await hashPath(destination)) !== intended) {
      throw new Error(`managed directory changed immediately after installation: ${destination}`);
    }
    this.registry.files[destination] = intended;
    this.registry.kinds ??= {};
    this.registry.kinds[destination] = "directory";
    delete this.registry.links[destination];
    this.setOwner(destination);
    this.consumeNativePrecondition(destination);
    await this.flush();
    return true;
  }

  private async link(source: string, destination: string): Promise<boolean> {
    await this.assertDistinctSourceAndDestination(source, destination, true);
    await this.assertSafeDestination(destination);
    const existed = await pathExists(destination);
    const observed = existed ? await hashPath(destination) : null;
    await this.assertNativePrecondition(destination, observed);
    if (this.options.dryRun) {
      if (existed) {
        const alreadyCorrect = await symlinkPointsTo(destination, source);
        if (!alreadyCorrect && !this.options.force) {
          this.skip(destination, "destination exists and is not a managed link");
          return false;
        }
      }
      this.linked.push(destination);
      return true;
    }

    let result = await ensureRelativeSymlink(source, destination);
    if (result === "occupied") {
      // The occupant is ours when the ledger's recorded hash still matches —
      // a copy→symlink mode change. Backing it up keeps the content recoverable.
      const occupiedHash = await hashPath(destination);
      const ownedCopy = this.registry.files[destination] === occupiedHash;
      if (this.options.force || ownedCopy) {
        await this.assertNativePrecondition(destination, occupiedHash);
        await this.backup(destination, occupiedHash);
        result = await ensureRelativeSymlink(source, destination);
      }
    }
    if (result === "occupied") {
      // Retain it: finish() prunes every owned path it was not told about, so a
      // skipped destination would otherwise be moved into the backup tree.
      this.retain(destination);
      this.skip(destination, "destination exists and is not the expected managed link");
      return false;
    }
    this.linked.push(destination);
    this.registry.links[destination] = source;
    delete this.registry.files[destination];
    delete this.registry.kinds?.[destination];
    this.setOwner(destination);
    if (result === "linked") this.consumeNativePrecondition(destination);
    await this.flush();
    return true;
  }

  private async canReplace(path: string): Promise<boolean> {
    if (!(await pathExists(path))) return true;
    if (this.options.force) return true;
    const prior = this.registry.files[path];
    if (prior && prior === (await hashPath(path))) return true;
    // A projection this writer owns may be re-materialised in the other link
    // mode. Ownership is proven by the ledger, so no --force is needed.
    const priorLink = this.registry.links[path];
    if (priorLink && (await symlinkPointsTo(path, priorLink))) return true;
    this.skip(path, "destination changed outside harness-sync; use import or --force");
    return false;
  }

  /** True when `destination` is the managed symlink this writer previously
   * created for `source` — the shape a symlink→copy mode change has to undo. */
  private async isManagedLinkFor(source: string, destination: string): Promise<boolean> {
    const recorded = this.registry.links[destination];
    if (recorded === undefined) return false;
    if (resolve(recorded) !== resolve(source)) return false;
    return symlinkPointsTo(destination, source);
  }

  /** Clear a managed symlink so the copy writers see an empty destination.
   * Returns true when the destination should be treated as absent. */
  private async clearManagedLink(source: string, destination: string): Promise<boolean> {
    if (!(await this.isManagedLinkFor(source, destination))) return false;
    if (!this.options.dryRun) {
      await rm(destination, { force: true });
      delete this.registry.links[destination];
    }
    return true;
  }

  private acceptObservedHash(path: string, observed: string | null): boolean {
    if (this.options.force || observed === null) return true;
    const prior = this.registry.files[path];
    if (prior === observed) return true;
    this.skip(path, "destination changed while replacement was being prepared");
    return false;
  }

  private preparedPath(path: string): string {
    return join(dirname(path), `.${basename(path)}.${randomUUID()}.prepared`);
  }

  private async installPreparedFile(prepared: string, destination: string): Promise<void> {
    if (await pathExists(destination)) {
      throw new Error(`destination reappeared during managed file replacement: ${destination}`);
    }
    await hardLink(prepared, destination);
    await rm(prepared, { force: true });
  }

  private async assertDistinctSourceAndDestination(
    source: string,
    destination: string,
    allowExistingTargetLink = false,
  ): Promise<void> {
    const sameLexicalPath = resolve(source) === resolve(destination);
    const samePhysicalPath =
      (await resolvePhysicalPath(source)) ===
      (await resolvePhysicalPath(destination));
    if (sameLexicalPath || samePhysicalPath) {
      if (
        !sameLexicalPath &&
        allowExistingTargetLink &&
        (await symlinkPointsTo(destination, source))
      ) {
        return;
      }
      throw new Error(
        `canonical source and native destination are the same path: ${destination}`,
      );
    }
  }

  private skip(path: string, reason: string): void {
    this.skipped.push(path);
    this.warnings.push(`${path}: ${reason}`);
  }

  private setOwner(path: string): void {
    this.registry.owners ??= {};
    const previous = this.registry.owners[path];
    const owners = Array.isArray(previous)
      ? previous
      : previous
        ? [previous]
        : [];
    this.registry.owners[path] = [...new Set([...owners, this.options.target])];
  }

  private async assertSafeDestination(path: string): Promise<void> {
    if (!this.options.allowedRoot) return;
    const root = resolve(this.options.allowedRoot);
    const destination = resolve(path);
    const remainder = relative(root, destination);
    if (remainder === ".." || remainder.startsWith(`..${sep}`)) {
      throw new Error(`projection destination escapes allowed root ${root}: ${destination}`);
    }

    const parentRemainder = relative(root, dirname(destination));
    let current = root;
    for (const component of parentRemainder.split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error(
            `projection destination has a symlink ancestor outside writer control: ${current}`,
          );
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }

  private async assertNativePrecondition(
    path: string,
    observedHash: string | null,
  ): Promise<void> {
    const preconditions = this.options.nativePreconditions;
    if (!preconditions) return;
    const destination = resolve(path);
    if (preconditions.consumed.has(destination)) return;
    const covered = preconditions.roots.some((root) => {
      const remainder = relative(resolve(root), destination);
      return remainder === "" ||
        (remainder !== ".." &&
          !remainder.startsWith(`..${sep}`) &&
          !isAbsolute(remainder));
    });
    if (!covered) return;
    const expected = preconditions.hashes.get(destination) ??
      preconditions.missingHash;
    const observed = observedHash ?? preconditions.missingHash;
    if (observed !== expected) {
      throw new Error(
        `native migration source changed after capture: ${destination}; takeover was not performed`,
      );
    }
    const expectedContent = preconditions.contentHashes.get(destination);
    if (
      expectedContent !== undefined &&
      (await hashNativePath(
        destination,
        preconditions.symlinkContentRoot,
      )) !== expectedContent
    ) {
      throw new Error(
        `native migration source content changed after capture: ${destination}; takeover was not performed`,
      );
    }
  }

  private consumeNativePrecondition(path: string): void {
    this.options.nativePreconditions?.consumed.add(resolve(path));
  }

  private async backup(path: string, expectedHash?: string): Promise<string | null> {
    if (!(await pathExists(path))) return null;
    const sourceInfo = await lstat(path);
    const originalLink = sourceInfo.isSymbolicLink()
      ? await readlink(path)
      : null;
    const resolvedLink = originalLink && !isAbsolute(originalLink)
      ? resolve(dirname(path), originalLink)
      : originalLink;
    const linkType = originalLink
      ? ((await stat(path)).isDirectory() ? "dir" : "file")
      : undefined;
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const destination = join(
      this.options.storeDir,
      "backups",
      stamp,
      this.options.target,
      `${createHash("sha256").update(path).digest("hex").slice(0, 12)}-${randomUUID()}-${basename(path)}`,
    );
    await assertSafeStorePath(this.options.storeDir, destination);
    await mkdir(dirname(destination), { recursive: true });
    await assertSafeStorePath(this.options.storeDir, dirname(destination));
    try {
      await rename(path, destination);
    } catch (error) {
      if (isNodeError(error) && error.code === "EXDEV") {
        throw new Error(
          `cannot safely back up ${path} across filesystems; place the canonical store on the same filesystem or move the path manually`,
        );
      }
      throw error;
    }
    if (expectedHash !== undefined && (await hashPath(destination)) !== expectedHash) {
      if (!(await pathExists(path))) await rename(destination, path);
      throw new Error(`destination changed while it was being backed up: ${path}`);
    }
    if (originalLink && resolvedLink && !isAbsolute(originalLink)) {
      const relocatedLink = relative(dirname(destination), resolvedLink) || ".";
      try {
        await rm(destination, { force: true });
        await symlink(relocatedLink, destination, linkType);
      } catch (error) {
        await rm(destination, { force: true });
        if (!(await pathExists(path))) {
          await symlink(originalLink, path, linkType);
        }
        throw new Error(
          `failed to preserve relative symlink semantics while backing up ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return destination;
  }

  private async flush(): Promise<void> {
    if (this.options.dryRun) return;
    await writeJsonAtomicInside(
      this.options.storeDir,
      this.registryPath,
      this.registry,
    );
  }
}

export async function fingerprintManagedTarget(
  storeDir: string,
  target: TargetName,
): Promise<string> {
  const registryPath = join(storeDir, ".managed.json");
  await assertSafeStorePath(storeDir, registryPath);
  let registry: ManagedRegistry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8")) as ManagedRegistry;
  } catch {
    return hashPaths([]);
  }
  if (registry.schemaVersion !== 1) return hashPaths([]);
  const owned = new Set(
    Object.entries(registry.owners ?? {})
      .filter(([, owner]) =>
        Array.isArray(owner) ? owner.includes(target) : owner === target,
      )
      .map(([path]) => path),
  );
  return hashPaths([...owned]);
}

export async function managedPathsForTarget(
  storeDir: string,
  target: TargetName,
): Promise<string[]> {
  const registry = await readManagedRegistry(storeDir);
  return registry ? ownedPaths(registry, target) : [];
}

/**
 * Return every native path ever recorded by this store, including paths whose
 * target is currently disabled. Fleet registration uses this stricter view so
 * a second controller cannot claim a stale managed destination.
 */
export async function managedPathsForStore(storeDir: string): Promise<string[]> {
  const path = join(storeDir, ".managed.json");
  await assertSafeStorePath(storeDir, path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid managed path registry at ${path}`, { cause: error });
  }
  if (!isManagedRegistryShape(parsed)) {
    throw new Error(`invalid managed path registry at ${path}`);
  }
  const paths = new Set([
    ...Object.keys(parsed.files),
    ...Object.keys(parsed.links),
    ...Object.keys(parsed.owners ?? {}),
  ]);
  for (const nativePath of paths) {
    if (!isAbsolute(nativePath)) {
      throw new Error(
        `invalid non-absolute managed path in ${path}: ${nativePath}`,
      );
    }
  }
  return [...paths].sort();
}

export async function changedManagedPathsForTarget(
  storeDir: string,
  target: TargetName,
): Promise<string[]> {
  const registry = await readManagedRegistry(storeDir);
  if (!registry) return [];
  const changed: string[] = [];
  for (const path of ownedPaths(registry, target)) {
    const expected = registry.files[path];
    if (expected !== undefined && expected !== (await hashPath(path))) {
      changed.push(path);
    }
  }
  return changed.sort();
}

export async function assertManagedTargetStructure(
  storeDir: string,
  target: TargetName,
): Promise<void> {
  const registry = await readManagedRegistry(storeDir);
  if (!registry) return;
  const owned = ownedPaths(registry, target);
  for (const path of owned) {
    if (path in registry.links) {
      const source = registry.links[path]!;
      if (!(await symlinkPointsTo(path, source))) {
        throw new Error(
          `managed link was deleted or replaced: ${path}; run an explicit migration/apply to adopt the structural change`,
        );
      }
      continue;
    }
    if (path in registry.files) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          throw new Error(`managed materialized path became a symlink: ${path}`);
        }
        const expectedKind = registry.kinds?.[path];
        if (
          (expectedKind === "file" && !info.isFile()) ||
          (expectedKind === "directory" && !info.isDirectory())
        ) {
          throw new Error(
            `managed materialized ${expectedKind} was replaced with a different path type: ${path}`,
          );
        }
        if (!expectedKind && !info.isFile() && !info.isDirectory()) {
          throw new Error(`managed materialized path has an unsupported type: ${path}`);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new Error(
            `managed materialized path was deleted: ${path}; canonical deletion must be explicit`,
          );
        }
        throw error;
      }
    }
  }
}

export async function refreshManagedTargetHashes(
  storeDir: string,
  target: TargetName,
): Promise<void> {
  const registry = await readManagedRegistry(storeDir);
  if (!registry) return;
  for (const path of ownedPaths(registry, target)) {
    if (path in registry.files) registry.files[path] = await hashPath(path);
  }
  await writeJsonAtomicInside(
    storeDir,
    join(storeDir, ".managed.json"),
    registry,
  );
}

export async function assertManagedTargetMatchesRegistry(
  storeDir: string,
  target: TargetName,
): Promise<void> {
  const registry = await readManagedRegistry(storeDir);
  if (!registry) return;
  await assertManagedTargetStructure(storeDir, target);
  for (const path of ownedPaths(registry, target)) {
    const expected = registry.files[path];
    if (expected !== undefined && expected !== (await hashPath(path))) {
      throw new Error(`managed output changed during projection: ${path}`);
    }
  }
}

async function readManagedRegistry(storeDir: string): Promise<ManagedRegistry | null> {
  const path = join(storeDir, ".managed.json");
  await assertSafeStorePath(storeDir, path);
  try {
    const registry = JSON.parse(
      await readFile(path, "utf8"),
    ) as ManagedRegistry;
    return registry.schemaVersion === 1 ? registry : null;
  } catch {
    return null;
  }
}

function isManagedRegistryShape(value: unknown): value is ManagedRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 1 &&
    isRecordValue(candidate.files) &&
    isRecordValue(candidate.links) &&
    (candidate.owners === undefined || isRecordValue(candidate.owners));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownedPaths(registry: ManagedRegistry, target: TargetName): string[] {
  return Object.entries(registry.owners ?? {})
    .filter(([, owner]) =>
      Array.isArray(owner) ? owner.includes(target) : owner === target,
    )
    .map(([path]) => path);
}

function ownerList(value: TargetName | TargetName[] | undefined): TargetName[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}
