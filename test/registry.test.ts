import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultProjectConfig,
  PROJECT_CONFIG_NAME,
  writeProjectConfig,
} from "../src/core/config.js";
import { acquireLock } from "../src/core/fs.js";
import {
  addController,
  defaultRegistry,
  discoverControllers,
  listControllers,
  loadRegistry,
  removeController,
  updateController,
  validateControllerTopology,
  writeRegistry,
  type ControllerRegistry,
} from "../src/core/registry.js";
import type { ProjectConfig, Scope, TargetName } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("controller registry", () => {
  it("uses an empty default for a missing registry and writes strict YAML atomically", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "machine", "registry.yaml");
    expect(await loadRegistry(registryPath)).toEqual(defaultRegistry());

    const registry = defaultRegistry();
    registry.discovery.roots = [join(root, "projects")];
    await writeRegistry(registry, registryPath);

    const loaded = await loadRegistry(registryPath);
    expect(loaded).toEqual({
      ...registry,
      discovery: {
        ...registry.discovery,
        roots: [await realpath(root).then((physical) => join(physical, "projects"))],
      },
    });
    expect(await readdir(dirname(registryPath))).toEqual(["registry.yaml"]);
    expect(await readFile(registryPath, "utf8")).toContain("autoEnroll: false\n");
  });

  it.each([
    {
      name: "malformed YAML",
      source: "schemaVersion: [\n",
      error: /invalid registry YAML/u,
    },
    {
      name: "unknown fields",
      source:
        "schemaVersion: 1\ncontrollers: []\ndiscovery:\n  roots: []\n  ignore: []\n  autoEnroll: false\nunexpected: true\n",
      error: /unknown field/u,
    },
    {
      name: "relative controller paths",
      source:
        "schemaVersion: 1\ncontrollers:\n  - id: demo\n    config: relative/harness-sync.yaml\n    enabled: true\n    watch: true\ndiscovery:\n  roots: []\n  ignore: []\n  autoEnroll: false\n",
      error: /must be an absolute path/u,
    },
    {
      name: "automatic enrollment",
      source:
        "schemaVersion: 1\ncontrollers: []\ndiscovery:\n  roots: []\n  ignore: []\n  autoEnroll: true\n",
      error: /autoEnroll must be false/u,
    },
  ])("rejects $name", async ({ source, error }) => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    await writeFile(registryPath, source, "utf8");
    await expect(loadRegistry(registryPath)).rejects.toThrow(error);
  });

  it("rejects duplicate ids and physical config aliases in a hand-written registry", async () => {
    const root = await tempRoot();
    const first = join(root, "first", PROJECT_CONFIG_NAME);
    const second = join(root, "second", PROJECT_CONFIG_NAME);
    await makeController(dirname(first), "first");
    await makeController(dirname(second), "second");
    const registryPath = join(root, "registry.yaml");

    await writeRawRegistry(registryPath, [
      { id: "same", config: first, enabled: true, watch: true },
      { id: "same", config: second, enabled: true, watch: true },
    ]);
    await expect(loadRegistry(registryPath)).rejects.toThrow(/duplicate controller id/u);

    const aliasRoot = join(root, "alias");
    await symlink(dirname(first), aliasRoot, "dir");
    await writeRawRegistry(registryPath, [
      { id: "one", config: first, enabled: true, watch: true },
      {
        id: "two",
        config: join(aliasRoot, PROJECT_CONFIG_NAME),
        enabled: true,
        watch: true,
      },
    ]);
    await expect(loadRegistry(registryPath)).rejects.toThrow(
      /duplicate controller config path/u,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects config hardlink aliases by filesystem identity",
    async () => {
      const root = await tempRoot();
      const first = await makeController(join(root, "first"), undefined);
      const second = join(root, "second", PROJECT_CONFIG_NAME);
      await mkdir(dirname(second), { recursive: true });
      await link(first, second);
      const registryPath = join(root, "registry.yaml");
      await writeRawRegistry(registryPath, [
        { id: "one", config: first, enabled: true, watch: true },
        { id: "two", config: second, enabled: true, watch: true },
      ]);

      await expect(loadRegistry(registryPath)).rejects.toThrow(
        /same filesystem object/u,
      );
    },
  );

  it("canonicalizes a project-directory alias on add and refuses duplicate enrollment", async () => {
    const root = await tempRoot();
    const projectRoot = join(root, "real-project");
    const configPath = await makeController(projectRoot, "legacy-project");
    const aliasRoot = join(root, "project-alias");
    const registryPath = join(root, "registry.yaml");
    await symlink(projectRoot, aliasRoot, "dir");

    const added = await addController(aliasRoot, {
      registryPath,
    });
    expect(added.config).toBe(await realpath(configPath));
    await expect(
      addController(projectRoot, { registryPath }),
    ).rejects.toThrow(/duplicate controller id/u);
    expect((await loadRegistry(registryPath)).controllers).toHaveLength(1);
  });

  it("rejects a symlinked controller marker rather than bypassing control-file safety", async () => {
    const root = await tempRoot();
    const realConfig = await makeController(join(root, "real"), "real");
    const linkedRoot = join(root, "linked");
    await mkdir(linkedRoot);
    const linkedConfig = join(linkedRoot, PROJECT_CONFIG_NAME);
    await symlink(realConfig, linkedConfig);

    await expect(
      addController(linkedConfig, { registryPath: join(root, "registry.yaml") }),
    ).rejects.toThrow(/must be a regular file, not a symlink/u);
  });

  it("requires an explicit id for a legacy controller and rejects id divergence", async () => {
    const root = await tempRoot();
    const legacy = await makeController(join(root, "legacy"), undefined);
    const current = await makeController(join(root, "current"), "canonical-id");
    const registryPath = join(root, "registry.yaml");

    await expect(addController(legacy, { registryPath, id: "legacy-id" })).rejects.toThrow(
      /controllerId is missing/u,
    );
    await expect(
      addController(current, { registryPath, id: "different-id" }),
    ).rejects.toThrow(/does not match controllerId/u);
    expect((await loadRegistry(registryPath)).controllers).toEqual([]);
  });

  it("updates and removes enrollment without changing the controller file", async () => {
    const root = await tempRoot();
    const configPath = await makeController(join(root, "project"), "project-id");
    const registryPath = join(root, "registry.yaml");
    const before = await readFile(configPath, "utf8");
    await addController(configPath, { registryPath });

    const updated = await updateController(
      "project-id",
      { enabled: false, watch: false },
      registryPath,
    );
    expect(updated).toMatchObject({ enabled: false, watch: false });
    expect(await readFile(configPath, "utf8")).toBe(before);

    const removed = await removeController("project-id", registryPath);
    expect(removed.id).toBe("project-id");
    expect((await loadRegistry(registryPath)).controllers).toEqual([]);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("keeps a missing controller representable and removable", async () => {
    const root = await tempRoot();
    const registryPath = join(root, "registry.yaml");
    const missing = join(root, "offline", PROJECT_CONFIG_NAME);
    const registry = defaultRegistry();
    registry.controllers.push({
      id: "offline",
      config: missing,
      enabled: true,
      watch: true,
    });
    await writeRegistry(registry, registryPath);

    expect(await listControllers(registryPath)).toEqual([
      expect.objectContaining({
        id: "offline",
        config: join(await realpath(root), "offline", PROJECT_CONFIG_NAME),
        status: "missing",
      }),
    ]);
    await updateController("offline", { enabled: false }, registryPath);
    await removeController("offline", registryPath);
    expect((await loadRegistry(registryPath)).controllers).toEqual([]);
  });

  it("reports a malformed or identity-divergent controller without breaking registry load", async () => {
    const root = await tempRoot();
    const malformed = join(root, "malformed", PROJECT_CONFIG_NAME);
    await mkdir(dirname(malformed), { recursive: true });
    await writeFile(malformed, "schemaVersion: 2\n", "utf8");
    const mismatched = await makeController(join(root, "mismatch"), "actual-id");
    const legacy = await makeController(join(root, "legacy"), undefined);
    const registryPath = join(root, "registry.yaml");
    await writeRawRegistry(registryPath, [
      { id: "malformed", config: malformed, enabled: false, watch: false },
      { id: "registry-id", config: mismatched, enabled: false, watch: false },
      { id: "legacy-id", config: legacy, enabled: false, watch: false },
    ]);

    expect((await loadRegistry(registryPath)).controllers).toHaveLength(3);
    const listed = await listControllers(registryPath);
    expect(listed[0]).toMatchObject({ id: "malformed", status: "invalid" });
    expect(listed[1]).toMatchObject({
      id: "registry-id",
      status: "invalid",
      error: expect.stringMatching(/does not match controllerId/u),
    });
    expect(listed[2]).toMatchObject({
      id: "legacy-id",
      status: "invalid",
      error: expect.stringMatching(/<missing>/u),
    });
  });

  it("allows only one enabled user-scope controller", async () => {
    const root = await tempRoot();
    const first = await makeController(join(root, "first"), "first-user", {
      scope: "user",
      disableTargets: true,
    });
    const second = await makeController(join(root, "second"), "second-user", {
      scope: "user",
      disableTargets: true,
    });
    const registryPath = join(root, "registry.yaml");
    await addController(first, { registryPath });
    await addController(second, { registryPath, enabled: false });

    await expect(
      updateController("second-user", { enabled: true }, registryPath),
    ).rejects.toThrow(/only one enabled user-scope controller/u);
    expect(
      (await loadRegistry(registryPath)).controllers.find(
        (entry) => entry.id === "second-user",
      )?.enabled,
    ).toBe(false);
  });

  it("rejects overlapping native paths across enabled controllers", async () => {
    const root = await tempRoot();
    const sharedNative = join(root, "shared-native");
    const first = await makeController(join(root, "first"), "first", {
      onlyTarget: "claude",
      targetRoot: sharedNative,
    });
    const second = await makeController(join(root, "second"), "second", {
      onlyTarget: "claude",
      targetRoot: sharedNative,
    });
    const registryPath = join(root, "registry.yaml");
    await addController(first, { registryPath });

    await expect(addController(second, { registryPath })).rejects.toThrow(
      /controller paths overlap.*native path/u,
    );
    expect((await loadRegistry(registryPath)).controllers).toHaveLength(1);
  });

  it("rejects cross-controller store/native and config/store containment", async () => {
    const root = await tempRoot();
    const sharedNative = join(root, "native");
    const nativeOwner = await makeController(join(root, "owner"), "owner", {
      onlyTarget: "claude",
      targetRoot: sharedNative,
    });
    const nestedStore = join(sharedNative, ".claude", "rules", "canonical");
    const storeOwner = await makeController(join(root, "store-owner"), "store-owner", {
      store: nestedStore,
      disableTargets: true,
    });
    const registryPath = join(root, "registry.yaml");
    await addController(nativeOwner, { registryPath });
    await expect(addController(storeOwner, { registryPath })).rejects.toThrow(
      /canonical store.*native path|native path.*canonical store/u,
    );

    const container = join(root, "controller-container");
    const containedConfig = await makeController(
      join(container, "project"),
      "contained",
      {
        store: join(root, "contained-external-store"),
        disableTargets: true,
      },
    );
    const containingStore = await makeController(join(root, "container-owner"), "container-owner", {
      store: container,
      disableTargets: true,
    });
    const secondRegistry = join(root, "second-registry.yaml");
    await addController(containedConfig, { registryPath: secondRegistry });
    await expect(
      addController(containingStore, { registryPath: secondRegistry }),
    ).rejects.toThrow(/controller config.*canonical store|canonical store.*controller config/u);
  });

  it("includes stale managed ownership in cross-controller overlap checks", async () => {
    const root = await tempRoot();
    const firstRoot = join(root, "first");
    const first = await makeController(firstRoot, "first", {
      disableTargets: true,
    });
    const claimed = join(root, "old-native", "claimed");
    await mkdir(join(firstRoot, ".harness-sync"), { recursive: true });
    await writeFile(
      join(firstRoot, ".harness-sync", ".managed.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        files: { [claimed]: "old-hash" },
        links: {},
      })}\n`,
      "utf8",
    );
    const second = await makeController(join(root, "second"), "second", {
      store: join(claimed, "canonical"),
      disableTargets: true,
    });
    const registryPath = join(root, "registry.yaml");
    await addController(first, { registryPath });

    await expect(addController(second, { registryPath })).rejects.toThrow(
      /managed native path.*canonical store/u,
    );
  });

  it("fails closed on a malformed managed path registry", async () => {
    const root = await tempRoot();
    const projectRoot = join(root, "project");
    const config = await makeController(projectRoot, "project", {
      disableTargets: true,
    });
    await mkdir(join(projectRoot, ".harness-sync"), { recursive: true });
    await writeFile(
      join(projectRoot, ".harness-sync", ".managed.json"),
      "{ malformed",
      "utf8",
    );

    await expect(
      addController(config, { registryPath: join(root, "registry.yaml") }),
    ).rejects.toThrow(/invalid managed path registry/u);
  });

  it.skipIf(process.platform === "win32")(
    "retains a managed symlink's native leaf when checking overlaps",
    async () => {
      const root = await tempRoot();
      const firstRoot = join(root, "first");
      const first = await makeController(firstRoot, "first", {
        disableTargets: true,
      });
      const firstStore = join(firstRoot, ".harness-sync");
      const canonicalSkills = join(firstStore, "skills");
      const nativeRoot = join(root, "native");
      const nativeClaim = join(nativeRoot, "skills");
      await mkdir(canonicalSkills, { recursive: true });
      await mkdir(nativeRoot, { recursive: true });
      await symlink(canonicalSkills, nativeClaim, "dir");
      await writeFile(
        join(firstStore, ".managed.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          files: {},
          links: { [nativeClaim]: canonicalSkills },
        })}\n`,
        "utf8",
      );
      const second = await makeController(join(root, "second"), "second", {
        store: nativeRoot,
        disableTargets: true,
      });
      const registryPath = join(root, "registry.yaml");
      await addController(first, { registryPath });

      await expect(addController(second, { registryPath })).rejects.toThrow(
        /managed native path.*canonical store/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains the future target claimed by a dangling managed symlink",
    async () => {
      const root = await tempRoot();
      const firstRoot = join(root, "first");
      const first = await makeController(firstRoot, "first", {
        disableTargets: true,
      });
      const firstStore = join(firstRoot, ".harness-sync");
      const nativeRoot = join(root, "native");
      const nativeClaim = join(nativeRoot, "skills");
      const futureStore = join(root, "future-store");
      await mkdir(firstStore, { recursive: true });
      await mkdir(nativeRoot, { recursive: true });
      await symlink(futureStore, nativeClaim, "dir");
      await writeFile(
        join(firstStore, ".managed.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          files: {},
          links: { [nativeClaim]: futureStore },
        })}\n`,
        "utf8",
      );
      const second = await makeController(join(root, "second"), "second", {
        store: futureStore,
        disableTargets: true,
      });
      const registryPath = join(root, "registry.yaml");
      await addController(first, { registryPath });

      await expect(addController(second, { registryPath })).rejects.toThrow(
        /managed native path.*canonical store/u,
      );
    },
  );

  it("refuses a registry inside a managed canonical store", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    const config = await makeController(join(root, "project"), "project", {
      store,
      disableTargets: true,
    });

    await expect(
      addController(config, { registryPath: join(store, "registry.yaml") }),
    ).rejects.toThrow(/registry.*overlaps.*canonical store/u);
  });

  it("serializes registry mutations with a machine-local lock", async () => {
    const root = await tempRoot();
    const config = await makeController(join(root, "project"), "project");
    const registryPath = join(root, "registry.yaml");
    const release = await acquireLock(`${registryPath}.lock`);
    try {
      await expect(addController(config, { registryPath })).rejects.toThrow(
        /another harness-sync process holds/u,
      );
      expect((await loadRegistry(registryPath)).controllers).toEqual([]);
    } finally {
      await release();
    }
  });

  it("discovers only valid, non-excluded markers without enrolling them", async () => {
    const root = await tempRoot();
    const projects = join(root, "projects");
    const good = await makeController(join(projects, "good"), "good");
    await makeController(join(projects, "ignored", "nested"), "ignored");
    await makeController(join(projects, ".git", "fixture"), "git-fixture");
    const invalid = join(projects, "invalid", PROJECT_CONFIG_NAME);
    await mkdir(dirname(invalid), { recursive: true });
    await writeFile(invalid, "schemaVersion: 2\n", "utf8");
    const outside = join(root, "outside");
    await makeController(outside, "outside");
    await symlink(outside, join(projects, "linked-outside"), "dir");

    const registryPath = join(root, "registry.yaml");
    const registry = defaultRegistry();
    registry.discovery.roots = [projects];
    registry.discovery.ignore.push("**/ignored/**");
    await writeRegistry(registry, registryPath);
    const before = await readFile(registryPath, "utf8");

    const discovered = await discoverControllers({ registryPath });

    expect(discovered).toEqual([
      expect.objectContaining({
        config: await realpath(good),
        controllerId: "good",
        registered: false,
      }),
    ]);
    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect((await loadRegistry(registryPath)).controllers).toEqual([]);
  });

  it("honors discovery depth and entry bounds", async () => {
    const root = await tempRoot();
    const projects = join(root, "projects");
    await makeController(join(projects, "one", "two"), "deep");

    expect(
      await discoverControllers({
        registryPath: join(root, "missing-registry.yaml"),
        roots: [projects],
        maxDepth: 1,
      }),
    ).toEqual([]);
    await expect(
      discoverControllers({
        registryPath: join(root, "missing-registry.yaml"),
        roots: [projects],
        maxEntries: 1,
      }),
    ).rejects.toThrow(/exceeded maxEntries/u);
  });

  it("discovers overlapping roots independently of their input order", async () => {
    const root = await tempRoot();
    const projects = join(root, "projects");
    const nestedRoot = join(projects, "one");
    const deep = await makeController(join(nestedRoot, "two"), "deep");
    const options = {
      registryPath: join(root, "missing-registry.yaml"),
      maxDepth: 1,
    };

    const parentFirst = await discoverControllers({
      ...options,
      roots: [projects, nestedRoot],
    });
    const childFirst = await discoverControllers({
      ...options,
      roots: [nestedRoot, projects],
    });

    expect(parentFirst.map((entry) => entry.config)).toEqual([await realpath(deep)]);
    expect(childFirst).toEqual(parentFirst);
  });

  it("can require every enabled controller to be online for mutating preflight", async () => {
    const root = await tempRoot();
    const registry = defaultRegistry();
    registry.controllers.push({
      id: "offline",
      config: join(root, "offline", PROJECT_CONFIG_NAME),
      enabled: true,
      watch: true,
    });

    await expect(
      validateControllerTopology(registry, { requireOnline: true }),
    ).rejects.toThrow(/controller is offline/u);
    await expect(validateControllerTopology(registry)).resolves.toBeUndefined();
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-registry-"));
  roots.push(root);
  return root;
}

async function makeController(
  root: string,
  controllerId: string | undefined,
  options: {
    scope?: Scope;
    store?: string;
    disableTargets?: boolean;
    onlyTarget?: TargetName;
    targetRoot?: string;
  } = {},
): Promise<string> {
  await mkdir(root, { recursive: true });
  const config = defaultProjectConfig(options.scope ?? "project");
  if (controllerId !== undefined) config.controllerId = controllerId;
  if (options.store !== undefined) config.store = options.store;
  if (options.disableTargets || options.onlyTarget) {
    for (const target of Object.keys(config.targets) as TargetName[]) {
      config.targets[target].enabled = target === options.onlyTarget;
    }
  }
  if (options.onlyTarget && options.targetRoot) {
    config.targets[options.onlyTarget].root = options.targetRoot;
  }
  const configPath = join(root, PROJECT_CONFIG_NAME);
  await writeProjectConfig(configPath, config);
  return configPath;
}

async function writeRawRegistry(
  registryPath: string,
  controllers: ControllerRegistry["controllers"],
): Promise<void> {
  const registry: ControllerRegistry = {
    schemaVersion: 1,
    controllers,
    discovery: { roots: [], ignore: [], autoEnroll: false },
  };
  await writeFile(registryPath, stringifyYaml(registry, { lineWidth: 0 }), "utf8");
}
