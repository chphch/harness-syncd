import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import type {
  AdapterWarning,
  AgentDefinition,
  CanonicalHarness,
  CommandDefinition,
  HookGroup,
  HookHandler,
  McpServer,
  Scope,
  TargetName,
} from "../types.js";
import {
  assertNativeImportPath,
  copyFileAtomicInside,
  copyTreeForImportInside,
  listFilesRecursive,
  pathExists,
  readTextIfExists,
  resolveInside,
  writeTextAtomicInside,
} from "../core/fs.js";
import { isRecord, parseFrontmatter } from "../core/frontmatter.js";
import { redactSecrets } from "../core/secrets.js";
import {
  containsEnvironmentReference,
  environmentReference,
} from "../core/secrets.js";
import { assertArtifactName } from "../core/validate.js";
import { GENERATED_DIRECTORY_NAMES } from "../core/fs.js";
import type { HookScriptLayout } from "./adapter.js";
import {
  assertNamedFileName,
  type NamedFileEntry,
} from "../core/named-files.js";
import {
  assertOutputStyleName,
  type OutputStyleEntry,
} from "../core/output-styles.js";

const CLAUDE_RESERVED_MCP_SERVER_NAMES = new Set([
  "workspace",
  "claude-in-chrome",
  "computer-use",
  "claude preview",
  "claude browser",
]);

export function cloneHarness(harness: CanonicalHarness): CanonicalHarness {
  return structuredClone(harness);
}

export function agentHasOnlyForeignTargetCapabilities(
  agent: AgentDefinition,
  target: TargetName,
): boolean {
  const scopedTargets = Object.keys(agent.targets ?? {});
  return scopedTargets.length > 0 && agent.targets?.[target] === undefined;
}

export function mcpExecutableContainsEnvironmentReference(
  server: McpServer,
): boolean {
  return containsEnvironmentReference({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
  });
}

export async function readJsoncObject(
  path: string,
  nativeRoot = join(path, ".."),
): Promise<Record<string, unknown> | null> {
  await assertNativeImportPath(path, nativeRoot);
  const input = await readTextIfExists(path);
  if (input === null) return null;
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(input, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`${path}: invalid JSONC (${detail})`);
  }
  if (!isRecord(parsed)) throw new Error(`${path}: expected an object`);
  return parsed;
}

