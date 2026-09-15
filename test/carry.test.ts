import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultHarness,
  loadHarness,
  loadProjectConfig,
  writeHarness,
} from "../src/core/config.js";
import { canonicalArtifactPaths } from "../src/core/artifacts.js";
import { initializeProject, loadProject } from "../src/core/project.js";
import { pathExists } from "../src/core/fs.js";
import {
  captureCarry,
  captureCarrySafely,
  carryLedgerPath,
  readCarryLedger,
  type CarryReport,
} from "../src/core/carry.js";
import {
  assertCarryDestinationSpelling,
  assertCarryEntriesDistinct,
  assertCarryIncludePattern,
  carryIncludeMatches,
  normalizeCarry,
  type CarryEntry,
} from "../src/core/carry-entry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix = "harness-sync-carry-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** `path` follows `name` unless a row overrides it on purpose, so a rename in
 * one of these fixtures cannot accidentally test the path-pinning rule. */
function entry(
  overrides: { [K in keyof CarryEntry]?: CarryEntry[K] | undefined } = {},
): Record<string, unknown> {
  const name = overrides.name ?? "launch-agents";
  return {
    name,
    kind: "directory",
    path: `carry/${name}`,
    destination: "~/Library/LaunchAgents",
    include: ["com.example.*.plist"],
    ...overrides,
  };
}

describe("carry grammar", () => {
  it("refuses every destination spelling that is not ~/-rooted", () => {
    // Each row is a real spelling somebody would reasonably try. `$` is the
    // interesting one: validate.ts's containsNativeEnvironmentTemplate does NOT
    // treat `${env:HOME}` as a template while secret-scan.ts's `(?:env:)?`
    // lookaheads DO, so the same token means two different things to two
    // subsystems. The grammar refuses the character rather than picking a side.
    const refused = [
      "/Users/someone/Library",
      "~someone/Library",
      "~",
      "~/",
      "~/Library/",
      "~/Library/../../etc",
      "~/Library/./Agents",
      "~/Library//Agents",
      "~\\Library",
      "~/${HOME}/x",
      "~/${env:HOME}/x",
      "~/$HOME/x",
      `~/${"a".repeat(256)}`,
      "~/C:/Windows",
      "Library/LaunchAgents",
      "",
    ];
    for (const destination of refused) {
      expect(() => assertCarryDestinationSpelling(destination, "carry x"), destination).toThrow();
    }
  });

  it("accepts an ordinary home-relative destination", () => {
    for (const destination of ["~/Library/LaunchAgents", "~/.local/bin", "~/.gitconfig"]) {
      expect(() => assertCarryDestinationSpelling(destination, "carry x")).not.toThrow();
    }
  });

  it("requires include on a directory and forbids it on a file", () => {
    // CANARY: delete the requirement and the default silently becomes
    // "everything in the directory" — which against the four real destinations
    // means third-party launchd plists and 267 MB of vendor binaries.
    expect(() => normalizeCarry([entry({ include: undefined })])).toThrow(/at least one pattern/u);
    expect(() => normalizeCarry([entry({ include: [] })])).toThrow(/at least one pattern/u);
    expect(() =>
      normalizeCarry([entry({ kind: "file", destination: "~/.gitconfig", include: ["*"] })]),
    ).toThrow(/names one file already/u);
  });

  it("never infers kind from the presence of include", () => {
    // A mistyped `includes:` must be an error, not a directory sweep with no
    // patterns. Both halves: the unknown field throws, and a missing `kind`
    // throws rather than defaulting.
    const mistyped = { ...entry(), includes: ["com.example.*.plist"] };
    expect(() => normalizeCarry([mistyped])).toThrow(/unknown field "includes"/u);
    expect(() => normalizeCarry([entry({ kind: undefined })])).toThrow(/expected "file" or "directory"/u);
  });

  it("refuses an include pattern that can leave the directory", () => {
    for (const pattern of ["**/*.plist", "sub/*.plist", "../x", ".hidden", ""]) {
      expect(() => assertCarryIncludePattern(pattern, "carry x"), pattern).toThrow();
    }
    expect(() => assertCarryIncludePattern("com.example.*.plist", "carry x")).not.toThrow();
  });

  it("treats an include pattern as a glob, never as a regular expression", () => {
    // An include pattern travels in Git, so a store accepted from a remote
    // could otherwise supply a regular expression.
    expect(carryIncludeMatches("com.example.*.plist", "com.example.job.plist")).toBe(true);
    expect(carryIncludeMatches("com.example.*.plist", "com!example!job.plist")).toBe(false);
    expect(carryIncludeMatches("sw?tch", "switch")).toBe(true);
    expect(carryIncludeMatches("sw?tch", "swtch")).toBe(false);
    // `.` is a literal dot, not "any character", and the match is anchored.
    expect(carryIncludeMatches("hcs", "hcs.bak")).toBe(false);
    expect(carryIncludeMatches("hcs", "my-hcs")).toBe(false);
  });

  it("pins path to carry/<name> and rejects unknown fields", () => {
    expect(() => normalizeCarry([entry({ path: "carry/other" })])).toThrow(/expected "carry\/launch-agents"/u);
    expect(() => normalizeCarry([{ ...entry(), scan: false }])).toThrow(/unknown field "scan"/u);
  });

  it("refuses two declarations that could own the same file", () => {
    // Without this the winner is decided by iteration order — the order
    // somebody happened to type the entries in — and the loser's store copy
    // silently stops being updated.
    const nested = normalizeCarry([
      entry({ name: "bin", destination: "~/.local/bin", include: ["switch"] }),
      entry({ name: "local", destination: "~/.local", include: ["*"] }),
    ]);
    expect(() => assertCarryEntriesDistinct(nested)).toThrow(/destinations overlap/u);

    const identical = normalizeCarry([
      entry({ name: "one", destination: "~/.local/bin", include: ["switch"] }),
      entry({ name: "two", destination: "~/.local/bin", include: ["hcs"] }),
    ]);
    expect(() => assertCarryEntriesDistinct(identical)).toThrow(/destinations overlap/u);

    const siblings = normalizeCarry([
      entry({ name: "bin", destination: "~/.local/bin", include: ["switch"] }),
      entry({ name: "share", destination: "~/.local/share", include: ["*"] }),
    ]);
    expect(() => assertCarryEntriesDistinct(siblings)).not.toThrow();
  });

  it("does not sort, so a hand-written order survives a round-trip", () => {
    // Same reason named-files.ts states: sorting would rewrite the canonical
    // bytes of a hand-ordered store on its first load.
    const order = ["zulu", "alpha", "mike"];
    const parsed = normalizeCarry(
      order.map((name) => entry({ name })),
    );
    expect(parsed.map((item) => item.name)).toEqual(order);
  });
});

