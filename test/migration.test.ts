import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { CodexAdapter } from "../src/adapters/codex.js";
import { loadHarness, writeHarness } from "../src/core/config.js";
import { pathExists } from "../src/core/fs.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { migrateFrom } from "../src/core/migrate.js";
import { applyHarness, initializeProject, loadProject } from "../src/core/project.js";
import { reconcileOnce } from "../src/core/reconcile.js";
import { refreshManagedTargetHashes } from "../src/core/writer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Claude migration", () => {
  it("imports safely, redacts secrets, and installs shared skill links", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-migrate-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "skills", "review"), { recursive: true });
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "# Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nReview carefully.\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review code\nmodel: sonnet\nmcpServers:\n  inline:\n    headers:\n      Authorization: Bearer agent-private-value-12345\n---\nFind correctness bugs.\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "commands", "check.md"),
      "---\ndescription: Run checks\n---\nRun the full test suite.\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "rules", "typescript.md"),
      "---\npaths:\n  - '**/*.ts'\n---\nUse strict TypeScript.\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(pnpm test:*)"] },
        env: { API_KEY: "this-is-a-literal-secret" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          sample: {
            command: "node",
            args: [
              "server.js",
              "-H",
              "Authorization: Bearer mcp-private-value-123456",
            ],
            env: {
              TOKEN: "do-not-commit-this-token",
              FROM_SHELL: "${FROM_SHELL}",
            },
          },
        },
      }),
      "utf8",
    );

    const project = await initializeProject(root);
    const result = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);

    expect(result.mode).toBe("applied");
    expect(result.summary).toMatchObject({
      rules: 1,
      skills: 1,
      commands: 1,
      agents: 1,
      mcpServers: 1,
    });
    expect(result.warnings.some((warning) => warning.code === "secret-redacted")).toBe(true);
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, "AGENTS.md"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, ".claude", "skills", "review"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, ".agents", "skills", "review"))).isSymbolicLink()).toBe(true);
    await expect(loadProject(root)).resolves.toMatchObject({
      storeDir: project.storeDir,
    });
    expect(resolve(root, ".claude", "skills", await readlink(join(root, ".claude", "skills", "review")))).toBe(
      join(project.storeDir, "skills", "review"),
    );
    expect(harness.mcpServers.sample?.env?.TOKEN).toBe("${env:TOKEN}");
    expect(harness.mcpServers.sample?.env?.FROM_SHELL).toBe(
      "${env:FROM_SHELL}",
    );
    const codexConfig = await readFile(join(root, ".codex", "config.toml"), "utf8");
    expect(codexConfig).toContain("[agents.reviewer]");
    expect(codexConfig).not.toContain("mcp-private-value-123456");
    expect(result.projections.find((entry) => entry.target === "codex")?.warnings)
      .toContainEqual(
        expect.objectContaining({ code: "mcp-executable-secret-not-projected" }),
      );
    expect(await readFile(join(root, ".agents", "mcp_config.json"), "utf8")).toContain(
      '"mcpServers"',
    );
    const codexAgent = parseToml(
      await readFile(join(root, ".codex", "agents", "reviewer.toml"), "utf8"),
    ) as Record<string, unknown>;
    expect(codexAgent).toMatchObject({
      sandbox_mode: "read-only",
      approval_policy: "untrusted",
      web_search: "disabled",
      developer_instructions: "Find correctness bugs.\n",
    });
    const antigravityAgent = parseFrontmatter(
      await readFile(join(root, ".agents", "agents", "reviewer.md"), "utf8"),
    );
    expect(antigravityAgent.body).toBe("Find correctness bugs.\n");
    expect(antigravityAgent.data).toMatchObject({
      name: "reviewer",
      description: "Review code",
      tools: [],
    });
    for (const target of ["codex", "antigravity"] as const) {
      expect(result.projections.find((entry) => entry.target === target)?.warnings)
        .toContainEqual(
          expect.objectContaining({
            code: "agent-capabilities-conservative-fallback",
          }),
        );
    }
    const canonical = await readFile(join(project.storeDir, "harness.yaml"), "utf8");
    expect(canonical).not.toContain("this-is-a-literal-secret");
    expect(canonical).not.toContain("do-not-commit-this-token");
    expect(canonical).not.toContain("agent-private-value-12345");
    expect(canonical).not.toContain("mcp-private-value-123456");
  });

  it("keeps Antigravity-native MCP authentication active only in Antigravity", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-native-mcp-auth-"));
    roots.push(root);
    await mkdir(join(root, ".agents"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          gcp: {
            serverUrl: "https://example.invalid/mcp",
            authProviderType: "google_credentials",
          },
        },
      }),
      "utf8",
    );
    const project = await initializeProject(root);

    const migrated = await migrateFrom(project, "antigravity", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    let harness = await loadHarness(project.storeDir);
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { gcp: Record<string, unknown> } };
    const claudeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { gcp: Record<string, unknown> } };

    expect(harness.mcpServers.gcp?.requiredNativeFeatures).toEqual({
      antigravity: [
        "authProviderType",
        "remoteProtocol",
        "settings.projectTrust",
      ],
    });
    expect(antigravity.mcpServers.gcp).toMatchObject({
      authProviderType: "google_credentials",
    });
    expect(antigravity.mcpServers.gcp).not.toHaveProperty("disabled");
    expect(claudeSettings.disabledMcpjsonServers).toContain("gcp");
    expect(codex.mcp_servers.gcp.enabled).toBe(false);
    for (const target of ["claude", "codex"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toContainEqual(
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        );
    }

    const claudeMcpPath = join(root, ".mcp.json");
    const claudeMcp = JSON.parse(await readFile(claudeMcpPath, "utf8"));
    claudeMcp.auditNote = "target-only edit";
    await writeFile(claudeMcpPath, `${JSON.stringify(claudeMcp, null, 2)}\n`);
    expect((await reconcileOnce(project)).action).toBe("captured-native");
    harness = await loadHarness(project.storeDir);
    expect(harness.mcpServers.gcp?.enabled).toBeUndefined();
    const sourceAfterInverse = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { gcp: Record<string, unknown> } };
    expect(sourceAfterInverse.mcpServers.gcp).not.toHaveProperty("disabled");
  });

  it("keeps Claude dynamic authentication and eager loading active only in Claude", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-native-mcp-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          internal: {
            type: "http",
            url: "https://example.invalid/mcp",
            headersHelper: "/opt/bin/get-mcp-auth-headers.sh",
            alwaysLoad: true,
          },
        },
      }),
      "utf8",
    );
    const project = await initializeProject(root);

    const migrated = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: { internal: Record<string, unknown> };
    };
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { internal: Record<string, unknown> } };
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { internal: Record<string, unknown> } };

    expect(harness.mcpServers.internal?.requiredNativeFeatures).toEqual({
      claude: [
        "headersHelper",
        "alwaysLoad",
        "settings.projectMcpApproval",
      ],
    });
    expect(claude.mcpServers.internal).toMatchObject({
      headersHelper: "/opt/bin/get-mcp-auth-headers.sh",
      alwaysLoad: true,
    });
    expect(codex.mcp_servers.internal.enabled).toBe(false);
    expect(antigravity.mcpServers.internal.disabled).toBe(true);
    for (const target of ["codex", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toContainEqual(
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        );
    }
  });

  it("keeps Claude MCP allow/deny policy from widening on foreign targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-mcp-policy-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          dangerous: {
            type: "http",
            url: "https://example.invalid/mcp",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        deniedMcpServers: [{ serverName: "dangerous" }],
      }),
      "utf8",
    );
    const project = await initializeProject(root);

    const migrated = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const claudeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { dangerous: Record<string, unknown> } };
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { dangerous: Record<string, unknown> } };

    expect(harness.mcpServers.dangerous?.requiredNativeFeatures).toEqual({
      claude: ["settings.projectMcpApproval", "settings.mcpPolicy"],
    });
    expect(claudeSettings.deniedMcpServers).toEqual([
      { serverName: "dangerous" },
    ]);
    expect(codex.mcp_servers.dangerous.enabled).toBe(false);
    expect(antigravity.mcpServers.dangerous.disabled).toBe(true);
    for (const target of ["codex", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toContainEqual(
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        );
    }
  });

  it("keeps Claude project MCP approval gates from activating foreign servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-mcp-approval-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          approved: { type: "http", url: "https://approved.invalid/mcp" },
          pending: { type: "http", url: "https://pending.invalid/mcp" },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        enableAllProjectMcpServers: false,
        enabledMcpjsonServers: ["approved"],
      }),
      "utf8",
    );
    const project = await initializeProject(root);

    const migrated = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const claudeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: Record<string, Record<string, unknown>> };
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };

    expect(claudeSettings).toMatchObject({
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: ["approved"],
    });
    for (const name of ["approved", "pending"] as const) {
      expect(harness.mcpServers[name]?.requiredNativeFeatures).toEqual({
        claude: ["settings.projectMcpApproval"],
      });
      expect(codex.mcp_servers[name]?.enabled).toBe(false);
      expect(antigravity.mcpServers[name]?.disabled).toBe(true);
    }
    for (const target of ["codex", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        ]));
    }
  });

  it("keeps Codex MCP approval and required-startup contracts active only in Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-native-mcp-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[mcp_servers.mutating]",
        'url = "https://example.invalid/mcp"',
        "required = true",
        'default_tools_approval_mode = "prompt"',
        "",
        "[mcp_servers.mutating.tools.delete_everything]",
        'approval_mode = "prompt"',
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);

    const migrated = await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { mutating: Record<string, unknown> } };
    const claudeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { mutating: Record<string, unknown> } };

    expect(harness.mcpServers.mutating?.requiredNativeFeatures).toEqual({
      codex: [
        "default_tools_approval_mode",
        "tools.approval_mode",
        "required",
        "settings.projectTrust",
      ],
    });
    expect(codex.mcp_servers.mutating).toMatchObject({
      required: true,
      default_tools_approval_mode: "prompt",
      tools: { delete_everything: { approval_mode: "prompt" } },
    });
    expect(codex.mcp_servers.mutating.enabled).not.toBe(false);
    expect(claudeSettings.disabledMcpjsonServers).toContain("mutating");
    expect(antigravity.mcpServers.mutating.disabled).toBe(true);
    for (const target of ["claude", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toContainEqual(
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        );
    }
  });

  it("keeps Codex project trust from activating its MCP command in foreign clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-project-trust-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[mcp_servers.untrusted_project]",
        'command = "/usr/bin/printf"',
        'args = ["hello"]',
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);

    const migrated = await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { untrusted_project: Record<string, unknown> } };
    const claudeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { untrusted_project: Record<string, unknown> } };

    expect(harness.mcpServers.untrusted_project?.requiredNativeFeatures).toEqual({
      codex: ["settings.projectTrust"],
    });
    expect(codex.mcp_servers.untrusted_project).not.toHaveProperty("enabled");
    expect(claudeSettings.disabledMcpjsonServers).toContain("untrusted_project");
    expect(antigravity.mcpServers.untrusted_project.disabled).toBe(true);
    for (const target of ["claude", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        ]));
    }
  });

  it("fails closed when project-trust evidence is applied at user scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-scope-bound-trust-"));
    roots.push(root);
    const native = join(root, "native");
    const claudeRoot = join(native, "claude");
    const codexRoot = join(native, "codex");
    const antigravityRoot = join(native, "gemini");
    await Promise.all([
      mkdir(claudeRoot, { recursive: true }),
      mkdir(codexRoot, { recursive: true }),
      mkdir(antigravityRoot, { recursive: true }),
    ]);
    const project = await initializeProject(root);
    project.config.scope = "user";
    project.config.sync.linkMode = "copy";
    project.config.targets.claude.root = claudeRoot;
    project.config.targets.codex.root = codexRoot;
    project.config.targets.antigravity.root = antigravityRoot;
    const harness = await loadHarness(project.storeDir);
    harness.mcpServers.codex_scoped = {
      transport: "stdio",
      command: "/usr/bin/false",
      requiredNativeFeatures: { codex: ["settings.projectTrust"] },
    };
    harness.mcpServers.antigravity_scoped = {
      transport: "stdio",
      command: "/usr/bin/false",
      requiredNativeFeatures: { antigravity: ["settings.projectTrust"] },
    };
    harness.overlays.codex.metadata = { projectTrustCaptured: true };
    harness.overlays.antigravity.metadata = { projectTrustCaptured: true };
    await writeHarness(project.storeDir, harness);

    const results = await applyHarness(project, harness, {
      dryRun: false,
      force: true,
    });
    const codex = parseToml(
      await readFile(join(codexRoot, "config.toml"), "utf8"),
    ) as { mcp_servers: Record<string, Record<string, unknown>> };
    const antigravity = JSON.parse(
      await readFile(join(antigravityRoot, "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };

    expect(codex.mcp_servers.codex_scoped?.enabled).toBe(false);
    expect(antigravity.mcpServers.antigravity_scoped?.disabled).toBe(true);
    for (const target of ["codex", "antigravity"] as const) {
      expect(results.find((entry) => entry.target === target)?.warnings)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        ]));
    }
  });

  it("captures project-local Codex hooks.json beside its config layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-project-hooks-file-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Shared instructions\n");
    await writeFile(
      join(root, ".codex", "config.toml"),
      '[mcp_servers.project_policy]\ncommand = "/usr/bin/printf"\n',
    );
    const hooksFile = {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "/usr/bin/false" }],
          },
        ],
      },
    };
    await writeFile(
      join(root, ".codex", "hooks.json"),
      JSON.stringify(hooksFile),
    );
    const project = await initializeProject(root);

    await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);

    expect(harness.mcpServers.project_policy?.requiredNativeFeatures?.codex)
      .toEqual(["settings.projectTrust", "settings.mcpHooks"]);
    expect(harness.overlays.codex.metadata?.hooksFileRaw).toEqual(hooksFile);
    expect(JSON.parse(
      await readFile(join(root, ".codex", "hooks.json"), "utf8"),
    )).toEqual(hooksFile);
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { project_policy: Record<string, unknown> } };
    expect(codex.mcp_servers.project_policy.enabled).toBe(false);
  });

  it("captures Codex user hooks.json and keeps its MCP gate from widening", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-user-hooks-file-"));
    roots.push(root);
    const native = join(root, "native");
    const claudeRoot = join(native, "claude");
    const codexRoot = join(native, "codex");
    const antigravityRoot = join(native, "gemini");
    await Promise.all([
      mkdir(claudeRoot, { recursive: true }),
      mkdir(codexRoot, { recursive: true }),
      mkdir(antigravityRoot, { recursive: true }),
    ]);
    await writeFile(join(codexRoot, "AGENTS.md"), "Shared instructions\n");
    await writeFile(
      join(codexRoot, "config.toml"),
      [
        "[mcp_servers.dangerous]",
        'url = "https://example.invalid/mcp"',
        "",
      ].join("\n"),
    );
    const hooksFile = {
      description: "Keep dangerous MCP tools behind a native policy hook.",
      hooks: {
        PermissionRequest: [
          {
            matcher: "^mcp__dangerous__.*$",
            hooks: [{ type: "command", command: "/usr/bin/false" }],
          },
        ],
      },
    };
    await writeFile(join(codexRoot, "hooks.json"), JSON.stringify(hooksFile));
    const project = await initializeProject(root);
    project.config.scope = "user";
    project.config.sync.linkMode = "copy";
    project.config.targets.claude.root = claudeRoot;
    project.config.targets.codex.root = codexRoot;
    project.config.targets.antigravity.root = antigravityRoot;

    const migrated = await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    let harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(codexRoot, "config.toml"), "utf8"),
    ) as { mcp_servers: { dangerous: Record<string, unknown> } };
    const claudeSettings = JSON.parse(
      await readFile(join(claudeRoot, "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };
    const antigravity = JSON.parse(
      await readFile(join(antigravityRoot, "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { dangerous: Record<string, unknown> } };

    expect(migrated.imported).toContain(join(codexRoot, "hooks.json"));
    expect(harness.mcpServers.dangerous?.requiredNativeFeatures).toEqual({
      codex: ["settings.mcpHooks"],
    });
    expect(harness.overlays.codex.metadata?.hooksFileRaw).toEqual(hooksFile);
    expect(JSON.parse(await readFile(join(codexRoot, "hooks.json"), "utf8")))
      .toEqual(hooksFile);
    expect(codex.mcp_servers.dangerous.enabled).toBe(false);
    expect(claudeSettings.disabledMcpjsonServers).toContain("dangerous");
    expect(antigravity.mcpServers.dangerous.disabled).toBe(true);
    for (const target of ["claude", "codex", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        ]));
    }

    const editedHooksFile = structuredClone(hooksFile);
    editedHooksFile.hooks.PermissionRequest[0]!.hooks[0]!.command = "/usr/bin/true";
    await writeFile(
      join(codexRoot, "hooks.json"),
      JSON.stringify(editedHooksFile),
    );
    const reconciled = await reconcileOnce(project);
    harness = await loadHarness(project.storeDir);
    expect(reconciled.action).toBe("captured-native");
    expect(harness.overlays.codex.metadata?.hooksFileRaw).toEqual(editedHooksFile);
  });

  it("retains a secret-bearing Codex hooks.json and disables its gated MCP server", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-secret-hooks-file-"));
    roots.push(root);
    const native = join(root, "native");
    const claudeRoot = join(native, "claude");
    const codexRoot = join(native, "codex");
    const antigravityRoot = join(native, "gemini");
    await Promise.all([
      mkdir(claudeRoot, { recursive: true }),
      mkdir(codexRoot, { recursive: true }),
      mkdir(antigravityRoot, { recursive: true }),
    ]);
    await writeFile(join(codexRoot, "AGENTS.md"), "Shared instructions\n");
    await writeFile(
      join(codexRoot, "config.toml"),
      '[mcp_servers.dangerous]\nurl = "https://example.invalid/mcp"\n',
    );
    const literalSecret = "private-hook-token-value-123456789";
    const nativeHooks = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^mcp__dangerous__.*$",
            hooks: [
              {
                type: "command",
                command: `/usr/bin/check-policy --token ${literalSecret}`,
              },
            ],
          },
        ],
      },
    });
    await writeFile(join(codexRoot, "hooks.json"), nativeHooks);
    const project = await initializeProject(root);
    project.config.scope = "user";
    project.config.targets.claude.root = claudeRoot;
    project.config.targets.codex.root = codexRoot;
    project.config.targets.antigravity.root = antigravityRoot;

    const migrated = await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(codexRoot, "config.toml"), "utf8"),
    ) as { mcp_servers: { dangerous: Record<string, unknown> } };
    const claudeSettings = JSON.parse(
      await readFile(join(claudeRoot, "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };
    const antigravity = JSON.parse(
      await readFile(join(antigravityRoot, "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { dangerous: Record<string, unknown> } };

    expect(await readFile(join(codexRoot, "hooks.json"), "utf8"))
      .toBe(nativeHooks);
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
      .not.toContain(literalSecret);
    expect(harness.mcpServers.dangerous?.requiredNativeFeatures?.codex)
      .toEqual(["settings.mcpHooks"]);
    expect(codex.mcp_servers.dangerous.enabled).toBe(false);
    expect(claudeSettings.disabledMcpjsonServers).toContain("dangerous");
    expect(antigravity.mcpServers.dangerous.disabled).toBe(true);
    expect(migrated.projections.find((entry) => entry.target === "codex")?.warnings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "hook-secret-reference-not-projected",
          path: join(codexRoot, "hooks.json"),
        }),
        expect.objectContaining({ code: "mcp-native-hook-not-projected" }),
      ]));
  });

  it("does not promote a generated Claude fallback into a matching contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-fallback-roundtrip-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[mcp_servers.danger]",
        'command = "/usr/bin/printf"',
        'args = ["hello"]',
        "required = true",
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);

    await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const claudeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };

    expect(harness.mcpServers.danger?.requiredNativeFeatures?.codex)
      .toEqual(["required", "settings.projectTrust"]);
    expect(harness.mcpServers.danger?.requiredNativeFeatures?.claude)
      .toBeUndefined();
    expect(claudeSettings.disabledMcpjsonServers).toContain("danger");
  });

  it("keeps restrictive Claude MCP permission rules from widening in user scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-user-mcp-permission-"));
    roots.push(root);
    const native = join(root, "native");
    const claudeRoot = join(native, "claude");
    const codexRoot = join(native, "codex");
    const antigravityRoot = join(native, "gemini");
    await mkdir(claudeRoot, { recursive: true });
    await mkdir(codexRoot, { recursive: true });
    await mkdir(antigravityRoot, { recursive: true });
    await writeFile(join(claudeRoot, "CLAUDE.md"), "Shared instructions\n", "utf8");
    await writeFile(
      join(native, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          dangerous: {
            type: "http",
            url: "https://example.invalid/mcp",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(claudeRoot, "settings.json"),
      JSON.stringify({
        permissions: { deny: ["mcp__dangerous__*"] },
      }),
      "utf8",
    );
    const project = await initializeProject(root);
    project.config.scope = "user";
    project.config.targets.claude.root = claudeRoot;
    project.config.targets.codex.root = codexRoot;
    project.config.targets.antigravity.root = antigravityRoot;

    const migrated = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(codexRoot, "config.toml"), "utf8"),
    ) as { mcp_servers: { dangerous: Record<string, unknown> } };
    const antigravity = JSON.parse(
      await readFile(join(antigravityRoot, "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { dangerous: Record<string, unknown> } };

    expect(harness.mcpServers.dangerous?.requiredNativeFeatures).toEqual({
      claude: ["settings.mcpPermissions"],
    });
    expect(codex.mcp_servers.dangerous.enabled).toBe(false);
    expect(antigravity.mcpServers.dangerous.disabled).toBe(true);
    for (const target of ["codex", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        ]));
    }
  });

  it("keeps Claude user MCP servers disabled by any project state from widening", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-user-project-toggle-"));
    roots.push(root);
    const native = join(root, "native");
    const claudeRoot = join(native, "claude");
    const codexRoot = join(native, "codex");
    const antigravityRoot = join(native, "gemini");
    await Promise.all([
      mkdir(claudeRoot, { recursive: true }),
      mkdir(codexRoot, { recursive: true }),
      mkdir(antigravityRoot, { recursive: true }),
    ]);
    await writeFile(join(claudeRoot, "CLAUDE.md"), "Shared instructions\n");
    const claudeState = JSON.stringify({
      mcpServers: {
        disabled_somewhere: {
          type: "http",
          url: "https://disabled.example.invalid/mcp",
        },
        active: {
          type: "http",
          url: "https://active.example.invalid/mcp",
        },
      },
      projects: {
        "/private/project": {
          disabledMcpServers: ["disabled_somewhere", "unrelated"],
        },
      },
    });
    await writeFile(join(native, ".claude.json"), claudeState);
    const project = await initializeProject(root);
    project.config.scope = "user";
    project.config.targets.claude.root = claudeRoot;
    project.config.targets.codex.root = codexRoot;
    project.config.targets.antigravity.root = antigravityRoot;

    const migrated = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(codexRoot, "config.toml"), "utf8"),
    ) as { mcp_servers: Record<string, Record<string, unknown>> };
    const antigravity = JSON.parse(
      await readFile(join(antigravityRoot, "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };

    expect(harness.mcpServers.disabled_somewhere?.requiredNativeFeatures).toEqual({
      claude: ["projects.disabledMcpServers"],
    });
    expect(harness.mcpServers.active?.requiredNativeFeatures).toBeUndefined();
    expect(codex.mcp_servers.disabled_somewhere?.enabled).toBe(false);
    expect(codex.mcp_servers.active?.enabled).not.toBe(false);
    expect(antigravity.mcpServers.disabled_somewhere?.disabled).toBe(true);
    expect(antigravity.mcpServers.active?.disabled).not.toBe(true);
    expect(await readFile(join(native, ".claude.json"), "utf8"))
      .toBe(claudeState);
    for (const target of ["codex", "antigravity"] as const) {
      expect(migrated.projections.find((entry) => entry.target === target)?.warnings)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "mcp-target-feature-not-projected" }),
        ]));
    }
  });

  it("keeps Claude MCP permission modes and blocking hooks target-local", async () => {
    const cases: Array<{
      name: string;
      settings: Record<string, unknown>;
      feature: string;
    }> = [
      {
        name: "dont-ask",
        settings: { permissions: { defaultMode: "dontAsk" } },
        feature: "settings.mcpPermissions",
      },
      {
        name: "blocking-hook",
        settings: {
          hooks: {
            PreToolUse: [
              {
                matcher: "mcp__dangerous__.*",
                hooks: [{ type: "command", command: "exit 2" }],
              },
            ],
          },
        },
        feature: "settings.mcpHooks",
      },
    ];

    for (const fixture of cases) {
      const root = await mkdtemp(join(tmpdir(), `harness-sync-${fixture.name}-`));
      roots.push(root);
      const native = join(root, "native");
      const claudeRoot = join(native, "claude");
      const codexRoot = join(native, "codex");
      const antigravityRoot = join(native, "gemini");
      await Promise.all([
        mkdir(claudeRoot, { recursive: true }),
        mkdir(codexRoot, { recursive: true }),
        mkdir(antigravityRoot, { recursive: true }),
      ]);
      await writeFile(join(claudeRoot, "CLAUDE.md"), "Shared instructions\n");
      await writeFile(
        join(native, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            dangerous: {
              type: "http",
              url: "https://example.invalid/mcp",
            },
          },
        }),
      );
      await writeFile(
        join(claudeRoot, "settings.json"),
        JSON.stringify(fixture.settings),
      );
      const project = await initializeProject(root);
      project.config.scope = "user";
      project.config.targets.claude.root = claudeRoot;
      project.config.targets.codex.root = codexRoot;
      project.config.targets.antigravity.root = antigravityRoot;

      await migrateFrom(project, "claude", {
        apply: true,
        install: true,
        includeLocal: false,
        force: true,
        excludeSkills: [],
      });
      const harness = await loadHarness(project.storeDir);
      const codex = parseToml(
        await readFile(join(codexRoot, "config.toml"), "utf8"),
      ) as { mcp_servers: { dangerous: Record<string, unknown> } };
      const antigravity = JSON.parse(
        await readFile(join(antigravityRoot, "config", "mcp_config.json"), "utf8"),
      ) as { mcpServers: { dangerous: Record<string, unknown> } };

      expect(harness.mcpServers.dangerous?.requiredNativeFeatures).toEqual({
        claude: [fixture.feature],
      });
      expect(codex.mcp_servers.dangerous.enabled).toBe(false);
      expect(antigravity.mcpServers.dangerous.disabled).toBe(true);
    }
  });

  it("preserves nested Claude agent paths without creating duplicate definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-nested-agent-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "agents", "team"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "agents", "team", "source-file.md"),
      "---\nname: reviewer\ndescription: Review changes\n---\nReview carefully.\n",
      "utf8",
    );
    const project = await initializeProject(root);

    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);

    expect(harness.agents.reviewer?.nativePaths?.claude)
      .toBe("team/source-file.md");
    expect(await pathExists(join(root, ".claude", "agents", "team", "source-file.md")))
      .toBe(true);
    expect(await pathExists(join(root, ".claude", "agents", "reviewer.md")))
      .toBe(false);
  });

  it("rejects malformed agent metadata before committing canonical changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-malformed-frontmatter-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Native instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "agents", "reviewer.md"),
      "---\nname:\n  nested: invalid\ndescription: Review\n---\nBody\n",
      "utf8",
    );
    const project = await initializeProject(root);
    const harnessBefore = await readFile(
      join(project.storeDir, "harness.yaml"),
      "utf8",
    );

    await expect(migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    })).rejects.toThrow(/frontmatter name must be a string/u);
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
      .toBe(harnessBefore);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8"))
      .toBe("Native instructions\n");
  });

  it("preflights unsafe native symlink ancestors before committing a migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-native-symlink-root-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, "shared-rules"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Native instructions\n", "utf8");
    await writeFile(join(root, "shared-rules", "policy.md"), "Policy\n", "utf8");
    await symlink(
      "../shared-rules",
      join(root, ".claude", "rules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const project = await initializeProject(root);
    const harnessBefore = await readFile(
      join(project.storeDir, "harness.yaml"),
      "utf8",
    );

    await expect(migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    })).rejects.toThrow(/(?:symlink ancestor|unmanaged symlinked directory)/u);
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
      .toBe(harnessBefore);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8"))
      .toBe("Native instructions\n");
  });

  it("keeps plan mode read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-plan-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "source instructions\n", "utf8");
    const project = await initializeProject(root);
    const before = await readFile(join(project.storeDir, "instructions", "root.md"), "utf8");

    const result = await migrateFrom(project, "claude", {
      apply: false,
      install: false,
      includeLocal: false,
      force: false,
      excludeSkills: [],
    });

    expect(result.mode).toBe("plan");
    expect(result.imported).toContain(join(root, "CLAUDE.md"));
    expect(await readFile(join(project.storeDir, "instructions", "root.md"), "utf8")).toBe(before);
  });

  it("commits an explicitly included Claude local overlay only on apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-local-overlay-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.local.json"),
      `${JSON.stringify({ model: "sonnet", outputStyle: "concise" }, null, 2)}\n`,
      "utf8",
    );
    const project = await initializeProject(root);
    const retained = join(project.storeDir, ".local", "claude.settings.json");

    await migrateFrom(project, "claude", {
      apply: false,
      install: false,
      includeLocal: true,
      force: false,
      excludeSkills: [],
    });
    expect(await pathExists(retained)).toBe(false);

    await migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: true,
      force: false,
      excludeSkills: [],
    });
    expect(JSON.parse(await readFile(retained, "utf8"))).toEqual({
      model: "sonnet",
      outputStyle: "concise",
    });
    expect((await lstat(retained)).mode & 0o077).toBe(0);
  });

  it("validates a staged migration before changing canonical artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-staged-migration-"));
    roots.push(root);
    const project = await initializeProject(root);
    const harnessBefore = await readFile(
      join(project.storeDir, "harness.yaml"),
      "utf8",
    );
    const instructionsBefore = await readFile(
      join(project.storeDir, "instructions", "root.md"),
      "utf8",
    );
    await writeFile(join(root, "CLAUDE.md"), "Native replacement\n", "utf8");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { broken: { type: "stdio" } } }),
      "utf8",
    );

    for (const apply of [false, true]) {
      await expect(migrateFrom(project, "claude", {
        apply,
        install: false,
        includeLocal: false,
        force: false,
        excludeSkills: [],
      })).rejects.toThrow(/broken\.command/u);
      expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
        .toBe(harnessBefore);
      expect(
        await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
      ).toBe(instructionsBefore);
    }

    for (const [mcpServers, message] of [
      [{ shorthand: "stdio://future-format" }, /shorthand.*server object/u],
      [
        {
          future: {
            type: "grpc",
            url: "grpc://127.0.0.1:9000",
            futureOption: { nested: true },
          },
        },
        /unsupported MCP transport "grpc"/u,
      ],
    ] as const) {
      await writeFile(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers }),
        "utf8",
      );
      await expect(migrateFrom(project, "claude", {
        apply: true,
        install: true,
        includeLocal: false,
        force: true,
        excludeSkills: [],
      })).rejects.toThrow(message);
      expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
        .toBe(harnessBefore);
      expect(
        await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
      ).toBe(instructionsBefore);
    }
  });

  it("rejects malformed Codex agent and hook tables without changing canonical artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-shape-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    const project = await initializeProject(root);
    const harnessBefore = await readFile(
      join(project.storeDir, "harness.yaml"),
      "utf8",
    );

    for (const [source, message] of [
      ['agents = "invalid"\n', /agents: expected a TOML table/u],
      ['hooks = ["invalid"]\n', /hooks: expected a TOML table/u],
    ] as const) {
      await writeFile(join(root, ".codex", "config.toml"), source, "utf8");
      await expect(migrateFrom(project, "codex", {
        apply: true,
        install: true,
        includeLocal: false,
        force: true,
        excludeSkills: [],
      })).rejects.toThrow(message);
      expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
        .toBe(harnessBefore);
    }

    await writeFile(join(root, ".codex", "config.toml"), "", "utf8");
    const malformedHooksFile = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "mcp__.*", hooks: "not-an-array" }],
      },
    });
    await writeFile(
      join(root, ".codex", "hooks.json"),
      malformedHooksFile,
      "utf8",
    );
    await expect(migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    })).rejects.toThrow(/hooks\.PreToolUse\[0\]\.hooks: expected an array/u);
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
      .toBe(harnessBefore);
    expect(await readFile(join(root, ".codex", "hooks.json"), "utf8"))
      .toBe(malformedHooksFile);
  });

  it("rejects a malformed Codex agent prompt without rewriting its native file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-agent-shape-"));
    roots.push(root);
    await mkdir(join(root, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[agents.reviewer]",
        'description = "Review"',
        'config_file = "agents/reviewer.toml"',
        "",
      ].join("\n"),
      "utf8",
    );
    const nativeAgent = join(root, ".codex", "agents", "reviewer.toml");
    const malformed = 'developer_instructions = ["not", "a string"]\nmodel = "gpt-example"\n';
    await writeFile(nativeAgent, malformed, "utf8");
    const project = await initializeProject(root);
    const harnessBefore = await readFile(
      join(project.storeDir, "harness.yaml"),
      "utf8",
    );

    await expect(migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    })).rejects.toThrow(/developer_instructions: expected a string/u);
    expect(await readFile(nativeAgent, "utf8")).toBe(malformed);
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
      .toBe(harnessBefore);
  });

  it("expands the official CLAUDE.md @AGENTS.md wrapper without self-reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-wrapper-"));
    roots.push(root);
    await writeFile(join(root, "AGENTS.md"), "Shared agent instructions\n", "utf8");
    await writeFile(join(root, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
    const project = await initializeProject(root);

    const result = await migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
      excludeSkills: [],
    });

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "instruction-import-expanded" }),
    );
    expect(
      await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Shared agent instructions\n");
  });

  it("expands an inline root AGENTS import and rejects a differently resolved import", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-inline-wrapper-"));
    roots.push(root);
    await writeFile(join(root, "AGENTS.md"), "shared body", "utf8");
    await writeFile(
      join(root, "CLAUDE.md"),
      "Before @AGENTS.md after\n",
      "utf8",
    );
    const project = await initializeProject(root);

    await migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
      excludeSkills: [],
    });
    expect(
      await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Before shared body after\n");

    await writeFile(join(root, "CLAUDE.md"), "@../AGENTS.md\n", "utf8");
    await expect(
      migrateFrom(project, "claude", {
        apply: true,
        install: false,
        includeLocal: false,
        force: false,
        excludeSkills: [],
      }),
    ).rejects.toThrow(/does not resolve/u);
  });

  it("keeps a lone .claude/CLAUDE.md fallback as the managed instruction path", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-fallback-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    const fallback = join(root, ".claude", "CLAUDE.md");
    await writeFile(fallback, "Fallback instructions\n", "utf8");
    const project = await initializeProject(root);

    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    expect(await pathExists(join(root, "CLAUDE.md"))).toBe(false);
    expect((await lstat(fallback)).isSymbolicLink()).toBe(true);
    await writeFile(
      join(project.storeDir, "instructions", "root.md"),
      "Updated canonical fallback\n",
      "utf8",
    );
    expect(await readFile(fallback, "utf8"))
      .toBe("Updated canonical fallback\n");
  });

  it("inverse-captures edits from a copied .claude/CLAUDE.md fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-copy-fallback-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    const fallback = join(root, ".claude", "CLAUDE.md");
    await writeFile(fallback, "Fallback instructions\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    await writeFile(fallback, "Edited fallback copy\n", "utf8");
    const result = await reconcileOnce(project);

    expect(result.action).toBe("captured-native");
    expect(
      await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Edited fallback copy\n");
  });

  it("inverse-captures edits from a copied Antigravity GEMINI.md fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-antigravity-copy-fallback-"));
    roots.push(root);
    const fallback = join(root, "GEMINI.md");
    await writeFile(fallback, "Gemini fallback\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    project.config.targets.claude.enabled = false;
    project.config.targets.codex.enabled = false;
    await migrateFrom(project, "antigravity", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    await writeFile(fallback, "Edited Gemini fallback\n", "utf8");
    const result = await reconcileOnce(project);

    expect(result.action).toBe("captured-native");
    expect(
      await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Edited Gemini fallback\n");
  });

  it("prunes an unchanged managed skill after explicit canonical deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-prune-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "skills", "retired"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "skills", "retired", "SKILL.md"),
      "---\nname: retired\ndescription: Retire me\n---\nBody\n",
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    harness.skills = [];
    await writeHarness(project.storeDir, harness);

    const result = await applyHarness(project, harness, {
      dryRun: false,
      force: false,
    });

    expect(result.flatMap((entry) => entry.removed)).toContain(
      join(root, ".claude", "skills", "retired"),
    );
    expect(await pathExists(join(root, ".claude", "skills", "retired"))).toBe(false);
    expect(await pathExists(join(root, ".agents", "skills", "retired"))).toBe(false);
  });

  it("appends mandatory private/runtime ignores to an existing store ignore file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-ignore-"));
    roots.push(root);
    await mkdir(join(root, ".harness-sync"), { recursive: true });
    await writeFile(join(root, ".harness-sync", ".gitignore"), "custom.tmp\n", "utf8");

    const project = await initializeProject(root);
    const ignore = await readFile(join(project.storeDir, ".gitignore"), "utf8");

    expect(ignore).toContain("custom.tmp\n");
    expect(ignore).toContain("/.local/\n");
    expect(ignore).toContain("/backups/\n");
    expect(ignore).toContain("/.managed.json\n");
  });

  it("fails closed when Claude cannot represent MCP enablement and tool filters", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-mcp-controls-"));
    roots.push(root);
    const project = await initializeProject(root);
    const harness = await loadHarness(project.storeDir);
    harness.mcpServers.disabled_demo = {
      transport: "stdio",
      command: "node",
      args: ["disabled.js"],
      enabled: false,
    };
    harness.mcpServers.filtered_demo = {
      transport: "stdio",
      command: "node",
      args: ["filtered.js"],
      enabled: true,
      enabledTools: ["read"],
    };
    harness.mcpServers.empty_allowlist_demo = {
      transport: "stdio",
      command: "node",
      args: ["empty.js"],
      enabled: true,
      enabledTools: [],
    };
    harness.mcpServers.timed_demo = {
      transport: "stdio",
      command: "node",
      args: ["timed.js"],
      startupTimeoutMs: 2_000,
    };
    harness.mcpServers.cwd_demo = {
      transport: "stdio",
      command: "node",
      args: ["cwd.js"],
      cwd: "tools/server",
    };
    await writeHarness(project.storeDir, harness);

    const results = await applyHarness(project, harness, {
      dryRun: false,
      force: true,
    });
    const nativeMcp = JSON.parse(
      await readFile(join(root, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    const nativeSettings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as { disabledMcpjsonServers: string[] };
    const claude = results.find((result) => result.target === "claude");

    expect(nativeSettings.disabledMcpjsonServers).toEqual([
      "disabled_demo",
      "cwd_demo",
      "empty_allowlist_demo",
      "filtered_demo",
    ].sort());
    for (const server of Object.values(nativeMcp.mcpServers)) {
      expect(server).not.toHaveProperty("enabled");
      expect(server).not.toHaveProperty("enabledTools");
      expect(server).not.toHaveProperty("disabledTools");
      expect(server).not.toHaveProperty("cwd");
    }
    expect(claude?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "mcp-tool-filter-not-projected" }),
      expect.objectContaining({ code: "mcp-timeout-not-projected" }),
      expect.objectContaining({ code: "mcp-cwd-not-projected" }),
    ]));
  });

  it("preserves Codex Bearer-token environment names and fails closed where unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-bearer-env-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[mcp_servers.secure]",
        'url = "https://example.invalid/mcp"',
        'bearer_token_env_var = "PRIVATE_API_TOKEN"',
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);

    const result = await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const harness = await loadHarness(project.storeDir);
    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: { secure: Record<string, unknown> } };
    const claude = JSON.parse(
      await readFile(join(root, ".mcp.json"), "utf8"),
    ) as { mcpServers: { secure: { headers: Record<string, string> } } };
    const antigravity = JSON.parse(
      await readFile(join(root, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { secure: Record<string, unknown> } };

    expect(harness.mcpServers.secure?.bearerTokenEnvVar)
      .toBe("PRIVATE_API_TOKEN");
    expect(codex.mcp_servers.secure.bearer_token_env_var)
      .toBe("PRIVATE_API_TOKEN");
    expect(claude.mcpServers.secure.headers.Authorization)
      .toBe("Bearer ${PRIVATE_API_TOKEN}");
    expect(antigravity.mcpServers.secure).toMatchObject({ disabled: true });
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: "secret-redacted" }),
    );
    expect(result.projections.find((entry) => entry.target === "antigravity")?.warnings)
      .toContainEqual(
        expect.objectContaining({ code: "mcp-bearer-token-not-projected" }),
      );
  });

  it("preserves restrictive local Codex permissions during a Claude migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-permissions-"));
    roots.push(root);
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        'approval_policy = "untrusted"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        "",
        "[features]",
        "shell_tool = false",
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);

    const result = await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    const codexConfig = await readFile(
      join(root, ".codex", "config.toml"),
      "utf8",
    );
    const codex = result.projections.find((entry) => entry.target === "codex");

    expect(codexConfig).toContain('approval_policy = "untrusted"');
    expect(codexConfig).toContain('sandbox_mode = "read-only"');
    expect(codexConfig).toContain('web_search = "disabled"');
    expect(codexConfig).toContain("shell_tool = false");
    expect(codex?.warnings).toContainEqual(
      expect.objectContaining({ code: "codex-permissions-preserved-local" }),
    );

    const harness = await loadHarness(project.storeDir);
    await applyHarness(project, harness, { dryRun: false, force: true });
    const secondConfig = await readFile(join(root, ".codex", "config.toml"), "utf8");
    expect(secondConfig).toContain('web_search = "disabled"');
    expect(secondConfig).toContain("shell_tool = false");
  });

  it("preserves restrictive unmanaged Claude settings across repeated applies", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-claude-permissions-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".agents"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Bash", "Write", "Edit"] },
        disableAllHooks: true,
      }),
      "utf8",
    );
    await writeFile(
      join(root, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            serverUrl: "https://example.invalid/mcp",
            disabled: true,
          },
        },
      }),
      "utf8",
    );
    const project = await initializeProject(root);

    await migrateFrom(project, "antigravity", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await applyHarness(project, await loadHarness(project.storeDir), {
      dryRun: false,
      force: true,
    });
    const settings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(settings).toMatchObject({
      permissions: { deny: ["Bash", "Write", "Edit"] },
      disableAllHooks: true,
      disabledMcpjsonServers: ["docs"],
    });

    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({ disabledMcpjsonServers: ["docs"] }, null, 2)}\n`,
      "utf8",
    );
    expect((await reconcileOnce(project)).action).toBe("captured-native");
    const canonical = await loadHarness(project.storeDir);
    canonical.metadata.description = "trigger projection after local deletion";
    await writeHarness(project.storeDir, canonical);
    expect((await reconcileOnce(project)).action).toBe("projected-canonical");
    const afterDeletion = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(afterDeletion).not.toHaveProperty("permissions");
    expect(afterDeletion).not.toHaveProperty("disableAllHooks");
  });

  it("refreshes an unowned local base before a later forced takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-refresh-base-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({ theme: "one", custom: 1 }, null, 2)}\n`,
      "utf8",
    );
    const project = await initializeProject(root);
    const harness = await loadHarness(project.storeDir);

    const skipped = await applyHarness(project, harness, {
      dryRun: false,
      force: false,
    });
    expect(skipped.find((entry) => entry.target === "claude")?.skipped)
      .toContain(settingsPath);

    await writeFile(
      settingsPath,
      `${JSON.stringify({ theme: "two", custom: 2, addedAfterSkip: true }, null, 2)}\n`,
      "utf8",
    );
    await applyHarness(project, harness, { dryRun: false, force: true });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      theme: "two",
      custom: 2,
      addedAfterSkip: true,
    });
  });

  it("does not resurrect a skipped unowned settings file after deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-delete-skipped-base-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({ theme: "should-stay-deleted" }, null, 2)}\n`,
      "utf8",
    );
    const project = await initializeProject(root);
    const harness = await loadHarness(project.storeDir);

    await applyHarness(project, harness, { dryRun: false, force: false });
    await rm(settingsPath, { force: true });
    await applyHarness(project, harness, { dryRun: false, force: true });

    expect(await pathExists(settingsPath)).toBe(false);
    expect(
      await pathExists(
        join(project.storeDir, ".local", "preserved", "claude-settings.json"),
      ),
    ).toBe(false);
  });

  it("captures clearing a managed Claude settings file to an empty object", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-empty-settings-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    const settingsPath = join(root, ".claude", "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({ outputStyle: "concise" }, null, 2)}\n`,
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    await writeFile(settingsPath, "{}\n", "utf8");
    const captured = await reconcileOnce(project);
    expect(captured.action).toBe("captured-native");
    expect((await loadHarness(project.storeDir)).overlays.claude.settings)
      .toEqual({});

    const canonical = await loadHarness(project.storeDir);
    canonical.metadata.description = "project after settings clear";
    await writeHarness(project.storeDir, canonical);
    expect((await reconcileOnce(project)).action).toBe("projected-canonical");
    expect(await pathExists(settingsPath)).toBe(false);
  });

  it("captures removal of optional Claude rule and command metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-clear-metadata-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    const rulePath = join(root, ".claude", "rules", "typescript.md");
    const commandPath = join(root, ".claude", "commands", "check.md");
    await writeFile(
      rulePath,
      "---\npaths:\n  - src/**/*.ts\n---\nUse strict TypeScript.\n",
      "utf8",
    );
    await writeFile(
      commandPath,
      "---\ndescription: Run checks\nargument-hint: '[scope]'\n---\nRun tests.\n",
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    await writeFile(rulePath, "Use strict TypeScript.\n", "utf8");
    expect((await reconcileOnce(project)).action).toBe("captured-native");
    const afterRule = await loadHarness(project.storeDir);
    expect(afterRule.rules[0]).not.toHaveProperty("globs");
    expect(afterRule.rules[0]?.targets?.claude).toEqual({});

    await writeFile(commandPath, "Run tests.\n", "utf8");
    expect((await reconcileOnce(project)).action).toBe("captured-native");
    const afterCommand = await loadHarness(project.storeDir);
    expect(afterCommand.commands.check).not.toHaveProperty("description");
    expect(afterCommand.commands.check).not.toHaveProperty("argumentHint");
    expect(afterCommand.commands.check?.targets?.claude).toEqual({});
  });

  it("round-trips TOML temporal/special scalars and exact agent whitespace through YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-toml-scalars-"));
    roots.push(root);
    await mkdir(join(root, ".codex", "agents"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".codex", "agents", "reviewer.toml"),
      'developer_instructions = "\\n    code\\n\\n"\nreview_on = 2026-09-09\n',
      "utf8",
    );
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "review_after = 2026-09-09T12:34:56Z",
        "local_date = 2026-09-09",
        "local_time = 12:34:56",
        "threshold = nan",
        "",
        "[agents.reviewer]",
        'description = "Review"',
        'config_file = "agents/reviewer.toml"',
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "codex", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
      excludeSkills: [],
    });
    const reloaded = await loadHarness(project.storeDir);
    expect(JSON.stringify(reloaded.overlays.codex)).toContain(
      "$harnessSyncTomlScalar",
    );
    expect(
      await readFile(join(project.storeDir, "agents", "reviewer.md"), "utf8"),
    ).toBe("\n    code\n\n");

    const output = join(root, "output");
    await mkdir(output, { recursive: true });
    await new CodexAdapter().apply(reloaded, {
      projectRoot: output,
      targetRoot: output,
      storeDir: project.storeDir,
      scope: "project",
    }, {
      dryRun: false,
      force: true,
      linkMode: "copy",
      activeTargets: ["codex"],
    });
    const rendered = parseToml(
      await readFile(join(output, ".codex", "config.toml"), "utf8"),
    );
    const renderedAgent = parseToml(
      await readFile(join(output, ".codex", "agents", "reviewer.toml"), "utf8"),
    );
    expect(String(rendered.review_after)).toContain("2026");
    expect((rendered.local_date as Date).toJSON()).toBe("2026-09-09");
    expect((rendered.local_time as Date).toJSON()).toBe("12:34:56.000");
    expect(Number.isNaN(rendered.threshold)).toBe(true);
    expect(renderedAgent.developer_instructions).toBe("\n    code\n\n");
    expect((renderedAgent.review_on as Date).toJSON()).toBe("2026-09-09");
  });

  it("captures edits to owned materialized files and refreshes ownership hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-owned-edit-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read", "Bash(pnpm test)"] } }),
      "utf8",
    );
    const captured = await reconcileOnce(project);
    expect(captured.action).toBe("captured-native");

    const harness = await loadHarness(project.storeDir);
    harness.metadata.description = "force a later canonical projection";
    await writeHarness(project.storeDir, harness);
    const projected = await reconcileOnce(project);
    expect(projected.action).toBe("projected-canonical");
    expect(projected.applyResults.flatMap((entry) => entry.skipped)).toEqual([]);
  });

  it("accepts a semantic-only JSON reformat without wedging reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-format-only-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Write"], allow: ["Read"] } }),
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await writeFile(
      join(root, ".claude", "settings.json"),
      '{\n  "permissions": {\n    "allow": ["Read"],\n    "deny": ["Write"]\n  }\n}\n',
      "utf8",
    );

    const accepted = await reconcileOnce(project);

    expect(accepted.action).toBe("captured-native");
    expect(accepted.conflict).toBeUndefined();
    expect(accepted.warnings).toContainEqual(
      expect.objectContaining({ code: "native-formatting-only" }),
    );
    expect((await reconcileOnce(project)).action).toBe("noop");
  });

  it("conflicts when target state changed but the ownership registry was advanced", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-stale-registry-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Write"] } }),
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] } }),
      "utf8",
    );
    await refreshManagedTargetHashes(project.storeDir, "claude");

    const result = await reconcileOnce(project);

    expect(result.action).toBe("conflict");
    expect(result.conflict?.message).toMatch(/Concurrent canonical\/native/u);
    expect((await loadHarness(project.storeDir)).permissions.commandAllow)
      .toEqual(["Write"]);
  });

  it("does not baseline malformed JSON as a formatting-only native edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-malformed-format-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.json"),
      '{"permissions":{"allow":["Read"]}}\n',
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await writeFile(
      join(root, ".claude", "settings.json"),
      '{"permissions":{"allow":["Read"],},}\n',
      "utf8",
    );

    await expect(reconcileOnce(project)).rejects.toThrow(/invalid JSON/u);
  });

  it("does not silently enroll a new unmanaged native skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-private-skill-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await mkdir(join(root, ".claude", "skills", "private-local"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".claude", "skills", "private-local", "SKILL.md"),
      "---\nname: private-local\ndescription: Local only\n---\nDo not import.\n",
      "utf8",
    );

    const result = await reconcileOnce(project);
    expect(result.action).toBe("noop");
    expect((await loadHarness(project.storeDir)).skills).toEqual([]);
  });

  it("turns deletion of a managed native path into a conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-native-delete-"));
    roots.push(root);
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await rm(join(root, ".claude", "settings.json"), { force: true });

    const result = await reconcileOnce(project);
    expect(result.action).toBe("conflict");
    expect(result.conflict?.message).toContain("was deleted");
  });

  it("does not prune a shared path that another active target still owns", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-shared-owner-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    project.config.targets.antigravity.root = "subproject";
    const harness = await loadHarness(project.storeDir);

    const results = await applyHarness(project, harness, {
      dryRun: false,
      force: false,
    });

    expect(results.flatMap((entry) => entry.skipped)).toEqual([]);
    expect(await pathExists(join(root, "AGENTS.md"))).toBe(true);
    expect(await pathExists(join(root, "subproject", "AGENTS.md"))).toBe(true);
  });

  it("captures one copy-mode edit to a path shared by Codex and Antigravity", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-copy-shared-"));
    roots.push(root);
    await writeFile(join(root, "CLAUDE.md"), "Original instructions\n", "utf8");
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    await writeFile(join(root, "AGENTS.md"), "Edited shared instructions\n", "utf8");
    const result = await reconcileOnce(project);

    expect(result.action).toBe("captured-native");
    expect(result.changedTargets).toEqual(["codex", "antigravity"]);
    expect(
      await readFile(join(project.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Edited shared instructions\n");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8"))
      .toBe("Edited shared instructions\n");
  });

  it("conflicts when a copied managed skill loses SKILL.md instead of baselining divergence", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-skill-delete-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "skills", "demo"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\nBody\n",
      "utf8",
    );
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await rm(join(root, ".claude", "skills", "demo", "SKILL.md"));

    const result = await reconcileOnce(project);

    expect(result.action).toBe("conflict");
    expect(result.conflict?.message).toContain("could not represent");
    expect(
      await readFile(join(project.storeDir, "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("Body");
  });

  it("conflicts on direct edits to a projected Codex command skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-command-edit-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "commands", "check.md"),
      "---\ndescription: Check\n---\nOriginal command\n",
      "utf8",
    );
    const project = await initializeProject(root);
    project.config.sync.linkMode = "copy";
    project.config.targets.antigravity.enabled = false;
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    await writeFile(
      join(root, ".agents", "skills", "check", "SKILL.md"),
      "---\nname: check\ndescription: Check\n---\nEdited only in Codex\n",
      "utf8",
    );
    await writeFile(join(root, "AGENTS.md"), "Representable instruction edit\n", "utf8");

    const result = await reconcileOnce(project);

    expect(result.action).toBe("conflict");
    expect(result.conflict?.message).toContain("partially representable");
    expect(await readFile(join(project.storeDir, "commands", "check.md"), "utf8"))
      .toContain("Original command");
  });

  it("rejects duplicate nested Claude agent names before writing either artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-agent-collision-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "agents", "frontend"), { recursive: true });
    await mkdir(join(root, ".claude", "agents", "backend"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "agents", "frontend", "reviewer.md"),
      "Frontend review\n",
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "agents", "backend", "reviewer.md"),
      "Backend review\n",
      "utf8",
    );
    const project = await initializeProject(root);

    await expect(migrateFrom(project, "claude", {
      apply: true,
      install: false,
      includeLocal: false,
      force: false,
      excludeSkills: [],
    })).rejects.toThrow(/Duplicate imported agent name/u);
    expect(await pathExists(join(project.storeDir, "agents", "reviewer.md"))).toBe(false);
  });

  it("preserves granular Codex approval policy and prunes derived agent declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-policy-"));
    roots.push(root);
    await mkdir(join(root, ".codex", "agents"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Instructions\n", "utf8");
    await writeFile(
      join(root, ".codex", "agents", "reviewer.toml"),
      'developer_instructions = "Review carefully"\n',
      "utf8",
    );
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[approval_policy.granular]",
        'sandbox_approval = "on-request"',
        "",
        "[agents]",
        "max_threads = 7",
        "",
        "[agents.reviewer]",
        'description = "Review code"',
        'config_file = "agents/reviewer.toml"',
        'vendor_flag = "keep"',
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);
    await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    const firstConfig = await readFile(join(root, ".codex", "config.toml"), "utf8");
    expect(firstConfig).toContain("[approval_policy.granular]");
    expect(firstConfig).toContain('vendor_flag = "keep"');
    expect(firstConfig).toContain("max_threads = 7");
    expect((await loadHarness(project.storeDir)).agents.reviewer?.description)
      .toBe("Review code");

    const harness = await loadHarness(project.storeDir);
    harness.agents = {};
    await writeHarness(project.storeDir, harness);
    await applyHarness(project, harness, { dryRun: false, force: false });
    const prunedConfig = await readFile(join(root, ".codex", "config.toml"), "utf8");
    expect(prunedConfig).not.toContain("[agents.reviewer]");
    expect(prunedConfig).toContain("[approval_policy.granular]");
    expect(prunedConfig).toContain("max_threads = 7");
  });

  it("keeps a secret-bearing Codex agent and declaration target-local", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-codex-secret-agent-"));
    roots.push(root);
    await mkdir(join(root, ".codex", "private-agents"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Instructions\n", "utf8");
    const nativeAgent = join(root, ".codex", "private-agents", "reviewer.toml");
    const literal = "private-agent-token-value-123456789";
    await writeFile(
      nativeAgent,
      `developer_instructions = "Review carefully"\napi_key = "${literal}"\n`,
      "utf8",
    );
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "[agents.reviewer]",
        'description = "Review code"',
        'config_file = "private-agents/reviewer.toml"',
        "",
      ].join("\n"),
      "utf8",
    );
    const project = await initializeProject(root);
    const result = await migrateFrom(project, "codex", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });

    expect(await readFile(nativeAgent, "utf8")).toContain(literal);
    const config = await readFile(join(root, ".codex", "config.toml"), "utf8");
    expect(config).toContain('config_file = "private-agents/reviewer.toml"');
    expect(result.projections.find((entry) => entry.target === "codex")?.warnings)
      .toContainEqual(
        expect.objectContaining({ code: "agent-secret-reference-not-projected" }),
      );
    expect(await readFile(join(project.storeDir, "harness.yaml"), "utf8"))
      .not.toContain(literal);
  });

  it("captures a native settings edit while a projected skill symlink points at the live store", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sync-stage-symlink-"));
    roots.push(root);
    await mkdir(join(root, ".claude", "skills", "review"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
    await writeFile(
      join(root, ".claude", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nReview carefully.\n",
      "utf8",
    );
    const settingsPath = join(root, ".claude", "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`,
      "utf8",
    );

    const project = await initializeProject(root);
    await migrateFrom(project, "claude", {
      apply: true,
      install: true,
      includeLocal: false,
      force: true,
      excludeSkills: [],
    });
    expect((await lstat(join(root, ".claude", "skills", "review"))).isSymbolicLink())
      .toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
    };
    settings.permissions.allow.push("Bash(pwd:*)");
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    expect((await reconcileOnce(project)).action).toBe("captured-native");
    expect((await loadHarness(project.storeDir)).permissions.commandAllow)
      .toContain("Bash(pwd:*)");
  });
});

