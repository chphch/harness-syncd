/**
 * The `carry` command group.
 *
 * Two things every verb here owes. First, the STORE LOCK on anything that
 * writes: `writeHarness` re-stringifies the whole parsed object, so an unlocked
 * verb that read harness.yaml before the daemon installed a captured one writes
 * its own copy back over it — losing the entire native edit, not a line.
 * `acquireLock` is not re-entrant, so no verb here may call another.
 *
 * Second, every measured status comes from `captureCarry({ dryRun: true })`
 * rather than from a second walk of the same states. The truth table has ten
 * cells and the two mechanisms that make a missing one MISCLASSIFY rather than
 * error are silent, so a preview that disagrees with the run it previews would
 * be worse than no preview.
 */

import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { loadHarness, writeHarness, writeProjectConfig } from "./core/config.js";
import { loadProject, type LoadedProject } from "./core/project.js";
import { acquireLock, pathExists } from "./core/fs.js";
import { validateHarness } from "./core/validate.js";
import {
  CARRY_DENY_BASENAMES,
  captureCarry,
  carryLedgerPath,
  readCarryLedger,
  resolveCarryDestination,
} from "./core/carry.js";
import {
  CARRY_STORE_PREFIX,
  assertCarryDestinationSpelling,
  assertCarryIncludePattern,
  carryIncludeMatches,
  normalizeCarry,
  type CarryEntry,
} from "./core/carry-entry.js";

type Print = (value: unknown) => void;

/** `~/`-spell an absolute path, refusing anything that is not under $HOME —
 * the same boundary the grammar enforces, applied at the point the user names
 * a path rather than after they have typed a declaration. */
