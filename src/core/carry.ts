/**
 * Capture for the `carry` kind: ordinary files the store keeps a copy of
 * because keeping them beside the harness is convenient.
 *
 * ONE PROPERTY GOVERNS THIS WHOLE FILE — **carry never writes outside the
 * store, and never deletes anything anywhere.** A carried file is frequently
 * the only copy of itself, and the machine best placed to judge that is not the
 * one running the capture. So there is no restore direction, no `mkdir` outside
 * `storeDir`, no `unlink`, no `rename`, and no participation in `.managed.json`.
 *
 * That last one is not a style preference. `ManagedWriter.adopt()` looks like
 * exactly the primitive a capture needs — right up until `finish()`, which
 * builds its desired set from what was written and linked, finds a
 * capture-only writer's set empty, and RENAMES the adopted destination into
 * `<store>/backups/`. Measured. The defence is that this module imports one
 * symbol from writer.ts and it is a reader.
 *
 * The ledger that replaces `.managed.json` lives at
 * `<store>/.local/carry/ledger.json`, which is machine-local: `/.local/` is one
 * of the required .gitignore lines and is excluded from the secret scan.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { AdapterWarning, CanonicalHarness } from "../types.js";
import { TARGET_NAMES } from "../types.js";
import { getAdapter } from "../adapters/index.js";
import { resolveTargetRoot } from "./config.js";
import { adapterContext, type LoadedProject } from "./project.js";
import { managedPathsForStore } from "./writer.js";
import {
  copyFileAtomicInside,
  hashPath,
  isNodeError,
  pathExists,
  readTextIfExists,
  resolveInside,
  resolvePathClaims,
  resolvePhysicalPath,
  writeJsonAtomicInside,
} from "./fs.js";
import { MAX_SCANNED_FILE_BYTES, scanTextForSecrets } from "./secret-scan.js";
import { partitionByAllowlist } from "./secret-allowlist.js";
import { carryIncludeMatches, type CarryEntry } from "./carry-entry.js";

/** Basenames never carried, whatever an include pattern says. Checked against
 * every SELECTED CHILD rather than against the declared directory: the deny
 * list is what makes `include: ["*"]` survivable, and a list bound to the
 * directory never sees what the glob actually swept up. The secret scan is a
 * weak backstop for exactly this — measured, `{"api_token": "abcdef0123456789abcdef"}`
 * produces zero findings, because the scanner's quoted alternative requires the
 * whole quoted token to be a bare field name. */
export const CARRY_DENY_BASENAMES: ReadonlySet<string> = new Set([
  ".credentials.json",
  ".env",
  ".envrc",
  ".htpasswd",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "token.json",
]);

const LEDGER_RELATIVE = join(".local", "carry", "ledger.json");
const REQUIRED_IGNORE_LINE = "/.local/";

/** What the DESTINATION hashed to at this machine's last successful capture.
 * Machine-local by construction: a fresh clone has none, which is what makes
 * truth-table cell 2 — store copy present, nothing here — reachable and
 * reportable instead of silently mistaken for a deletion. */
export interface CarryLedger {
  schemaVersion: 1;
  entries: Record<string, { lastCaptureAt: string; files: Record<string, string> }>;
}

export type CarryFileState =
  | "captured"
  | "unchanged"
  | "absent-here"
  | "store-only"
  | "destination-missing"
  | "store-ahead"
  | "conflict";

export interface CarryFileReport {
  entry: string;
  file: string;
  state: CarryFileState;
  destinationHash?: string;
  storeHash?: string;
}

export interface CarryReport {
  enabled: boolean;
  /** True when nothing was written. `captured` then lists what WOULD be
   * captured — the states are computed by the same code either way, so a
   * preview cannot disagree with the run it previews. */
  dryRun: boolean;
  captured: string[];
  files: CarryFileReport[];
  warnings: AdapterWarning[];
}

export interface CaptureCarryOptions {
  homeDir?: string;
  /** Compute every state and write nothing. What `carry list`, `status` and
   * `doctor` use, so none of them owns a second copy of the truth table. */
  dryRun?: boolean;
  /** Resolve a conflict (cells 4 and 8d) or a store-ahead (8c) by taking the
   * destination. Explicit and per-entry, because any automatic choice here
   * silently discards one of two divergent versions. */
  adopt?: { entry: string; file?: string };
}

function warn(code: string, message: string, path?: string): AdapterWarning {
  return { code, message, ...(path === undefined ? {} : { path }) };
}

// ── the ledger ───────────────────────────────────────────────────────────────

export function carryLedgerPath(storeDir: string): string {
  return resolveInside(storeDir, LEDGER_RELATIVE);
}

