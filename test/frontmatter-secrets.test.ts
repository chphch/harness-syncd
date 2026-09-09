import { describe, expect, it } from "vitest";
import {
  captureMcpServers,
  mergeCapturedAgents,
  mergeCapturedMcpServers,
  mergeCapturedRules,
  mergeMcpServerOverlays,
  mcpRequiresForeignNativeFeatures,
  mcpServerOverlays,
  renderMcpServers,
} from "../src/adapters/common.js";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/frontmatter.js";
import { redactSecrets } from "../src/core/secrets.js";

describe("frontmatter", () => {
  it("round-trips metadata and body", () => {
    const source = stringifyFrontmatter(
      { name: "review", description: "Review code" },
      "Check behavior.\n",
    );
    expect(parseFrontmatter(source)).toEqual({
      data: { name: "review", description: "Review code" },
      body: "Check behavior.\n",
    });
  });

  it("preserves leading blank lines and indentation in the authored body", () => {
    const body = "\n    echo indented\n\n";
    const source = stringifyFrontmatter({ name: "indent" }, body);

    expect(parseFrontmatter(source).body).toBe(body);
  });

  it("rejects unterminated or non-object frontmatter", () => {
    expect(() => parseFrontmatter("---\nname: broken\nbody\n"))
      .toThrow(/missing closing/u);
    expect(() => parseFrontmatter("---\n- invalid\n---\nbody\n"))
      .toThrow(/must be an object/u);
  });
});

describe("secret redaction", () => {
  it("replaces literals but preserves environment references", () => {
    const result = redactSecrets({
      apiKey: "literal-value",
      token: "${TOKEN}",
      nested: { client_secret: "another-value" },
    });
    expect(result.value).toEqual({
      apiKey: "${env:APIKEY}",
      token: "${TOKEN}",
      nested: { client_secret: "${env:CLIENT_SECRET}" },
    });
    expect(result.warnings).toHaveLength(2);
  });

  it("redacts Basic-auth passwords in hook commands and argument arrays", () => {
    const result = redactSecrets({
      command: "curl --user user:very-long-private-password https://example.invalid",
      args: ["--user", "other:another-private-password"],
    });
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("very-long-private-password");
    expect(serialized).not.toContain("another-private-password");
    expect(serialized).toContain("${env:BASIC_AUTH_PASSWORD}");
    expect(result.warnings).toHaveLength(2);
  });

  it("redacts URL userinfo and query credentials inside hook commands", () => {
    const result = redactSecrets({
      command:
        "curl https://monitor:monitor-private-password@audit.invalid/report?token=query-secret-value",
    });
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("monitor-private-password");
    expect(serialized).not.toContain("query-secret-value");
    expect(serialized).toContain("${env:URL_PASSWORD}");
    expect(serialized).toContain("${env:TOKEN}");
    expect(result.warnings).toHaveLength(2);
  });

  it("redacts split and combined credential flags inside hook commands", () => {
    const result = redactSecrets({
      command:
        "audit-client --token generic-hook-private-token-value-1234567890 " +
        "--client-secret=combined-private-value-123456 " +
        "--header 'Authorization: Bearer header-private-value-123456'",
    });
    const command = result.value.command;

    expect(command).not.toContain("generic-hook-private-token");
    expect(command).not.toContain("combined-private-value");
    expect(command).not.toContain("header-private-value");
    expect(command).toContain("--token ${env:TOKEN}");
    expect(command).toContain("--client-secret=${env:CLIENT_SECRET}");
    expect(command).toContain("Authorization: Bearer ${env:AUTHORIZATION}");
    expect(result.warnings).toHaveLength(3);
  });

  it("redacts URL credentials nested in executable argument arrays", () => {
    const result = redactSecrets({
      args: [
        "--endpoint",
        "https://service:url-private-password@api.invalid/mcp?token=query-private-token",
      ],
    });
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("url-private-password");
    expect(serialized).not.toContain("query-private-token");
    expect(serialized).toContain("${env:URL_PASSWORD}");
    expect(serialized).toContain("${env:TOKEN}");
  });

  it("redacts combined secret and authorization flags in argument arrays", () => {
    const result = redactSecrets({
      args: [
        "--token=generic-private-token-value-1234567890",
        "--client-secret=another-private-value-123456",
        "--header=Authorization: Bearer bearer-private-value-123456",
      ],
    });
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("generic-private-token-value");
    expect(serialized).not.toContain("another-private-value");
    expect(serialized).not.toContain("bearer-private-value");
    expect(result.value).toEqual({
      args: [
        "--token=${env:TOKEN}",
        "--client-secret=${env:CLIENT_SECRET}",
        "--header=Authorization: Bearer ${env:AUTHORIZATION}",
      ],
    });
    expect(result.warnings).toHaveLength(3);
  });

  it("preserves documented environment-variable names and templated auth", () => {
    const result = redactSecrets({
      bearer_token_env_var: "PRIVATE_API_TOKEN",
      headers: { Authorization: "Bearer ${PRIVATE_API_TOKEN}" },
    });

    expect(result.value).toEqual({
      bearer_token_env_var: "PRIVATE_API_TOKEN",
      headers: { Authorization: "Bearer ${PRIVATE_API_TOKEN}" },
    });
    expect(result.warnings).toEqual([]);
  });
});