function homeRelative(absolute: string, homeDir: string): string {
  const remainder = relative(homeDir, absolute);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`) ||
      isAbsolute(remainder)) {
    throw new Error(
      `${absolute} is not inside ${homeDir}; carry only holds paths under the home directory`,
    );
  }
  return `~/${remainder.split(sep).join("/")}`;
}

function suggestName(absolute: string): string {
  const raw = basename(absolute).replace(/^\.+/u, "").replace(/[^A-Za-z0-9._-]+/gu, "-");
  return raw === "" ? "carried" : raw;
}

export function registerCarryCommands(
  program: Command,
  context: { cwd: () => string; print: Print },
): void {
  const { cwd, print } = context;
  const carry = program
    .command("carry")
    .description(
      "keep a copy of files that are not harness configuration — a launchd plist, " +
        "a hand-written CLI, a plugin manifest",
    );

  carry
    .command("add")
    .description("preview (and with --apply, write) a carry declaration for a path")
    .argument("<path>", "file or directory inside the home directory")
    .option("--name <name>", "declaration name; defaults to the path's basename")
    .option(
      "--include <glob>",
      "basename pattern to take from a directory; repeatable, required for a directory",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--exclude <glob>",
      "basename pattern to drop after --include; repeatable",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--apply", "write the declaration into harness.yaml")
    .action(async (path: string, options: {
      name?: string;
      include?: string[];
      exclude?: string[];
      apply?: boolean;
    }) => {
      const project = await loadProject(cwd());
      const homeDir = homedir();
      const absolute = resolve(path);
      if (!(await pathExists(absolute))) throw new Error(`${absolute} does not exist`);
      const destination = homeRelative(absolute, homeDir);
      assertCarryDestinationSpelling(destination, "carry add");

      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`${absolute} is a symbolic link; name the file it points at`);
      }
      const kind = info.isDirectory() ? "directory" : "file";
      const include = options.include ?? [];
      if (kind === "directory" && include.length === 0) {
        throw new Error(
          `${absolute} is a directory, so --include is required. Without it the default ` +
            "would be every file in it. Run with --include '<pattern>' once per pattern.",
        );
      }
      if (kind === "file" && include.length > 0) {
        throw new Error("--include names files inside a directory; this path is a file");
      }
      const exclude = options.exclude ?? [];
      if (kind === "file" && exclude.length > 0) {
        throw new Error("--exclude drops files inside a directory; this path is a file");
      }
      for (const pattern of [...include, ...exclude]) {
        assertCarryIncludePattern(pattern, "carry add");
      }

      const name = options.name ?? suggestName(absolute);
      const entry = normalizeCarry([{
        name,
        kind,
        path: `${CARRY_STORE_PREFIX}/${name}`,
        destination,
        ...(kind === "directory" ? { include } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      }])[0]!;

      // MANDATORY OUTPUT, both halves. The matched list is what gets carried;
      // the unmatched list is how the author learns the directory also holds
      // files owned by somebody else — while they can still act on it.
      const { matched, unmatched } = await previewSelection(entry, absolute, kind);
      const warnings: string[] = [];
      if (include.includes("*")) {
        warnings.push(
          `include is a bare "*", which takes every file in the directory now and every file ` +
            "added to it later. The matched list below is today's answer, not tomorrow's.",
        );
      }
      for (const file of matched) {
        if (CARRY_DENY_BASENAMES.has(file.name.toLowerCase())) {
          warnings.push(`${file.name} is on the never-carried list and will be refused`);
        }
      }

      if (options.apply !== true) {
        print({
          applied: false,
          declaration: entry,
          matched,
          unmatched,
          warnings,
          next: `re-run with --apply to write this into ${join(project.storeDir, "harness.yaml")}`,
        });
        return;
      }

      const release = await acquireLock(join(project.storeDir, ".lock"));
      try {
        const harness = await loadHarness(project.storeDir);
        const existing = harness.carry ?? [];
        if (existing.some((item) => item.name.toLowerCase() === entry.name.toLowerCase())) {
          throw new Error(`carry ${entry.name} is already declared; remove it first`);
        }
        const updated = { ...harness, carry: [...existing, entry] };
        await validateHarness(project.storeDir, updated);
        await writeHarness(project.storeDir, updated);
        print({ applied: true, declaration: entry, matched, unmatched, warnings });
      } finally {
        await release();
      }
    });

  carry
    .command("list")
    .description("show every carry declaration and its MEASURED state on this machine")
    .action(async () => {
      const project = await loadProject(cwd());
      const harness = await loadHarness(project.storeDir);
      const report = await captureCarry(project, harness, { dryRun: true });
      const ledger = await readCarryLedger(project.storeDir);
      const entries = await Promise.all((harness.carry ?? []).map(async (entry) => ({
        name: entry.name,
        kind: entry.kind,
        destination: entry.destination,
        ...(entry.include === undefined ? {} : { include: entry.include }),
        ...(entry.exclude === undefined ? {} : { exclude: entry.exclude }),
        present: await pathExists(resolveCarryDestination(homedir(), entry)),
        lastCaptureAt: ledger.entries[entry.name]?.lastCaptureAt ?? null,
        files: report.files.filter((file) => file.entry === entry.name),
        wouldCapture: report.captured.filter((path) => path.startsWith(`${entry.path}/`)),
      })));
      print({ enabled: report.enabled, entries, warnings: report.warnings });
      if (carryExitCode(report) !== 0) process.exitCode = carryExitCode(report);
    });

  carry
    .command("capture")
    .description("capture the declared carried files now, without a full reconcile")
    .option("--dry-run", "compute every state and write nothing")
    .option(
      "--adopt-destination <name>",
      "resolve a conflict for this declaration by taking the machine's copy",
    )
    .option("--file <basename>", "narrow --adopt-destination to one file")
    .action(async (options: { dryRun?: boolean; adoptDestination?: string; file?: string }) => {
      if (options.file !== undefined && options.adoptDestination === undefined) {
        throw new Error("--file narrows --adopt-destination and requires it");
      }
      const project = await loadProject(cwd());
      const release = options.dryRun === true
        ? null
        : await acquireLock(join(project.storeDir, ".lock"));
      try {
        const harness = await loadHarness(project.storeDir);
        const report = await captureCarry(project, harness, {
          ...(options.dryRun === true ? { dryRun: true } : {}),
          ...(options.adoptDestination === undefined
            ? {}
            : {
              adopt: {
                entry: options.adoptDestination,
                ...(options.file === undefined ? {} : { file: options.file }),
              },
            }),
        });
        print(report);
        if (carryExitCode(report) !== 0) process.exitCode = carryExitCode(report);
      } finally {
        if (release) await release();
      }
    });

  carry
    .command("remove")
    .description("drop a carry declaration")
    .argument("<name>", "declaration name")
    .option(
      "--delete-store-copy",
      "also delete the copies under carry/<name>/ — they may be the only ones left",
    )
    .action(async (name: string, options: { deleteStoreCopy?: boolean }) => {
      const project = await loadProject(cwd());
      const release = await acquireLock(join(project.storeDir, ".lock"));
      try {
        const harness = await loadHarness(project.storeDir);
        const existing = harness.carry ?? [];
        const entry = existing.find((item) => item.name === name);
        if (!entry) throw new Error(`carry ${name} is not declared`);
        const remaining = existing.filter((item) => item.name !== name);
        const updated = remaining.length === 0
          ? stripCarry(harness)
          : { ...harness, carry: remaining };
        await validateHarness(project.storeDir, updated);
        await writeHarness(project.storeDir, updated);

        const storeDirectory = join(project.storeDir, entry.path);
        if (options.deleteStoreCopy !== true) {
          print({
            removed: name,
            storeCopyKept: storeDirectory,
            note:
              "the copies under this directory were NOT deleted; they may be the only ones " +
              "left. Re-run with --delete-store-copy once you have confirmed otherwise.",
          });
          return;
        }
        const { rm } = await import("node:fs/promises");
        await rm(storeDirectory, { recursive: true, force: true });
        print({ removed: name, storeCopyDeleted: storeDirectory });
      } finally {
        await release();
      }
    });

  for (const [verb, value] of [["enable", true], ["disable", false]] as const) {
    carry
      .command(verb)
      .description(`${verb} carry capture on THIS machine`)
      .action(async () => {
        const project = await loadProject(cwd());
        const release = await acquireLock(join(project.storeDir, ".lock"));
        try {
          // A verb rather than a hand edit, because `enabled: "true"` in YAML
          // is a string and leaves capture silently off.
          const config = { ...project.config, carry: { enabled: value } };
          await writeProjectConfig(project.configPath, config);
          print({ carry: { enabled: value }, machineLocal: project.configPath });
        } finally {
          await release();
        }
      });
  }
}

function stripCarry(harness: Awaited<ReturnType<typeof loadHarness>>) {
  const { carry: _dropped, ...rest } = harness;
  return rest as typeof harness;
}

/** Exit 2 only on ACTUAL failures. A legitimately disabled second machine
 * reports `enabled: false` in the output without failing — otherwise every
 * second machine fails forever and the signal stops meaning anything. */
export function carryExitCode(report: CarryReportLike): number {
  const failing = report.files.some((file) => file.state === "conflict");
  const refused = report.warnings.some((item) =>
    item.code === "carry-entry-refused" ||
    item.code === "carry-file-refused" ||
    item.code === "carry-capture-failed");
  return failing || refused ? 2 : 0;
}

interface CarryReportLike {
  files: Array<{ state: string }>;
  warnings: Array<{ code: string }>;
}

async function previewSelection(
  entry: CarryEntry,
  absolute: string,
  kind: "file" | "directory",
): Promise<{
  matched: Array<{ name: string; bytes: number; mode: string }>;
  unmatched: string[];
}> {
  if (kind === "file") {
    const info = await stat(absolute);
    return {
      matched: [{
        name: basename(absolute),
        bytes: info.size,
        mode: (info.mode & 0o7777).toString(8).padStart(4, "0"),
      }],
      unmatched: [],
    };
  }
  const matched: Array<{ name: string; bytes: number; mode: string }> = [];
  const unmatched: string[] = [];
  for (const child of await readdir(absolute, { withFileTypes: true })) {
    if (child.isDirectory()) {
      unmatched.push(`${child.name}/ (a directory; carry takes immediate files only)`);
      continue;
    }
    if (!(entry.include ?? []).some((pattern) => carryIncludeMatches(pattern, child.name))) {
      unmatched.push(child.name);
      continue;
    }
    if ((entry.exclude ?? []).some((pattern) => carryIncludeMatches(pattern, child.name))) {
      unmatched.push(`${child.name} (excluded)`);
      continue;
    }
    const info = await lstat(join(absolute, child.name));
    matched.push({
      name: child.name,
      bytes: info.size,
      mode: (info.mode & 0o7777).toString(8).padStart(4, "0"),
    });
  }
  return {
    matched: matched.sort((left, right) => left.name.localeCompare(right.name)),
    unmatched: unmatched.sort(),
  };
}

/** The `status` and `doctor` blocks, sharing the same measured report. */
export async function carrySummary(project: LoadedProject): Promise<unknown> {
  const harness = await loadHarness(project.storeDir);
  const declared = harness.carry ?? [];
  if (declared.length === 0) return { declared: 0 };
  const report = await captureCarry(project, harness, { dryRun: true });
  let bytes = 0;
  for (const entry of declared) {
    const directory = join(project.storeDir, entry.path);
    if (!(await pathExists(directory))) continue;
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.isFile()) bytes += (await lstat(join(directory, child.name))).size;
    }
  }
  return {
    declared: declared.length,
    // Silence here is itself the bug: a user who believes a backup is running
    // and finds out later is worse off than one who was told every time.
    enabled: report.enabled,
    storeBytes: bytes,
    ledger: carryLedgerPath(project.storeDir),
    states: countBy(report.files.map((file) => file.state)),
    warnings: report.warnings,
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