describe("carry: absent stays absent", () => {
  it("round-trips a harness.yaml that never mentions carry, byte for byte", async () => {
    // TWO CANARIES IN ONE. Add `carry: []` to defaultHarness and the bytes
    // change; make the normalizeHarness spread unconditional and the hash moves
    // — which would charge every existing install a reconcile for a key it
    // never asked for, since state.ts hashes the canonical harness.
    const store = await tempRoot();
    const harnessPath = join(store, "harness.yaml");
    await writeHarness(store, defaultHarness("test"));
    const original = await readFile(harnessPath, "utf8");
    expect(original).not.toContain("carry");

    const loaded = await loadHarness(store);
    expect(loaded.carry).toBeUndefined();

    await writeHarness(store, loaded);
    expect(await readFile(harnessPath, "utf8")).toBe(original);
  });

  it("stays out of canonicalArtifactPaths, so a carried edit is not a canonical change", () => {
    // CANARY for the deliberate omission. hashCanonical fans this list into the
    // pipeline's sole canonical-change signal; a kind that projects to no
    // target must not emit one, or a concurrent native edit is discarded into
    // recordConflict while carry claims the window.
    const harness = defaultHarness("test");
    const withCarry = { ...harness, carry: normalizeCarry([entry()]) };

    expect(canonicalArtifactPaths(withCarry)).toEqual(canonicalArtifactPaths(harness));
    expect(canonicalArtifactPaths(withCarry).some((path) => path.startsWith("carry"))).toBe(false);
  });

  it("round-trips a harness-sync.yaml that never mentions carry", async () => {
    const root = await tempRoot();
    const configPath = join(root, "harness-sync.yaml");
    await writeFile(
      configPath,
      ["schemaVersion: 1", "scope: user", "store: ./store"].join("\n") + "\n",
      "utf8",
    );

    const config = await loadProjectConfig(configPath);

    expect(config.carry).toBeUndefined();
  });

  it("keeps capture off for every truthy spelling that is not the boolean", async () => {
    // Opt-in-to-destructive direction: only a literal `true` enables capture.
    const root = await tempRoot();
    for (const spelling of ['"true"', '"yes"', "1", "1.0", '"on"']) {
      const configPath = join(root, "harness-sync.yaml");
      await writeFile(
        configPath,
        [
          "schemaVersion: 1",
          "scope: user",
          "store: ./store",
          "carry:",
          `  enabled: ${spelling}`,
        ].join("\n") + "\n",
        "utf8",
      );

      const config = await loadProjectConfig(configPath);

      expect(config.carry?.enabled, spelling).toBe(false);
    }
  });

  it("parses carry declarations out of a harness.yaml that has them", async () => {
    const store = await tempRoot();
    const harness = defaultHarness("test");
    await writeHarness(store, {
      ...harness,
      carry: normalizeCarry([entry({ reason: "every schedule on this machine" })]),
    });

    const loaded = await loadHarness(store);

    expect(loaded.carry).toEqual([{
      name: "launch-agents",
      kind: "directory",
      path: "carry/launch-agents",
      destination: "~/Library/LaunchAgents",
      include: ["com.example.*.plist"],
      reason: "every schedule on this machine",
    }]);
  });
});

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * A project scope (so target roots stay inside the fixture), a store with the
 * required .gitignore, and a fake $HOME the test owns outright. Every capture
 * test passes `homeDir` explicitly so nothing can reach the real home.
 */
