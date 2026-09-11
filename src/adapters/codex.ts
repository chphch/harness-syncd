import { readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type {
  AdapterWarning,
  ApplyResult,
  CanonicalHarness,
  PortablePermissions,
} from "../types.js";
import {
  assertNativeImportPath,
  assertSafeStorePath,
  pathExists,
  readTextIfExists,
  resolveInside,
  writeTextAtomicInside,
} from "../core/fs.js";
import { isRecord, stringifyFrontmatter } from "../core/frontmatter.js";
import {
  containsEnvironmentReference,
  environmentReference,
  redactSecrets,
  scrubEnvironmentReferences,
} from "../core/secrets.js";
import { assertArtifactName } from "../core/validate.js";
import { fingerprintManagedTarget, ManagedWriter } from "../core/writer.js";
import {
  captureBoundary,
  type AdapterContext,
  type ApplyOptions,
  type CaptureOptions,
  type HarnessAdapter,
} from "./adapter.js";
import {
  agentHasOnlyForeignTargetCapabilities,
  asString,
  asStringArray,
  assertUniqueImportedNames,
  capturePathAllowed,
  captureMcpServers,
  cloneHarness,
  deepMerge,
  importInstruction,
  importSkills,
  hasMcpBlockingHooks,
  mergeCapturedMcpServers,
  mergeCapturedAgents,
  mcpExecutableContainsEnvironmentReference,
  mcpRequiresUnavailableNativeFeatures,
  mcpServerOverlays,
  mergeMcpServerOverlays,
  readJsonObject,
  renderMcpServers,
  withoutKeys,
} from "./common.js";

const PORTABLE_CONFIG_KEYS = [
  "mcp_servers",
  "hooks",
  "agents",
];

export class CodexAdapter implements HarnessAdapter {
  readonly name = "codex" as const;

  async capture(
    current: CanonicalHarness,
    context: AdapterContext,
    options: CaptureOptions,
  ) {
    const harness = cloneHarness(current);
    const warnings = [];
    const imported: string[] = [];
    const paths = codexPaths(context);
    const nativeRoot = captureBoundary(context);
    const projectionFallbacks = codexMcpProjectionFallbacks(
      harness,
      context.scope,
    );
    const priorMetadata = current.overlays.codex.metadata;
    const priorHooksRaw = isRecord(priorMetadata?.hooksRaw)
      ? priorMetadata.hooksRaw
      : {};
    const priorHooksFileRaw = isRecord(priorMetadata?.hooksFileRaw)
      ? priorMetadata.hooksFileRaw
      : {};
    const hasGeneratedHookFallback = Object.entries(current.mcpServers).some(
      ([name, server]) =>
        projectionFallbacks.has(name) &&
        server.requiredNativeFeatures?.codex?.includes("settings.mcpHooks"),
    );
    const rawConfig = capturePathAllowed(paths.config, options.managedPaths)
      ? await readTomlObject(paths.config, nativeRoot)
      : null;
    const redactedConfig = rawConfig
      ? redactSecrets(rawConfig, paths.config)
      : null;
    if (redactedConfig) warnings.push(...redactedConfig.warnings);
    const config = redactedConfig?.value ?? null;
    const hooksFileCaptured = capturePathAllowed(
      paths.hooks,
      options.managedPaths,
    );
    const rawHooksFile = hooksFileCaptured
      ? await readJsonObject(paths.hooks, nativeRoot)
      : null;
    const redactedHooksFile = rawHooksFile
      ? redactSecrets(rawHooksFile, paths.hooks)
      : null;
    if (redactedHooksFile) warnings.push(...redactedHooksFile.warnings);
    const hooksFile = redactedHooksFile?.value ?? null;
    if (hooksFile) assertCodexHooksFileShape(hooksFile, paths.hooks);
    if (config?.agents !== undefined && !isRecord(config.agents)) {
      throw new Error(`${paths.config}.agents: expected a TOML table`);
    }
    if (config?.hooks !== undefined && !isRecord(config.hooks)) {
      throw new Error(`${paths.config}.hooks: expected a TOML table`);
    }

    if (
      await importInstruction(
        paths.instructions,
        context.storeDir,
        harness,
        options.write,
        options.managedPaths,
        nativeRoot,
        context.canonicalSourceStoreDir,
      )
    ) {
      imported.push(paths.instructions);
    }

    if (options.includeAssets) {
      const skills = await importSkills(
        paths.skills,
        context.storeDir,
        options.write,
        options.managedPaths,
        nativeRoot,
        context.canonicalSourceStoreDir,
        options.excludeSkills ?? [],
      );
      if (skills.length > 0) {
        const capturedNames = new Set(skills.map((skill) => skill.name));
        harness.skills = [
          ...harness.skills.filter((skill) => !capturedNames.has(skill.name)),
          ...skills,
        ];
        imported.push(paths.skills);
      }
      const agents = await importCodexAgents(
        paths.agents,
        context.storeDir,
        options.write,
        options.managedPaths,
        isRecord(config?.agents) ? config.agents : undefined,
        dirname(paths.config),
        context.targetRoot,
        warnings,
      );
      if (Object.keys(agents).length > 0) {
        harness.agents = mergeCapturedAgents(harness.agents, agents);
        imported.push(paths.agents);
      }
    }

    let authoredServerNames: string[] = [];
    if (config) {
      const safe = config;
      const encodedSafe = encodeTomlSpecialValues(safe) as Record<string, unknown>;
      const captured = captureMcpServers(
        safe.mcp_servers,
        `${paths.config}.mcp_servers`,
        this.name,
      );
      harness.mcpServers = mergeCapturedMcpServers(
        harness.mcpServers,
        captured.servers,
        this.name,
        projectionFallbacks,
      );
      warnings.push(...captured.warnings);
      const { filesystem: _filesystem, approval: _approval, ...otherPermissions } =
        harness.permissions;
      harness.permissions = {
        ...otherPermissions,
        ...captureCodexPermissions(safe),
      };
      const metadata = { ...harness.overlays.codex.metadata };
      delete metadata.hooksRaw;
      authoredServerNames = Object.keys(captured.servers).filter(
        (name) => !projectionFallbacks.has(name),
      );
      if (
        context.scope === "project" &&
        Object.keys(captured.servers).some(
          (name) => !projectionFallbacks.has(name),
        )
      ) {
        metadata.projectTrustCaptured = true;
        updateCodexProjectTrustRequirements(
          harness,
          Object.keys(captured.servers).filter(
            (name) => !projectionFallbacks.has(name),
          ),
        );
      }
      if (isRecord(encodedSafe.hooks)) {
        metadata.hooksRaw = encodedSafe.hooks;
      } else if (
        hasGeneratedHookFallback &&
        containsEnvironmentReference(priorHooksRaw)
      ) {
        metadata.hooksRaw = priorHooksRaw;
      }
      if (isRecord(encodedSafe.agents)) {
        metadata.agentDeclarationsRaw = Object.fromEntries(
          Object.entries(encodedSafe.agents).flatMap(([name, declaration]) =>
            isRecord(declaration)
              ? [[name, withoutKeys(declaration, ["description"])]]
              : [],
          ),
        );
        metadata.agentSettingsRaw = Object.fromEntries(
          Object.entries(encodedSafe.agents).filter(([, entry]) => !isRecord(entry)),
        );
      } else {
        delete metadata.agentDeclarationsRaw;
        delete metadata.agentSettingsRaw;
      }
      harness.overlays.codex.metadata = metadata;
      const settings = withoutKeys(encodedSafe, PORTABLE_CONFIG_KEYS);
      if (isPortableApprovalPolicy(safe.approval_policy)) {
        delete settings.approval_policy;
      }
      if (isPortableSandboxMode(safe.sandbox_mode)) {
        delete settings.sandbox_mode;
      }
      harness.overlays.codex.settings = settings;
      harness.overlays.codex.mcp = {
        serversRaw: encodedSafe.mcp_servers === undefined
          ? {}
          : mcpServerOverlays(
              encodedSafe.mcp_servers as Record<string, unknown>,
              this.name,
            ),
      };
      imported.push(paths.config);
    }

    if (hooksFileCaptured) {
      const metadata = { ...harness.overlays.codex.metadata };
      delete metadata.hooksFileRaw;
      if (hooksFile) {
        metadata.hooksFileRaw = hooksFile;
      } else if (
        hasGeneratedHookFallback &&
        containsEnvironmentReference(priorHooksFileRaw)
      ) {
        metadata.hooksFileRaw = priorHooksFileRaw;
      }
      harness.overlays.codex.metadata = metadata;
      if (hooksFile) imported.push(paths.hooks);
    }
    if (config || hooksFileCaptured) {
      const metadata = { ...harness.overlays.codex.metadata };
      const effectiveHooksFile = isRecord(metadata.hooksFileRaw)
        ? metadata.hooksFileRaw
        : {};
      const hookEvidenceCaptured = hasMcpBlockingHooks(
        metadata.hooksRaw,
        `${paths.config}.hooks`,
      ) || hasMcpBlockingHooks(
        effectiveHooksFile.hooks,
        `${paths.hooks}.hooks`,
      );
      const preservedHookRequirementNames = Object.entries(harness.mcpServers)
        .flatMap(([name, server]) =>
          projectionFallbacks.has(name) &&
          server.requiredNativeFeatures?.codex?.includes("settings.mcpHooks")
            ? [name]
            : [],
        );
      delete metadata.mcpHooksCaptured;
      if (hookEvidenceCaptured && (
        authoredServerNames.length > 0 ||
        preservedHookRequirementNames.length > 0
      )) {
        metadata.mcpHooksCaptured = true;
        updateCodexMcpHookRequirements(harness, authoredServerNames);
      } else if (!hookEvidenceCaptured) {
        removeCodexMcpHookRequirements(
          harness,
          preservedHookRequirementNames,
        );
      }
      harness.overlays.codex.metadata = metadata;
    }

    return { harness, warnings, imported };
  }

  async apply(
    harness: CanonicalHarness,
    context: AdapterContext,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    const paths = codexPaths(context);
    const writer = new ManagedWriter({
      ...options,
      storeDir: context.storeDir,
      target: this.name,
      allowedRoot: context.scope === "project" ? context.targetRoot : dirname(context.targetRoot),
    });
    await writer.load();
    const projectionWarnings: AdapterWarning[] = [];
    const existingConfig = await readTomlObject(
      paths.config,
      captureBoundary(context),
    );
    const preservedConfigPath = join(
      context.storeDir,
      ".local",
      "preserved",
      `${this.name}-config.toml`,
    );
    let preservedUnmanagedConfig = options.ignoreLocalBase
      ? null
      : await readTomlObject(preservedConfigPath, context.storeDir);
    if (!writer.owns(paths.config) && !options.ignoreLocalBase) {
      if (existingConfig) {
        preservedUnmanagedConfig = codexLocalBase(existingConfig);
        if (!options.dryRun) {
          await writeTextAtomicInside(
            context.storeDir,
            preservedConfigPath,
            stringifyToml(preservedUnmanagedConfig),
          );
        }
      } else {
        preservedUnmanagedConfig = {};
        if (!options.dryRun) {
          await assertSafeStorePath(context.storeDir, preservedConfigPath);
          await rm(preservedConfigPath, { force: true });
        }
      }
    }
    preservedUnmanagedConfig ??= {};
    const localPermissionSource = existingConfig ?? preservedUnmanagedConfig;
    const locallyPreservedPermissionKeys: string[] = [];
    const localPermissionFallback: Record<string, unknown> = {};
    if (
      harness.permissions.approval === undefined &&
      localPermissionSource.approval_policy !== undefined
    ) {
      localPermissionFallback.approval_policy = localPermissionSource.approval_policy;
      locallyPreservedPermissionKeys.push("approval_policy");
    }
    if (
      harness.permissions.filesystem === undefined &&
      localPermissionSource.sandbox_mode !== undefined
    ) {
      localPermissionFallback.sandbox_mode = localPermissionSource.sandbox_mode;
      locallyPreservedPermissionKeys.push("sandbox_mode");
      if (localPermissionSource.sandbox_workspace_write !== undefined) {
        localPermissionFallback.sandbox_workspace_write =
          localPermissionSource.sandbox_workspace_write;
        locallyPreservedPermissionKeys.push("sandbox_workspace_write");
      }
    }
    await writer.file(
      resolveInside(context.storeDir, harness.instructions.root),
      paths.instructions,
    );
    for (const skill of harness.skills) {
      await writer.directory(
        resolveInside(context.storeDir, skill.path),
        join(paths.skills, skill.name),
      );
    }
    for (const [name, command] of Object.entries(harness.commands)) {
      const body = await readFile(
        resolveInside(context.storeDir, command.promptFile),
        "utf8",
      );
      const skillName = harness.skills.some(
        (skill) => skill.name.toLowerCase() === name.toLowerCase(),
      )
        ? `command-${name}`
        : name;
      await writer.text(
        join(paths.skills, skillName, "SKILL.md"),
        stringifyFrontmatter(
          {
            name: skillName,
            description: command.description ?? `Run the ${name} workflow`,
          },
          body,
        ),
      );
    }

    const decodedCodexMetadata = decodeTomlSpecialValues(
      harness.overlays.codex.metadata ?? {},
    ) as Record<string, unknown>;
    const rawAgentDeclarations = isRecord(
      decodedCodexMetadata.agentDeclarationsRaw,
    )
      ? decodedCodexMetadata.agentDeclarationsRaw
      : {};
    const rawAgentSettings = isRecord(
      decodedCodexMetadata.agentSettingsRaw,
    )
      ? decodedCodexMetadata.agentSettingsRaw
      : {};
    const agentDeclarations: Record<string, unknown> = {};
    for (const [name, agent] of Object.entries(harness.agents)) {
      const configFile = join(paths.agents, `${name}.toml`);
      const usesConservativeFallback =
        agentHasOnlyForeignTargetCapabilities(agent, this.name);
      if (usesConservativeFallback) {
        projectionWarnings.push({
          code: "agent-capabilities-conservative-fallback",
          message: `${name}'s portable prompt was projected to Codex with a read-only sandbox, untrusted approvals, and web search disabled because it has no explicit Codex capability overlay`,
          path: configFile,
          fidelity: "compatible",
        });
      }
      if (containsEnvironmentReference(agent.targets?.codex)) {
        const rawDeclaration = isRecord(rawAgentDeclarations[name])
          ? rawAgentDeclarations[name]
          : {};
        const rawConfigFile = asString(rawDeclaration.config_file);
        const retainedConfigFile = rawConfigFile
          ? resolveCodexAgentPath(
              dirname(paths.config),
              rawConfigFile,
              context.targetRoot,
            )
          : configFile;
        const retained = await pathExists(retainedConfigFile);
        if (retained) {
          writer.retain(retainedConfigFile);
          agentDeclarations[name] = deepMerge(rawDeclaration, {
            description: agent.description,
            config_file:
              rawConfigFile ?? relative(dirname(paths.config), configFile),
          });
        }
        projectionWarnings.push({
          code: "agent-secret-reference-not-projected",
          message: retained
            ? `${name} contains redacted target-native credentials that Codex cannot expand generically; its existing config and declaration were left target-local`
            : `${name} contains redacted target-native credentials that Codex cannot expand generically, and no existing native config was available to retain`,
          path: retainedConfigFile,
          fidelity: "unsupported",
        });
        continue;
      }
      const body = await readFile(
        resolveInside(context.storeDir, agent.instructionsFile),
        "utf8",
      );
      const fallback = usesConservativeFallback
        ? {
            sandbox_mode: "read-only",
            approval_policy: "untrusted",
            web_search: "disabled",
          }
        : {};
      const portableAgent = {
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.reasoningEffort
          ? { model_reasoning_effort: agent.reasoningEffort }
          : {}),
        ...(agent.filesystem
          ? {
              sandbox_mode:
                agent.filesystem === "full-access"
                  ? "danger-full-access"
                  : agent.filesystem,
            }
          : {}),
      };
      await writer.text(
        configFile,
        stringifyToml(
          deepMerge(
            deepMerge(fallback, portableAgent),
            deepMerge(
              decodeTomlSpecialValues(
                agent.targets?.codex ?? {},
              ) as Record<string, unknown>,
              { developer_instructions: body },
            ),
          ),
        ),
      );
      agentDeclarations[name] = deepMerge(
        isRecord(rawAgentDeclarations[name]) ? rawAgentDeclarations[name] : {},
        {
          description: agent.description,
          config_file: relative(dirname(paths.config), configFile),
        },
      );
    }

    const decodedCodexMcp = decodeTomlSpecialValues(
      harness.overlays.codex.mcp ?? {},
    ) as Record<string, unknown>;
    const rawServers = isRecord(decodedCodexMcp.serversRaw)
      ? decodedCodexMcp.serversRaw
      : {};
    const unresolvedNativeSecretNames = new Set(
      Object.entries(rawServers).flatMap(([name, value]) =>
        containsEnvironmentReference(value) ? [name] : [],
      ),
    );
    const unsupportedExecutableSecretServers = Object.entries(
      harness.mcpServers,
    ).filter(([, server]) => mcpExecutableContainsEnvironmentReference(server));
    const unsupportedExecutableSecretNames = new Set(
      unsupportedExecutableSecretServers.map(([name]) => name),
    );
    const rawHooks = isRecord(decodedCodexMetadata.hooksRaw)
      ? decodedCodexMetadata.hooksRaw
      : {};
    const rawHooksFile = isRecord(decodedCodexMetadata.hooksFileRaw)
      ? decodedCodexMetadata.hooksFileRaw
      : {};
    const omitRawHooks = containsEnvironmentReference(rawHooks);
    const omitRawHooksFile = containsEnvironmentReference(rawHooksFile);
    const unresolvedHookGateNames = new Set(
      Object.entries(harness.mcpServers).flatMap(([name, server]) =>
        (omitRawHooks || omitRawHooksFile) &&
        server.requiredNativeFeatures?.codex?.includes("settings.mcpHooks")
          ? [name]
          : [],
      ),
    );
    const supportedServers = Object.fromEntries(
      Object.entries(harness.mcpServers).filter(
        ([name, server]) =>
          (server.transport === "stdio" || server.transport === "http") &&
          !unsupportedExecutableSecretNames.has(name),
      ).map(([name, server]) => [
        name,
        mcpRequiresUnavailableNativeFeatures(
          server,
          this.name,
          context.scope,
        ) ||
          unresolvedNativeSecretNames.has(name) ||
          unresolvedHookGateNames.has(name)
          ? { ...server, enabled: false }
          : server,
      ]),
    );
    const portableServers = renderMcpServers(supportedServers, "snake");
    for (const [name, server] of Object.entries(supportedServers)) {
      if (
        server.requiredNativeFeatures?.codex?.includes("env_vars.object") &&
        isRecord(portableServers[name])
      ) {
        delete portableServers[name].env_vars;
      }
    }
    const mergedServers = mergeMcpServerOverlays(
      rawServers,
      portableServers,
      harness.mcpServers,
      this.name,
    );
    const portableConfig: Record<string, unknown> = {
      ...localPermissionFallback,
      ...(harness.permissions.approval
        ? { approval_policy: harness.permissions.approval }
        : {}),
      ...(harness.permissions.filesystem
        ? { sandbox_mode: mapFilesystem(harness.permissions.filesystem) }
        : {}),
      ...(Object.keys(rawHooks).length > 0 && !omitRawHooks
        ? { hooks: rawHooks }
        : {}),
      ...(Object.keys(mergedServers).length > 0
        ? { mcp_servers: mergedServers }
        : {}),
      ...(Object.keys(agentDeclarations).length > 0 || Object.keys(rawAgentSettings).length > 0
        ? { agents: { ...rawAgentSettings, ...agentDeclarations } }
        : {}),
    };
    const config = deepMerge(
      deepMerge(
        preservedUnmanagedConfig,
        withoutKeys(
          decodeTomlSpecialValues(
            harness.overlays.codex.settings ?? {},
          ) as Record<string, unknown>,
          ["agents"],
        ),
      ),
      portableConfig,
    );
    const scrubbedConfig = scrubEnvironmentReferences(config);
    if (Object.keys(scrubbedConfig.value).length > 0) {
      await writer.text(paths.config, stringifyToml(scrubbedConfig.value));
    }
    if (Object.keys(rawHooksFile).length > 0) {
      if (omitRawHooksFile) {
        if (await pathExists(paths.hooks)) writer.retain(paths.hooks);
      } else {
        await writer.json(paths.hooks, rawHooksFile);
      }
    }

    await writer.finish();
    const warnings: AdapterWarning[] = [
      ...projectionWarnings,
      ...writer.warnings.map((message) => ({
        code: "write-skipped",
        message,
        fidelity: "target-only" as const,
      })),
    ];
    if (locallyPreservedPermissionKeys.length > 0) {
      warnings.push({
        code: "codex-permissions-preserved-local",
        message:
          `Preserved existing Codex ${locallyPreservedPermissionKeys.join(", ")} because the canonical harness did not specify equivalent permission policy`,
        path: paths.config,
        fidelity: "target-only",
      });
    }
    const unsupportedPermissionKeys = [
      harness.permissions.network !== undefined ? "network" : null,
      harness.permissions.commandAllow !== undefined ? "commandAllow" : null,
      harness.permissions.commandDeny !== undefined ? "commandDeny" : null,
      harness.permissions.commandAsk !== undefined ? "commandAsk" : null,
    ].filter((key): key is string => key !== null);
    if (unsupportedPermissionKeys.length > 0) {
      warnings.push({
        code: "permissions-not-projected",
        message: `Codex has no lossless adapter for canonical ${unsupportedPermissionKeys.join(", ")}; those restrictions remain canonical and require a reviewed target-local policy`,
        path: paths.config,
        fidelity: "unsupported",
      });
    }
    if (Object.keys(preservedUnmanagedConfig).length > 0) {
      warnings.push({
        code: "codex-local-settings-base-preserved",
        message:
          "Applied the machine-local preserved Codex config base; canonical values take precedence and the base is excluded from Git",
        path: preservedConfigPath,
        fidelity: "target-only",
      });
    }
    if (omitRawHooks) {
      warnings.push({
        code: "hook-secret-reference-not-projected",
        message:
          "Codex target-native hooks containing redacted credentials were not emitted because no documented generic expansion is available",
        path: paths.config,
        fidelity: "unsupported",
      });
    }
    if (omitRawHooksFile) {
      warnings.push({
        code: "hook-secret-reference-not-projected",
        message:
          "Codex target-native hooks.json containing redacted credentials was retained locally and not emitted because no documented generic expansion is available",
        path: paths.hooks,
        fidelity: "unsupported",
      });
    }
    for (const [name] of unsupportedExecutableSecretServers) {
      warnings.push({
        code: "mcp-executable-secret-not-projected",
        message: `${name} contains a redacted credential in an executable MCP field that Codex cannot expand safely; the whole server was omitted`,
        path: paths.config,
        fidelity: "unsupported",
      });
    }
    for (const [name, server] of Object.entries(harness.mcpServers)) {
      if (
        !mcpRequiresUnavailableNativeFeatures(
          server,
          this.name,
          context.scope,
        )
      ) continue;
      warnings.push({
        code: "mcp-target-feature-not-projected",
        message:
          `${name} requires native MCP features unavailable to Codex in ${context.scope} scope; ` +
          "the server was disabled instead of being started with incomplete authentication or runtime semantics",
        path: paths.config,
        fidelity: "unsupported",
      });
    }
    for (const name of unresolvedNativeSecretNames) {
      warnings.push({
        code: "mcp-native-secret-not-projected",
        message:
          `${name} contains a redacted Codex-native MCP value without a generic expansion contract; ` +
          "the server was disabled instead of using partial configuration",
        path: paths.config,
        fidelity: "unsupported",
      });
    }
    for (const name of unresolvedHookGateNames) {
      warnings.push({
        code: "mcp-native-hook-not-projected",
        message:
          `${name} depends on a Codex-native blocking hook that contains a redacted credential; ` +
          "the server was disabled because that hook could not be emitted",
        path: paths.config,
        fidelity: "unsupported",
      });
    }
    if (
      Object.keys(harness.hooks).length > 0 &&
      !isRecord(harness.overlays.codex.metadata?.hooksRaw)
    ) {
      warnings.push({
        code: "hooks-not-projected",
        message:
          "Portable hooks were not projected to Codex without a target-native hook contract",
        fidelity: "unsupported" as const,
      });
    }
    if (scrubbedConfig.removed > 0) {
      warnings.push({
        code: "secret-reference-not-projected",
        message: `${scrubbedConfig.removed} target-unsupported secret reference(s) were omitted from Codex config; use env_vars/env_http_headers or a machine-local overlay`,
        fidelity: "unsupported",
      });
    }
    const unsupportedEnvAliases = Object.values(harness.mcpServers).reduce(
      (count, server) =>
        count +
        Object.entries(server.env ?? {}).filter(([key, value]) => {
          const environment = environmentReference(value);
          return environment !== null && environment !== key;
        }).length,
      0,
    );
    if (unsupportedEnvAliases > 0) {
      warnings.push({
        code: "mcp-env-alias-not-projected",
        message: `${unsupportedEnvAliases} MCP env alias reference(s) were retained canonically but omitted because Codex env_vars cannot rename variables`,
        fidelity: "unsupported",
      });
    }
    const unsupportedRemoteTransports = Object.values(harness.mcpServers).filter(
      (server) => server.transport === "ws" || server.transport === "sse",
    ).length;
    if (unsupportedRemoteTransports > 0) {
      warnings.push({
        code: "mcp-transport-not-projected",
        message: `${unsupportedRemoteTransports} SSE/WebSocket MCP server(s) were not projected because Codex currently documents stdio and streamable HTTP`,
        fidelity: "unsupported",
      });
    }
    return {
      target: this.name,
      written: writer.written,
      linked: writer.linked,
      removed: writer.removed,
      skipped: writer.skipped,
      warnings,
    };
  }

  async fingerprint(context: AdapterContext): Promise<string> {
    return fingerprintManagedTarget(context.storeDir, this.name);
  }

  watchPaths(context: AdapterContext): string[] {
    const paths = codexPaths(context);
    return [
      paths.instructions,
      paths.skills,
      paths.agents,
      paths.rules,
      paths.config,
      paths.hooks,
    ];
  }
}

