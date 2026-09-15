import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultHarness,
  loadHarness,
  loadProjectConfig,
  writeHarness,
} from "../src/core/config.js";
import { canonicalArtifactPaths } from "../src/core/artifacts.js";
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
