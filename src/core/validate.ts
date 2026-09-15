import { lstat, realpath, readdir } from "node:fs/promises";
import { assertSecretAllowlist } from "./secret-allowlist.js";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TARGET_NAMES, type CanonicalHarness, type TargetName } from "../types.js";
import { isRecord } from "./frontmatter.js";
import { pathExists, resolveInside } from "./fs.js";
import { assertHookScriptName } from "./hook-scripts.js";
import { assertOutputStyleName } from "./output-styles.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const CODEX_RESERVED_AGENT_NAMES = new Set([
  "enabled",
  "default_subagent_model",
  "default_subagent_reasoning_effort",
  "interrupt_message",
  "max_concurrent_threads_per_session",
  "max_threads",
]);
const MCP_NATIVE_FEATURES: Record<TargetName, ReadonlySet<string>> = {
  claude: new Set([
    "oauth",
    "headersHelper",
    "alwaysLoad",
    "settings.mcpPolicy",
    "settings.projectMcpApproval",
    "settings.mcpPermissions",
    "settings.mcpHooks",
    "projects.disabledMcpServers",
    "templateExpansion",
  ]),
  codex: new Set([
    "auth",
    "oauth",
    "oauth_resource",
    "scopes",
    "http_headers_helper",
    "env_vars.object",
    "experimental_environment.remote",
    "default_tools_approval_mode",
    "tools.approval_mode",
    "required",
    "literalTemplate",
    "settings.projectTrust",
    "settings.mcpHooks",
  ]),
  antigravity: new Set([
    "authProviderType",
    "oauth",
    "literalTemplate",
    "remoteProtocol",
    "settings.projectTrust",
    "settings.mcpPermissions",
    "settings.mcpHooks",
  ]),
};

export function assertArtifactName(name: string, kind: string): void {
  if (
    !SAFE_NAME.test(name) ||
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    WINDOWS_RESERVED.test(name)
  ) {
    throw new Error(`Invalid ${kind} name: ${JSON.stringify(name)}`);
  }
}