function codexMcpProjectionFallbacks(
  harness: CanonicalHarness,
  scope: AdapterContext["scope"],
): Set<string> {
  const decoded = decodeTomlSpecialValues(
    harness.overlays.codex.mcp ?? {},
  ) as Record<string, unknown>;
  const rawServers = isRecord(decoded.serversRaw) ? decoded.serversRaw : {};
  return new Set(
    Object.entries(harness.mcpServers).flatMap(([name, server]) => {
      const generatedFallback =
        mcpRequiresUnavailableNativeFeatures(server, "codex", scope) ||
        server.transport === "sse" ||
        server.transport === "ws" ||
        mcpExecutableContainsEnvironmentReference(server) ||
        containsEnvironmentReference(rawServers[name]);
      return generatedFallback ? [name] : [];
    }),
  );
}

function updateCodexProjectTrustRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.codex ?? []).filter(
      (feature) => feature !== "settings.projectTrust",
    );
    features.push("settings.projectTrust");
    requirements.codex = features;
    server.requiredNativeFeatures = requirements;
  }
}

function updateCodexMcpHookRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.codex ?? []).filter(
      (feature) => feature !== "settings.mcpHooks",
    );
    features.push("settings.mcpHooks");
    requirements.codex = features;
    server.requiredNativeFeatures = requirements;
  }
}

function removeCodexMcpHookRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.codex ?? []).filter(
      (feature) => feature !== "settings.mcpHooks",
    );
    if (features.length > 0) requirements.codex = features;
    else delete requirements.codex;
    if (Object.keys(requirements).length > 0) {
      server.requiredNativeFeatures = requirements;
    } else {
      delete server.requiredNativeFeatures;
    }
  }
}

function codexPaths(context: AdapterContext) {
  if (context.scope === "user") {
    return {
      instructions: join(context.targetRoot, "AGENTS.md"),
      skills: join(dirname(context.targetRoot), ".agents", "skills"),
      agents: join(context.targetRoot, "agents"),
      rules: join(context.targetRoot, "rules"),
      config: join(context.targetRoot, "config.toml"),
      hooks: join(context.targetRoot, "hooks.json"),
    };
  }
  return {
    instructions: join(context.targetRoot, "AGENTS.md"),
    skills: join(context.targetRoot, ".agents", "skills"),
    agents: join(context.targetRoot, ".codex", "agents"),
    rules: join(context.targetRoot, ".codex", "rules"),
    config: join(context.targetRoot, ".codex", "config.toml"),
    hooks: join(context.targetRoot, ".codex", "hooks.json"),
  };
}

function assertCodexHooksFileShape(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`${path}.description: expected a string`);
  }
  if (value.hooks === undefined) return;
  if (!isRecord(value.hooks)) {
    throw new Error(`${path}.hooks: expected an object of hook events`);
  }
  for (const [event, groups] of Object.entries(value.hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`${path}.hooks.${event}: expected an array`);
    }
    for (const [groupIndex, group] of groups.entries()) {
      if (!isRecord(group)) {
        throw new Error(
          `${path}.hooks.${event}[${groupIndex}]: expected an object`,
        );
      }
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new Error(
          `${path}.hooks.${event}[${groupIndex}].matcher: expected a string`,
        );
      }
      if (
        typeof group.matcher === "string" &&
        group.matcher.length > 0 &&
        group.matcher !== "*"
      ) {
        try {
          new RegExp(group.matcher, "u");
        } catch (error) {
          throw new Error(
            `${path}.hooks.${event}[${groupIndex}].matcher: invalid regular expression (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      if (!Array.isArray(group.hooks)) {
        throw new Error(
          `${path}.hooks.${event}[${groupIndex}].hooks: expected an array`,
        );
      }
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        const handlerPath =
          `${path}.hooks.${event}[${groupIndex}].hooks[${handlerIndex}]`;
        if (!isRecord(handler)) {
          throw new Error(`${handlerPath}: expected an object`);
        }
        if (typeof handler.type !== "string" || handler.type.length === 0) {
          throw new Error(`${handlerPath}.type: expected a non-empty string`);
        }
        for (const key of [
          "command",
          "commandWindows",
          "statusMessage",
          "server",
          "tool",
          "prompt",
        ] as const) {
          if (handler[key] !== undefined && typeof handler[key] !== "string") {
            throw new Error(`${handlerPath}.${key}: expected a string`);
          }
        }
        if (handler.type === "command" && typeof handler.command !== "string") {
          throw new Error(`${handlerPath}.command: expected a string`);
        }
        if (
          handler.type === "mcp_tool" &&
          (typeof handler.server !== "string" || typeof handler.tool !== "string")
        ) {
          throw new Error(
            `${handlerPath}: mcp_tool requires string server and tool fields`,
          );
        }
        if (handler.input !== undefined && !isRecord(handler.input)) {
          throw new Error(`${handlerPath}.input: expected an object`);
        }
        if (handler.async !== undefined && typeof handler.async !== "boolean") {
          throw new Error(`${handlerPath}.async: expected a boolean`);
        }
        if (
          handler.timeout !== undefined &&
          (typeof handler.timeout !== "number" ||
            !Number.isFinite(handler.timeout) ||
            handler.timeout < 0)
        ) {
          throw new Error(`${handlerPath}.timeout: expected a non-negative number`);
        }
      }
    }
  }
}

async function readTomlObject(
  path: string,
  nativeRoot = dirname(path),
): Promise<Record<string, unknown> | null> {
  await assertNativeImportPath(path, nativeRoot);
  const source = await readTextIfExists(path);
  if (source === null) return null;
  const parsed: unknown = parseToml(source);
  if (!isRecord(parsed)) throw new Error(`${path}: expected a TOML table`);
  return parsed;
}

async function importCodexAgents(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  managedPaths?: readonly string[],
  declarations?: Record<string, unknown>,
  configDir?: string,
  allowedRoot?: string,
  warningSink?: AdapterWarning[],
): Promise<CanonicalHarness["agents"]> {
  if (await pathExists(sourceDir)) {
    await assertNativeImportPath(sourceDir, allowedRoot ?? dirname(sourceDir));
  }
  const entries = (await pathExists(sourceDir))
    ? await readdir(sourceDir, { withFileTypes: true })
    : [];
  const agents: CanonicalHarness["agents"] = {};
  const discovered: Array<{
    source: string;
    name: string;
    value: Record<string, unknown>;
    description?: string;
  }> = [];
  const declaredNames = new Set<string>();
  for (const [name, declaration] of Object.entries(declarations ?? {})) {
    if (!isRecord(declaration)) continue;
    assertArtifactName(name, "agent");
    if (
      declaration.description !== undefined &&
      typeof declaration.description !== "string"
    ) {
      throw new Error(`Codex agent ${name} description must be a string`);
    }
    const configuredPath = asString(declaration.config_file);
    if (!configuredPath) {
      throw new Error(`Codex agent ${name} is missing a string config_file`);
    }
    const source = resolveCodexAgentPath(
      configDir ?? dirname(sourceDir),
      configuredPath,
      allowedRoot ?? dirname(sourceDir),
    );
    if (!capturePathAllowed(source, managedPaths)) continue;
    const rawValue = await readTomlObject(
      source,
      allowedRoot ?? dirname(sourceDir),
    );
    if (!rawValue) throw new Error(`Codex agent ${name} config_file does not exist: ${source}`);
    const redacted = redactSecrets(rawValue, source);
    warningSink?.push(...redacted.warnings);
    const value = redacted.value;
    validateCodexAgentPromptShape(value, source);
    discovered.push({
      source,
      name,
      value,
      ...(asString(declaration.description)
        ? { description: asString(declaration.description)! }
        : {}),
    });
    declaredNames.add(name);
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".toml")) continue;
    if (!entry.isFile()) {
      throw new Error(
        `native Codex agent import contains a non-regular TOML file: ${join(sourceDir, entry.name)}`,
      );
    }
    const source = join(sourceDir, entry.name);
    if (!capturePathAllowed(source, managedPaths)) continue;
    const rawValue = await readTomlObject(
      source,
      allowedRoot ?? dirname(sourceDir),
    );
    if (!rawValue) continue;
    const redacted = redactSecrets(rawValue, source);
    warningSink?.push(...redacted.warnings);
    const value = redacted.value;
    validateCodexAgentPromptShape(value, source);
    const name = basename(entry.name, ".toml");
    if (declaredNames.has(name)) continue;
    assertArtifactName(name, "agent");
    discovered.push({ source, name, value });
  }
  assertUniqueImportedNames(discovered, "agent");
  for (const { name, value, description } of discovered) {
    const instructionsFile = `agents/${name}.md`;
    const prompt =
      asString(value.developer_instructions) ??
      asString(value.instructions) ??
      "";
    if (write) {
      await writeTextAtomicInside(
        storeDir,
        join(storeDir, instructionsFile),
        prompt,
      );
    }
    agents[name] = {
      description: description ?? asString(value.description) ?? name,
      instructionsFile,
      targets: {
        codex: encodeTomlSpecialValues(value) as Record<string, unknown>,
      },
    };
  }
  return agents;
}

function validateCodexAgentPromptShape(
  value: Record<string, unknown>,
  source: string,
): void {
  for (const key of ["developer_instructions", "instructions", "description"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${source}.${key}: expected a string`);
    }
  }
}

