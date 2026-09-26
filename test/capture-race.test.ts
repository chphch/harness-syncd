import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHarness, writeHarness } from "../src/core/config.js";
import { migrateFrom } from "../src/core/migrate.js";
import { initializeProject, type LoadedProject } from "../src/core/project.js";
import { reconcileOnce } from "../src/core/reconcile.js";
import { readState } from "../src/core/state.js";
import { refreshManagedTargetHashes } from "../src/core/writer.js";

/**
 * One-shot hooks at the seams of an inverse capture, so a native or canonical
 * write can land at the exact moment a concurrent editor's write did. Each hook
 * runs once and disarms itself.
 */
const hooks = vi.hoisted(() => ({
  afterApply: null as null | (() => Promise<void>),
  afterClearLocalBase: null as null | (() => Promise<void>),
  beforeRefresh: null as null | (() => Promise<void>),
  beforeSnapshot: null as null | (() => Promise<void>),
}));

async function fire(name: keyof typeof hooks): Promise<void> {
  const hook = hooks[name];
  hooks[name] = null;
  if (hook) await hook();
}

vi.mock("../src/core/project.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/project.js")>();
  return {
    ...actual,
    applyHarness: async (...args: Parameters<typeof actual.applyHarness>) => {
      const results = await actual.applyHarness(...args);
      await fire("afterApply");
      return results;
    },
  };
});

vi.mock("../src/core/local-base.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/local-base.js")>();
  return {
    ...actual,
    clearPreservedLocalBase: async (
      ...args: Parameters<typeof actual.clearPreservedLocalBase>
    ) => {
      await actual.clearPreservedLocalBase(...args);
      await fire("afterClearLocalBase");
    },
  };
});