export function assertMcpServerName(name: string): void {
  if (!SAFE_MCP_NAME.test(name)) {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(name)}`);
  }
}

export async function validateHarness(
  storeDir: string,
  harness: CanonicalHarness,
): Promise<void> {
  if (!isRecord(harness.metadata) || typeof harness.metadata.name !== "string") {
    throw new Error("Invalid metadata: expected a string name");
  }
  assertOptionalString(harness.metadata.description, "metadata.description");
  if (!isRecord(harness.instructions) || typeof harness.instructions.root !== "string") {
    throw new Error("Invalid instructions: expected a string root");
  }
  assertSecretAllowlist(harness.secretAllowlist ?? []);
  if (!Array.isArray(harness.skills) || !Array.isArray(harness.rules)) {
    throw new Error("Invalid harness: skills and rules must be arrays");
  }
  for (const [label, value] of [
    ["commands", harness.commands],
    ["agents", harness.agents],
    ["mcpServers", harness.mcpServers],
    ["permissions", harness.permissions],
    ["hooks", harness.hooks],
    ["overlays", harness.overlays],
  ] as const) {
    if (!isRecord(value)) throw new Error(`Invalid ${label}: expected an object`);
  }

  await validateArtifact(
    storeDir,
    harness.instructions.root,
    "instructions",
    "instructions",
    "file",
  );
  const names = new Set<string>();
  const skillNames = new Set<string>();
  for (const skill of harness.skills) {
    if (!skill || typeof skill.name !== "string" || typeof skill.path !== "string") {
      throw new Error("Invalid skill entry: expected string name and path");
    }
    assertArtifactName(skill.name, "skill");
    if (skill.name.toLowerCase() === "synced") {
      throw new Error('Invalid skill name "synced": Claude reserves this folder');
    }
    const folded = skill.name.toLowerCase();
    if (names.has(folded)) throw new Error(`Duplicate skill name (case-insensitive): ${skill.name}`);
    names.add(folded);
    skillNames.add(folded);
    await validateArtifact(
      storeDir,
      skill.path,
      `skill ${skill.name}`,
      "skills",
      "directory",
    );
    const skillEntry = resolveInside(storeDir, `${skill.path}/SKILL.md`);
    if (!(await pathExists(skillEntry)) || !(await lstat(skillEntry)).isFile()) {
      throw new Error(`Skill ${skill.name} must contain a regular SKILL.md file`);
    }
  }
  const rulePaths = new Set<string>();
  for (const rule of harness.rules) {
    if (!rule || typeof rule.path !== "string") {
      throw new Error("Invalid rule entry: expected a string path");
    }
    const folded = rule.path.toLowerCase();
    if (rulePaths.has(folded)) throw new Error(`Duplicate rule path: ${rule.path}`);
    rulePaths.add(folded);
    assertOptionalStringArray(rule.globs, `rule ${rule.path}.globs`);
    if (rule.portable !== undefined && typeof rule.portable !== "boolean") {
      throw new Error(`Invalid rule ${rule.path}.portable: expected a boolean`);
    }
    validateTargetMaps(rule.targets, `rule ${rule.path}.targets`);
    await validateArtifact(storeDir, rule.path, "rule", "rules", "file");
  }
  const commandNames = new Set<string>();
  const projectedCommandSkills = new Set<string>();
  for (const [name, command] of Object.entries(harness.commands)) {
    assertArtifactName(name, "command");
    if (!command || typeof command.promptFile !== "string") {
      throw new Error(`Invalid command ${name}: expected a string promptFile`);
    }
    assertOptionalString(command.description, `command ${name}.description`);
    assertOptionalString(command.argumentHint, `command ${name}.argumentHint`);
    validateTargetMaps(command.targets, `command ${name}.targets`);
    const folded = name.toLowerCase();
    if (commandNames.has(folded)) throw new Error(`Duplicate command name: ${name}`);
    commandNames.add(folded);
    const projected = skillNames.has(folded) ? `command-${name}` : name;
    const projectedFolded = projected.toLowerCase();
    if (skillNames.has(projectedFolded) || projectedCommandSkills.has(projectedFolded)) {
      throw new Error(
        `Command ${name} collides with projected skill directory ${projected}`,
      );
    }
    assertArtifactName(projected, "projected command skill");
    projectedCommandSkills.add(projectedFolded);
    await validateArtifact(
      storeDir,
      command.promptFile,
      `command ${name}`,
      "commands",
      "file",
    );
  }
  const agentNames = new Set<string>();
  const agentNativePaths = new Set<string>();
  for (const [name, agent] of Object.entries(harness.agents)) {
    assertArtifactName(name, "agent");
    if (CODEX_RESERVED_AGENT_NAMES.has(name.toLowerCase())) {
      throw new Error(
        `Invalid agent name ${JSON.stringify(name)}: reserved by Codex [agents] configuration`,
      );
    }
    if (!agent || typeof agent.instructionsFile !== "string") {
      throw new Error(`Invalid agent ${name}: expected a string instructionsFile`);
    }
    if (typeof agent.description !== "string") {
      throw new Error(`Invalid agent ${name}.description: expected a string`);
    }
    assertOptionalString(agent.model, `agent ${name}.model`);
    assertOptionalString(agent.reasoningEffort, `agent ${name}.reasoningEffort`);
    if (
      agent.filesystem !== undefined &&
      !["read-only", "workspace-write", "full-access"].includes(agent.filesystem)
    ) {
      throw new Error(`Invalid agent ${name}.filesystem`);
    }
    assertOptionalStringArray(agent.tools, `agent ${name}.tools`);
    assertOptionalStringArray(agent.disallowedTools, `agent ${name}.disallowedTools`);
    validateTargetMaps(agent.targets, `agent ${name}.targets`);
    if (agent.nativePaths !== undefined) {
      if (!isRecord(agent.nativePaths)) {
        throw new Error(`Invalid agent ${name}.nativePaths: expected an object`);
      }
      for (const [target, nativePath] of Object.entries(agent.nativePaths)) {
        if (!(TARGET_NAMES as readonly string[]).includes(target)) {
          throw new Error(`Invalid agent ${name}.nativePaths.${target}: unsupported target`);
        }
        if (target === "codex") {
          throw new Error(
            `Invalid agent ${name}.nativePaths.codex: Codex native agent paths are not portable yet`,
          );
        }
        if (
          typeof nativePath !== "string" ||
          nativePath.length === 0 ||
          isAbsolute(nativePath) ||
          nativePath.includes("\\") ||
          !nativePath.toLowerCase().endsWith(".md") ||
          nativePath
            .split(/[\\/]+/u)
            .some(
              (component) =>
                component === "." ||
                component === ".." ||
                component.toLowerCase() === ".git",
            )
        ) {
          throw new Error(
            `Invalid agent ${name}.nativePaths.${target}: expected a safe relative Markdown path`,
          );
        }
      }
    }
    for (const target of ["claude", "antigravity"] as const) {
      const nativePath = agent.nativePaths?.[target] ?? `${name}.md`;
      const normalized = nativePath
        .split("/")
        .filter(Boolean)
        .join("/")
        .toLowerCase();
      const key = `${target}:${normalized}`;
      if (agentNativePaths.has(key)) {
        throw new Error(`Duplicate native agent path for ${target}: ${nativePath}`);
      }
      agentNativePaths.add(key);
    }
    const folded = name.toLowerCase();
    if (agentNames.has(folded)) throw new Error(`Duplicate agent name: ${name}`);
    agentNames.add(folded);
    await validateArtifact(
      storeDir,
      agent.instructionsFile,
      `agent ${name}`,
      "agents",
      "file",
    );
  }
  for (const [name, server] of Object.entries(harness.mcpServers)) {
    assertMcpServerName(name);
    validateMcpServer(server, name);
    validateMcpNativeRequirements(harness, server, name);
  }
  validatePermissions(harness.permissions);
  validateHooks(harness.hooks);
  validateOverlays(harness.overlays);
  await validateHookScripts(storeDir, harness);
  await validateOutputStyles(storeDir, harness);
}

async function validateArtifact(
  storeDir: string,
  relativePath: string,
  label: string,
  expectedRoot: string,
  expectedType: "file" | "directory",
): Promise<void> {
  if (
    relativePath
      .split(/[\\/]+/u)
      .some((component) => component.toLowerCase() === ".git")
  ) {
    throw new Error(`${label} path contains reserved Git metadata: ${relativePath}`);
  }
  const candidate = resolveInside(storeDir, relativePath);
  const expected = resolve(storeDir, expectedRoot);
  const rootRemainder = relative(expected, candidate);
  if (rootRemainder === ".." || rootRemainder.startsWith(`..${sep}`)) {
    throw new Error(`${label} must live under ${expectedRoot}/: ${relativePath}`);
  }
  if (!(await pathExists(candidate))) {
    throw new Error(`Missing ${label} artifact: ${relativePath}`);
  }
  const info = await lstat(candidate);
  const validType = expectedType === "file" ? info.isFile() : info.isDirectory();
  if (!validType) {
    throw new Error(
      `Invalid ${label} artifact type: expected a regular ${expectedType}: ${relativePath}`,
    );
  }
  const [realStore, realCandidate] = await Promise.all([
    realpath(storeDir),
    realpath(candidate),
  ]);
  assertContained(realStore, realCandidate, `${label} symlink`);
  await validateNestedSymlinks(realStore, candidate, new Set<string>());
}

function validateMcpServer(value: unknown, name: string): void {
  if (!isRecord(value)) throw new Error(`Invalid MCP server ${name}: expected an object`);
  if (!["stdio", "http", "sse", "ws"].includes(String(value.transport))) {
    throw new Error(`Invalid MCP server ${name}.transport`);
  }
  for (const key of ["command", "cwd", "url", "bearerTokenEnvVar"] as const) {
    assertOptionalString(value[key], `MCP server ${name}.${key}`);
  }
  if (
    value.bearerTokenEnvVar !== undefined &&
    !/^[A-Z_][A-Z0-9_]*$/u.test(String(value.bearerTokenEnvVar))
  ) {
    throw new Error(
      `Invalid MCP server ${name}.bearerTokenEnvVar: expected an environment variable name`,
    );
  }
  if (value.transport === "stdio") {
    assertRequiredNonEmptyString(value.command, `MCP server ${name}.command`);
  } else {
    assertRequiredNonEmptyString(value.url, `MCP server ${name}.url`);
  }
  for (const key of ["args", "enabledTools", "disabledTools"] as const) {
    assertOptionalStringArray(value[key], `MCP server ${name}.${key}`);
  }
  for (const key of ["env", "headers"] as const) {
    assertOptionalStringRecord(value[key], `MCP server ${name}.${key}`);
  }
  if (value.requiredNativeFeatures !== undefined) {
    if (!isRecord(value.requiredNativeFeatures)) {
      throw new Error(
        `Invalid MCP server ${name}.requiredNativeFeatures: expected an object`,
      );
    }
    for (const [target, features] of Object.entries(
      value.requiredNativeFeatures,
    )) {
      if (!(TARGET_NAMES as readonly string[]).includes(target)) {
        throw new Error(
          `Invalid MCP server ${name}.requiredNativeFeatures.${target}: unsupported target`,
        );
      }
      if (
        !Array.isArray(features) ||
        features.length === 0 ||
        features.some(
          (feature) => typeof feature !== "string" || feature.length === 0,
        )
      ) {
        throw new Error(
          `Invalid MCP server ${name}.requiredNativeFeatures.${target}: expected a non-empty array of strings`,
        );
      }
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Invalid MCP server ${name}.enabled: expected a boolean`);
  }
  for (const key of ["startupTimeoutMs", "toolTimeoutMs"] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)
    ) {
      throw new Error(`Invalid MCP server ${name}.${key}: expected a non-negative number`);
    }
  }
}