export async function readJsonObject(
  path: string,
  nativeRoot = join(path, ".."),
): Promise<Record<string, unknown> | null> {
  await assertNativeImportPath(path, nativeRoot);
  const input = await readTextIfExists(path);
  if (input === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${path}: expected an object`);
  return parsed;
}

export function captureMcpServers(
  input: unknown,
  path: string,
  target?: TargetName,
): { servers: Record<string, McpServer>; warnings: AdapterWarning[] } {
  if (input === undefined) return { servers: {}, warnings: [] };
  if (!isRecord(input)) {
    throw new Error(`${path}: expected an object of MCP server definitions`);
  }
  const servers: Record<string, McpServer> = {};
  const warnings: AdapterWarning[] = [];

  for (const [name, raw] of Object.entries(input)) {
    if (
      target === "claude" &&
      CLAUDE_RESERVED_MCP_SERVER_NAMES.has(name.toLowerCase())
    ) {
      throw new Error(
        `${path}.${name}: Claude reserves this built-in MCP server name`,
      );
    }
    if (!isRecord(raw)) {
      throw new Error(`${path}.${name}: expected an MCP server object`);
    }
    assertNativeMcpRemoteKey(raw, `${path}.${name}`, target);
    assertMcpServerShape(raw, `${path}.${name}`, target);
    assertMcpAliasConsistency(raw, `${path}.${name}`);
    const redaction = redactSecrets(raw, `${path}.${name}`);
    warnings.push(...redaction.warnings);
    const value = redaction.value;
    const command = asString(value.command);
    const url = asString(value.serverUrl ?? value.url ?? value.httpUrl);
    if (command !== undefined && url !== undefined) {
      throw new Error(
        `${path}.${name}: MCP server cannot define both command and URL transport fields`,
      );
    }
    if (target === "claude" && url !== undefined && value.type === undefined) {
      throw new Error(
        `${path}.${name}.type: Claude URL MCP servers require an explicit transport type`,
      );
    }
    const transport = normalizeTransport(
      value.type,
      command,
      url,
      `${path}.${name}.type`,
    );
    if (transport === "stdio" && url !== undefined) {
      throw new Error(`${path}.${name}: stdio MCP server cannot define a URL`);
    }
    if (transport !== "stdio" && command !== undefined) {
      throw new Error(
        `${path}.${name}: remote MCP server cannot define a command`,
      );
    }
    const literalEnv = normalizeEnvironmentReferences(
      asStringRecord(value.env) ?? {},
      target === "claude",
    );
    const stringEnvironmentVariables = asStringArray(value.env_vars);
    const inheritedEnv = Object.fromEntries(
      (stringEnvironmentVariables ?? []).map((variable) => [
        variable,
        `\${env:${variable}}`,
      ]),
    );
    const sourceHeaders = asStringRecord(value.headers ?? value.http_headers) ?? {};
    const headerBearerTokenEnvVar = target === "claude"
      ? bearerTokenEnvironment(sourceHeaders)
      : undefined;
    const literalHeaders = normalizeEnvironmentReferences(
      withoutBearerAuthorizationHeader(sourceHeaders, headerBearerTokenEnvVar),
      target === "claude",
    );
    const inheritedHeaders = Object.fromEntries(
      Object.entries(asStringRecord(value.env_http_headers) ?? {}).map(
        ([header, variable]) => [header, `\${env:${variable}}`],
      ),
    );
    servers[name] = compact({
      transport,
      command,
      args: asStringArray(value.args),
      cwd: asString(value.cwd),
      url,
      env: nonEmptyRecord({ ...literalEnv, ...inheritedEnv }),
      headers: nonEmptyRecord({ ...literalHeaders, ...inheritedHeaders }),
      bearerTokenEnvVar:
        asString(value.bearer_token_env_var) ?? headerBearerTokenEnvVar,
      enabled:
        asBoolean(value.enabled) ??
        (asBoolean(value.disabled) === undefined
          ? undefined
          : !asBoolean(value.disabled)),
      startupTimeoutMs: asNumber(
        value.startupTimeoutMs ??
          value.startup_timeout_ms ??
          millisecondsFromSeconds(value.startup_timeout_sec) ??
          millisecondsFromSeconds(value.timeoutSeconds),
      ),
      toolTimeoutMs:
        asNumber(value.timeout ?? value.toolTimeoutMs) ??
        secondsToMs(value.tool_timeout_sec),
      enabledTools: asStringArray(value.enabledTools ?? value.enabled_tools),
      disabledTools: asStringArray(value.disabledTools ?? value.disabled_tools),
      requiredNativeFeatures: target
        ? detectRequiredNativeFeatures(value, target)
        : undefined,
    });
  }
  return { servers, warnings };
}

function assertNativeMcpRemoteKey(
  value: Record<string, unknown>,
  path: string,
  target?: TargetName,
): void {
  if (target === "antigravity") {
    if (value.url !== undefined || value.httpUrl !== undefined) {
      throw new Error(
        `${path}: Antigravity remote MCP servers require serverUrl; url/httpUrl aliases are not activated`,
      );
    }
    return;
  }
  if (
    (target === "claude" || target === "codex") &&
    (value.serverUrl !== undefined || value.httpUrl !== undefined)
  ) {
    throw new Error(
      `${path}: ${target} remote MCP servers require url; serverUrl/httpUrl aliases are not activated`,
    );
  }
}

function assertMcpServerShape(
  value: Record<string, unknown>,
  path: string,
  target?: TargetName,
): void {
  for (const key of [
    "type",
    "command",
    "cwd",
    "url",
    "serverUrl",
    "httpUrl",
    "bearer_token_env_var",
    "authProviderType",
    "auth",
    "oauth_resource",
    "http_headers_helper",
    "headersHelper",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${path}.${key}: expected a string`);
    }
  }
  for (const key of ["args", "scopes", "enabledTools", "enabled_tools", "disabledTools", "disabled_tools"] as const) {
    if (value[key] !== undefined && asStringArray(value[key]) === undefined) {
      throw new Error(`${path}.${key}: expected an array of strings`);
    }
  }
  if (value.env_vars !== undefined && !isCodexEnvironmentVariableArray(value.env_vars)) {
    throw new Error(
      `${path}.env_vars: expected strings or { name, source: "local" | "remote" } entries`,
    );
  }
  for (const key of ["env", "headers", "http_headers", "env_http_headers"] as const) {
    if (value[key] !== undefined && asStringRecord(value[key]) === undefined) {
      throw new Error(`${path}.${key}: expected an object of strings`);
    }
  }
  for (const key of ["enabled", "disabled"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${path}.${key}: expected a boolean`);
    }
  }
  for (const key of ["alwaysLoad", "required"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${path}.${key}: expected a boolean`);
    }
  }
  if (value.default_tools_approval_mode !== undefined) {
    assertMcpApprovalMode(
      value.default_tools_approval_mode,
      `${path}.default_tools_approval_mode`,
    );
  }
  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) {
      throw new Error(`${path}.tools: expected an object`);
    }
    for (const [toolName, toolValue] of Object.entries(value.tools)) {
      if (!isRecord(toolValue)) {
        throw new Error(`${path}.tools.${toolName}: expected an object`);
      }
      if (toolValue.approval_mode !== undefined) {
        assertMcpApprovalMode(
          toolValue.approval_mode,
          `${path}.tools.${toolName}.approval_mode`,
        );
      }
      if (
        toolValue.output_token_limit !== undefined &&
        (typeof toolValue.output_token_limit !== "number" ||
          !Number.isInteger(toolValue.output_token_limit) ||
          toolValue.output_token_limit < 0)
      ) {
        throw new Error(
          `${path}.tools.${toolName}.output_token_limit: expected a non-negative integer`,
        );
      }
    }
  }
  if (value.alwaysLoad !== undefined && typeof value.alwaysLoad !== "boolean") {
    throw new Error(`${path}.alwaysLoad: expected a boolean`);
  }
  if (
    value.experimental_environment !== undefined &&
    value.experimental_environment !== "local" &&
    value.experimental_environment !== "remote"
  ) {
    throw new Error(`${path}.experimental_environment: expected "local" or "remote"`);
  }
  if (
    value.auth !== undefined &&
    value.auth !== "oauth" &&
    value.auth !== "chatgpt"
  ) {
    throw new Error(`${path}.auth: expected "oauth" or "chatgpt"`);
  }
  if (value.oauth !== undefined) {
    if (!isRecord(value.oauth)) {
      throw new Error(`${path}.oauth: expected an object`);
    }
    for (const key of [
      "clientId",
      "clientSecret",
      "authServerMetadataUrl",
      "client_id",
      "callback_url",
      "scopes",
    ] as const) {
      if (value.oauth[key] !== undefined && typeof value.oauth[key] !== "string") {
        throw new Error(`${path}.oauth.${key}: expected a string`);
      }
    }
    if (
      value.oauth.callbackPort !== undefined &&
      (typeof value.oauth.callbackPort !== "number" ||
        !Number.isInteger(value.oauth.callbackPort) ||
        value.oauth.callbackPort < 0 ||
        value.oauth.callbackPort > 65_535)
    ) {
      throw new Error(`${path}.oauth.callbackPort: expected a valid port number`);
    }
    if (
      value.oauth.callback_port !== undefined &&
      (typeof value.oauth.callback_port !== "number" ||
        !Number.isInteger(value.oauth.callback_port) ||
        value.oauth.callback_port < 0 ||
        value.oauth.callback_port > 65_535)
    ) {
      throw new Error(`${path}.oauth.callback_port: expected a valid port number`);
    }
  }
  for (const key of [
    "startupTimeoutMs",
    "startup_timeout_ms",
    "startup_timeout_sec",
    "toolTimeoutMs",
    "tool_timeout_sec",
    "timeoutSeconds",
    "timeout",
  ] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isFinite(value[key]) ||
        value[key] < 0)
    ) {
      throw new Error(`${path}.${key}: expected a non-negative finite number`);
    }
  }
}

function assertMcpApprovalMode(value: unknown, path: string): void {
  if (!["auto", "prompt", "writes", "approve"].includes(String(value))) {
    throw new Error(
      `${path}: expected "auto", "prompt", "writes", or "approve"`,
    );
  }
}

function assertMcpAliasConsistency(
  value: Record<string, unknown>,
  path: string,
): void {
  assertEquivalentAliases(value, ["serverUrl", "url", "httpUrl"], path);
  assertEquivalentAliases(value, ["headers", "http_headers"], path);
  assertEquivalentAliases(value, ["enabledTools", "enabled_tools"], path);
  assertEquivalentAliases(value, ["disabledTools", "disabled_tools"], path);

  if (
    value.enabled !== undefined &&
    value.disabled !== undefined &&
    value.enabled !== !value.disabled
  ) {
    throw new Error(`${path}: conflicting aliases enabled and disabled`);
  }

  assertEquivalentNumericAliases(value, path, [
    ["startupTimeoutMs", 1],
    ["startup_timeout_ms", 1],
    ["startup_timeout_sec", 1_000],
    ["timeoutSeconds", 1_000],
  ]);
  assertEquivalentNumericAliases(value, path, [
    ["toolTimeoutMs", 1],
    ["timeout", 1],
    ["tool_timeout_sec", 1_000],
  ]);
}