function resolveCodexAgentPath(
  configDir: string,
  configuredPath: string,
  allowedRoot: string,
): string {
  if (isAbsolute(configuredPath)) {
    throw new Error("Codex agent config_file must be relative to the target root");
  }
  const candidate = resolve(configDir, configuredPath);
  const remainder = relative(resolve(allowedRoot), candidate);
  if (remainder === ".." || remainder.startsWith(`..${sep}`)) {
    throw new Error(`Codex agent config_file escapes the target root: ${configuredPath}`);
  }
  return candidate;
}

function captureCodexPermissions(
  config: Record<string, unknown>,
): PortablePermissions {
  const sandbox = asString(config.sandbox_mode);
  const approval = asString(config.approval_policy);
  return {
    ...(sandbox === "read-only"
      ? { filesystem: "read-only" as const }
      : sandbox === "workspace-write"
        ? { filesystem: "workspace-write" as const }
        : sandbox === "danger-full-access"
          ? { filesystem: "full-access" as const }
          : {}),
    ...(approval === "untrusted" || approval === "on-request" || approval === "never"
      ? { approval }
      : {}),
  };
}

function isPortableApprovalPolicy(value: unknown): boolean {
  return value === "untrusted" || value === "on-request" || value === "never";
}

function isPortableSandboxMode(value: unknown): boolean {
  return value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access";
}