describe("link mode switching", () => {
  async function seedProject(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    const project = await initializeProject(root);
    await mkdir(join(project.storeDir, "skills", "demo", "references"), {
      recursive: true,
    });
    await writeFile(
      join(project.storeDir, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: demo skill\n---\n\nbody\n",
      "utf8",
    );
    await writeFile(
      join(project.storeDir, "skills", "demo", "references", "notes.md"),
      "note\n",
      "utf8",
    );
    const harness = await loadHarness(project.storeDir);
    harness.skills.push({ name: "demo", path: "skills/demo" });
    await writeHarness(project.storeDir, harness);
    return { root, project, harness: await loadHarness(project.storeDir) };
  }

  it("replaces managed symlinks with copies when the mode changes, without --force", async () => {
    const { root, project, harness } = await seedProject("harness-sync-linkmode-copy-");
    await applyHarness(project, harness, { dryRun: false, force: false });
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(true);

    project.config.sync.linkMode = "copy";
    const results = await applyHarness(project, harness, { dryRun: false, force: false });

    expect(results.flatMap((result) => result.skipped)).toEqual([]);
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("#");
    expect(await pathExists(join(root, ".claude", "skills", "demo", "references", "notes.md")))
      .toBe(true);
    expect((await lstat(join(root, ".claude", "skills", "demo"))).isDirectory()).toBe(true);
  });

  it("restores symlinks from managed copies when the mode changes back", async () => {
    const { root, project, harness } = await seedProject("harness-sync-linkmode-link-");
    project.config.sync.linkMode = "copy";
    await applyHarness(project, harness, { dryRun: false, force: false });
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(false);

    project.config.sync.linkMode = "symlink";
    const results = await applyHarness(project, harness, { dryRun: false, force: false });

    expect(results.flatMap((result) => result.skipped)).toEqual([]);
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "CLAUDE.md"))).toContain("instructions");
  });

  it("still refuses an occupant it does not own, and keeps it", async () => {
    const { root, project, harness } = await seedProject("harness-sync-linkmode-foreign-");
    await applyHarness(project, harness, { dryRun: false, force: false });
    await rm(join(root, "CLAUDE.md"), { force: true });
    await writeFile(join(root, "CLAUDE.md"), "hand written\n", "utf8");

    const results = await applyHarness(project, harness, { dryRun: false, force: false });

    expect(results.flatMap((result) => result.skipped)).toContain(join(root, "CLAUDE.md"));
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("hand written\n");
  });
});