function validateMcpNativeRequirements(
  harness: CanonicalHarness,
  server: unknown,
  name: string,
): void {
  if (!isRecord(server) || !isRecord(server.requiredNativeFeatures)) return;
  for (const [targetName, features] of Object.entries(
    server.requiredNativeFeatures,
  )) {
    const target = targetName as TargetName;
    if (!Array.isArray(features)) continue;
    const overlay = harness.overlays[target]?.mcp;
    const serverMap = target === "antigravity"
      ? (isRecord(overlay?.mcpServers) ? overlay.mcpServers : {})
      : (isRecord(overlay?.serversRaw) ? overlay.serversRaw : {});
    const raw = serverMap[name];
    const serverFeatures = features.filter(
      (feature) =>
        feature !== "settings.mcpPolicy" &&
        feature !== "settings.projectMcpApproval" &&
        feature !== "settings.mcpPermissions" &&
        feature !== "settings.mcpHooks" &&
        feature !== "settings.projectTrust" &&
        feature !== "projects.disabledMcpServers",
    );
    if (serverFeatures.length > 0 && !isRecord(raw)) {
      throw new Error(
        `MCP server ${name} requires ${target} native features but has no matching target overlay`,
      );
    }
    for (const feature of features) {
      if (!MCP_NATIVE_FEATURES[target]?.has(feature)) {
        throw new Error(
          `Invalid MCP server ${name}.requiredNativeFeatures.${target}: unknown feature ${JSON.stringify(feature)}`,
        );
      }
      const present = nativeFeatureEvidencePresent(
        harness,
        target,
        feature,
        raw,
      );
      if (!present) {
        throw new Error(
          `MCP server ${name} requires ${target} native feature ${feature}, but its target overlay does not contain it`,
        );
      }
    }
  }
}