async function fixture(options: { enabled?: boolean } = {}) {
  const root = await tempRoot("harness-sync-carry-capture-");
  const home = join(root, "home");
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  // The project lives INSIDE the fake home, mirroring the real install where
  // the store sits at ~/.local/share/harness-sync/user. With it outside, the
  // store-overlap and adapter-owned cases are simply unreachable and their
  // tests would pass for the wrong reason.
  const project = await initializeProject(join(home, "project"));
  if (options.enabled !== false) {
    const raw = await readFile(project.configPath, "utf8");
    await writeFile(project.configPath, `${raw}carry:\n  enabled: true\n`, "utf8");
  }
  const reloaded = await loadProject(project.configPath);
  return { root, home, project: reloaded, store: reloaded.storeDir };
}

const PLIST = ["<plist>", "  <key>Label</key>", "  <string>com.example.job</string>", "</plist>"]
  .join("\n");

const DECLARATION: CarryEntry = {
  name: "launch-agents",
  kind: "directory",
  path: "carry/launch-agents",
  destination: "~/Library/LaunchAgents",
  include: ["com.example.*.plist"],
};

function harnessWith(...carry: CarryEntry[]) {
  return { ...defaultHarness("test"), carry };
}

async function destination(home: string, name: string, body = PLIST): Promise<string> {
  const path = join(home, "Library", "LaunchAgents", name);
  await writeFile(path, `${body}\n`, "utf8");
  return path;
}