export async function readCarryLedger(storeDir: string): Promise<CarryLedger> {
  const raw = await readTextIfExists(carryLedgerPath(storeDir));
  if (raw === null) return { schemaVersion: 1, entries: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return { schemaVersion: 1, entries: {} };
    }
    const entries = (parsed as { entries?: unknown }).entries;
    if (typeof entries !== "object" || entries === null) {
      return { schemaVersion: 1, entries: {} };
    }
    return { schemaVersion: 1, entries: entries as CarryLedger["entries"] };
  } catch {
    // A corrupt ledger must degrade to "this machine has no record", which is
    // cell 2/4 — report, never delete. Throwing here would instead stop capture
    // for every entry.
    return { schemaVersion: 1, entries: {} };
  }
}

/**
 * The ledger records which files this machine has captured, so shipping it to
 * another machine would ship one machine's authority to all of them. That it
 * stays local is an ASSUMPTION until something measures it: `initializeProject`
 * writes the required .gitignore lines once and `loadProject` never re-checks.
 */
export async function assertCarryLedgerIsGitIgnored(storeDir: string): Promise<void> {
  const ignore = (await readTextIfExists(join(storeDir, ".gitignore"))) ?? "";
  const lines = new Set(ignore.split(/\r?\n/u).map((line) => line.trim()));
  if (!lines.has(REQUIRED_IGNORE_LINE)) {
    throw new Error(
      `${join(storeDir, ".gitignore")} is missing the ${REQUIRED_IGNORE_LINE} line, so the ` +
        "machine-local carry ledger would be committed and travel to every other machine. " +
        "Add that line before enabling carry.",
    );
  }
}

export async function writeCarryLedger(storeDir: string, ledger: CarryLedger): Promise<void> {
  await assertCarryLedgerIsGitIgnored(storeDir);
  await writeJsonAtomicInside(storeDir, carryLedgerPath(storeDir), ledger);
}

// ── destination guards ───────────────────────────────────────────────────────

/** The SOLE producer of an absolute carried path, mirroring `resolveTargetRoot`.
 * No other module may join a destination onto a base. */
export function resolveCarryDestination(homeDir: string, entry: CarryEntry): string {
  return join(homeDir, entry.destination.slice(2));
}

function overlaps(left: string, right: string): boolean {
  const contained = (value: string) =>
    value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return contained(relative(left, right)) || contained(relative(right, left));
}

/**
 * Physical containment in $HOME, not lexical. A symlinked `~/Library` pointing
 * at another volume turns a lexically-fine `Library/x` into a read outside the
 * home directory.
 *
 * Note this is deliberately LOOSER than `ManagedWriter.assertSafeDestination`,
 * which refuses any symlinked ancestor at all. It can afford to be: carry only
 * ever READS a destination. Since carry no longer routes through ManagedWriter,
 * this is the only containment policy that applies to a carried path.
 */
async function assertCarryDestinationContained(
  absolute: string,
  homeDir: string,
  label: string,
): Promise<void> {
  const [realHome, realDestination] = await Promise.all([
    resolvePhysicalPath(homeDir),
    resolvePhysicalPath(absolute),
  ]);
  const remainder = relative(realHome, realDestination);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`) ||
      isAbsolute(remainder)) {
    throw new Error(
      `${label} resolves outside the home directory: ${realDestination}`,
    );
  }
}

/** The store must not carry itself. This user's store lives at
 * `~/.local/share/harness-sync/user`, so a destination of `~/.local` would make
 * every capture grow the store. `assertSafeProjectTopology` does not close
 * this: it inspects only the watched leaves of ENABLED targets. */
async function assertCarryDestinationNotStore(
  absolute: string,
  project: LoadedProject,
  label: string,
): Promise<void> {
  const [destination, store, config] = await Promise.all([
    resolvePhysicalPath(absolute),
    resolvePhysicalPath(project.storeDir),
    resolvePhysicalPath(project.configPath),
  ]);
  for (const [other, what] of [[store, "canonical store"], [config, "controller"]] as const) {
    if (overlaps(destination, other)) {
      throw new Error(`${label} overlaps the ${what} at ${other}`);
    }
  }
}

/**
 * Derived, never hardcoded: every target root and every path an adapter watches
 * or projects hook scripts into, for all three targets whether enabled or not.
 *
 * This is what keeps the `~/.claude/plugins` case honest. That directory sits
 * inside a target root but no adapter claims it, so it is carryable — and the
 * day an adapter does claim it, this guard starts refusing it automatically
 * rather than silently letting two owners write one path.
 */
async function assertCarryDestinationNotAdapterOwned(
  absolute: string,
  project: LoadedProject,
  label: string,
): Promise<void> {
  const destination = await resolvePhysicalPath(absolute);
  for (const target of TARGET_NAMES) {
    const root = resolveTargetRoot(project.configPath, project.config, target);
    if (destination === (await resolvePhysicalPath(root))) {
      throw new Error(`${label} is the ${target} target root ${root}`);
    }
    const context = adapterContext(project, target);
    const adapter = getAdapter(target);
    const layout = adapter.hookScripts(context);
    const claimed = [
      ...adapter.watchPaths(context),
      ...(layout === null ? [] : [layout.dir]),
    ];
    for (const claim of claimed) {
      if (overlaps(destination, await resolvePhysicalPath(claim))) {
        throw new Error(`${label} overlaps ${target}'s ${claim}`);
      }
    }
  }
}