function assertEquivalentAliases(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const present = keys.filter((key) => value[key] !== undefined);
  if (present.length < 2) return;
  const first = value[present[0]!];
  if (present.slice(1).some((key) => !isDeepStrictEqual(first, value[key]))) {
    throw new Error(`${path}: conflicting aliases ${present.join(", ")}`);
  }
}

function assertEquivalentNumericAliases(
  value: Record<string, unknown>,
  path: string,
  aliases: ReadonlyArray<readonly [string, number]>,
): void {
  const present = aliases.filter(([key]) => value[key] !== undefined);
  if (present.length < 2) return;
  const [firstKey, firstScale] = present[0]!;
  const first = Number(value[firstKey]) * firstScale;
  if (
    present
      .slice(1)
      .some(([key, scale]) => Number(value[key]) * scale !== first)
  ) {
    throw new Error(
      `${path}: conflicting timeout aliases ${present.map(([key]) => key).join(", ")}`,
    );
  }
}

export function mergeCapturedMcpServers(
  current: Record<string, McpServer>,
  captured: Record<string, McpServer>,
  target: TargetName,
  preserveProjectionFallbacks: ReadonlySet<string> = new Set(),
): Record<string, McpServer> {
  const output: Record<string, McpServer> = {};
  const names = new Set([...Object.keys(current), ...Object.keys(captured)]);
  for (const name of names) {
    const before = current[name];
    const next = captured[name];
    if (!next) {
      if (
        before &&
        (preserveProjectionFallbacks.has(name) ||
          (target === "codex" &&
          (before.transport === "sse" || before.transport === "ws")) ||
          (target === "antigravity" && before.transport === "ws"))
      ) {
        output[name] = before;
      }
      continue;
    }
    if (!before) {
      output[name] = next;
      continue;
    }
    if (target === "codex") {
      const merged = compact({
        ...next,
        env: preserveUnsupportedCodexEnvironmentReferences(before.env, next.env),
        requiredNativeFeatures: preserveProjectionFallbacks.has(name)
          ? before.requiredNativeFeatures
          : mergeRequiredNativeFeatures(before, next, target),
      });
      preserveFallbackEnabledState(merged, before, name, preserveProjectionFallbacks);
      output[name] = merged;
      continue;
    }
    if (target === "claude") {
      const merged = compact({
        ...next,
        cwd: next.cwd ?? before.cwd,
        startupTimeoutMs: next.startupTimeoutMs ?? before.startupTimeoutMs,
        enabledTools: next.enabledTools ?? before.enabledTools,
        disabledTools: next.disabledTools ?? before.disabledTools,
        requiredNativeFeatures: preserveProjectionFallbacks.has(name)
          ? before.requiredNativeFeatures
          : mergeRequiredNativeFeatures(before, next, target),
      });
      if (
        before.cwd !== undefined ||
        before.enabledTools !== undefined ||
        before.disabledTools !== undefined
      ) {
        if (before.enabled !== undefined) merged.enabled = before.enabled;
        else delete merged.enabled;
      }
      preserveFallbackEnabledState(merged, before, name, preserveProjectionFallbacks);
      output[name] = merged;
      continue;
    }
    const merged: McpServer = { ...next };
    const requiredNativeFeatures = preserveProjectionFallbacks.has(name)
      ? before.requiredNativeFeatures
      : mergeRequiredNativeFeatures(before, next, target);
    if (requiredNativeFeatures) {
      merged.requiredNativeFeatures = requiredNativeFeatures;
    } else {
      delete merged.requiredNativeFeatures;
    }
    if (before.transport !== "stdio" && next.transport !== "stdio") {
      merged.transport = target === "antigravity" &&
          (before.transport === "ws" || next.transport === "ws")
        ? next.transport
        : before.transport;
    }
    if (before.toolTimeoutMs !== undefined) {
      merged.toolTimeoutMs = before.toolTimeoutMs;
    }
    if (before.bearerTokenEnvVar !== undefined) {
      merged.bearerTokenEnvVar = before.bearerTokenEnvVar;
    }
    if (before.enabledTools !== undefined) {
      merged.enabledTools = before.enabledTools;
      if (before.enabled !== undefined) merged.enabled = before.enabled;
      else delete merged.enabled;
    }
    preserveFallbackEnabledState(merged, before, name, preserveProjectionFallbacks);
    const env = preserveEnvironmentReferences(before.env, next.env);
    const headers = preserveEnvironmentReferences(before.headers, next.headers);
    if (env) merged.env = env;
    else delete merged.env;
    if (headers) merged.headers = headers;
    else delete merged.headers;
    output[name] = compact(merged);
  }
  return output;
}

function preserveFallbackEnabledState(
  merged: McpServer,
  before: McpServer,
  name: string,
  fallbacks: ReadonlySet<string>,
): void {
  if (!fallbacks.has(name)) return;
  if (before.enabled !== undefined) merged.enabled = before.enabled;
  else delete merged.enabled;
}

export function mcpRequiresForeignNativeFeatures(
  server: McpServer,
  target: TargetName,
): boolean {
  const requirements = server.requiredNativeFeatures ?? {};
  return Object.values(requirements).some(
    (features) => (features?.length ?? 0) > 0,
  ) && (requirements[target]?.length ?? 0) === 0;
}

export function mcpRequiresUnavailableNativeFeatures(
  server: McpServer,
  target: TargetName,
  scope: Scope,
): boolean {
  if (mcpRequiresForeignNativeFeatures(server, target)) return true;
  return (server.requiredNativeFeatures?.[target] ?? []).some(
    (feature) => !nativeFeatureAvailableInScope(target, feature, scope),
  );
}

function nativeFeatureAvailableInScope(
  target: TargetName,
  feature: string,
  scope: Scope,
): boolean {
  if (target === "codex" && feature === "settings.mcpHooks") {
    // Codex skips every non-managed hook until its exact definition hash is
    // reviewed in native UI state. That trust state is intentionally not
    // synchronized, so merely materializing hooks cannot prove the gate runs.
    return false;
  }
  if (feature === "settings.projectMcpApproval") {
    return target === "claude" && scope === "project";
  }
  if (feature === "projects.disabledMcpServers") {
    return target === "claude" && scope === "user";
  }
  if (feature === "settings.projectTrust") {
    return (target === "codex" || target === "antigravity") &&
      scope === "project";
  }
  if (feature === "settings.mcpPermissions" && target === "antigravity") {
    return scope === "user";
  }
  return true;
}