vi.mock("../src/core/writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/writer.js")>();
  return {
    ...actual,
    // First called by snapshotState, after every checkpoint is written.
    assertManagedTargetMatchesRegistry: async (
      ...args: Parameters<typeof actual.assertManagedTargetMatchesRegistry>
    ) => {
      await fire("beforeSnapshot");
      return actual.assertManagedTargetMatchesRegistry(...args);
    },
    refreshManagedTargetHashes: async (
      ...args: Parameters<typeof actual.refreshManagedTargetHashes>
    ) => {
      await fire("beforeRefresh");
      return actual.refreshManagedTargetHashes(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  hooks.afterApply = null;
  hooks.afterClearLocalBase = null;
  hooks.beforeRefresh = null;
  hooks.beforeSnapshot = null;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A project whose Claude settings.json is a materialized managed file — the
 * shape of the hook script a session was editing on 2026-09-16. */
async function fixture(
  settings: unknown,
  linkMode: "symlink" | "copy" = "symlink",
): Promise<{ project: LoadedProject; settingsPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-capture-race-"));
  roots.push(root);
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
  const settingsPath = join(root, ".claude", "settings.json");
  await writeFile(settingsPath, JSON.stringify(settings), "utf8");
  const project = await initializeProject(root);
  project.config.sync.linkMode = linkMode;
  await migrateFrom(project, "claude", {
    apply: true,
    install: true,
    includeLocal: false,
    force: true,
    excludeSkills: [],
  });
  expect((await reconcileOnce(project)).action).toBe("noop");
  return { project, settingsPath };
}

const allowList = async (project: LoadedProject) =>
  (await loadHarness(project.storeDir)).permissions.commandAllow;

const EDIT = { permissions: { allow: ["Read", "Bash(pnpm test)"] } };
const NEWER_EDIT = { permissions: { allow: ["Read", "Bash(pnpm test)", "Bash(pnpm build)"] } };

describe("a native edit racing a committed inverse capture", () => {
  // Each case: the first edit is captured and committed to canonical, then a
  // newer edit lands before the state snapshot. Canonical must never be left
  // ahead of .state.json, and the newer bytes must be captured next cycle.
  const seams = [
    {
      name: "after the captured revision was projected, before the snapshot (2026-09-16)",
      arm: (write: () => Promise<void>) => (hooks.afterApply = write),
    },
    {
      name: "after the capture commit, before the ownership ledger is refreshed",
      arm: (write: () => Promise<void>) => (hooks.afterClearLocalBase = write),
    },
    {
      name: "while the ownership ledger is being refreshed",
      arm: (write: () => Promise<void>) => (hooks.beforeRefresh = write),
    },
  ];

  for (const seam of seams) {
    it(`self-heals when it lands ${seam.name}`, async () => {
      const { project, settingsPath } = await fixture({ permissions: { allow: ["Read"] } });
      await writeFile(settingsPath, JSON.stringify(EDIT), "utf8");
      seam.arm(() => writeFile(settingsPath, JSON.stringify(NEWER_EDIT), "utf8"));

      // Whatever this cycle reports, it must not strand canonical ahead of state.
      await reconcileOnce(project).catch(() => undefined);
      expect(await allowList(project)).toContain("Bash(pnpm test)");

      const next = await reconcileOnce(project);
      expect(next.conflict?.message).toBeUndefined();
      expect(next.action).toBe("captured-native");
      expect(await allowList(project)).toContain("Bash(pnpm build)");
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(NEWER_EDIT);
      expect((await reconcileOnce(project)).action).toBe("noop");
    });
  }

  it("keeps and projects a canonical edit that lands during the projection", async () => {
    // The other direction: an edit to the canonical store in the same window
    // is a genuine concurrent canonical change and must not be discarded.
    const { project, settingsPath } = await fixture({ permissions: { allow: ["Read"] } });
    const root = join(project.storeDir, "instructions", "root.md");
    await writeFile(settingsPath, JSON.stringify(EDIT), "utf8");
    hooks.afterApply = () => writeFile(root, "Edited in the store\n", "utf8");

    await reconcileOnce(project).catch(() => undefined);
    const next = await reconcileOnce(project);

    expect(next.conflict?.message).toBeUndefined();
    expect(next.action).toBe("projected-canonical");
    expect(await readFile(root, "utf8")).toBe("Edited in the store\n");
    expect(await allowList(project)).toContain("Bash(pnpm test)");
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("does not absorb a canonical edit that lands right after the capture commit", async () => {
    // Copy mode, so CLAUDE.md is a copy the capture source owns: were the edit
    // folded into the committed revision's hash, it would never reach it.
    const { project, settingsPath } = await fixture({ permissions: { allow: ["Read"] } }, "copy");
    const root = join(project.storeDir, "instructions", "root.md");
    await writeFile(settingsPath, JSON.stringify(EDIT), "utf8");
    hooks.afterClearLocalBase = () => writeFile(root, "Edited in the store\n", "utf8");

    await reconcileOnce(project).catch(() => undefined);
    const next = await reconcileOnce(project);

    expect(next.conflict?.message).toBeUndefined();
    expect(next.action).toBe("projected-canonical");
    expect(await readFile(join(project.projectRoot, "CLAUDE.md"), "utf8"))
      .toBe("Edited in the store\n");
    expect(await allowList(project)).toContain("Bash(pnpm test)");
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("measures, rather than pins, a source path another target's projection rewrote", async () => {
    // Codex and Antigravity can own one physical file. When the other owner's
    // projection rewrites it after the capture, the ledger follows the new
    // bytes; pinning the source to its pre-projection fingerprint would then
    // read next cycle as a changed target with no changed path.
    const { project, settingsPath } = await fixture({ permissions: { allow: ["Read"] } });
    await writeFile(settingsPath, JSON.stringify(EDIT), "utf8");
    hooks.afterApply = async () => {
      await writeFile(settingsPath, `${JSON.stringify(EDIT, null, 2)}\n`, "utf8");
      await refreshManagedTargetHashes(project.storeDir, "claude");
    };

    expect((await reconcileOnce(project)).action).toBe("captured-native");
    const next = await reconcileOnce(project);

    expect(next.conflict?.message).toBeUndefined();
    expect(next.action).toBe("noop");
  });

  it("reports the capture as done even though the source moved on", async () => {
    const { project, settingsPath } = await fixture({ permissions: { allow: ["Read"] } });
    await writeFile(settingsPath, JSON.stringify(EDIT), "utf8");
    hooks.afterApply = () => writeFile(settingsPath, JSON.stringify(NEWER_EDIT), "utf8");

    const first = await reconcileOnce(project);

    expect(first.action).toBe("captured-native");
    expect(first.warnings).toContainEqual(
      expect.objectContaining({ code: "native-changed-after-capture" }),
    );
    // The state pairs the committed canonical revision with the fingerprint of
    // the CAPTURED content, which is what makes the newer edit visible.
    expect((await readState(project.storeDir))?.lastWriter).toBe("claude");
  });
});

describe("a native edit racing a semantic no-op", () => {
  it("keeps the ledger and state paired when the snapshot then fails", async () => {
    const settings = { permissions: { deny: ["Write"], allow: ["Read"] } };
    const { project, settingsPath } = await fixture(settings);
    await writeFile(
      settingsPath,
      '{\n  "permissions": {\n    "allow": ["Read"],\n    "deny": ["Write"]\n  }\n}\n',
      "utf8",
    );
    // A canonical edit after the ledger refresh fails this cycle's snapshot.
    const root = join(project.storeDir, "instructions", "root.md");
    hooks.beforeSnapshot = () => writeFile(root, "Edited in the store\n", "utf8");

    const first = await reconcileOnce(project).catch((error: Error) => error);
    expect(first).toBeInstanceOf(Error);
    const next = await reconcileOnce(project);

    expect(next.conflict?.message).toBeUndefined();
    expect(next.action).toBe("projected-canonical");
    expect(await readFile(root, "utf8")).toBe("Edited in the store\n");
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("does not strand a co-owner of the reformatted path when the snapshot fails", async () => {
    // Codex and Antigravity both own .agents/skills/<name>; a reformat there
    // changes both targets, and only one of them is the capture source.
    const root = await mkdtemp(join(tmpdir(), "harness-sync-shared-noop-"));
    roots.push(root);
    const skill = join(root, ".claude", "skills", "demo");
    await mkdir(skill, { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(join(skill, "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nBody\n");
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    expect((await reconcileOnce(project)).action).toBe("noop");
    const shared = join(root, ".agents", "skills", "demo", "SKILL.md");
    // Same frontmatter, keys reordered: a semantic no-op.
    await writeFile(shared, "---\ndescription: Demo\nname: demo\n---\nBody\n");
    const canonicalRoot = join(project.storeDir, "instructions", "root.md");
    hooks.beforeSnapshot = () => writeFile(canonicalRoot, "Edited in the store\n", "utf8");

    const first = await reconcileOnce(project).catch((error: Error) => error);
    expect(first).toBeInstanceOf(Error);
    const next = await reconcileOnce(project);

    expect(next.conflict?.message).toBeUndefined();
    expect(next.action).toBe("projected-canonical");
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("does not bring back a removed takeover-only value when canonical changes mid-refresh", async () => {
    const { project, settingsPath } = await fixture({ permissions: { allow: ["Read"] } });
    // A value only the machine-local takeover base holds; projection merges it in.
    const base = join(project.storeDir, ".local", "preserved", "claude-settings.json");
    await mkdir(dirname(base), { recursive: true });
    await writeFile(base, JSON.stringify({ localOnly: "machine-value" }), "utf8");
    const harness = await loadHarness(project.storeDir);
    harness.metadata.description = "force a projection";
    await writeHarness(project.storeDir, harness);
    expect((await reconcileOnce(project)).action).toBe("projected-canonical");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).localOnly).toBe("machine-value");

    // The user deletes it by hand, which is a semantic no-op against canonical...
    const edited = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    delete edited.localOnly;
    await writeFile(settingsPath, JSON.stringify(edited), "utf8");
    // ...while a canonical edit lands during the ownership-ledger refresh.
    const root = join(project.storeDir, "instructions", "root.md");
    hooks.beforeRefresh = () => writeFile(root, "Edited in the store\n", "utf8");

    await reconcileOnce(project).catch(() => undefined);
    const later = [];
    for (let cycle = 0; cycle < 3; cycle += 1) later.push((await reconcileOnce(project)).action);

    expect(JSON.parse(await readFile(settingsPath, "utf8")).localOnly).toBeUndefined();
    expect(await readFile(root, "utf8")).toBe("Edited in the store\n");
    expect(later.at(-1)).toBe("noop");
  });

  it("does not advance the ownership ledger past what was verified", async () => {
    const settings = { permissions: { deny: ["Write"], allow: ["Read"] } };
    const { project, settingsPath } = await fixture(settings);
    // Formatting only: verified as a semantic no-op, so only the ledger moves.
    await writeFile(
      settingsPath,
      '{\n  "permissions": {\n    "allow": ["Read"],\n    "deny": ["Write"]\n  }\n}\n',
      "utf8",
    );
    // ...and a real edit lands while the ledger is being refreshed.
    hooks.beforeRefresh = () =>
      writeFile(
        settingsPath,
        JSON.stringify({ permissions: { deny: ["Write"], allow: ["Read", "Bash"] } }),
        "utf8",
      );

    await reconcileOnce(project).catch(() => undefined);
    const next = await reconcileOnce(project);

    expect(next.conflict?.message).toBeUndefined();
    expect(next.action).toBe("captured-native");
    expect(await allowList(project)).toContain("Bash");
    expect((await reconcileOnce(project)).action).toBe("noop");
  });
});
