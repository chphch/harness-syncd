import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readJsoncObject } from "../src/adapters/common.js";
import {
  defaultHarness,
  loadHarness,
  loadProjectConfig,
} from "../src/core/config.js";
import {
  copyTreeForImport,
  hashNativePath,
  hashPath,
  pathExists,
  snapshotNativePaths,
} from "../src/core/fs.js";
import { scanStoreForSecrets } from "../src/core/secret-scan.js";
import { initializeProject } from "../src/core/project.js";
import { migrateFrom } from "../src/core/migrate.js";
import { validateHarness } from "../src/core/validate.js";
import { ManagedWriter } from "../src/core/writer.js";

const roots: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("projection safety", () => {
  it("rejects command-as-skill directory collisions before writing", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await mkdir(join(store, "skills", "x"), { recursive: true });
    await mkdir(join(store, "skills", "command-x"), { recursive: true });
    await mkdir(join(store, "commands"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    await writeFile(join(store, "skills", "x", "SKILL.md"), "x\n");
    await writeFile(join(store, "skills", "command-x", "SKILL.md"), "command x\n");
    await writeFile(join(store, "commands", "x.md"), "command\n");
    const harness = defaultHarness("collision");
    harness.skills = [
      { name: "x", path: "skills/x" },
      { name: "command-x", path: "skills/command-x" },
    ];
    harness.commands.x = { promptFile: "commands/x.md" };

    await expect(validateHarness(store, harness)).rejects.toThrow(
      /collides with projected skill directory/u,
    );
  });

  it("refuses to write through a symlinked native ancestor", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    const native = join(root, "native");
    const outside = join(root, "outside");
    await mkdir(store, { recursive: true });
    await mkdir(native, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(native, ".agents"));
    const writer = new ManagedWriter({
      storeDir: store,
      target: "codex",
      dryRun: false,
      force: true,
      linkMode: "symlink",
      allowedRoot: native,
    });
    await writer.load();

    await expect(
      writer.text(join(native, ".agents", "skills", "x", "SKILL.md"), "x\n"),
    ).rejects.toThrow(/symlink ancestor/u);
  });

  it("refuses a forced takeover when the native source changed after capture", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    const native = join(root, "CLAUDE.md");
    await mkdir(store, { recursive: true });
    await writeFile(native, "captured value\n", "utf8");
    const nativePreconditions = await snapshotNativePaths([native], root);
    await writeFile(native, "new concurrent edit\n", "utf8");
    const writer = new ManagedWriter({
      storeDir: store,
      target: "claude",
      dryRun: false,
      force: true,
      linkMode: "copy",
      allowedRoot: root,
      nativePreconditions,
    });
    await writer.load();

    await expect(writer.text(native, "captured value\n")).rejects.toThrow(
      /native migration source changed after capture/u,
    );
    expect(await readFile(native, "utf8")).toBe("new concurrent edit\n");
  });

  it("keeps a relative symlink backup pointed at its original target", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    const native = join(root, "native");
    const canonicalSkill = join(store, "skills", "demo");
    const originalSkill = join(native, "shared", "demo");
    const destination = join(native, ".claude", "skills", "demo");
    await mkdir(canonicalSkill, { recursive: true });
    await mkdir(originalSkill, { recursive: true });
    await mkdir(join(native, ".claude", "skills"), { recursive: true });
    await writeFile(join(canonicalSkill, "SKILL.md"), "Canonical\n");
    await writeFile(join(originalSkill, "SKILL.md"), "Original\n");
    await symlink(
      "../../shared/demo",
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
    const originalTarget = await realpath(destination);
    const writer = new ManagedWriter({
      storeDir: store,
      target: "claude",
      dryRun: false,
      force: true,
      linkMode: "symlink",
      allowedRoot: native,
    });
    await writer.load();

    await writer.directory(canonicalSkill, destination);
    const [stamp] = await readdir(join(store, "backups"));
    const [backupName] = await readdir(join(store, "backups", stamp!, "claude"));
    const backup = join(store, "backups", stamp!, "claude", backupName!);

    expect(await realpath(backup)).toBe(originalTarget);
    expect(await readlink(backup)).not.toBe("../../shared/demo");
  });

  it("rejects an imported bundle whose nested symlink escapes the bundle", async () => {
    const root = await tempRoot();
    const source = join(root, "source");
    const outside = join(root, "outside");
    await mkdir(source, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "skill\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join("..", "outside"), join(source, "references"));

    await expect(
      copyTreeForImport(source, join(root, "store", "skills", "unsafe")),
    ).rejects.toThrow(/nested symlink/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a native rule symlink that resolves outside the project boundary",
    async () => {
      const root = await tempRoot();
      const outside = await tempRoot();
      await mkdir(join(root, ".claude", "rules"), { recursive: true });
      await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
      await writeFile(join(outside, "external.md"), "external private data\n");
      await symlink(
        join(outside, "external.md"),
        join(root, ".claude", "rules", "external.md"),
      );
      const project = await initializeProject(root);

      await expect(
        migrateFrom(project, "claude", {
          apply: true,
          install: false,
          includeLocal: false,
          force: false,
        }),
      ).rejects.toThrow(/outside allowed root/u);
    },
  );

  it("rejects nested .git paths in native recursive imports", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".claude", "rules", ".git"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
    await writeFile(join(root, ".claude", "rules", ".git", "policy.md"), "Policy\n");
    const project = await initializeProject(root);

    await expect(migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
    })).rejects.toThrow(/nested Git metadata/u);
  });

  it("rejects a symlinked Claude command instead of silently skipping it", async () => {
    const root = await tempRoot();
    const external = join(await tempRoot(), "review.md");
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
    await writeFile(external, "Review carefully.\n");
    await symlink(external, join(root, ".claude", "commands", "review.md"));
    const project = await initializeProject(root);

    await expect(migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
    })).rejects.toThrow(/non-regular Markdown file/u);
  });

  it("rejects an unmanaged symlinked recursive import root", async () => {
    const root = await tempRoot();
    const sharedRules = join(root, "shared", "rules");
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(sharedRules, { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
    await writeFile(join(sharedRules, "policy.md"), "Policy\n");
    await symlink(join("..", "shared", "rules"), join(root, ".claude", "rules"));
    const project = await initializeProject(root);

    await expect(migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
    })).rejects.toThrow(/unmanaged symlinked directory/u);
  });

  it("includes symlinked file contents in native migration preconditions", async () => {
    const root = await tempRoot();
    const target = join(root, "target.md");
    const link = join(root, "policy.md");
    await writeFile(target, "before\n");
    await symlink("target.md", link);
    const beforeRaw = await hashPath(link);
    const beforeNative = await hashNativePath(link, root);

    await writeFile(target, "after\n");

    expect(await hashPath(link)).toBe(beforeRaw);
    expect(await hashNativePath(link, root)).not.toBe(beforeNative);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a special Antigravity agent entry without blocking on it",
    async () => {
      const root = await tempRoot();
      const agents = join(root, ".agents", "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "Instructions\n");
      await execFile("mkfifo", [join(agents, "reviewer.md")]);
      const project = await initializeProject(root);

      await expect(migrateFrom(project, "antigravity", {
        apply: true,
        install: false,
        includeLocal: false,
        force: false,
      })).rejects.toThrow(/non-regular entry/u);
    },
  );

  it("rejects a symlinked Antigravity agent bundle", async () => {
    const root = await tempRoot();
    const externalRoot = await tempRoot();
    const external = join(externalRoot, "reviewer");
    const agents = join(root, ".agents", "agents");
    await mkdir(external, { recursive: true });
    await mkdir(agents, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Instructions\n");
    await writeFile(join(external, "agent.md"), "Review carefully.\n");
    await symlink(external, join(agents, "reviewer"));
    const project = await initializeProject(root);

    await expect(migrateFrom(project, "antigravity", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
    })).rejects.toThrow(/contains a symlink/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects special files before attempting to read them",
    async () => {
      const root = await tempRoot();
      const rules = join(root, ".claude", "rules");
      await mkdir(rules, { recursive: true });
      await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
      await execFile("mkfifo", [join(rules, "blocking.md")]);
      const project = await initializeProject(root);

      await expect(migrateFrom(project, "claude", {
        apply: true,
        install: false,
        includeLocal: false,
        force: false,
      })).rejects.toThrow(/non-regular file/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a special single-file config before attempting to read it",
    async () => {
      const root = await tempRoot();
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(join(root, "CLAUDE.md"), "Instructions\n");
      await execFile("mkfifo", [join(root, ".claude", "settings.json")]);
      const project = await initializeProject(root);

      await expect(migrateFrom(project, "claude", {
        apply: true,
        install: false,
        includeLocal: false,
        force: false,
      })).rejects.toThrow(/non-regular path/u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects special files already present in a canonical bundle",
    async () => {
      const root = await tempRoot();
      const store = join(root, "store");
      const skill = join(store, "skills", "unsafe");
      await mkdir(join(store, "instructions"), { recursive: true });
      await mkdir(skill, { recursive: true });
      await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
      await writeFile(join(skill, "SKILL.md"), "Unsafe\n");
      await execFile("mkfifo", [join(skill, "pipe")]);
      const harness = defaultHarness("canonical-special-file");
      harness.skills = [{ name: "unsafe", path: "skills/unsafe" }];

      await expect(validateHarness(store, harness)).rejects.toThrow(
        /canonical artifact contains a non-regular file/u,
      );
    },
  );

  it("rejects nested Git metadata instead of creating an unrecoverable gitlink", async () => {
    const root = await tempRoot();
    const source = join(root, "source");
    await mkdir(join(source, ".git"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "skill\n");
    await writeFile(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");

    await expect(
      copyTreeForImport(source, join(root, "store", "skills", "nested-repo")),
    ).rejects.toThrow(/nested Git metadata/u);
  });

  it("stops on malformed JSONC instead of normalizing a partial parse", async () => {
    const root = await tempRoot();
    const path = join(root, "mcp_config.json");
    await writeFile(path, '{ "mcpServers": { "x": } }\n');

    await expect(readJsoncObject(path)).rejects.toThrow(/invalid JSONC/u);
  });

  it("requires a regular SKILL.md inside every canonical skill directory", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await mkdir(join(store, "skills", "incomplete"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("missing-skill-entry");
    harness.skills = [{ name: "incomplete", path: "skills/incomplete" }];

    await expect(validateHarness(store, harness)).rejects.toThrow(/SKILL\.md/u);
  });

  it("rejects malformed nested canonical values before an adapter can dereference them", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("bad-server");
    (harness.mcpServers as Record<string, unknown>).broken = null;

    await expect(validateHarness(store, harness)).rejects.toThrow(/MCP server broken/u);
  });

  it("rejects orphaned MCP native-feature markers", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("orphan-marker");
    harness.mcpServers.private_api = {
      transport: "http",
      url: "https://example.invalid/mcp",
      requiredNativeFeatures: { antigravity: ["authProviderType"] },
    };

    await expect(validateHarness(store, harness)).rejects.toThrow(
      /no matching target overlay/u,
    );
  });

  it("rejects native gate markers backed only by capture booleans", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    const cases = [
      ["claude", "settings.mcpHooks", "mcpHooksCaptured"],
      ["codex", "settings.mcpHooks", "mcpHooksCaptured"],
      ["antigravity", "settings.mcpHooks", "mcpHooksCaptured"],
      ["claude", "settings.mcpPermissions", "mcpPermissionsCaptured"],
      ["antigravity", "settings.mcpPermissions", "mcpPermissionsCaptured"],
    ] as const;

    for (const [target, feature, marker] of cases) {
      const harness = defaultHarness(`orphan-${target}-${feature}`);
      harness.mcpServers.dangerous = {
        transport: "stdio",
        command: "/usr/bin/false",
        requiredNativeFeatures: { [target]: [feature] },
      };
      harness.overlays[target].metadata = { [marker]: true };

      await expect(validateHarness(store, harness)).rejects.toThrow(
        /target overlay does not contain it/u,
      );
    }
  });

  it("rejects Codex-reserved agent names and colliding native paths", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await mkdir(join(store, "agents"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    await writeFile(join(store, "agents", "one.md"), "One\n");
    await writeFile(join(store, "agents", "two.md"), "Two\n");
    const harness = defaultHarness("agent-path-safety");
    harness.agents.enabled = {
      description: "Reserved",
      instructionsFile: "agents/one.md",
    };
    await expect(validateHarness(store, harness)).rejects.toThrow(/reserved by Codex/u);

    harness.agents = {
      alpha: {
        description: "Alpha",
        instructionsFile: "agents/one.md",
      },
      beta: {
        description: "Beta",
        instructionsFile: "agents/two.md",
        nativePaths: { claude: "alpha.md" },
      },
    };
    await expect(validateHarness(store, harness)).rejects.toThrow(
      /Duplicate native agent path/u,
    );

    harness.agents.beta!.nativePaths = { claude: ".git/config.md" };
    await expect(validateHarness(store, harness)).rejects.toThrow(
      /safe relative Markdown path/u,
    );
  });

  it("rejects canonical artifact paths that contain a .git component", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await mkdir(join(store, "rules", ".git"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    await writeFile(join(store, "rules", ".git", "policy.md"), "Policy\n");
    const harness = defaultHarness("git-component");
    harness.rules = [{ path: "rules/.git/policy.md" }];

    await expect(validateHarness(store, harness)).rejects.toThrow(
      /reserved Git metadata/u,
    );
  });

  it("rejects a present harness container with the wrong type instead of coercing it empty", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(store, { recursive: true });
    const malformed = defaultHarness("bad");
    (malformed as unknown as Record<string, unknown>).skills = {};
    await writeFile(
      join(store, "harness.yaml"),
      `${JSON.stringify(malformed, null, 2)}\n`,
    );

    await expect(loadHarness(store)).rejects.toThrow(/harness\.skills/u);
  });

  it("finds private keys and quoted JSON credential fields", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "identity.PEM"),
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
    );
    await writeFile(
      join(root, "settings.JSON"),
      '{"password":"abcdefghijklmnop"}\n',
    );

    const findings = await scanStoreForSecrets(root);

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "identity.PEM", rule: "private-key" }),
      expect.objectContaining({ path: "settings.JSON", rule: "literal-secret-field" }),
    ]));
  });

  it("finds combined generic secret flags in arbitrary file types", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "launch.args"),
      "--token=generic-private-token-value-1234567890\n",
    );

    expect(await scanStoreForSecrets(root)).toContainEqual(
      expect.objectContaining({
        path: "launch.args",
        rule: "literal-secret-field",
      }),
    );
  });

  it("finds split generic secret flags in hook command text", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "hooks.yaml"),
      "command: audit-client --token generic-hook-private-token-value-1234567890\n",
    );

    expect(await scanStoreForSecrets(root)).toContainEqual(
      expect.objectContaining({
        path: "hooks.yaml",
        rule: "command-flag-credential",
      }),
    );
  });

  it("blocks Basic-auth literals inside byte-shared skill content", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "publish"), { recursive: true });
    await writeFile(
      join(root, "skills", "publish", "SKILL.md"),
      "Run curl --user user:very-long-private-password https://example.invalid\n",
    );

    expect(await scanStoreForSecrets(root)).toContainEqual(
      expect.objectContaining({
        path: "skills/publish/SKILL.md",
        rule: "basic-auth-credential",
      }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "never follows canonical-store symlinks during secret scanning",
    async () => {
      const root = await tempRoot();
      const outside = await tempRoot();
      await writeFile(
        join(outside, "secret.txt"),
        "password=very-private-external-value\n",
      );
      await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));

      const findings = await scanStoreForSecrets(root);

      expect(findings).toContainEqual({
        path: "linked.txt",
        line: 0,
        rule: "symbolic-link-not-scanned",
      });
      expect(findings).not.toContainEqual(
        expect.objectContaining({ rule: "literal-secret-field" }),
      );
    },
  );

  it("rejects oversized text from bounded secret scanning and prunes private trees", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "backups"), { recursive: true });
    await writeFile(join(root, ".git", "large.txt"), "x".repeat(2_100_000));
    await writeFile(join(root, "backups", "secret.txt"), "password=private-value-12345\n");
    await writeFile(join(root, "large.txt"), "x".repeat(2_100_000));

    expect(await scanStoreForSecrets(root)).toEqual([
      { path: "large.txt", line: 0, rule: "oversized-text-file" },
    ]);
  });

  it("still scans reserved-looking directories nested inside authored artifacts", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "demo", "backups"), { recursive: true });
    await writeFile(
      join(root, "skills", "demo", "backups", "token.txt"),
      "password=nested-private-value-12345\n",
    );

    expect(await scanStoreForSecrets(root)).toContainEqual(
      expect.objectContaining({
        path: join("skills", "demo", "backups", "token.txt"),
        rule: "literal-secret-field",
      }),
    );
  });

  it("scans small regular files regardless of extension", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "credentials.conf"),
      "api_key=extension-independent-private-value\n",
    );

    expect(await scanStoreForSecrets(root)).toContainEqual(
      expect.objectContaining({
        path: "credentials.conf",
        rule: "literal-secret-field",
      }),
    );
  });

  it("reports NUL-containing regular files instead of silently skipping them", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "compiled.pyc"),
      Buffer.concat([
        Buffer.from([0x42, 0x0d, 0x0a, 0x00]),
        Buffer.from("password=binary-private-value-1234567890\n"),
      ]),
    );

    expect(await scanStoreForSecrets(root)).toEqual([
      { path: "compiled.pyc", line: 0, rule: "binary-file-not-scanned" },
    ]);
  });

  it("skips __pycache__ at any depth without reporting its compiled files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "skills", "demo", "__pycache__"), { recursive: true });
    await writeFile(
      join(root, "skills", "demo", "__pycache__", "demo.cpython-314.pyc"),
      Buffer.concat([
        Buffer.from([0x42, 0x0d, 0x0a, 0x00]),
        Buffer.from("password=binary-private-value-1234567890\n"),
      ]),
    );
    await writeFile(join(root, "skills", "demo", "demo.py"), "value = 1\n");

    expect(await scanStoreForSecrets(root)).toEqual([]);
  });

  it("does not let a NUL byte hide a private key from the scan", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "sneaky.md"),
      Buffer.concat([
        Buffer.from("-----BEGIN RSA PRIVATE KEY-----\n"),
        Buffer.from([0x00]),
      ]),
    );

    expect(await scanStoreForSecrets(root)).toEqual([
      { path: "sneaky.md", line: 0, rule: "binary-file-not-scanned" },
    ]);
  });

  it("detects credential fields whose name is embedded in a compound key", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "compound.yaml"),
      [
        'db_password = "very-private-literal-value"',
        'openai_api_key: "abcdefghijklmnopq"',
        'config.password = "actual-private-literal-value"',
      ].join("\n"),
    );

    expect(await scanStoreForSecrets(root)).toEqual([
      { path: "compound.yaml", line: 1, rule: "literal-secret-field" },
      { path: "compound.yaml", line: 2, rule: "literal-secret-field" },
      { path: "compound.yaml", line: 3, rule: "literal-secret-field" },
    ]);
  });

  it("treats an interpolation cut off by a nested quote as a dynamic reference", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "share.sh"),
      [
        'TOKEN="$(curl -s -X POST "$HOST/api/login" --data @-)"',
        'SESSION_KEY="${LONG_PRIVATE_SESSION_NAME}"',
      ].join("\n"),
    );

    expect(await scanStoreForSecrets(root)).toEqual([]);
  });

  it("detects unquoted credential values that interleave letters and digits", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "alnum.env"), "api_key=abc123def456ghi789\n");

    expect(await scanStoreForSecrets(root)).toEqual([
      { path: "alnum.env", line: 1, rule: "literal-secret-field" },
    ]);
  });

  it("does not mistake JavaScript and Python expressions for literal credentials", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "references.ts"),
      [
        "const password = process.env.DATABASE_PASSWORD;",
        "const token = credentials.accessToken;",
        "const authorization = createAuthorization(request);",
      ].join("\n"),
    );
    await writeFile(
      join(root, "references.py"),
      [
        "api_key = load_api_key()",
        'client_secret = settings["client_secret"]',
        "credential = configured_credential_value",
      ].join("\n"),
    );

    expect(await scanStoreForSecrets(root)).toEqual([]);
  });

  it("does not mistake templates or environment references for literal credentials", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "references.env"),
      [
        "password=$LONG_PRIVATE_PASSWORD_NAME",
        "token=${LONG_PRIVATE_TOKEN_NAME}",
        "api_key=$env:PRIVATE_API_KEY_VALUE",
        "client_secret=%CLIENT_SECRET_VALUE%",
        'authorization="${AUTHORIZATION_VALUE}"',
        "credential={{ secrets.RUNTIME_CREDENTIAL }}",
        "private_key=`${process.env.PRIVATE_KEY}`",
      ].join("\n"),
    );

    expect(await scanStoreForSecrets(root)).toEqual([]);
  });

  it("keeps detecting quoted and credible unquoted credential literals", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "credentials.yaml"),
      [
        'password: "quoted-private-password-value"',
        "api_key=extension-independent-private-value",
        "--token=generic-private-token-value-1234567890",
      ].join("\n"),
    );

    const findings = await scanStoreForSecrets(root);

    expect(findings).toEqual(expect.arrayContaining([
      { path: "credentials.yaml", line: 1, rule: "literal-secret-field" },
      { path: "credentials.yaml", line: 2, rule: "literal-secret-field" },
      { path: "credentials.yaml", line: 3, rule: "literal-secret-field" },
    ]));
  });

  it("detects URL credentials embedded in executable text", async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, "hook.txt"),
      "curl https://monitor:monitor-private-password@audit.invalid/report?token=query-secret-value\n",
    );

    expect(await scanStoreForSecrets(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "url-userinfo-credential" }),
      expect.objectContaining({ rule: "url-query-credential" }),
    ]));
  });

  it("rejects MCP servers and hook handlers without their discriminant payload", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(join(store, "instructions"), { recursive: true });
    await writeFile(join(store, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("invalid-executable-config");
    (harness.mcpServers as Record<string, unknown>).missingCommand = {
      transport: "stdio",
    };

    await expect(validateHarness(store, harness)).rejects.toThrow(/command/u);

    delete harness.mcpServers.missingCommand;
    (harness.hooks as Record<string, unknown>).PreToolUse = [{
      handlers: [{ type: "http" }],
    }];
    await expect(validateHarness(store, harness)).rejects.toThrow(/url/u);
  });

  it("rejects malformed nested canonical and controller scalars", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    await mkdir(store, { recursive: true });
    const malformed = defaultHarness("bad-root");
    (malformed.instructions as unknown as Record<string, unknown>).root = {
      bad: true,
    };
    await writeFile(
      join(store, "harness.yaml"),
      `${JSON.stringify(malformed, null, 2)}\n`,
    );
    const controller = join(root, "harness-sync.yaml");
    await writeFile(
      controller,
      "schemaVersion: 1\nsync:\n  linkMode: sometimes\n",
    );

    await expect(loadHarness(store)).rejects.toThrow(/instructions\.root/u);
    await expect(loadProjectConfig(controller)).rejects.toThrow(/sync\.linkMode/u);
  });

  it("assigns a stable controller identity while keeping legacy configs readable", async () => {
    const root = await tempRoot();
    const project = await initializeProject(root);
    const firstId = project.config.controllerId;

    expect(firstId).toMatch(/^[a-z0-9][a-z0-9._-]*-[0-9a-f]{8}$/u);
    await expect(initializeProject(root)).resolves.toMatchObject({
      config: { controllerId: firstId },
    });

    const legacyRoot = await tempRoot();
    const legacyController = join(legacyRoot, "harness-sync.yaml");
    await writeFile(
      legacyController,
      "schemaVersion: 1\nscope: project\nstore: .harness-sync\n",
      "utf8",
    );
    await expect(loadProjectConfig(legacyController)).resolves.toMatchObject({
      scope: "project",
    });
    expect((await loadProjectConfig(legacyController)).controllerId).toBeUndefined();
  });

  it("rejects an invalid controller identity before writing controller state", async () => {
    const root = await tempRoot();

    await expect(
      initializeProject(root, { controllerId: "../../outside" }),
    ).rejects.toThrow(/controllerId/u);
    expect(await pathExists(join(root, "harness-sync.yaml"))).toBe(false);
  });

  it("rejects an empty identity and a store containing its own controller", async () => {
    const emptyIdRoot = await tempRoot();
    await expect(
      initializeProject(emptyIdRoot, { controllerId: "" }),
    ).rejects.toThrow(/controllerId/u);
    expect(await pathExists(join(emptyIdRoot, "harness-sync.yaml"))).toBe(false);

    const overlappingRoot = await tempRoot();
    await expect(
      initializeProject(overlappingRoot, { store: "." }),
    ).rejects.toThrow(/canonical store overlaps project controller/u);
    expect(await pathExists(join(overlappingRoot, "harness-sync.yaml"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("includes executable bits in artifact hashes", async () => {
    const root = await tempRoot();
    const script = join(root, "run.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const executable = await hashPath(script);
    await chmod(script, 0o644);

    expect(await hashPath(script)).not.toBe(executable);
  });

  it("rejects a canonical store that overlaps a native harness subtree", async () => {
    const root = await tempRoot();

    await expect(initializeProject(root, { store: ".claude" })).rejects.toThrow(
      /canonical store overlaps claude native path/u,
    );
    expect(await pathExists(join(root, "harness-sync.yaml"))).toBe(false);
    await expect(initializeProject(root, { store: "safe-store" })).resolves.toMatchObject({
      storeDir: join(root, "safe-store"),
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses init writes through a symlinked canonical namespace",
    async () => {
      const root = await tempRoot();
      const store = join(root, "store");
      const victim = join(root, "victim");
      await mkdir(store, { recursive: true });
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "root.md"), "do not overwrite\n", "utf8");
      await symlink(victim, join(store, "instructions"));

      await expect(initializeProject(root, { store })).rejects.toThrow(
        /canonical store path contains a symlink/u,
      );
      expect(await readFile(join(victim, "root.md"), "utf8"))
        .toBe("do not overwrite\n");
      expect(await pathExists(join(root, "harness-sync.yaml"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses migration commits through a dormant canonical namespace symlink",
    async () => {
      const root = await tempRoot();
      const project = await initializeProject(root);
      const victim = join(root, "victim");
      await mkdir(join(root, ".claude", "skills", "demo"), { recursive: true });
      await writeFile(
        join(root, ".claude", "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\nDemo\n",
        "utf8",
      );
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "marker"), "untouched\n", "utf8");
      await symlink(victim, join(project.storeDir, "skills"));

      await expect(migrateFrom(project, "claude", {
        apply: true,
        install: false,
        includeLocal: false,
        force: false,
      })).rejects.toThrow(/canonical store path contains a symlink/u);
      expect(await readFile(join(victim, "marker"), "utf8")).toBe("untouched\n");
      expect(await pathExists(join(victim, "demo"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a canonical store that reaches a native subtree through a symlink alias",
    async () => {
      const root = await tempRoot();
      await mkdir(join(root, ".claude", "skills", "demo"), { recursive: true });
      await writeFile(join(root, ".claude", "skills", "demo", "SKILL.md"), "Skill\n");
      await symlink(".claude", join(root, "store-link"));

      await expect(
        initializeProject(root, { store: "store-link" }),
      ).rejects.toThrow(/canonical store overlaps claude native path/u);
    },
  );

  it("never replaces a canonical artifact with a self-referential projection", async () => {
    const root = await tempRoot();
    const store = join(root, "store");
    const artifact = join(store, "skills", "demo");
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "SKILL.md"), "Skill\n");
    const writer = new ManagedWriter({
      storeDir: store,
      target: "claude",
      dryRun: false,
      force: true,
      linkMode: "symlink",
      allowedRoot: root,
    });
    await writer.load();

    await expect(writer.directory(artifact, artifact)).rejects.toThrow(
      /same path/u,
    );
  });

  it.skipIf(process.platform === "win32")(
    "detects source and destination identity through a symlink alias",
    async () => {
      const root = await tempRoot();
      const nativeArtifact = join(root, ".claude", "skills", "demo");
      await mkdir(nativeArtifact, { recursive: true });
      await writeFile(join(nativeArtifact, "SKILL.md"), "Skill\n");
      await symlink(".claude", join(root, "store-link"));
      const writer = new ManagedWriter({
        storeDir: join(root, "store-link"),
        target: "claude",
        dryRun: false,
        force: true,
        linkMode: "symlink",
        allowedRoot: root,
      });
      await writer.load();

      await expect(
        writer.directory(
          join(root, "store-link", "skills", "demo"),
          nativeArtifact,
        ),
      ).rejects.toThrow(/same path/u);
    },
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-safety-"));
  roots.push(root);
  return root;
}