function mergeRequiredNativeFeatures(
  before: McpServer,
  next: McpServer,
  target: TargetName,
): McpServer["requiredNativeFeatures"] {
  const merged = { ...(before.requiredNativeFeatures ?? {}) };
  delete merged[target];
  const nextFeatures = next.requiredNativeFeatures?.[target];
  if ((nextFeatures?.length ?? 0) > 0) {
    merged[target] = nextFeatures!;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function detectRequiredNativeFeatures(
  value: Record<string, unknown>,
  target: TargetName,
): McpServer["requiredNativeFeatures"] {
  const features: string[] = [];
  if (target === "claude") {
    for (const key of ["oauth", "headersHelper"] as const) {
      if (value[key] !== undefined) features.push(key);
    }
    if (value.alwaysLoad === true) features.push("alwaysLoad");
    if (hasUnsafeClaudeTemplateExpansion(value)) {
      features.push("templateExpansion");
    }
  } else if (target === "codex") {
    for (const key of ["auth", "oauth", "oauth_resource", "scopes", "http_headers_helper"] as const) {
      if (value[key] !== undefined) features.push(key);
    }
    if (value.default_tools_approval_mode !== undefined) {
      features.push("default_tools_approval_mode");
    }
    if (
      isRecord(value.tools) &&
      Object.values(value.tools).some(
        (tool) => isRecord(tool) && tool.approval_mode !== undefined,
      )
    ) {
      features.push("tools.approval_mode");
    }
    if (value.required === true) features.push("required");
    if (hasLiteralNativeTemplate(value)) features.push("literalTemplate");
    if (value.env_vars !== undefined && asStringArray(value.env_vars) === undefined) {
      features.push("env_vars.object");
    }
    if (value.experimental_environment === "remote") {
      features.push("experimental_environment.remote");
    }
  } else {
    for (const key of ["authProviderType", "oauth"] as const) {
      if (value[key] !== undefined) features.push(key);
    }
    if (hasLiteralNativeTemplate(value)) features.push("literalTemplate");
    if (
      typeof value.serverUrl === "string" &&
      /^https?:\/\//iu.test(value.serverUrl)
    ) {
      features.push("remoteProtocol");
    }
  }
  return features.length > 0 ? { [target]: features } : undefined;
}

function isCodexEnvironmentVariableArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry === "string") return true;
    if (!isRecord(entry) || typeof entry.name !== "string") return false;
    return entry.source === "local" || entry.source === "remote";
  });
}

export function mergeCapturedAgents(
  current: Record<string, AgentDefinition>,
  captured: Record<string, AgentDefinition>,
): Record<string, AgentDefinition> {
  const output = { ...current };
  for (const [name, next] of Object.entries(captured)) {
    const before = current[name];
    output[name] = {
      ...before,
      ...next,
      ...(before?.targets || next.targets
        ? { targets: { ...(before?.targets ?? {}), ...(next.targets ?? {}) } }
        : {}),
      ...(before?.nativePaths || next.nativePaths
        ? {
            nativePaths: {
              ...(before?.nativePaths ?? {}),
              ...(next.nativePaths ?? {}),
            },
          }
        : {}),
    };
  }
  return output;
}

export function mergeCapturedCommands(
  current: Record<string, CommandDefinition>,
  captured: Record<string, CommandDefinition>,
): Record<string, CommandDefinition> {
  const output = { ...current };
  for (const [name, next] of Object.entries(captured)) {
    const before = current[name];
    output[name] = {
      ...next,
      ...(before?.targets || next.targets
        ? { targets: { ...(before?.targets ?? {}), ...(next.targets ?? {}) } }
        : {}),
    };
  }
  return output;
}

export function mergeCapturedRules(
  current: CanonicalHarness["rules"],
  captured: CanonicalHarness["rules"],
  target: TargetName,
): CanonicalHarness["rules"] {
  const capturedPaths = new Set(captured.map((rule) => rule.path));
  const replacements = captured.map((next) => {
    const before = current.find((rule) => rule.path === next.path);
    return {
      ...next,
      ...(target !== "antigravity" && before?.portable !== undefined
        ? { portable: before.portable }
        : {}),
      ...(before?.targets || next.targets
        ? { targets: { ...(before?.targets ?? {}), ...(next.targets ?? {}) } }
        : {}),
    };
  });
  return [...current.filter((rule) => !capturedPaths.has(rule.path)), ...replacements];
}

export function renderMcpServers(
  servers: Record<string, McpServer>,
  style: "camel" | "snake",
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const value: Record<string, unknown> = {};
    if (style === "camel" && server.transport !== "stdio") {
      value.type = server.transport;
    }
    assign(value, "command", server.command);
    assign(value, "args", server.args);
    if (style === "snake") assign(value, "cwd", server.cwd);
    assign(value, "url", server.url);
    if (style === "camel") {
      assign(value, "env", renderClaudeReferences(server.env));
      const headers = { ...(server.headers ?? {}) };
      if (
        server.bearerTokenEnvVar &&
        !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
      ) {
        headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
      }
      assign(
        value,
        "headers",
        Object.keys(headers).length > 0
          ? renderClaudeReferences(headers)
          : undefined,
      );
    } else {
      const env = splitEnvironmentReferences(server.env);
      const headers = splitEnvironmentReferences(server.headers);
      assign(value, "env", env.literals);
      assign(value, "env_vars", env.references);
      assign(value, "http_headers", headers.literals);
      assign(value, "env_http_headers", headers.referenceMap);
    }
    if (style === "snake") {
      assign(value, "bearer_token_env_var", server.bearerTokenEnvVar);
      assign(value, "enabled", server.enabled);
      assign(
        value,
        "startup_timeout_sec",
        server.startupTimeoutMs === undefined
          ? undefined
          : server.startupTimeoutMs / 1000,
      );
    }
    if (server.toolTimeoutMs !== undefined) {
      assign(
        value,
        style === "camel" ? "timeout" : "tool_timeout_sec",
        style === "camel" ? server.toolTimeoutMs : server.toolTimeoutMs / 1000,
      );
    }
    if (style === "snake") {
      assign(value, "enabled_tools", server.enabledTools);
      assign(value, "disabled_tools", server.disabledTools);
    }
    output[name] = value;
  }
  return output;
}