describe("skill import exclusion", () => {
  async function nativeTreeWithTwoBadSkills(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    const skills = join(root, ".claude", "skills");
    await mkdir(skills, { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");

    // importable
    await mkdir(join(skills, "alpha-normal"), { recursive: true });
    await writeFile(join(skills, "alpha-normal", "SKILL.md"), "---\nname: alpha-normal\n---\nbody\n");

    // a skill that IS a symlink to a directory outside the project (the b200 shape)
    const outside = join(root, "external", "linked-skill");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "---\nname: bravo-external\n---\nbody\n");
    await symlink(outside, join(skills, "bravo-external"), "dir");

    // a normal skill directory holding a nested symlink (the node_modules shape)
    const nested = join(skills, "charlie-nested", "deps", "bin");
    await mkdir(nested, { recursive: true });
    await writeFile(join(skills, "charlie-nested", "SKILL.md"), "---\nname: charlie-nested\n---\nbody\n");
    await writeFile(join(skills, "charlie-nested", "deps", "real.js"), "1\n");
    await symlink("../real.js", join(nested, "tool"));

    return { root, skills };
  }

  const opts = (excludeSkills: string[]) => ({
    apply: true,
    install: false,
    includeLocal: false,
    force: true,
    excludeSkills,
  });

  it("still fails without the flag, and fails again on the second blocker", async () => {
    const { root } = await nativeTreeWithTwoBadSkills("harness-sync-exclude-control-");
    const project = await initializeProject(root);

    await expect(migrateFrom(project, "claude", opts([]))).rejects.toThrow(
      /unmanaged symlinked directory/u,
    );
    // excluding only the first reveals the second — two independent gates
    await expect(
      migrateFrom(project, "claude", opts(["bravo-external"])),
    ).rejects.toThrow(/nested symlink/u);
  });

  it("imports the rest once both are excluded, and says which were excluded", async () => {
    const { root } = await nativeTreeWithTwoBadSkills("harness-sync-exclude-apply-");
    const project = await initializeProject(root);

    const result = await migrateFrom(
      project,
      "claude",
      opts(["charlie-nested", "bravo-external"]),
    );

    expect(result.summary.skills).toBe(1);
    expect(result.excluded).toEqual({ skills: ["bravo-external", "charlie-nested"] });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "import-excluded" })]),
    );
    const harness = await loadHarness(project.storeDir);
    expect(harness.skills.map((skill) => skill.name)).toEqual(["alpha-normal"]);
    expect(await pathExists(join(project.storeDir, "skills", "bravo-external"))).toBe(false);
    expect(await pathExists(join(project.storeDir, "skills", "charlie-nested"))).toBe(false);
  });

  it("leaves the excluded native paths exactly as they were", async () => {
    const { root, skills } = await nativeTreeWithTwoBadSkills("harness-sync-exclude-native-");
    const project = await initializeProject(root);
    const before = await readlink(join(skills, "bravo-external"));

    await migrateFrom(project, "claude", opts(["charlie-nested", "bravo-external"]));

    expect((await lstat(join(skills, "bravo-external"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(skills, "bravo-external"))).toBe(before);
    expect((await lstat(join(skills, "charlie-nested", "deps", "bin", "tool"))).isSymbolicLink())
      .toBe(true);
  });

  it("treats an unmatched name as a no-op rather than a silent success", async () => {
    const { root } = await nativeTreeWithTwoBadSkills("harness-sync-exclude-typo-");
    const project = await initializeProject(root);

    await expect(
      migrateFrom(project, "claude", opts(["bravo-externl"])),
    ).rejects.toThrow(/unmanaged symlinked directory/u);
  });

  it("does not remove a canonical skill that a later run excludes", async () => {
    const { root } = await nativeTreeWithTwoBadSkills("harness-sync-exclude-keep-");
    const project = await initializeProject(root);
    await migrateFrom(project, "claude", opts(["charlie-nested", "bravo-external"]));

    await migrateFrom(
      project,
      "claude",
      opts(["charlie-nested", "bravo-external", "alpha-normal"]),
    );

    const harness = await loadHarness(project.storeDir);
    expect(harness.skills.map((skill) => skill.name)).toContain("alpha-normal");
  });
});