describe("MCP translation", () => {
  it("round-trips Codex startup_timeout_sec through canonical milliseconds", () => {
    const native = {
      demo: { command: "node", startup_timeout_sec: 2.5 },
    };
    const captured = captureMcpServers(native, "mcp_servers");

    expect(captured.servers.demo?.startupTimeoutMs).toBe(2_500);
    expect(renderMcpServers(captured.servers, "snake").demo).toMatchObject({
      startup_timeout_sec: 2.5,
    });
    expect(mcpServerOverlays(native)).toEqual({});
  });

  it("adapts a Codex Bearer token environment name to Claude headers", () => {
    const captured = captureMcpServers({
      secure: {
        url: "https://example.invalid/mcp",
        bearer_token_env_var: "PRIVATE_API_TOKEN",
      },
    }, "mcp_servers");

    expect(captured.servers.secure?.bearerTokenEnvVar)
      .toBe("PRIVATE_API_TOKEN");
    expect(renderMcpServers(captured.servers, "snake").secure).toMatchObject({
      bearer_token_env_var: "PRIVATE_API_TOKEN",
    });
    expect(renderMcpServers(captured.servers, "camel").secure).toMatchObject({
      headers: { Authorization: "Bearer ${PRIVATE_API_TOKEN}" },
    });
  });

  it("rejects malformed known MCP fields instead of silently dropping them", () => {
    expect(() => captureMcpServers(
      { broken: { command: "node", args: "server.js" } },
      "mcp_servers",
    )).toThrow(/broken\.args.*array of strings/u);
    expect(() => captureMcpServers(
      { broken: { type: "grpc", url: "grpc:\/\/localhost" } },
      "mcp_servers",
    )).toThrow(/unsupported MCP transport/u);
    expect(() => captureMcpServers(
      {
        broken: {
          url: "https://one.invalid/mcp",
          serverUrl: "https://two.invalid/mcp",
        },
      },
      "mcp_servers",
    )).toThrow(/conflicting aliases/u);
    expect(() => captureMcpServers(
      {
        broken: {
          command: "node",
          experimental_environment: "somewhere",
        },
      },
      "mcp_servers",
    )).toThrow(/experimental_environment/u);
    expect(() => captureMcpServers(
      { dormant: { url: "https://example.invalid/mcp" } },
      "mcpServers",
      "claude",
    )).toThrow(/explicit transport type/u);
    expect(() => captureMcpServers(
      {
        ambiguous: {
          command: "server",
          url: "https://example.invalid/mcp",
        },
      },
      "mcp_servers",
      "codex",
    )).toThrow(/both command and URL/u);
    expect(() => captureMcpServers(
      {
        workspace: {
          type: "http",
          url: "https://example.invalid/mcp",
        },
      },
      "mcpServers",
      "claude",
    )).toThrow(/reserves this built-in MCP server name/u);
    expect(() => captureMcpServers(
      { dormant: { serverUrl: "https://example.invalid/mcp" } },
      "mcp_servers",
      "codex",
    )).toThrow(/codex remote MCP servers require url/u);
    expect(() => captureMcpServers(
      { dormant: { type: "http", serverUrl: "https://example.invalid/mcp" } },
      "mcpServers",
      "claude",
    )).toThrow(/claude remote MCP servers require url/u);
    expect(() => captureMcpServers(
      { dormant: { url: "https://example.invalid/mcp" } },
      "mcpServers",
      "antigravity",
    )).toThrow(/Antigravity remote MCP servers require serverUrl/u);
  });

  it("preserves native MCP requirements and blocks foreign projections", () => {
    const antigravityNative = {
      gcp: {
        serverUrl: "https://example.invalid/mcp",
        authProviderType: "google_credentials",
      },
    };
    const captured = captureMcpServers(
      antigravityNative,
      "mcpServers",
      "antigravity",
    );
    const server = captured.servers.gcp!;

    expect(server.requiredNativeFeatures).toEqual({
      antigravity: ["authProviderType", "remoteProtocol"],
    });
    expect(mcpServerOverlays(antigravityNative)).toEqual({
      gcp: { authProviderType: "google_credentials" },
    });
    expect(mcpRequiresForeignNativeFeatures(server, "antigravity")).toBe(false);
    expect(mcpRequiresForeignNativeFeatures(server, "claude")).toBe(true);
    expect(mcpRequiresForeignNativeFeatures(server, "codex")).toBe(true);
  });

  it("retains Codex object env_vars as a native overlay", () => {
    const native = {
      remote: {
        command: "worker",
        env_vars: [{ name: "TOKEN", source: "remote" }],
        experimental_environment: "remote",
      },
    };
    const captured = captureMcpServers(native, "mcp_servers", "codex");

    expect(captured.servers.remote?.requiredNativeFeatures).toEqual({
      codex: ["env_vars.object", "experimental_environment.remote"],
    });
    expect(mcpServerOverlays(native)).toEqual({
      remote: {
        env_vars: [{ name: "TOKEN", source: "remote" }],
        experimental_environment: "remote",
      },
    });
  });

  it("marks native MCP authentication, approval, and startup contracts", () => {
    const claude = captureMcpServers({
      internal: {
        type: "http",
        url: "https://example.invalid/mcp",
        headersHelper: "/opt/bin/mcp-headers",
        alwaysLoad: true,
      },
    }, "mcpServers", "claude");
    expect(claude.servers.internal?.requiredNativeFeatures).toEqual({
      claude: ["headersHelper", "alwaysLoad"],
    });

    const codex = captureMcpServers({
      mutating: {
        url: "https://example.invalid/mcp",
        required: true,
        default_tools_approval_mode: "prompt",
        tools: {
          delete_everything: { approval_mode: "prompt" },
        },
      },
    }, "mcp_servers", "codex");
    expect(codex.servers.mutating?.requiredNativeFeatures).toEqual({
      codex: [
        "default_tools_approval_mode",
        "tools.approval_mode",
        "required",
      ],
    });
    expect(mcpRequiresForeignNativeFeatures(codex.servers.mutating!, "claude"))
      .toBe(true);
  });

  it("keeps native template syntax target-aware instead of treating it as portable", () => {
    const codexNative = {
      literal: {
        command: "worker",
        env: { TOKEN: "${TOKEN}" },
      },
    };
    const codex = captureMcpServers(codexNative, "mcp_servers", "codex");
    const codexOverlay = mcpServerOverlays(codexNative, "codex");

    expect(codex.servers.literal).toMatchObject({
      env: { TOKEN: "${TOKEN}" },
      requiredNativeFeatures: { codex: ["literalTemplate"] },
    });
    expect(codexOverlay).toEqual({
      literal: { command: "worker", env: { TOKEN: "${TOKEN}" } },
    });
    expect(mergeMcpServerOverlays(
      codexOverlay,
      renderMcpServers(codex.servers, "snake"),
      codex.servers,
      "codex",
    )).toMatchObject(codexNative);
    expect(mcpRequiresForeignNativeFeatures(codex.servers.literal!, "claude"))
      .toBe(true);

    const claudeSafe = captureMcpServers({
      inherited: {
        command: "worker",
        env: { TOKEN: "${TOKEN}" },
        headers: { Authorization: "Bearer ${AUTH_TOKEN}" },
      },
    }, "mcpServers", "claude");
    expect(claudeSafe.servers.inherited).toMatchObject({
      env: { TOKEN: "${env:TOKEN}" },
      bearerTokenEnvVar: "AUTH_TOKEN",
    });
    expect(claudeSafe.servers.inherited?.requiredNativeFeatures).toBeUndefined();

    const claudeNative = {
      basic: {
        type: "http",
        url: "https://example.invalid/${MCP_PATH:-mcp}",
        headers: { Authorization: "Basic ${MCP_BASIC}" },
      },
    };
    const claude = captureMcpServers(claudeNative, "mcpServers", "claude");
    const claudeOverlay = mcpServerOverlays(claudeNative, "claude");
    expect(claude.servers.basic?.requiredNativeFeatures).toEqual({
      claude: ["templateExpansion"],
    });
    expect(mergeMcpServerOverlays(
      claudeOverlay,
      renderMcpServers(claude.servers, "camel"),
      claude.servers,
      "claude",
    )).toMatchObject(claudeNative);
    expect(mcpRequiresForeignNativeFeatures(claude.servers.basic!, "codex"))
      .toBe(true);
  });

  it("infers Antigravity WebSocket transport from serverUrl", () => {
    const captured = captureMcpServers({
      socket: { serverUrl: "wss://example.invalid/mcp" },
    }, "mcpServers", "antigravity");

    expect(captured.servers.socket).toMatchObject({
      transport: "ws",
      url: "wss://example.invalid/mcp",
    });
  });

  it("rejects malformed native MCP control fields", () => {
    expect(() => captureMcpServers({
      broken: {
        url: "https://example.invalid/mcp",
        default_tools_approval_mode: "never",
      },
    }, "mcp_servers", "codex")).toThrow(/default_tools_approval_mode/u);
    expect(() => captureMcpServers({
      broken: {
        url: "https://example.invalid/mcp",
        tools: { mutate: { approval_mode: false } },
      },
    }, "mcp_servers", "codex")).toThrow(/approval_mode/u);
    expect(() => captureMcpServers({
      broken: {
        type: "http",
        url: "https://example.invalid/mcp",
        oauth: { callbackPort: "8080", scopes: "read" },
      },
    }, "mcpServers", "claude")).toThrow(/callbackPort/u);
    expect(() => captureMcpServers({
      broken: {
        type: "http",
        url: "https://example.invalid/mcp",
        oauth: { scopes: ["read"] },
      },
    }, "mcpServers", "claude")).toThrow(/oauth\.scopes/u);
  });

  it("does not emit unsupported Claude MCP control fields", () => {
    const rendered = renderMcpServers(
      {
        demo: {
          transport: "stdio",
          command: "node",
          enabled: false,
          startupTimeoutMs: 2_000,
          toolTimeoutMs: 3_000,
          enabledTools: ["read"],
          disabledTools: ["write"],
        },
      },
      "camel",
    ).demo as Record<string, unknown>;

    expect(rendered).toMatchObject({ command: "node" });
    expect(rendered).not.toHaveProperty("enabled");
    expect(rendered).toHaveProperty("timeout", 3_000);
    expect(rendered).not.toHaveProperty("cwd");
    expect(rendered).not.toHaveProperty("enabledTools");
    expect(rendered).not.toHaveProperty("disabledTools");
  });

  it("preserves MCP fields that a source adapter cannot round-trip", () => {
    const before = {
      demo: {
        transport: "stdio" as const,
        command: "node",
        args: ["before.js"],
        cwd: "tools/server",
        enabled: true,
        startupTimeoutMs: 4_000,
        enabledTools: ["read"],
        disabledTools: ["write"],
      },
    };
    const claude = mergeCapturedMcpServers(before, {
      demo: {
        transport: "stdio",
        command: "node",
        args: ["after.js"],
        enabled: false,
      },
    }, "claude");
    const antigravity = mergeCapturedMcpServers(before, {
      demo: {
        transport: "stdio",
        command: "node",
        args: ["after.js"],
        enabled: false,
        disabledTools: ["write"],
      },
    }, "antigravity");

    expect(claude.demo).toMatchObject({
      args: ["after.js"],
      cwd: "tools/server",
      enabled: true,
      startupTimeoutMs: 4_000,
      enabledTools: ["read"],
      disabledTools: ["write"],
    });
    expect(antigravity.demo).toMatchObject({
      args: ["after.js"],
      enabled: true,
      enabledTools: ["read"],
    });
  });

  it("preserves canonical agent controls and rule routing during target-native edits", () => {
    const agents = mergeCapturedAgents({
      reviewer: {
        description: "Before",
        instructionsFile: "agents/reviewer.md",
        model: "portable-model",
        reasoningEffort: "high",
        filesystem: "read-only",
        tools: ["Read"],
        disallowedTools: ["Write"],
        targets: { codex: { sandbox_mode: "read-only" } },
      },
    }, {
      reviewer: {
        description: "After",
        instructionsFile: "agents/reviewer.md",
        targets: { claude: { model: "sonnet" } },
      },
    });
    const rules = mergeCapturedRules([
      {
        path: "rules/private.md",
        portable: false,
        targets: { claude: { paths: ["src/**"] } },
      },
    ], [
      {
        path: "rules/private.md",
        targets: { claude: { paths: ["lib/**"] } },
      },
    ], "claude");

    expect(agents.reviewer).toMatchObject({
      description: "After",
      model: "portable-model",
      reasoningEffort: "high",
      filesystem: "read-only",
      tools: ["Read"],
      disallowedTools: ["Write"],
      targets: {
        codex: { sandbox_mode: "read-only" },
        claude: { model: "sonnet" },
      },
    });
    expect(rules[0]).toMatchObject({ portable: false });
  });
});