export function captureHooks(input: unknown): Record<string, HookGroup[]> {
  if (!isRecord(input)) return {};
  const output: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(input)) {
    if (!Array.isArray(groups)) continue;
    output[event] = groups.flatMap((group): HookGroup[] => {
      if (!isRecord(group)) return [];
      const rawHandlers = Array.isArray(group.hooks) ? group.hooks : [];
      const handlers = rawHandlers.flatMap((handler): HookHandler[] => {
        if (!isRecord(handler)) return [];
        const type = normalizeHookType(handler.type);
        const extra = withoutKeys(handler, [
          "type",
          "command",
          "url",
          "prompt",
          "timeout",
          "async",
        ]);
        return [
          compact({
            type,
            command: asString(handler.command),
            url: asString(handler.url),
            prompt: asString(handler.prompt),
            timeoutSeconds: asNumber(handler.timeout),
            async: asBoolean(handler.async),
            extra: Object.keys(extra).length > 0 ? extra : undefined,
          }),
        ];
      });
      return [
        compact({
          matcher: asString(group.matcher),
          handlers,
        }),
      ];
    });
  }
  return output;
}

export function hasMcpBlockingHooks(
  value: unknown,
  path: string,
): boolean {
  if (!isRecord(value)) return false;
  for (const event of ["PreToolUse", "PermissionRequest"] as const) {
    const groups = value[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) {
      throw new Error(`${path}.${event}: expected an array`);
    }
    for (const [index, group] of groups.entries()) {
      if (!isRecord(group)) {
        throw new Error(`${path}.${event}[${index}]: expected an object`);
      }
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new Error(`${path}.${event}[${index}].matcher: expected a string`);
      }
      if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
        throw new Error(`${path}.${event}[${index}].hooks: expected an array`);
      }
      const matcher = asString(group.matcher) ?? "";
      if (matcher.length === 0 || matcher === "*") return true;
      let expression: RegExp;
      try {
        expression = new RegExp(matcher, "u");
      } catch (error) {
        throw new Error(
          `${path}.${event}[${index}].matcher: invalid regular expression (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (
        matcher.toLowerCase().includes("mcp") ||
        ["mcp__dangerous__tool", "mcp__x__y"].some((tool) => {
          expression.lastIndex = 0;
          return expression.test(tool);
        })
      ) return true;
    }
  }
  return false;
}

export function renderHooks(
  hooks: Record<string, HookGroup[]>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(hooks).map(([event, groups]) => [
      event,
      groups.map((group) => ({
        ...(group.matcher ? { matcher: group.matcher } : {}),
        hooks: group.handlers.map((handler) => ({
          type: handler.type === "mcp" ? "mcp_tool" : handler.type,
          ...(handler.command ? { command: handler.command } : {}),
          ...(handler.url ? { url: handler.url } : {}),
          ...(handler.prompt ? { prompt: handler.prompt } : {}),
          ...(handler.timeoutSeconds !== undefined
            ? { timeout: handler.timeoutSeconds }
            : {}),
          ...(handler.async !== undefined ? { async: handler.async } : {}),
          ...handler.extra,
        })),
      })),
    ]),
  );
}

export async function importInstruction(
  source: string,
  storeDir: string,
  harness: CanonicalHarness,
  write: boolean,
  managedPaths?: readonly string[],
  nativeRoot = join(source, ".."),
  canonicalSourceStoreDir?: string,
): Promise<string | null> {
  if (!capturePathAllowed(source, managedPaths)) return null;
  const destination = resolveInside(storeDir, harness.instructions.root);
  await assertNativeImportPath(
    source,
    nativeRoot,
    canonicalSourceStoreDir
      ? [destination, resolveInside(canonicalSourceStoreDir, harness.instructions.root)]
      : destination,
  );
  const content = await readTextIfExists(source);
  if (content === null) return null;
  if (write) await writeTextAtomicInside(storeDir, destination, content);
  return destination;
}

export async function importSkills(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  managedPaths?: readonly string[],
  nativeRoot = sourceDir,
  canonicalSourceStoreDir?: string,
  excludeNames: readonly string[] = [],
): Promise<Array<{ name: string; path: string }>> {
  if (!(await pathExists(sourceDir))) return [];
  await assertNativeImportPath(sourceDir, nativeRoot);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const discovered: Array<{ name: string; path: string; source: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = join(sourceDir, entry.name);
    if (!capturePathAllowed(source, managedPaths)) continue;
    // Decided from the directory entry alone, before the first stat: an excluded
    // skill is never opened, walked, or followed, so no import check is relaxed
    // for it — or for anything else.
    if (excludeNames.includes(entry.name)) continue;
    if (!(await pathExists(join(source, "SKILL.md")))) continue;
    assertArtifactName(entry.name, "skill");
    discovered.push({
      name: entry.name,
      path: `skills/${entry.name}`,
      source,
    });
  }
  assertUniqueImportedNames(discovered, "skill");
  const skills: Array<{ name: string; path: string }> = [];
  for (const skill of discovered) {
    const destination = join(storeDir, skill.path);
    if (write && relative(skill.source, destination) !== "") {
      await assertNativeImportPath(
        skill.source,
        nativeRoot,
        canonicalSourceStoreDir
          ? [destination, resolveInside(canonicalSourceStoreDir, skill.path)]
          : destination,
      );
      await copyTreeForImportInside(storeDir, skill.source, destination);
    }
    skills.push({ name: skill.name, path: skill.path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function importRules(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  target?: TargetName,
  managedPaths?: readonly string[],
  nativeRoot = sourceDir,
): Promise<CanonicalHarness["rules"]> {
  if (await pathExists(sourceDir)) {
    await assertNativeImportPath(sourceDir, nativeRoot);
  }
  const files = (await listFilesRecursive(sourceDir)).filter((file) =>
    file.endsWith(".md"),
  );
  const rules: CanonicalHarness["rules"] = [];
  for (const file of files) {
    const source = join(sourceDir, file);
    if (!capturePathAllowed(source, managedPaths)) continue;
    const destination = join(storeDir, "rules", file);
    await assertNativeImportPath(source, nativeRoot, destination);
    const parsed = parseFrontmatter(await readFile(source, "utf8"));
    if (
      parsed.data.paths !== undefined &&
      asStringArray(parsed.data.paths) === undefined
    ) {
      throw new Error(`${source}: frontmatter paths must be an array of strings`);
    }
    const globs = asStringArray(parsed.data.paths);
    if (write) await writeTextAtomicInside(storeDir, destination, parsed.body);
    rules.push({
      path: `rules/${file}`,
      ...(globs ? { globs } : {}),
      ...(target ? { targets: { [target]: parsed.data } } : {}),
    });
  }
  return rules;
}

export async function importAgents(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  target?: TargetName,
  managedPaths?: readonly string[],
  warningSink?: AdapterWarning[],
  nativeRoot = sourceDir,
): Promise<Record<string, AgentDefinition>> {
  if (!(await pathExists(sourceDir))) return {};
  await assertNativeImportPath(sourceDir, nativeRoot);
  const agents: Record<string, AgentDefinition> = {};
  const files = (await listFilesRecursive(sourceDir)).filter((file) =>
    file.endsWith(".md"),
  );
  const discovered: Array<{
    source: string;
    name: string;
    parsed: ReturnType<typeof parseFrontmatter>;
  }> = [];
  for (const file of files) {
    const source = join(sourceDir, file);
    if (!capturePathAllowed(source, managedPaths)) continue;
    const expectedName = basename(file, ".md");
    await assertNativeImportPath(
      source,
      nativeRoot,
      join(storeDir, "agents", `${expectedName}.md`),
    );
    const parsed = parseFrontmatter(await readFile(source, "utf8"));
    const redacted = redactSecrets(parsed.data, source);
    warningSink?.push(...redacted.warnings);
    const data = redacted.value;
    assertOptionalFrontmatterString(data, "name", source);
    assertOptionalFrontmatterString(data, "description", source);
    const name = asString(data.name) ?? expectedName;
    assertArtifactName(name, "agent");
    discovered.push({ source, name, parsed: { ...parsed, data } });
  }
  assertUniqueImportedNames(discovered, "agent");
  for (const { source, name, parsed } of discovered) {
    const relativeInstructions = `agents/${name}.md`;
    if (write) {
      await writeTextAtomicInside(
        storeDir,
        join(storeDir, relativeInstructions),
        parsed.body,
      );
    }
    const targetSpecific = target !== undefined;
    agents[name] = compact({
      description: asString(parsed.data.description) ?? name,
      instructionsFile: relativeInstructions,
      model: targetSpecific ? undefined : asString(parsed.data.model),
      reasoningEffort: targetSpecific
        ? undefined
        : asString(
            parsed.data.reasoningEffort ?? parsed.data.model_reasoning_effort,
          ),
      tools: targetSpecific ? undefined : asStringArray(parsed.data.tools),
      disallowedTools: targetSpecific
        ? undefined
        : asStringArray(
            parsed.data.disallowedTools ?? parsed.data.disallowed_tools,
          ),
      targets: target ? { [target]: parsed.data } : undefined,
      nativePaths: target
        ? { [target]: relative(sourceDir, source).split(sep).join("/") }
        : undefined,
    });
  }
  return agents;
}

export async function importCommands(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  target?: TargetName,
  managedPaths?: readonly string[],
  nativeRoot = sourceDir,
): Promise<Record<string, CommandDefinition>> {
  if (!(await pathExists(sourceDir))) return {};
  await assertNativeImportPath(sourceDir, nativeRoot);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const commands: Record<string, CommandDefinition> = {};
  const discovered: Array<{
    source: string;
    name: string;
    parsed: ReturnType<typeof parseFrontmatter>;
  }> = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile()) {
      throw new Error(
        `native command import contains a non-regular Markdown file: ${join(sourceDir, entry.name)}`,
      );
    }
    const source = join(sourceDir, entry.name);
    if (!capturePathAllowed(source, managedPaths)) continue;
    await assertNativeImportPath(
      source,
      nativeRoot,
      join(storeDir, "commands", entry.name),
    );
    const parsed = parseFrontmatter(await readFile(source, "utf8"));
    assertOptionalFrontmatterString(parsed.data, "description", source);
    assertOptionalFrontmatterString(parsed.data, "argument-hint", source);
    const name = basename(entry.name, ".md");
    assertArtifactName(name, "command");
    discovered.push({ source, name, parsed });
  }
  assertUniqueImportedNames(discovered, "command");
  for (const { name, parsed } of discovered) {
    const promptFile = `commands/${name}.md`;
    if (write) {
      await writeTextAtomicInside(storeDir, join(storeDir, promptFile), parsed.body);
    }
    commands[name] = compact({
      description: asString(parsed.data.description),
      argumentHint: asString(parsed.data["argument-hint"]),
      promptFile,
      targets: target ? { [target]: parsed.data } : undefined,
    });
  }
  return commands;
}

/**
 * Sweep a target's hook-script directory into one canonical entry per real
 * file. DECLARATION, NOT DERIVATION: the file set is never derived from the
 * hook commands — a shared library named by no command (measured: one 18KB
 * helper required by five sibling hooks) would be left behind, and every hook
 * that requires it would fail on the second machine.
 *
 * Entries are per FILE, never a directory bundle. `fingerprintManagedTarget`
 * hashes the BYTES of every owned path and recurses into owned directories, so
 * owning the directory would make a generated cache or an in-tree log file a
 * managed change; owning each file individually means a generated file is
 * simply not a managed path.
 */
export async function importExecutableDirectory(
  sourceDir: string,
  storePrefix: string,
  kind: string,
  storeDir: string,
  write: boolean,
  managedPaths: readonly string[] | undefined,
  nativeRoot: string,
  canonicalSourceStoreDir?: string,
): Promise<{ entries: NamedFileEntry[]; warnings: AdapterWarning[] }> {
  const warnings: AdapterWarning[] = [];
  if (!(await pathExists(sourceDir))) return { entries: [], warnings };
  await assertNativeImportPath(sourceDir, nativeRoot);

  const discovered: Array<{ name: string; path: string; source: string }> = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const source = join(directory, child.name);
      const name = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if ((GENERATED_DIRECTORY_NAMES as readonly string[]).includes(child.name)) {
        warnings.push({
          code: `${kind}-generated-path-excluded`,
          message:
            `${child.name} holds machine-generated files that are rebuilt from source; it was not imported`,
          path: source,
          fidelity: "compatible",
        });
        continue;
      }
      if (child.name.startsWith(".")) {
        warnings.push({
          code: `${kind}-hidden-path-excluded`,
          message:
            "Hidden paths inside a hook-script directory are runtime state, not authored content; it was not imported",
          path: source,
          fidelity: "compatible",
        });
        continue;
      }
      // Skip rather than throw: the directory is swept wholesale, so one stray
      // entry must not block the rest. Skipping is also the safe direction —
      // a per-file copy DEREFERENCES a symlink, so following one into, say, a
      // private key would copy it into a Git-synchronized store.
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        warnings.push({
          code: `${kind}-non-regular-path-skipped`,
          message:
            "Only regular files are imported as hook scripts; a symlink or special file was skipped",
          path: source,
          fidelity: "unsupported",
        });
        continue;
      }
      if (child.isDirectory()) {
        await walk(source, name);
        continue;
      }
      assertNamedFileName(name, kind);
      discovered.push({ name, path: `${storePrefix}/${name}`, source });
    }
  };
  await walk(sourceDir, "");
  assertUniqueImportedNames(discovered, kind);

  const entries: NamedFileEntry[] = [];
  for (const entry of discovered) {
    // `layout.dir` is load-bearing: with per-file entries the DIRECTORY is
    // never itself a managed path, so an inverse capture restricted to owned
    // paths could never adopt a newly authored hook script.
    if (!capturePathAllowed(entry.source, managedPaths ? [...managedPaths, sourceDir] : undefined)) {
      continue;
    }
    const destination = resolveInside(storeDir, entry.path);
    if (write && relative(entry.source, destination) !== "") {
      await assertNativeImportPath(
        entry.source,
        nativeRoot,
        canonicalSourceStoreDir
          ? [destination, resolveInside(canonicalSourceStoreDir, entry.path)]
          : destination,
      );
      await copyFileAtomicInside(storeDir, entry.source, destination);
    }
    entries.push({ name: entry.name, path: entry.path });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, warnings };
}

/**
 * Sweep a target's output-style directory into one canonical entry per file.
 * Flat by construction — Claude reads only the top level — and Markdown only,
 * so anything else in the directory is left unmanaged rather than adopted.
 */
export async function importOutputStyles(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  managedPaths: readonly string[] | undefined,
  nativeRoot: string,
  canonicalSourceStoreDir?: string,
): Promise<OutputStyleEntry[]> {
  if (!(await pathExists(sourceDir))) return [];
  await assertNativeImportPath(sourceDir, nativeRoot);
  const discovered: Array<{ name: string; path: string; source: string }> = [];
  for (const child of await readdir(sourceDir, { withFileTypes: true })) {
    if (!child.isFile() || !child.name.endsWith(".md")) continue;
    const source = join(sourceDir, child.name);
    if (!capturePathAllowed(source, managedPaths ? [...managedPaths, sourceDir] : undefined)) {
      continue;
    }
    assertOutputStyleName(child.name);
    discovered.push({ name: child.name, path: `output-styles/${child.name}`, source });
  }
  assertUniqueImportedNames(discovered, "output style");
  const entries: OutputStyleEntry[] = [];
  for (const entry of discovered) {
    const destination = resolveInside(storeDir, entry.path);
    if (write && relative(entry.source, destination) !== "") {
      await assertNativeImportPath(
        entry.source,
        nativeRoot,
        canonicalSourceStoreDir
          ? [destination, resolveInside(canonicalSourceStoreDir, entry.path)]
          : destination,
      );
      await copyFileAtomicInside(storeDir, entry.source, destination);
    }
    entries.push({ name: entry.name, path: entry.path });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Report hook commands that name a machine-specific path into the script
 * directory. READ-ONLY — it rewrites nothing, so its failure mode is a missing
 * warning rather than a corrupted command. Never resolves or realpaths: under
 * symlink link mode a managed native path resolves into the store.
 */
export function scanHookScriptReferences(
  value: unknown,
  layout: HookScriptLayout,
): AdapterWarning[] {
  const warnings: AdapterWarning[] = [];
  const home = homedir();
  const tildeDir = layout.dir === home || layout.dir.startsWith(`${home}/`)
    ? `~${layout.dir.slice(home.length)}`
    : null;
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    if (typeof node !== "string" || !/\.command$/u.test(path)) return;
    if (node.includes(layout.commandPrefix)) return;
    if (node.includes(layout.dir) || (tildeDir !== null && node.includes(tildeDir))) {
      warnings.push({
        code: "hook-command-machine-specific-path",
        message:
          `A hook command names this machine's own path to the hook-script directory; write ${layout.commandPrefix}/<script> instead so it resolves on every machine`,
        path,
        fidelity: "compatible",
      });
    }
  };
  visit(value, "");
  return warnings;
}

