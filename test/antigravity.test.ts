import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../src/adapters/antigravity.js";
import type { AdapterContext } from "../src/adapters/adapter.js";
import { defaultHarness } from "../src/core/config.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { pathExists } from "../src/core/fs.js";
import { managedPathsForTarget } from "../src/core/writer.js";

const roots: string[] = [];
const adapter = new AntigravityAdapter();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Antigravity adapter", () => {
  it("imports GEMINI.md as a fallback and watches both instruction names without auto-enrolling unmanaged files", async () => {
    const fixture = await makeFixture();
    const agentsPath = join(fixture.nativeRoot, "AGENTS.md");
    const geminiPath = join(fixture.nativeRoot, "GEMINI.md");
    await writeFile(geminiPath, "Gemini fallback\n", "utf8");

    const before = await adapter.fingerprint(fixture.context);
    await writeFile(geminiPath, "Updated Gemini fallback\n", "utf8");
    const after = await adapter.fingerprint(fixture.context);
    const fallback = await adapter.capture(
      defaultHarness("fallback"),
      fixture.context,
      captureOptions,
    );

    expect(after).toBe(before);
    expect(adapter.watchPaths(fixture.context)).toEqual(
      expect.arrayContaining([agentsPath, geminiPath]),
    );
    expect(fallback.imported).toContain(geminiPath);
    expect(
      await readFile(join(fixture.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Updated Gemini fallback\n");

    const installedFallback = await adapter.apply(fallback.harness, fixture.context, {
      ...applyOptions,
      force: true,
      linkMode: "symlink",
    });
    expect(installedFallback.linked).toContain(geminiPath);
    expect((await lstat(geminiPath)).isSymbolicLink()).toBe(true);
    expect(await pathExists(agentsPath)).toBe(false);
    await writeFile(
      join(fixture.storeDir, "instructions", "root.md"),
      "Live canonical update\n",
      "utf8",
    );
    expect(await readFile(geminiPath, "utf8")).toBe("Live canonical update\n");

    await writeFile(agentsPath, "Agents takes priority\n", "utf8");
    const both = await adapter.capture(
      fallback.harness,
      fixture.context,
      captureOptions,
    );

    expect(both.imported).toContain(agentsPath);
    expect(both.warnings).toContainEqual(
      expect.objectContaining({ code: "multiple-antigravity-instructions" }),
    );
    expect(
      await readFile(join(fixture.storeDir, "instructions", "root.md"), "utf8"),
    ).toBe("Agents takes priority\n");

    const refused = await adapter.apply(both.harness, fixture.context, applyOptions);
    expect(refused.skipped).toContain(geminiPath);
    expect(refused.warnings).toContainEqual(
      expect.objectContaining({ code: "multiple-antigravity-instructions" }),
    );
    expect(await pathExists(agentsPath)).toBe(true);
    expect(await pathExists(geminiPath)).toBe(true);

    const resolved = await adapter.apply(both.harness, fixture.context, {
      ...applyOptions,
      force: true,
      linkMode: "symlink",
    });
    expect(resolved.removed).toContain(geminiPath);
    expect(await pathExists(geminiPath)).toBe(false);
    expect((await lstat(agentsPath)).isSymbolicLink()).toBe(true);
  });

  it("keeps Antigravity agent model and tools in its target overlay", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    await mkdir(join(fixture.nativeRoot, ".agents", "agents"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.nativeRoot, ".agents", "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Review Antigravity changes",
        "model: pro",
        "tools:",
        "  - run_command",
        "---",
        "Review carefully.",
        "",
      ].join("\n"),
      "utf8",
    );

    const captured = await adapter.capture(
      defaultHarness("agents"),
      fixture.context,
      captureOptions,
    );
    const reviewer = captured.harness.agents.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer).not.toHaveProperty("model");
    expect(reviewer).not.toHaveProperty("tools");
    expect(reviewer?.targets?.antigravity).toMatchObject({
      model: "pro",
      tools: ["run_command"],
    });

    const genericInstructions = "agents/generic.md";
    await mkdir(join(fixture.storeDir, "agents"), { recursive: true });
    await writeFile(
      join(fixture.storeDir, genericInstructions),
      "Generic agent instructions.\n",
      "utf8",
    );
    captured.harness.agents.generic = {
      description: "Imported from another harness",
      instructionsFile: genericInstructions,
      model: "sonnet",
      tools: ["Bash"],
    };

    const output = await makeOutputContext(fixture);
    await adapter.apply(captured.harness, output, applyOptions);

    const nativeReviewer = parseFrontmatter(
      await readFile(join(output.targetRoot, ".agents", "agents", "reviewer.md"), "utf8"),
    );
    const nativeGeneric = parseFrontmatter(
      await readFile(join(output.targetRoot, ".agents", "agents", "generic.md"), "utf8"),
    );
    expect(nativeReviewer.data).toMatchObject({
      model: "pro",
      tools: ["run_command"],
    });
    expect(nativeGeneric.data).not.toHaveProperty("model");
    expect(nativeGeneric.data).not.toHaveProperty("tools");
  });

  it("preserves an imported Antigravity agent bundle path", async () => {
    const fixture = await makeFixture();
    const bundle = join(
      fixture.nativeRoot,
      ".agents",
      "agents",
      "reviewer",
    );
    await mkdir(bundle, { recursive: true });
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n");
    await writeFile(
      join(bundle, "agent.md"),
      "---\nname: reviewer\ndescription: Review\n---\nReview carefully.\n",
    );

    const captured = await adapter.capture(
      defaultHarness("agent-bundle"),
      fixture.context,
      captureOptions,
    );
    await adapter.apply(captured.harness, fixture.context, {
      ...applyOptions,
      force: true,
    });

    expect(captured.harness.agents.reviewer?.nativePaths?.antigravity)
      .toBe("reviewer/agent.md");
    expect(await pathExists(join(bundle, "agent.md"))).toBe(true);
    expect(
      await pathExists(
        join(fixture.nativeRoot, ".agents", "agents", "reviewer.md"),
      ),
    ).toBe(false);
  });

  it("uses the directory name for official directory-form agents", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    const agentDir = join(
      fixture.nativeRoot,
      ".agents",
      "agents",
      "reviewer",
    );
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "agent.md"),
      "---\ndescription: Directory reviewer\n---\nReview.\n",
      "utf8",
    );

    const captured = await adapter.capture(
      defaultHarness("directory-agent"),
      fixture.context,
      captureOptions,
    );

    expect(captured.harness.agents.reviewer).toMatchObject({
      description: "Directory reviewer",
      instructionsFile: "agents/reviewer.md",
    });
    expect(captured.harness.agents).not.toHaveProperty("agent");
  });

  it("preserves nested rule paths and rejects rules over 12,000 characters", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    const rulesRoot = join(fixture.nativeRoot, ".agents", "rules");
    await mkdir(join(rulesRoot, "backend"), { recursive: true });
    await mkdir(join(rulesRoot, "frontend"), { recursive: true });
    await writeFile(join(rulesRoot, "backend", "shared.md"), "Backend rule\n", "utf8");
    await writeFile(join(rulesRoot, "frontend", "shared.md"), "Frontend rule\n", "utf8");
    await writeFile(join(rulesRoot, "too-long.md"), "x".repeat(12_001), "utf8");

    const captured = await adapter.capture(
      defaultHarness("rules"),
      fixture.context,
      captureOptions,
    );

    expect(captured.harness.rules.map((rule) => rule.path)).toEqual([
      "rules/backend/shared.md",
      "rules/frontend/shared.md",
    ]);
    expect(captured.warnings).toContainEqual(
      expect.objectContaining({ code: "antigravity-rule-too-long" }),
    );

    const canonicalLongRule = join(fixture.storeDir, "rules", "canonical-long.md");
    await writeFile(canonicalLongRule, "y".repeat(12_001), "utf8");
    captured.harness.rules.push({ path: "rules/canonical-long.md" });

    const output = await makeOutputContext(fixture);
    const result = await adapter.apply(captured.harness, output, applyOptions);

    expect(
      await readFile(
        join(output.targetRoot, ".agents", "rules", "backend", "shared.md"),
        "utf8",
      ),
    ).toBe("Backend rule\n");
    expect(
      await readFile(
        join(output.targetRoot, ".agents", "rules", "frontend", "shared.md"),
        "utf8",
      ),
    ).toBe("Frontend rule\n");
    expect(result.skipped).toContain(
      join(output.targetRoot, ".agents", "rules", "canonical-long.md"),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "antigravity-rule-too-long" }),
    );

    await writeFile(
      join(fixture.storeDir, "rules", "backend", "shared.md"),
      "z".repeat(12_001),
      "utf8",
    );
    const rejectedUpdate = await adapter.apply(
      captured.harness,
      output,
      applyOptions,
    );
    expect(rejectedUpdate.skipped).toContain(
      join(output.targetRoot, ".agents", "rules", "backend", "shared.md"),
    );
    expect(
      await readFile(
        join(output.targetRoot, ".agents", "rules", "backend", "shared.md"),
        "utf8",
      ),
    ).toBe("Backend rule\n");
  });

  it("does not copy a managed skill symlink back onto its canonical target", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    const canonicalSkill = join(fixture.storeDir, "skills", "review");
    const nativeSkills = join(fixture.nativeRoot, ".agents", "skills");
    await mkdir(canonicalSkill, { recursive: true });
    await mkdir(nativeSkills, { recursive: true });
    await writeFile(
      join(canonicalSkill, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\nReview.\n",
      "utf8",
    );
    await symlink(
      canonicalSkill,
      join(nativeSkills, "review"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const captured = await adapter.capture(
      defaultHarness("self-copy"),
      fixture.context,
      captureOptions,
    );

    expect(captured.harness.skills).toEqual([
      { name: "review", path: "skills/review" },
    ]);
    expect(await readFile(join(canonicalSkill, "SKILL.md"), "utf8")).toContain(
      "description: Review code",
    );
  });

  it("preserves canonical secret references omitted from a lossy native MCP projection", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await writeFile(
      join(fixture.storeDir, "instructions", "root.md"),
      "Instructions\n",
      "utf8",
    );
    const harness = defaultHarness("mcp-lossless-capture");
    harness.mcpServers.demo = {
      transport: "stdio",
      command: "node",
      args: ["one.js"],
      env: { TOKEN: "${env:TOKEN}" },
    };
    harness.mcpServers.socket = {
      transport: "ws",
      url: "wss://example.invalid/mcp",
    };
    await adapter.apply(harness, fixture.context, applyOptions);
    const mcpPath = join(fixture.nativeRoot, ".agents", "mcp_config.json");
    const native = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: { demo: { args: string[] } };
    };
    native.mcpServers.demo.args = ["two.js"];
    await writeFile(mcpPath, `${JSON.stringify(native, null, 2)}\n`, "utf8");

    const captured = await adapter.capture(harness, fixture.context, {
      ...captureOptions,
      managedPaths: await managedPathsForTarget(
        fixture.storeDir,
        "antigravity",
      ),
    });

    expect(captured.harness.mcpServers.demo).toMatchObject({
      args: ["two.js"],
      env: { TOKEN: "${env:TOKEN}" },
    });
    expect(captured.harness.mcpServers.socket).toMatchObject({
      transport: "ws",
      url: "wss://example.invalid/mcp",
    });
  });

  it("preserves unknown fields only for canonical MCP servers and projects WebSocket serverUrl", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await writeFile(
      join(fixture.storeDir, "instructions", "root.md"),
      "Instructions\n",
      "utf8",
    );
    const harness = defaultHarness("mcp-prune");
    harness.mcpServers.demo = {
      transport: "http",
      url: "https://example.invalid/mcp",
    };
    harness.mcpServers.socket = {
      transport: "ws",
      url: "wss://example.invalid/mcp",
    };
    harness.overlays.antigravity.mcp = {
      mcpServers: {
        demo: { futureOption: "keep" },
        ghost: { futureOption: "remove" },
      },
    };

    const first = await adapter.apply(harness, fixture.context, applyOptions);
    const firstNative = JSON.parse(
      await readFile(join(fixture.nativeRoot, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(firstNative.mcpServers.demo).toMatchObject({ futureOption: "keep" });
    expect(firstNative.mcpServers).not.toHaveProperty("ghost");
    expect(firstNative.mcpServers.socket).toMatchObject({
      serverUrl: "wss://example.invalid/mcp",
    });
    expect(first.warnings).not.toContainEqual(
      expect.objectContaining({ code: "mcp-transport-not-projected" }),
    );

    harness.mcpServers = {};
    await adapter.apply(harness, fixture.context, applyOptions);
    const pruned = JSON.parse(
      await readFile(join(fixture.nativeRoot, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(pruned.mcpServers).toEqual({});
  });

  it("preserves unmanaged restrictive MCP controls across repeated takeover applies", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await mkdir(join(fixture.nativeRoot, ".agents"), { recursive: true });
    await writeFile(join(fixture.storeDir, "instructions", "root.md"), "Instructions\n");
    await writeFile(
      join(fixture.nativeRoot, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            serverUrl: "https://example.invalid/mcp",
            disabled: true,
            disabledTools: ["write_remote"],
          },
        },
      }),
    );
    const harness = defaultHarness("preserve-mcp-controls");
    harness.mcpServers.docs = {
      transport: "http",
      url: "https://example.invalid/mcp",
    };

    await adapter.apply(harness, fixture.context, {
      ...applyOptions,
      force: true,
    });
    await adapter.apply(harness, fixture.context, {
      ...applyOptions,
      force: true,
    });
    const native = JSON.parse(
      await readFile(join(fixture.nativeRoot, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { docs: Record<string, unknown> } };

    expect(native.mcpServers.docs).toMatchObject({
      disabled: true,
      disabledTools: ["write_remote"],
    });
  });

  it("disables enabledTools servers instead of widening their Antigravity tool set", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await writeFile(join(fixture.storeDir, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("enabled-tools");
    harness.mcpServers.docs = {
      transport: "http",
      url: "https://example.invalid/mcp",
      enabled: true,
      enabledTools: ["read_remote"],
    };

    const result = await adapter.apply(harness, fixture.context, applyOptions);
    const native = JSON.parse(
      await readFile(join(fixture.nativeRoot, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { docs: Record<string, unknown> } };

    expect(native.mcpServers.docs).toMatchObject({ disabled: true });
    expect(native.mcpServers.docs).not.toHaveProperty("enabledTools");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "mcp-enabled-tools-not-projected" }),
    );

    harness.mcpServers.docs.enabledTools = [];
    const emptyResult = await adapter.apply(harness, fixture.context, {
      ...applyOptions,
      force: true,
    });
    const emptyNative = JSON.parse(
      await readFile(join(fixture.nativeRoot, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { docs: Record<string, unknown> } };

    expect(emptyNative.mcpServers.docs).toMatchObject({ disabled: true });
    expect(emptyResult.warnings).toContainEqual(
      expect.objectContaining({ code: "mcp-enabled-tools-not-projected" }),
    );
  });

  it("does not promote a generated remote fallback into an Antigravity contract", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await writeFile(join(fixture.storeDir, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("fallback-roundtrip");
    harness.mcpServers.dangerous = {
      transport: "http",
      url: "https://example.invalid/mcp",
      requiredNativeFeatures: { codex: ["settings.mcpHooks"] },
    };

    await adapter.apply(harness, fixture.context, applyOptions);
    const captured = await adapter.capture(
      harness,
      fixture.context,
      captureOptions,
    );

    expect(captured.harness.mcpServers.dangerous?.requiredNativeFeatures)
      .toEqual({ codex: ["settings.mcpHooks"] });
    expect(captured.harness.mcpServers.dangerous?.requiredNativeFeatures)
      .not.toHaveProperty("antigravity");
  });

  it("disables a native OAuth server when its client secret was redacted", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await writeFile(join(fixture.storeDir, "instructions", "root.md"), "Instructions\n");
    const harness = defaultHarness("oauth-redaction");
    harness.mcpServers.secure = {
      transport: "http",
      url: "https://example.invalid/mcp",
      requiredNativeFeatures: { antigravity: ["oauth"] },
    };
    harness.overlays.antigravity.mcp = {
      mcpServers: {
        secure: {
          oauth: {
            clientId: "public-client",
            clientSecret: "${env:CLIENT_SECRET}",
          },
        },
      },
    };

    const result = await adapter.apply(harness, fixture.context, applyOptions);
    const native = JSON.parse(
      await readFile(join(fixture.nativeRoot, ".agents", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { secure: Record<string, unknown> } };

    expect(native.mcpServers.secure).toMatchObject({
      disabled: true,
      oauth: { clientId: "public-client" },
    });
    expect(JSON.stringify(native)).not.toContain("CLIENT_SECRET");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "mcp-native-secret-not-projected" }),
    );
  });

  it("retires standalone skill sources before installing bundle projections", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    const skillsRoot = join(fixture.nativeRoot, ".agents", "skills");
    await mkdir(skillsRoot, { recursive: true });
    const standalone = join(skillsRoot, "audit.md");
    await writeFile(standalone, "Audit carefully.\n", "utf8");
    const captured = await adapter.capture(
      defaultHarness("standalone-skill"),
      fixture.context,
      captureOptions,
    );

    const result = await adapter.apply(captured.harness, fixture.context, {
      ...applyOptions,
      force: true,
    });

    expect(result.removed).toContain(standalone);
    expect(await pathExists(standalone)).toBe(false);
    expect(
      await readFile(join(skillsRoot, "audit", "SKILL.md"), "utf8"),
    ).toBe("Audit carefully.\n");
  });

  it("does not project another target's nonportable rules", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.storeDir, "instructions"), { recursive: true });
    await mkdir(join(fixture.storeDir, "rules"), { recursive: true });
    await writeFile(join(fixture.storeDir, "instructions", "root.md"), "Instructions\n");
    await writeFile(join(fixture.storeDir, "rules", "claude-only.md"), "Claude only\n");
    const harness = defaultHarness("scoped-rule");
    harness.rules = [{
      path: "rules/claude-only.md",
      portable: false,
      targets: { claude: { paths: ["src/**"] } },
    }];

    await adapter.apply(harness, fixture.context, applyOptions);

    expect(
      await pathExists(
        join(fixture.nativeRoot, ".agents", "rules", "claude-only.md"),
      ),
    ).toBe(false);
  });

  it("redacts environment credentials embedded in target-native hook commands", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    await mkdir(join(fixture.nativeRoot, ".agents"), { recursive: true });
    await writeFile(
      join(fixture.nativeRoot, ".agents", "hooks.json"),
      JSON.stringify({
        hooks: {
          report: {
            command: "SENTRY_AUTH_TOKEN=hook-private-value-123456 ./report.sh",
          },
        },
      }),
      "utf8",
    );

    const captured = await adapter.capture(
      defaultHarness("hook-secrets"),
      fixture.context,
      captureOptions,
    );
    const serialized = JSON.stringify(captured.harness.overlays.antigravity);

    expect(serialized).not.toContain("hook-private-value-123456");
    expect(serialized).toContain("${env:SENTRY_AUTH_TOKEN}");
    expect(captured.warnings).toContainEqual(
      expect.objectContaining({ code: "secret-redacted" }),
    );

    const result = await adapter.apply(captured.harness, fixture.context, {
      ...applyOptions,
      force: true,
    });
    expect(await pathExists(join(fixture.nativeRoot, ".agents", "hooks.json")))
      .toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "hook-secret-reference-not-projected" }),
    );
  });

  it("disables an MCP server when its redacted blocking hook cannot be restored", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.nativeRoot, "AGENTS.md"), "Instructions\n", "utf8");
    await mkdir(join(fixture.nativeRoot, ".agents"), { recursive: true });
    await writeFile(
      join(fixture.nativeRoot, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          dangerous: { command: "/usr/bin/printf", args: ["hello"] },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(fixture.nativeRoot, ".agents", "hooks.json"),
      JSON.stringify({
        guard: {
          PreToolUse: [
            {
              matcher: "mcp__dangerous__.*",
              hooks: [
                {
                  type: "command",
                  command:
                    "SENTRY_AUTH_TOKEN=hook-private-value-123456 ./guard.sh",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const captured = await adapter.capture(
      defaultHarness("blocking-hook-secrets"),
      fixture.context,
      captureOptions,
    );
    expect(captured.harness.mcpServers.dangerous?.requiredNativeFeatures)
      .toEqual({
        antigravity: ["settings.projectTrust", "settings.mcpHooks"],
      });

    const result = await adapter.apply(captured.harness, fixture.context, {
      ...applyOptions,
      force: true,
    });
    const native = JSON.parse(
      await readFile(
        join(fixture.nativeRoot, ".agents", "mcp_config.json"),
        "utf8",
      ),
    ) as { mcpServers: { dangerous: Record<string, unknown> } };

    expect(native.mcpServers.dangerous.disabled).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "mcp-native-hook-not-projected" }),
    );
    expect(await pathExists(join(fixture.nativeRoot, ".agents", "hooks.json")))
      .toBe(false);
  });
});

const captureOptions = {
  includeLocal: false,
  includeAssets: true,
  write: true,
} as const;

const applyOptions = {
  dryRun: false,
  force: false,
  linkMode: "copy",
} as const;

async function makeFixture(): Promise<{
  root: string;
  nativeRoot: string;
  storeDir: string;
  context: AdapterContext;
}> {
  const root = await mkdtemp(join(tmpdir(), "harness-sync-antigravity-"));
  roots.push(root);
  const nativeRoot = join(root, "native");
  const storeDir = join(root, "store");
  await Promise.all([
    mkdir(nativeRoot, { recursive: true }),
    mkdir(storeDir, { recursive: true }),
  ]);
  return {
    root,
    nativeRoot,
    storeDir,
    context: {
      projectRoot: nativeRoot,
      targetRoot: nativeRoot,
      storeDir,
      scope: "project",
    },
  };
}

async function makeOutputContext(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
): Promise<AdapterContext> {
  const targetRoot = join(fixture.root, "output");
  await mkdir(targetRoot, { recursive: true });
  return {
    projectRoot: targetRoot,
    targetRoot,
    storeDir: fixture.storeDir,
    scope: "project",
  };
}