/** Compared through `resolvePathClaims`, not by string equality: a managed
 * projection may be reached through a symlink, and a DISABLED target's claims
 * count too — that inclusion is deliberate in `managedPathsForStore`. This is
 * a READ of `.managed.json`; carry never writes it. */
async function assertCarryDestinationNotLedgerClaimed(
  absolute: string,
  project: LoadedProject,
  label: string,
): Promise<void> {
  const managed = await managedPathsForStore(project.storeDir);
  if (managed.length === 0) return;
  const candidateClaims = new Set(await resolvePathClaims(absolute));
  for (const path of managed) {
    for (const claim of await resolvePathClaims(path)) {
      if (candidateClaims.has(claim) || overlaps(claim, absolute)) {
        throw new Error(`${label} is already a managed projection: ${path}`);
      }
    }
  }
}

export async function assertCarryDestination(
  entry: CarryEntry,
  project: LoadedProject,
  homeDir: string = homedir(),
): Promise<string> {
  const absolute = resolveCarryDestination(homeDir, entry);
  const label = `carry ${entry.name} destination ${entry.destination}`;
  await assertCarryDestinationContained(absolute, homeDir, label);
  await assertCarryDestinationNotStore(absolute, project, label);
  await assertCarryDestinationNotAdapterOwned(absolute, project, label);
  await assertCarryDestinationNotLedgerClaimed(absolute, project, label);
  return absolute;
}

// ── the per-file gate ────────────────────────────────────────────────────────

/**
 * Run BEFORE the copy, never after. A file that fails here is refused INTO the
 * store with one warning, and its previous store copy and ledger entry are left
 * exactly as they were.
 *
 * The direction matters more than the checks. `carry/` is scanned by
 * `scanStoreForSecrets`, `backupCanonicalStore` hardcodes `allowSecrets: false`,
 * the daemon's timer cannot pass `--allow-secrets`, and the daemon swallows the
 * throw — so ONE bad file entering the store would block every future backup of
 * the whole store, with nothing but a log line to say so. A structural finding
 * (oversized, binary) is worse: an allowlist entry naming one is itself refused,
 * so it could not be approved at all.
 */
export async function assertCarryCandidate(
  absoluteSource: string,
  storeRelativePath: string,
  allowlist: Parameters<typeof partitionByAllowlist>[1],
): Promise<void> {
  const name = basename(absoluteSource);
  const info = await lstat(absoluteSource);

  // A per-file copy DEREFERENCES a symlink, so carrying one silently captures
  // whatever it points at. `~/.local/bin` holds four symlinks into version
  // stores beside the four real CLIs.
  if (info.isSymbolicLink()) throw new Error(`${name} is a symbolic link`);
  if (!info.isFile()) throw new Error(`${name} is not a regular file`);

  if (CARRY_DENY_BASENAMES.has(name.toLowerCase())) {
    throw new Error(`${name} is on the never-carried list`);
  }

  // Measured: fs.copyFile of a 4755 source yields 0755, and the content hash
  // records only `executable=<bool>` — so both sides hash EQUAL and nothing
  // downstream would ever notice that the bit was dropped. Refuse rather than
  // carry a copy that silently is not the file.
  if ((info.mode & 0o7000) !== 0) {
    throw new Error(`${name} carries a setuid, setgid or sticky bit that a copy cannot preserve`);
  }
  if (info.size > MAX_SCANNED_FILE_BYTES) {
    throw new Error(
      `${name} is ${info.size} bytes, over the ${MAX_SCANNED_FILE_BYTES}-byte scan limit`,
    );
  }

  const bytes = await readFile(absoluteSource);
  if (bytes.includes(0)) throw new Error(`${name} is binary`);

  const findings = scanTextForSecrets(storeRelativePath, bytes.toString("utf8"));
  const partition = partitionByAllowlist(findings, allowlist ?? []);
  if (partition.blocking.length > 0) {
    throw new Error(
      `${name} would enter the store with an unapproved credential: ${partition.blocking
        .map((finding) => `${finding.rule} at line ${finding.line}`)
        .join(", ")}`,
    );
  }
}