export function assertUniqueImportedNames(
  entries: readonly { name: string; source: string }[],
  kind: string,
): void {
  const seen = new Map<string, { name: string; source: string }>();
  for (const entry of entries) {
    const folded = entry.name.toLowerCase();
    const prior = seen.get(folded);
    if (prior) {
      throw new Error(
        `Duplicate imported ${kind} name ${JSON.stringify(entry.name)} from ${prior.source} and ${entry.source}`,
      );
    }
    seen.set(folded, entry);
  }
}

export function assertOptionalFrontmatterString(
  data: Record<string, unknown>,
  key: string,
  source: string,
): void {
  if (data[key] !== undefined && typeof data[key] !== "string") {
    throw new Error(`${source}: frontmatter ${key} must be a string`);
  }
}

export function withoutKeys(
  input: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const output = cloneConfigRecord(input);
  for (const key of keys) delete output[key];
  return output;
}

export function capturePathAllowed(
  path: string,
  managedPaths: readonly string[] | undefined,
): boolean {
  if (!managedPaths) return true;
  const candidate = resolve(path);
  return managedPaths.some((managedPath) => {
    const managed = resolve(managedPath);
    return candidate === managed || relative(managed, candidate).split(sep)[0] !== "..";
  });
}

const KNOWN_MCP_SERVER_KEYS = [
  "type",
  "command",
  "args",
  "cwd",
  "url",
  "serverUrl",
  "httpUrl",
  "env",
  "env_vars",
  "headers",
  "http_headers",
  "env_http_headers",
  "bearer_token_env_var",
  "enabled",
  "disabled",
  "startupTimeoutMs",
  "startup_timeout_ms",
  "startup_timeout_sec",
  "toolTimeoutMs",
  "tool_timeout_sec",
  "timeoutSeconds",
  "timeout",
  "enabledTools",
  "enabled_tools",
  "disabledTools",
  "disabled_tools",
];