function nativeFeatureEvidencePresent(
  harness: CanonicalHarness,
  target: TargetName,
  feature: string,
  raw: unknown,
): boolean {
  if (feature === "settings.mcpPolicy") {
    return target === "claude" && hasClaudeMcpPolicyOverlay(harness);
  }
  if (feature === "settings.projectMcpApproval") {
    return target === "claude" &&
      harness.overlays.claude.metadata?.projectMcpApprovalCaptured === true;
  }
  if (feature === "projects.disabledMcpServers") {
    return target === "claude" &&
      harness.overlays.claude.metadata?.projectDisabledMcpServersCaptured === true;
  }
  if (feature === "settings.projectTrust") {
    return target === "codex"
      ? harness.overlays.codex.metadata?.projectTrustCaptured === true
      : target === "antigravity" &&
        harness.overlays.antigravity.metadata?.projectTrustCaptured === true;
  }
  if (feature === "settings.mcpPermissions") {
    return hasMcpPermissionEvidence(harness, target);
  }
  if (feature === "settings.mcpHooks") {
    return hasMcpHookEvidence(harness, target);
  }
  return isRecord(raw) && nativeFeatureIsPresent(raw, feature);
}

function hasMcpPermissionEvidence(
  harness: CanonicalHarness,
  target: TargetName,
): boolean {
  if (target === "claude") {
    if (harness.overlays.claude.metadata?.mcpPermissionsCaptured !== true) {
      return false;
    }
    const raw = harness.overlays.claude.metadata?.permissionsRaw;
    if (
      isRecord(raw) &&
      (raw.defaultMode === "dontAsk" || raw.defaultMode === "plan")
    ) {
      return true;
    }
    return [
      ...(harness.permissions.commandAsk ?? []),
      ...(harness.permissions.commandDeny ?? []),
    ].some(isRestrictiveClaudeMcpRule);
  }
  if (target === "antigravity") {
    if (
      harness.overlays.antigravity.metadata?.mcpPermissionsCaptured !== true
    ) {
      return false;
    }
    const settings = harness.overlays.antigravity.settings;
    const permissions = isRecord(settings?.permissions)
      ? settings.permissions
      : {};
    return ["ask", "deny"].some((key) =>
      stringArray(permissions[key]).some(
        (rule) => rule === "*" || /^mcp(?:\(|$)/iu.test(rule),
      ),
    );
  }
  return false;
}

function isRestrictiveClaudeMcpRule(rule: string): boolean {
  return !rule.includes("(") && (/^mcp__/u.test(rule) || rule.includes("*"));
}

function hasMcpHookEvidence(
  harness: CanonicalHarness,
  target: TargetName,
): boolean {
  const metadata = harness.overlays[target].metadata;
  if (metadata?.mcpHooksCaptured !== true) return false;
  if (target === "claude") {
    return hasMcpBlockingHookGroups(metadata.hooksRaw);
  }
  if (target === "codex") {
    const hooksFile = metadata.hooksFileRaw;
    return hasMcpBlockingHookGroups(metadata.hooksRaw) ||
      (isRecord(hooksFile) && hasMcpBlockingHookGroups(hooksFile.hooks));
  }
  const namedHooks = metadata.hooksRaw;
  return isRecord(namedHooks) && Object.values(namedHooks).some(
    (definition) =>
      isRecord(definition) &&
      definition.enabled !== false &&
      hasMcpBlockingHookGroups(definition),
  );
}

function hasMcpBlockingHookGroups(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const event of ["PreToolUse", "PermissionRequest"] as const) {
    const groups = value[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (
        !isRecord(group) ||
        !Array.isArray(group.hooks) ||
        !group.hooks.some(isRecord)
      ) {
        continue;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      if (matcher.length === 0 || matcher === "*") return true;
      if (matcher.toLowerCase().includes("mcp")) return true;
      try {
        const expression = new RegExp(matcher, "u");
        if (["mcp__dangerous__tool", "mcp__x__y"].some((tool) => {
          expression.lastIndex = 0;
          return expression.test(tool);
        })) {
          return true;
        }
      } catch {
        // Malformed raw hooks cannot prove the presence of a native gate.
      }
    }
  }
  return false;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function hasClaudeMcpPolicyOverlay(harness: CanonicalHarness): boolean {
  const settings = harness.overlays.claude.settings;
  if (!isRecord(settings)) return false;
  return settings.allowedMcpServers !== undefined ||
    (Array.isArray(settings.deniedMcpServers) && settings.deniedMcpServers.length > 0);
}

function nativeFeatureIsPresent(
  raw: Record<string, unknown>,
  feature: string,
): boolean {
  if (feature === "env_vars.object") {
    return Array.isArray(raw.env_vars) && raw.env_vars.some(isRecord);
  }
  if (feature === "experimental_environment.remote") {
    return raw.experimental_environment === "remote";
  }
  if (feature === "alwaysLoad" || feature === "required") {
    return raw[feature] === true;
  }
  if (feature === "tools.approval_mode") {
    return isRecord(raw.tools) && Object.values(raw.tools).some(
      (tool) => isRecord(tool) && tool.approval_mode !== undefined,
    );
  }
  if (feature === "remoteProtocol") {
    return typeof raw.serverUrl === "string" && /^https?:\/\//iu.test(raw.serverUrl);
  }
  if (feature === "templateExpansion" || feature === "literalTemplate") {
    return containsNativeEnvironmentTemplate(raw);
  }
  return Object.prototype.hasOwnProperty.call(raw, feature);
}

function containsNativeEnvironmentTemplate(value: unknown): boolean {
  if (typeof value === "string") {
    return /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/u.test(value);
  }
  if (Array.isArray(value)) return value.some(containsNativeEnvironmentTemplate);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsNativeEnvironmentTemplate);
}

function validatePermissions(value: unknown): void {
  if (!isRecord(value)) throw new Error("Invalid permissions: expected an object");
  if (
    value.filesystem !== undefined &&
    !["read-only", "workspace-write", "full-access"].includes(String(value.filesystem))
  ) {
    throw new Error("Invalid permissions.filesystem");
  }
  if (
    value.network !== undefined &&
    !["deny", "prompt", "allow"].includes(String(value.network))
  ) {
    throw new Error("Invalid permissions.network");
  }
  if (
    value.approval !== undefined &&
    !["untrusted", "on-request", "never"].includes(String(value.approval))
  ) {
    throw new Error("Invalid permissions.approval");
  }
  for (const key of ["commandAllow", "commandDeny", "commandAsk"] as const) {
    assertOptionalStringArray(value[key], `permissions.${key}`);
  }
}

function validateHooks(value: unknown): void {
  if (!isRecord(value)) throw new Error("Invalid hooks: expected an object");
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid hooks.${event}: expected an array`);
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group) || !Array.isArray(group.handlers)) {
        throw new Error(`Invalid hooks.${event}[${groupIndex}]: expected handlers array`);
      }
      assertOptionalString(group.matcher, `hooks.${event}[${groupIndex}].matcher`);
      for (const [handlerIndex, handler] of group.handlers.entries()) {
        const label = `hooks.${event}[${groupIndex}].handlers[${handlerIndex}]`;
        if (!isRecord(handler)) throw new Error(`Invalid ${label}: expected an object`);
        if (!["command", "http", "prompt", "agent", "mcp"].includes(String(handler.type))) {
          throw new Error(`Invalid ${label}.type`);
        }
        for (const key of ["command", "url", "prompt"] as const) {
          assertOptionalString(handler[key], `${label}.${key}`);
        }
        if (handler.type === "command") {
          assertRequiredNonEmptyString(handler.command, `${label}.command`);
        } else if (handler.type === "http") {
          assertRequiredNonEmptyString(handler.url, `${label}.url`);
        } else if (handler.type === "prompt" || handler.type === "agent") {
          assertRequiredNonEmptyString(handler.prompt, `${label}.prompt`);
        } else if (
          handler.type === "mcp" &&
          (!isRecord(handler.extra) ||
            typeof handler.extra.server !== "string" ||
            handler.extra.server.trim().length === 0 ||
            typeof handler.extra.tool !== "string" ||
            handler.extra.tool.trim().length === 0)
        ) {
          throw new Error(
            `Invalid ${label}.extra: MCP hooks require non-empty server and tool strings`,
          );
        }
        if (
          handler.timeoutSeconds !== undefined &&
          (typeof handler.timeoutSeconds !== "number" ||
            !Number.isFinite(handler.timeoutSeconds) ||
            handler.timeoutSeconds < 0)
        ) {
          throw new Error(`Invalid ${label}.timeoutSeconds`);
        }
        if (handler.async !== undefined && typeof handler.async !== "boolean") {
          throw new Error(`Invalid ${label}.async`);
        }
        if (handler.extra !== undefined && !isRecord(handler.extra)) {
          throw new Error(`Invalid ${label}.extra: expected an object`);
        }
      }
    }
  }
}

async function validateOutputStyles(
  storeDir: string,
  harness: CanonicalHarness,
): Promise<void> {
  if (harness.outputStyles === undefined) return;
  const names = new Set<string>();
  for (const entry of harness.outputStyles) {
    if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") {
      throw new Error("Invalid output style entry: expected string name and path");
    }
    assertOutputStyleName(entry.name);
    const folded = entry.name.toLowerCase();
    if (names.has(folded)) {
      throw new Error(`Duplicate output style name (case-insensitive): ${entry.name}`);
    }
    names.add(folded);
    await validateArtifact(
      storeDir,
      entry.path,
      `output style ${entry.name}`,
      "output-styles",
      "file",
    );
  }
}

async function validateHookScripts(
  storeDir: string,
  harness: CanonicalHarness,
): Promise<void> {
  // Short-circuit so a store that never used the feature pays nothing.
  if (harness.hookScripts === undefined) return;
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const entry of harness.hookScripts) {
    if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") {
      throw new Error("Invalid hook script entry: expected string name and path");
    }
    assertHookScriptName(entry.name);
    const foldedName = entry.name.toLowerCase();
    if (names.has(foldedName)) {
      throw new Error(`Duplicate hook script name (case-insensitive): ${entry.name}`);
    }
    names.add(foldedName);
    const foldedPath = entry.path.toLowerCase();
    if (paths.has(foldedPath)) {
      throw new Error(`Duplicate hook script path (case-insensitive): ${entry.path}`);
    }
    paths.add(foldedPath);
    await validateArtifact(
      storeDir,
      entry.path,
      `hook script ${entry.name}`,
      "hook-scripts",
      "file",
    );
  }
}

function validateOverlays(value: unknown): void {
  if (!isRecord(value)) throw new Error("Invalid overlays: expected an object");
  for (const target of TARGET_NAMES) {
    const overlay = value[target];
    // Mirrors normalizeHarness: a missing overlay is defaulted on load, so
    // rejecting it here would only move the fourth-target failure one file over.
    if (overlay === undefined) continue;
    if (!isRecord(overlay)) throw new Error(`Invalid overlays.${target}: expected an object`);
    for (const key of ["settings", "mcp", "metadata"] as const) {
      if (overlay[key] !== undefined && !isRecord(overlay[key])) {
        throw new Error(`Invalid overlays.${target}.${key}: expected an object`);
      }
    }
  }
}

function validateTargetMaps(
  value: Partial<Record<TargetName, Record<string, unknown>>> | undefined,
  label: string,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`Invalid ${label}: expected an object`);
  for (const [target, overlay] of Object.entries(value)) {
    if (!(TARGET_NAMES as readonly string[]).includes(target) || !isRecord(overlay)) {
      throw new Error(`Invalid ${label}.${target}: expected a supported target object`);
    }
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected a string`);
  }
}

function assertRequiredNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }
}

function assertOptionalStringArray(value: unknown, label: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`Invalid ${label}: expected an array of strings`);
  }
}

function assertOptionalStringRecord(value: unknown, label: string): void {
  if (
    value !== undefined &&
    (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`Invalid ${label}: expected an object of strings`);
  }
}

async function validateNestedSymlinks(
  realStore: string,
  current: string,
  visited: Set<string>,
): Promise<void> {
  const resolved = await realpath(current);
  assertContained(realStore, resolved, "artifact symlink");
  if (visited.has(resolved)) return;
  visited.add(resolved);
  const currentInfo = await lstat(current);
  if (currentInfo.isFile()) return;
  if (!currentInfo.isDirectory()) {
    throw new Error(`canonical artifact contains a non-regular file: ${current}`);
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.toLowerCase() === ".git") {
      throw new Error(`canonical artifact contains nested Git metadata: ${join(current, entry.name)}`);
    }
    const candidate = join(current, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new Error(`canonical artifact contains a nested symlink: ${candidate}`);
    }
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error(`canonical artifact contains a non-regular file: ${candidate}`);
    }
    await validateNestedSymlinks(realStore, candidate, visited);
  }
}

function assertContained(base: string, candidate: string, label: string): void {
  const remainder = relative(resolve(base), resolve(candidate));
  if (
    remainder === ".." ||
    remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`${label} escapes the canonical store: ${candidate}`);
  }
}