// ── capture ──────────────────────────────────────────────────────────────────

interface CaptureCandidate {
  file: string;
  absolute: string;
  storePath: string;
  storeRelative: string;
}

async function selectCandidates(
  entry: CarryEntry,
  destination: string,
  storeDir: string,
): Promise<CaptureCandidate[]> {
  const make = (file: string, absolute: string): CaptureCandidate => {
    const storeRelative = `${entry.path}/${file}`;
    return { file, absolute, storePath: resolveInside(storeDir, storeRelative), storeRelative };
  };
  if (entry.kind === "file") {
    return [make(basename(destination), destination)];
  }
  let children;
  try {
    children = await readdir(destination, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return children
    .filter((child) => !child.isDirectory())
    .filter((child) => (entry.include ?? []).some((p) => carryIncludeMatches(p, child.name)))
    .map((child) => make(child.name, join(destination, child.name)))
    .sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * The truth table, and nothing else. Axes are (ledger record L, destination D,
 * store copy S); existence is always MEASURED with `pathExists` and never
 * inferred from a hash, because an absent path hashes to a fixed sentinel and
 * "missing" is therefore byte-indistinguishable from "changed".
 *
 * Nothing in here writes or deletes outside `storeDir`, and nothing deletes at
 * all. Every state that is not "the destination is newer" is a report.
 */
export async function captureCarry(
  project: LoadedProject,
  harness: CanonicalHarness,
  options: CaptureCarryOptions = {},
): Promise<CarryReport> {
  const dryRun = options.dryRun === true;
  const report: CarryReport = {
    enabled: false, dryRun, captured: [], files: [], warnings: [],
  };
  const entries = harness.carry ?? [];
  if (entries.length === 0) return report;

  if (project.config.carry?.enabled !== true) {
    // Warn, never silence. A user who believes a backup is running and finds
    // out otherwise later is worse off than one who was told on every tick.
    report.warnings.push(warn(
      "carry-capture-disabled",
      `${entries.length} carry ${entries.length === 1 ? "entry is" : "entries are"} declared ` +
        "but carry.enabled is not true in harness-sync.yaml, so nothing on this machine is " +
        "being captured.",
    ));
    return report;
  }
  report.enabled = true;

  const homeDir = options.homeDir ?? homedir();
  const allowlist = harness.secretAllowlist ?? [];
  const ledger = await readCarryLedger(project.storeDir);
  let ledgerChanged = false;

  for (const entry of entries) {
    let destination: string;
    try {
      destination = await assertCarryDestination(entry, project, homeDir);
    } catch (error) {
      report.warnings.push(warn(
        "carry-entry-refused",
        `carry ${entry.name} was refused: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }

    const recorded = ledger.entries[entry.name]?.files ?? {};
    const files: Record<string, string> = { ...recorded };
    let entryChanged = false;

    let candidates: CaptureCandidate[];
    try {
      candidates = await selectCandidates(entry, destination, project.storeDir);
    } catch (error) {
      report.warnings.push(warn(
        "carry-entry-refused",
        `carry ${entry.name} could not be read: ` +
          (error instanceof Error ? error.message : String(error)),
      ));
      continue;
    }

    // Cells 2, 5 and 6 are reached through the STORE and the LEDGER, not
    // through the destination — a file that is not here cannot be a candidate.
    const seen = new Set(candidates.map((candidate) => candidate.file));
    const known = new Set([...Object.keys(recorded), ...(await listStoreCopies(project.storeDir, entry))]);
    for (const file of [...known].sort()) {
      if (seen.has(file)) continue;
      const storeRelative = `${entry.path}/${file}`;
      const hasStore = await pathExists(resolveInside(project.storeDir, storeRelative));
      const hasLedger = Object.hasOwn(recorded, file);
      // Cell 2 — the payload, on the machine least able to judge it. Cell 6 —
      // a destination deleted on purpose, which is a normal user action; a
      // prune here would mean disabling a launchd schedule destroys its backup.
      // Cell 5 — both gone, and the ledger entry is the last evidence it
      // existed, so it is kept rather than cleared.
      const state: CarryFileState = hasStore
        ? (hasLedger ? "destination-missing" : "store-only")
        : "absent-here";
      report.files.push({ entry: entry.name, file, state });
    }

    for (const candidate of candidates) {
      try {
        await assertCarryCandidate(candidate.absolute, candidate.storeRelative, allowlist);
      } catch (error) {
        // The store keeps its last good copy. The opposite direction — letting
        // the file in and refusing every later backup — trades one file for the
        // whole store.
        report.warnings.push(warn(
          "carry-file-refused",
          `carry ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          candidate.absolute,
        ));
        continue;
      }

      const destinationHash = await hashPath(candidate.absolute);
      const hasStore = await pathExists(candidate.storePath);
      const storeHash = hasStore ? await hashPath(candidate.storePath) : undefined;
      const recordedHash = recorded[candidate.file];

      const adopting = options.adopt !== undefined &&
        options.adopt.entry === entry.name &&
        (options.adopt.file === undefined || options.adopt.file === candidate.file);

      const capture = async (): Promise<void> => {
        if (!dryRun) {
          await copyFileAtomicInside(project.storeDir, candidate.absolute, candidate.storePath);
          files[candidate.file] = destinationHash;
          entryChanged = true;
        }
        report.captured.push(candidate.storeRelative);
        report.files.push({ entry: entry.name, file: candidate.file, state: "captured" });
      };

      if (!hasStore) {
        // Cells 3 and 7. The destination is the source of truth for this kind,
        // and an absent store copy has nothing to conflict with — which is what
        // makes an accidental store-side deletion self-healing instead of
        // sticky.
        await capture();
        continue;
      }
      if (recordedHash === undefined) {
        // Cell 4 — two copies, no local record. Equal means just record it;
        // different means write nothing in either direction.
        if (storeHash === destinationHash) {
          if (!dryRun) {
            files[candidate.file] = destinationHash;
            entryChanged = true;
          }
          report.files.push({ entry: entry.name, file: candidate.file, state: "unchanged" });
        } else if (adopting) {
          await capture();
        } else {
          report.files.push({
            entry: entry.name,
            file: candidate.file,
            state: "conflict",
            destinationHash,
            ...(storeHash === undefined ? {} : { storeHash }),
          });
        }
        continue;
      }
      const destinationMoved = destinationHash !== recordedHash;
      const storeMoved = storeHash !== recordedHash;
      if (!destinationMoved && !storeMoved) {
        report.files.push({ entry: entry.name, file: candidate.file, state: "unchanged" });
      } else if (destinationMoved && !storeMoved) {
        await capture(); // Cell 8b — the normal path.
      } else if (adopting) {
        await capture();
      } else if (!destinationMoved && storeMoved) {
        // Cell 8c — another machine's capture arrived. There is no restore
        // direction, and overwriting here would silently discard it.
        report.files.push({
          entry: entry.name,
          file: candidate.file,
          state: "store-ahead",
          destinationHash,
          ...(storeHash === undefined ? {} : { storeHash }),
        });
      } else {
        report.files.push({
          entry: entry.name,
          file: candidate.file,
          state: "conflict",
          destinationHash,
          ...(storeHash === undefined ? {} : { storeHash }),
        });
      }
    }

    if (entryChanged) {
      ledger.entries[entry.name] = { lastCaptureAt: new Date().toISOString(), files };
      ledgerChanged = true;
    }
  }

  if (ledgerChanged) await writeCarryLedger(project.storeDir, ledger);
  return report;
}

/** The store side of cells 2 and 6: a file present in `carry/<name>/` that the
 * destination no longer offers. Read-only. */
async function listStoreCopies(storeDir: string, entry: CarryEntry): Promise<string[]> {
  try {
    const children = await readdir(resolveInside(storeDir, entry.path), { withFileTypes: true });
    return children.filter((child) => child.isFile()).map((child) => child.name);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * The total wrapper the pipeline calls. Every other guard in this file is an
 * `assert*` that throws, and `reconcileOnce`'s callers treat a throw as a failed
 * reconcile — so one bad carry entry would stop ALL synchronisation while the
 * backup timer kept committing an unchanged store, and the state would read as
 * "nothing changed". Converting any throw into one warning is what keeps a
 * carry problem a carry problem.
 */
export async function captureCarrySafely(
  project: LoadedProject,
  harness: CanonicalHarness,
  options: CaptureCarryOptions = {},
): Promise<CarryReport> {
  try {
    return await captureCarry(project, harness, options);
  } catch (error) {
    return {
      enabled: false,
      dryRun: options.dryRun === true,
      captured: [],
      files: [],
      warnings: [warn(
        "carry-capture-failed",
        `carry capture failed and was skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )],
    };
  }
}