export function mcpServerOverlays(
  servers: Record<string, unknown>,
  target?: TargetName,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, value]) => {
      if (!isRecord(value)) return [];
      const overlay = withoutKeys(value, KNOWN_MCP_SERVER_KEYS);
      if (
        value.env_vars !== undefined &&
        asStringArray(value.env_vars) === undefined
      ) {
        overlay.env_vars = value.env_vars;
      }
      const nativeFeatures = target
        ? detectRequiredNativeFeatures(value, target)?.[target] ?? []
        : [];
      if (
        nativeFeatures.includes("templateExpansion") ||
        nativeFeatures.includes("literalTemplate")
      ) {
        for (const key of TEMPLATE_SENSITIVE_MCP_KEYS) {
          if (value[key] !== undefined) overlay[key] = value[key];
        }
      }
      if (nativeFeatures.includes("remoteProtocol")) {
        overlay.serverUrl = value.serverUrl;
      }
      return Object.keys(overlay).length > 0 ? [[name, overlay]] : [];
    }),
  );
}

export function mergeMcpServerOverlays(
  overlays: Record<string, unknown>,
  portable: Record<string, unknown>,
  servers?: Record<string, McpServer>,
  target?: TargetName,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(portable).map(([name, value]) => {
      if (!isRecord(overlays[name]) || !isRecord(value)) return [name, value];
      const update = cloneConfigRecord(value);
      const features = target
        ? servers?.[name]?.requiredNativeFeatures?.[target] ?? []
        : [];
      if (
        features.includes("templateExpansion") ||
        features.includes("literalTemplate")
      ) {
        for (const key of TEMPLATE_SENSITIVE_MCP_KEYS) {
          if (Object.prototype.hasOwnProperty.call(overlays[name], key)) {
            delete update[key];
          }
        }
      }
      return [
        name,
        deepMerge(overlays[name] as Record<string, unknown>, update),
      ];
    }),
  );
}