function mapFilesystem(
  value: NonNullable<PortablePermissions["filesystem"]>,
): string {
  return value === "full-access" ? "danger-full-access" : value;
}

function codexLocalBase(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const base = deepMerge({}, existing);
  if (isRecord(base.agents)) {
    // Preserve global agent kill switches/limits, but not individual agent
    // declarations: canonical declarations are lifecycle-managed and must be
    // prunable when their canonical agent is removed.
    base.agents = Object.fromEntries(
      Object.entries(base.agents).filter(([, value]) => !isRecord(value)),
    );
  }
  return base;
}

const TOML_SCALAR_MARKER = "$harnessSyncTomlScalar";

function encodeTomlSpecialValues(value: unknown): unknown {
  if (value instanceof Date) {
    return { [TOML_SCALAR_MARKER]: value.toJSON() };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return {
      [TOML_SCALAR_MARKER]: Number.isNaN(value)
        ? "nan"
        : value > 0
          ? "+inf"
          : "-inf",
    };
  }
  if (Array.isArray(value)) return value.map(encodeTomlSpecialValues);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      encodeTomlSpecialValues(entry),
    ]),
  );
}

function decodeTomlSpecialValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTomlSpecialValues);
  if (!isRecord(value)) return value;
  if (
    Object.keys(value).length === 1 &&
    typeof value[TOML_SCALAR_MARKER] === "string"
  ) {
    const literal = value[TOML_SCALAR_MARKER];
    if (!isSafeTomlScalarLiteral(literal)) {
      throw new Error(`Invalid encoded TOML scalar: ${JSON.stringify(literal)}`);
    }
    const parsed = parseToml(`value = ${literal}\n`);
    return parsed.value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      decodeTomlSpecialValues(entry),
    ]),
  );
}

function isSafeTomlScalarLiteral(value: string): boolean {
  return /^(?:nan|[+-]inf|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/u.test(value);
}