async function storeCopy(store: string, name: string, body = PLIST): Promise<string> {
  const path = join(store, "carry", "launch-agents", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${body}\n`, "utf8");
  return path;
}

function stateOf(report: CarryReport, file: string): string | undefined {
  return report.files.find((row) => row.file === file)?.state;
}

describe("carry capture truth table", () => {
  // Ten cells, one test each. Testing one row proves nothing about the next:
  // the two mechanisms that make a missing row MISCLASSIFY rather than error —
  // the fixed hash an absent path returns, and a stale ledger entry re-deriving
  // the same wrong answer next run — are both silent.

  it("cell 1 — nothing anywhere: reports absent, writes nothing", async () => {
    const { home, project, store } = await fixture();

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.files).toEqual([]);
    expect(report.captured).toEqual([]);
    expect(await pathExists(join(store, "carry"))).toBe(false);
  });

  it("cell 2 — THE FRESH CLONE: a store copy with no ledger and no destination is never deleted", async () => {
    // The payload, on the machine least able to judge it. An earlier design
    // pruned exactly here, and the ledger is gitignored so EVERY fresh clone
    // starts in this state.
    const { home, project, store } = await fixture();
    const copy = await storeCopy(store, "com.example.only.plist");
    await rm(join(home, "Library", "LaunchAgents"), { recursive: true, force: true });

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(await pathExists(copy)).toBe(true);
    expect(await readFile(copy, "utf8")).toBe(`${PLIST}\n`);
    expect(stateOf(report, "com.example.only.plist")).toBe("store-only");
    expect(await pathExists(join(store, "backups"))).toBe(false);
  });

  it("cell 3 — first capture: destination only, so the store gains a copy", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.captured).toEqual(["carry/launch-agents/com.example.job.plist"]);
    expect(await readFile(join(store, "carry", "launch-agents", "com.example.job.plist"), "utf8"))
      .toBe(`${PLIST}\n`);
  });

  it("cell 4 — two copies, no local record: identical records, different CONFLICTS", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.same.plist");
    await storeCopy(store, "com.example.same.plist");
    await destination(home, "com.example.differs.plist", "<plist>destination</plist>");
    const other = await storeCopy(store, "com.example.differs.plist", "<plist>store</plist>");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(stateOf(report, "com.example.same.plist")).toBe("unchanged");
    expect(stateOf(report, "com.example.differs.plist")).toBe("conflict");
    // Neither side is chosen automatically: the store copy is byte-unchanged.
    expect(await readFile(other, "utf8")).toBe("<plist>store</plist>\n");
    expect(report.captured).toEqual([]);
  });

  it("cell 6 — the destination was deleted on purpose: the store copy stays", async () => {
    // Disabling a launchd schedule by deleting its plist is a normal action.
    // Pruning here would mean disabling a schedule destroys its only backup.
    const { home, project, store } = await fixture();
    const live = await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    await rm(live);

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    const copy = join(store, "carry", "launch-agents", "com.example.job.plist");
    expect(await pathExists(copy)).toBe(true);
    expect(stateOf(report, "com.example.job.plist")).toBe("destination-missing");
  });

  it("cell 7 — a store copy lost to a bad merge is re-captured, not left broken", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    const copy = join(store, "carry", "launch-agents", "com.example.job.plist");
    await rm(copy);

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(await pathExists(copy)).toBe(true);
    expect(report.captured).toEqual(["carry/launch-agents/com.example.job.plist"]);
  });

  it("cell 8a — nothing moved: no write, no capture", async () => {
    const { home, project } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.captured).toEqual([]);
    expect(stateOf(report, "com.example.job.plist")).toBe("unchanged");
  });

  it("cell 8b — the normal path: the user edited the file, the store follows", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    await destination(home, "com.example.job.plist", "<plist>edited</plist>");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.captured).toEqual(["carry/launch-agents/com.example.job.plist"]);
    expect(await readFile(join(store, "carry", "launch-agents", "com.example.job.plist"), "utf8"))
      .toBe("<plist>edited</plist>\n");
  });

  it("cell 8c — another machine's capture arrived: report it, never overwrite it", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    const copy = await storeCopy(store, "com.example.job.plist", "<plist>from machine B</plist>");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(stateOf(report, "com.example.job.plist")).toBe("store-ahead");
    expect(await readFile(copy, "utf8")).toBe("<plist>from machine B</plist>\n");
    expect(report.captured).toEqual([]);
  });

  it("cell 8d — both sides moved: CONFLICT, and neither is written", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    await destination(home, "com.example.job.plist", "<plist>local edit</plist>");
    const copy = await storeCopy(store, "com.example.job.plist", "<plist>remote edit</plist>");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    const row = report.files.find((item) => item.file === "com.example.job.plist");
    expect(row?.state).toBe("conflict");
    expect(row?.destinationHash).not.toBe(row?.storeHash);
    expect(await readFile(copy, "utf8")).toBe("<plist>remote edit</plist>\n");
  });

  it("measures existence rather than hashing it", async () => {
    // CANARY for the sentinel: an absent path hashes to a fixed value, so
    // "destination missing" and "destination changed" are byte-indistinguishable
    // in any naive hash compare. Replace the pathExists checks with one and the
    // two rows below collapse into the same state.
    const { home, project, store } = await fixture();
    await destination(home, "com.example.gone.plist");
    await destination(home, "com.example.edited.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    await rm(join(home, "Library", "LaunchAgents", "com.example.gone.plist"));
    await destination(home, "com.example.edited.plist", "<plist>edited</plist>");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(stateOf(report, "com.example.gone.plist")).toBe("destination-missing");
    expect(stateOf(report, "com.example.edited.plist")).toBe("captured");
    expect(await pathExists(join(store, "carry", "launch-agents", "com.example.gone.plist")))
      .toBe(true);
  });
});

describe("carry never writes outside the store", () => {
  it("THE MOST IMPORTANT TEST: a full capture leaves every destination byte- and inode-identical", async () => {
    // An earlier design routed capture through ManagedWriter. Measured, that
    // adopts the destination and then finish() RENAMES it into <store>/backups/
    // — the destination directory comes back empty. This test is what would
    // have caught it: it compares inodes, not just bytes, so a
    // delete-and-recreate cannot pass either.
    const { home, project, store } = await fixture();
    const agents = join(home, "Library", "LaunchAgents");
    await destination(home, "com.example.one.plist");
    await destination(home, "com.example.two.plist", "<plist>two</plist>");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(join(home, ".local", "bin", "switch"), "#!/bin/sh\necho hi\n", "utf8");
    await chmod(join(home, ".local", "bin", "switch"), 0o755);

    const before = new Map<string, { ino: bigint; mtimeMs: number; body: string }>();
    for (const [dir, name] of [
      [agents, "com.example.one.plist"],
      [agents, "com.example.two.plist"],
      [join(home, ".local", "bin"), "switch"],
    ] as const) {
      const info = await stat(join(dir, name), { bigint: true });
      before.set(join(dir, name), {
        ino: info.ino,
        mtimeMs: Number(info.mtimeMs),
        body: await readFile(join(dir, name), "utf8"),
      });
    }
    const listedBefore = (await readdir(agents)).sort();

    const report = await captureCarry(
      project,
      harnessWith(DECLARATION, {
        name: "local-bin",
        kind: "directory",
        path: "carry/local-bin",
        destination: "~/.local/bin",
        include: ["switch"],
      }),
      { homeDir: home },
    );

    expect(report.captured).toHaveLength(3);
    for (const [path, snapshot] of before) {
      const info = await stat(path, { bigint: true });
      expect(info.ino, path).toBe(snapshot.ino);
      expect(Number(info.mtimeMs), path).toBe(snapshot.mtimeMs);
      expect(await readFile(path, "utf8"), path).toBe(snapshot.body);
    }
    expect((await readdir(agents)).sort()).toEqual(listedBefore);
    // Nothing was created at a destination either, and no backup was taken.
    expect(await pathExists(join(home, ".local", "share"))).toBe(false);
    expect(await pathExists(join(store, "backups"))).toBe(false);
  });

  it("cell 5 — both copies gone: the ledger entry is kept as the last evidence", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    await rm(join(home, "Library", "LaunchAgents", "com.example.job.plist"));
    await rm(join(store, "carry", "launch-agents", "com.example.job.plist"));

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(stateOf(report, "com.example.job.plist")).toBe("absent-here");
    const ledger = await readCarryLedger(store);
    expect(ledger.entries["launch-agents"]?.files["com.example.job.plist"]).toBeTypeOf("string");
  });
});

describe("carry never deletes", () => {
  it("undeclaring an entry leaves the store copy and the destination alone", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    // The declaration is gone from harness.yaml — the shape a prune would fire on.
    const report = await captureCarry(project, defaultHarness("test"), { homeDir: home });

    expect(report.files).toEqual([]);
    expect(await pathExists(join(store, "carry", "launch-agents", "com.example.job.plist")))
      .toBe(true);
    expect(await pathExists(join(home, "Library", "LaunchAgents", "com.example.job.plist")))
      .toBe(true);
  });

  it("narrowing an include list leaves the file already in the store", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.keep.plist");
    await destination(home, "com.example.drop.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    await captureCarry(
      project,
      harnessWith({ ...DECLARATION, include: ["com.example.keep.plist"] }),
      { homeDir: home },
    );

    expect(await pathExists(join(store, "carry", "launch-agents", "com.example.drop.plist")))
      .toBe(true);
  });
});

describe("carry refusals are warnings, never throws", () => {
  it("refuses each bad candidate individually and captures the rest", async () => {
    const { home, project, store } = await fixture();
    const agents = join(home, "Library", "LaunchAgents");
    await destination(home, "com.example.good.plist");
    await symlink(join(agents, "com.example.good.plist"), join(agents, "com.example.link.plist"));
    await writeFile(join(agents, "com.example.big.plist"), "x".repeat(3 * 1024 * 1024), "utf8");
    await writeFile(join(agents, "com.example.binary.plist"), Buffer.from([0x3c, 0x00, 0x3e]));
    await destination(home, "com.example.setuid.plist");
    await chmod(join(agents, "com.example.setuid.plist"), 0o4755);
    await destination(
      home,
      "com.example.secret.plist",
      "<dict>\n  <key>API_TOKEN</key>\n  <string>abcdef0123456789abcdef</string>\n</dict>",
    );

    const report = await captureCarry(
      project,
      harnessWith({ ...DECLARATION, include: ["*"] }),
      { homeDir: home },
    );

    expect(report.captured).toEqual(["carry/launch-agents/com.example.good.plist"]);
    const refused = report.warnings
      .filter((item) => item.code === "carry-file-refused")
      .map((item) => item.message);
    expect(refused).toHaveLength(5);
    expect(refused.join(" ")).toMatch(/symbolic link/u);
    expect(refused.join(" ")).toMatch(/over the .* scan limit/u);
    expect(refused.join(" ")).toMatch(/is binary/u);
    expect(refused.join(" ")).toMatch(/setuid/u);
    expect(refused.join(" ")).toMatch(/unapproved credential/u);
    // None of the refused files entered the store — that is the direction that
    // matters: one bad file must not block every future backup of the store.
    expect((await readdir(join(store, "carry", "launch-agents"))).sort())
      .toEqual(["com.example.good.plist"]);
  });

  it("keeps the previous store copy when a file starts failing the gate", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });
    await writeFile(
      join(home, "Library", "LaunchAgents", "com.example.job.plist"),
      Buffer.from([0x3c, 0x00, 0x3e]),
    );

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.warnings.some((item) => item.code === "carry-file-refused")).toBe(true);
    expect(await readFile(join(store, "carry", "launch-agents", "com.example.job.plist"), "utf8"))
      .toBe(`${PLIST}\n`);
  });

  it("refuses a destination an adapter already owns, and keeps going", async () => {
    const { home, project } = await fixture();
    await destination(home, "com.example.job.plist");
    const claudeRoot = `~/${relative(home, join(project.projectRoot, ".claude"))}`;

    const report = await captureCarry(
      project,
      harnessWith(
        { name: "claude", kind: "directory", path: "carry/claude", destination: claudeRoot,
          include: ["*"] },
        DECLARATION,
      ),
      { homeDir: home },
    );

    expect(report.warnings.some((item) => item.code === "carry-entry-refused")).toBe(true);
    // The refusal is scoped to the one entry; the rest of the harness still runs.
    expect(report.captured).toEqual(["carry/launch-agents/com.example.job.plist"]);
  });

  it("refuses a destination that would make the store carry itself", async () => {
    const { home, project } = await fixture();

    const report = await captureCarry(
      project,
      harnessWith({
        name: "store",
        kind: "directory",
        path: "carry/store",
        destination: `~/${relative(home, project.storeDir)}`,
        include: ["*"],
      }),
      { homeDir: home },
    );

    expect(report.warnings.map((item) => item.message).join(" ")).toMatch(/canonical store/u);
  });

  it("turns any unexpected throw into one warning instead of stopping the pipeline", async () => {
    // Every other guard here is an assert. reconcileOnce's callers treat a
    // throw as a failed reconcile, so without this wrapper one bad carry entry
    // stops ALL synchronisation while the backup timer keeps committing an
    // unchanged store — and the state reads as "nothing changed".
    const { home, project } = await fixture();
    await destination(home, "com.example.job.plist");
    const broken = { ...project, storeDir: join(home, "no", "such", "store") };

    const report = await captureCarrySafely(broken, harnessWith(DECLARATION), { homeDir: home });

    expect(report.warnings.map((item) => item.code)).toContain("carry-capture-failed");
  });
});

describe("carry enablement", () => {
  it("writes nothing and says so when carry.enabled is not true", async () => {
    const { home, project, store } = await fixture({ enabled: false });
    await destination(home, "com.example.job.plist");

    const report = await captureCarry(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.enabled).toBe(false);
    expect(report.captured).toEqual([]);
    expect(await pathExists(join(store, "carry"))).toBe(false);
    expect(await pathExists(carryLedgerPath(store))).toBe(false);
    // Silence here is itself the bug: a user who believes a backup is running
    // and finds out later is worse off than one who was told.
    expect(report.warnings.map((item) => item.code)).toEqual(["carry-capture-disabled"]);
  });

  it("refuses to write a ledger the store would commit", async () => {
    const { home, project, store } = await fixture();
    await destination(home, "com.example.job.plist");
    await writeFile(join(store, ".gitignore"), "/backups/\n", "utf8");

    const report = await captureCarrySafely(project, harnessWith(DECLARATION), { homeDir: home });

    expect(report.warnings.map((item) => item.code)).toContain("carry-capture-failed");
    expect(report.warnings.map((item) => item.message).join(" ")).toMatch(/\/\.local\//u);
  });
});