export function deepMerge(
  base: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const output = cloneConfigRecord(base);
  for (const [key, value] of Object.entries(update)) {
    if (isMergeableRecord(value) && isMergeableRecord(output[key])) {
      output[key] = deepMerge(output[key] as Record<string, unknown>, value);
    } else {
      output[key] = cloneConfigValue(value);
    }
  }
  return output;
}

function isMergeableRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneConfigRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)]),
  );
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneConfigValue);
  if (isMergeableRecord(value)) return cloneConfigRecord(value);
  // TOML date/time scalars are Date subclasses with format semantics on their
  // prototype. They are immutable in our pipeline and must not be flattened by
  // structuredClone into ordinary Date instances.
  return value;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

export function asStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type Compact<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

export function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Compact<T>;
}

function normalizeTransport(
  value: unknown,
  command?: string,
  url?: string,
  path = "MCP server type",
): McpServer["transport"] {
  if (value === "streamable-http") return "http";
  if (value === "http" || value === "sse" || value === "stdio" || value === "ws") return value;
  if (value !== undefined) {
    throw new Error(`${path}: unsupported MCP transport ${JSON.stringify(value)}`);
  }
  if (command) return "stdio";
  if (url && /^wss?:\/\//iu.test(url)) return "ws";
  return url ? "http" : "stdio";
}

function normalizeHookType(value: unknown): HookHandler["type"] {
  if (value === "mcp_tool") return "mcp";
  return value === "http" ||
    value === "prompt" ||
    value === "agent" ||
    value === "mcp"
    ? value
    : "command";
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = asNumber(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function millisecondsFromSeconds(value: unknown): number | undefined {
  const seconds = asNumber(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function assign(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

function renderClaudeReferences(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const env = environmentReference(entry);
      return [key, env ? `\${${env}}` : entry];
    }),
  );
}

function splitEnvironmentReferences(value: Record<string, string> | undefined): {
  literals: Record<string, string> | undefined;
  references: string[] | undefined;
  referenceMap: Record<string, string> | undefined;
} {
  if (!value) {
    return { literals: undefined, references: undefined, referenceMap: undefined };
  }
  const literals: Record<string, string> = {};
  const references: string[] = [];
  const referenceMap: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const env = environmentReference(entry);
    if (env) {
      if (key === env) references.push(env);
      referenceMap[key] = env;
    } else {
      literals[key] = entry;
    }
  }
  return {
    literals: Object.keys(literals).length > 0 ? literals : undefined,
    references: references.length > 0 ? [...new Set(references)] : undefined,
    referenceMap:
      Object.keys(referenceMap).length > 0 ? referenceMap : undefined,
  };
}

function nonEmptyRecord(
  value: Record<string, string>,
): Record<string, string> | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function normalizeEnvironmentReferences(
  value: Record<string, string>,
  interpretClaudeSyntax = false,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const environment = interpretClaudeSyntax
        ? nativeClaudeEnvironmentReference(entry)
        : environmentReference(entry);
      return [key, environment ? `\${env:${environment}}` : entry];
    }),
  );
}

const TEMPLATE_SENSITIVE_MCP_KEYS = [
  "command",
  "args",
  "cwd",
  "url",
  "serverUrl",
  "httpUrl",
  "env",
  "headers",
  "http_headers",
] as const;

const NATIVE_ENV_TEMPLATE = /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/u;

function nativeClaudeEnvironmentReference(value: string): string | null {
  const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u.exec(value);
  return match?.[1] ?? null;
}

function hasUnsafeClaudeTemplateExpansion(
  value: Record<string, unknown>,
): boolean {
  for (const key of ["command", "args", "cwd", "url"] as const) {
    if (containsNativeTemplate(value[key])) return true;
  }
  for (const entry of Object.values(asStringRecord(value.env) ?? {})) {
    if (
      containsNativeTemplate(entry) &&
      nativeClaudeEnvironmentReference(entry) === null
    ) return true;
  }
  for (const [key, entry] of Object.entries(
    asStringRecord(value.headers) ?? {},
  )) {
    if (!containsNativeTemplate(entry)) continue;
    if (nativeClaudeEnvironmentReference(entry) !== null) continue;
    if (
      key.toLowerCase() === "authorization" &&
      /^Bearer\s+\$\{[A-Z_][A-Z0-9_]*\}$/u.test(entry)
    ) continue;
    return true;
  }
  return false;
}

function hasLiteralNativeTemplate(value: Record<string, unknown>): boolean {
  return TEMPLATE_SENSITIVE_MCP_KEYS.some((key) =>
    containsNativeTemplate(value[key]),
  );
}

function containsNativeTemplate(value: unknown): boolean {
  if (typeof value === "string") return NATIVE_ENV_TEMPLATE.test(value);
  if (Array.isArray(value)) return value.some(containsNativeTemplate);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsNativeTemplate);
}

function bearerTokenEnvironment(
  headers: Record<string, string>,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "authorization") continue;
    const match = /^Bearer\s+\$\{(?:env:)?([A-Z_][A-Z0-9_]*)\}$/u.exec(value);
    if (match) return match[1];
  }
  return undefined;
}

function withoutBearerAuthorizationHeader(
  headers: Record<string, string>,
  bearerTokenEnvVar: string | undefined,
): Record<string, string> {
  if (!bearerTokenEnvVar) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization"),
  );
}

function preserveEnvironmentReferences(
  before: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const output = { ...(next ?? {}) };
  for (const [key, value] of Object.entries(before ?? {})) {
    if (environmentReference(value)) output[key] = value;
  }
  return nonEmptyRecord(output);
}

function preserveUnsupportedCodexEnvironmentReferences(
  before: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const output = { ...(next ?? {}) };
  for (const [key, value] of Object.entries(before ?? {})) {
    const environment = environmentReference(value);
    if (environment && key !== environment) output[key] = value;
  }
  return nonEmptyRecord(output);
}
