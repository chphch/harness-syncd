import { readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
  writeJsonAtomicInside,
  writeTextAtomicInside,
} from "../core/fs.js";
import { parseFrontmatter, stringifyFrontmatter, isRecord } from "../core/frontmatter.js";
import {
  containsEnvironmentReference,
  redactSecrets,
  renderClaudeEnvironmentReferences,
  scrubEnvironmentReferences,
} from "../core/secrets.js";
import { fingerprintManagedTarget, ManagedWriter } from "../core/writer.js";
import {
  captureBoundary,
  type AdapterContext,
  type ApplyOptions,
  type CaptureOptions,
  type HarnessAdapter,
  type HookScriptLayout,
} from "./adapter.js";
import {
  agentHasOnlyForeignTargetCapabilities,
  asString,
  asStringArray,
  capturePathAllowed,
  captureMcpServers,
  cloneHarness,
  deepMerge,
  importAgents,
  importCommands,
  importInstruction,
  importRules,
  importSkills,
  hasMcpBlockingHooks,
  mergeCapturedMcpServers,
  mergeCapturedAgents,
  mergeCapturedCommands,
  mergeCapturedRules,
  mcpRequiresUnavailableNativeFeatures,
  mcpServerOverlays,
  mergeMcpServerOverlays,
  readJsonObject,
  importHookScripts,
  importOutputStyles,
  renderHooks,
  scanHookScriptReferences,
  renderMcpServers,
  withoutKeys,
} from "./common.js";

const PORTABLE_SETTINGS_KEYS = [
  "permissions",
  "hooks",
  "disabledMcpjsonServers",
];

export class ClaudeAdapter implements HarnessAdapter {
  readonly name = "claude" as const;

  async capture(
    current: CanonicalHarness,
    context: AdapterContext,
    options: CaptureOptions,
  ) {
    const harness = cloneHarness(current);
    const warnings = [];
    const imported: string[] = [];
    const paths = claudePaths(context);
    const nativeRoot = captureBoundary(context);
    const projectionFallbacks = claudeMcpProjectionFallbacks(
      harness,
      context.scope,
    );
    const settingsCaptured = capturePathAllowed(
      claudePaths(context).settings,
      options.managedPaths,
    );
    let capturedMcpPolicy: boolean | undefined;
    let capturedRestrictiveMcpPermissions: boolean | undefined;
    let capturedRestrictiveMcpHooks: boolean | undefined;
    let capturedProjectMcpServers: string[] = [];
    let capturedUserProjectDisabledMcpServers: string[] = [];

    const instructionSource =
      (await pathExists(paths.instructions)) || !paths.alternateInstructions
        ? paths.instructions
        : paths.alternateInstructions;
    const instructionImport = await importClaudeInstruction(
      instructionSource,
      paths.sharedInstructions,
      context.storeDir,
      harness,
      options.write,
      options.managedPaths,
      nativeRoot,
      context.canonicalSourceStoreDir,
    );
    imported.push(...instructionImport.sources);
    if (instructionImport.expanded) {
      warnings.push({
        code: "instruction-import-expanded",
        message:
          "Expanded Claude's @AGENTS.md wrapper into the canonical instructions to avoid creating a self-reference",
        path: instructionSource,
        fidelity: "compatible" as const,
      });
    }
    if (
      paths.alternateInstructions &&
      instructionSource === paths.instructions &&
      (await pathExists(paths.alternateInstructions))
    ) {
      await assertNativeImportPath(
        paths.alternateInstructions,
        nativeRoot,
        resolveInside(context.storeDir, harness.instructions.root),
      );
      const [primary, alternate] = await Promise.all([
        readTextIfExists(paths.instructions),
        readTextIfExists(paths.alternateInstructions),
      ]);
      if (primary !== alternate) {
        warnings.push({
          code: "instruction-source-conflict",
          message:
            "Both CLAUDE.md and .claude/CLAUDE.md exist with different content; root CLAUDE.md was selected",
          path: paths.instructions,
          fidelity: "target-only" as const,
        });
      }
    }

    if (options.includeAssets) {
      const rules = await importRules(
        paths.rules,
        context.storeDir,
        options.write,
        this.name,
        options.managedPaths,
        nativeRoot,
      );
      if (rules.length > 0) {
        harness.rules = mergeCapturedRules(harness.rules, rules, this.name);
        imported.push(paths.rules);
      }
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
      const hookScriptLayout = this.hookScripts(context);
      if (hookScriptLayout) {
        const importedScripts = await importHookScripts(
          hookScriptLayout,
          context.storeDir,
          options.write,
          options.managedPaths,
          nativeRoot,
          context.canonicalSourceStoreDir,
        );
        warnings.push(...importedScripts.warnings);
        // The `length > 0` guard does double duty. It is the non-destruction
        // guard — the importer returns [] for a missing directory, so a plain
        // assignment on a freshly cloned machine would write `hookScripts: []`,
        // which the next apply turns into a prune of every projected script.
        // It is also what keeps absent-stays-absent true for stores that never
        // used the feature. The name-keyed filter is a separate guard, for a
        // capture restricted to already-owned paths.
        if (importedScripts.entries.length > 0) {
          const capturedNames = new Set(
            importedScripts.entries.map((entry) => entry.name),
          );
          harness.hookScripts = [
            ...(harness.hookScripts ?? []).filter(
              (entry) => !capturedNames.has(entry.name),
            ),
            ...importedScripts.entries,
          ];
          imported.push(hookScriptLayout.dir);
        }
      }
      const outputStyles = await importOutputStyles(
        paths.outputStyles,
        context.storeDir,
        options.write,
        options.managedPaths,
        nativeRoot,
        context.canonicalSourceStoreDir,
      );
      // Same two guards as hookScripts: the length check keeps a store that
      // never used the feature from gaining an empty list (which the next apply
      // would read as "own nothing" and prune), and the name-keyed filter
      // protects entries outside a managed-paths-restricted capture.
      if (outputStyles.length > 0) {
        const capturedNames = new Set(outputStyles.map((entry) => entry.name));
        harness.outputStyles = [
          ...(harness.outputStyles ?? []).filter((entry) => !capturedNames.has(entry.name)),
          ...outputStyles,
        ];
        imported.push(paths.outputStyles);
      }
      const agents = await importAgents(
        paths.agents,
        context.storeDir,
        options.write,
        this.name,
        options.managedPaths,
        warnings,
        nativeRoot,
      );
      if (Object.keys(agents).length > 0) {
        harness.agents = mergeCapturedAgents(harness.agents, agents);
        imported.push(paths.agents);
      }
      const commands = await importCommands(
        paths.commands,
        context.storeDir,
        options.write,
        this.name,
        options.managedPaths,
        nativeRoot,
      );
      if (Object.keys(commands).length > 0) {
        harness.commands = mergeCapturedCommands(harness.commands, commands);
        imported.push(paths.commands);
      }
    }

    const settings = settingsCaptured
      ? await readJsonObject(paths.settings, nativeRoot)
      : null;
    if (settings) {
      const redacted = redactSecrets(settings, paths.settings);
      warnings.push(...redacted.warnings);
      const safe = redacted.value;
      assertClaudePortableSettingsShape(safe, paths.settings);
      capturedMcpPolicy = hasClaudeMcpPolicy(safe);
      capturedRestrictiveMcpPermissions = hasRestrictiveClaudeMcpPermissions(
        safe.permissions,
      );
      capturedRestrictiveMcpHooks = hasMcpBlockingHooks(
        safe.hooks,
        `${paths.settings}.hooks`,
      );
      const { commandAllow: _allow, commandDeny: _deny, commandAsk: _ask, ...otherPermissions } =
        harness.permissions;
      harness.permissions = {
        ...otherPermissions,
        ...captureClaudePermissions(safe.permissions),
      };
      const metadata = { ...harness.overlays.claude.metadata };
      delete metadata.permissionsRaw;
      delete metadata.hooksRaw;
      delete metadata.disabledMcpjsonServersRaw;
      if (isRecord(safe.permissions)) {
        const rawPermissions = withoutKeys(safe.permissions, ["allow", "deny", "ask"]);
        if (Object.keys(rawPermissions).length > 0) {
          metadata.permissionsRaw = rawPermissions;
        }
      }
      if (isRecord(safe.hooks)) metadata.hooksRaw = safe.hooks;
      // Read-only, and deliberately after redaction so it sees the text that
      // will actually be stored. Nothing mutates safe.hooks.
      const scanLayout = this.hookScripts(context);
      if (scanLayout) {
        warnings.push(...scanHookScriptReferences(safe.hooks, scanLayout));
      }
      const disabledMcpjsonServers = asStringArray(
        safe.disabledMcpjsonServers,
      );
      if (disabledMcpjsonServers) {
        metadata.disabledMcpjsonServersRaw = disabledMcpjsonServers;
      }
      harness.overlays.claude.metadata = metadata;
      harness.overlays.claude.settings = withoutKeys(
        safe,
        PORTABLE_SETTINGS_KEYS,
      );
      imported.push(paths.settings);
    } else if (settingsCaptured) {
      capturedMcpPolicy = false;
      capturedRestrictiveMcpPermissions = false;
      capturedRestrictiveMcpHooks = false;
    }

    const mcp = capturePathAllowed(paths.mcp, options.managedPaths)
      ? await readJsonObject(paths.mcp, nativeRoot)
      : null;
    if (mcp) {
      const redacted = redactSecrets(mcp, paths.mcp);
      warnings.push(...redacted.warnings);
      const safe = redacted.value;
      const captured = captureMcpServers(
        safe.mcpServers,
        `${paths.mcp}.mcpServers`,
        this.name,
      );
      if (context.scope === "user") {
        const projectDisabledMcpServers = captureClaudeProjectDisabledMcpServers(
          safe.projects,
          `${paths.mcp}.projects`,
        );
        capturedUserProjectDisabledMcpServers = Object.keys(captured.servers)
          .filter(
            (name) =>
              projectDisabledMcpServers.has(name) &&
              !projectionFallbacks.has(name),
          );
      }
      const safeServers = safe.mcpServers as Record<string, unknown> | undefined;
      if (context.scope === "project") {
        capturedProjectMcpServers = Object.keys(captured.servers).filter(
          (name) => !projectionFallbacks.has(name),
        );
      }
      harness.mcpServers = mergeCapturedMcpServers(
        harness.mcpServers,
        captured.servers,
        this.name,
        projectionFallbacks,
      );
      if (context.scope === "user") {
        const metadata = { ...harness.overlays.claude.metadata };
        delete metadata.projectDisabledMcpServersCaptured;
        harness.overlays.claude.metadata = metadata;
      }
      warnings.push(...captured.warnings);
      if (context.scope === "project") {
        harness.overlays.claude.mcp = {
          ...withoutKeys(safe, ["mcpServers"]),
          serversRaw: mcpServerOverlays(safeServers ?? {}, this.name),
        };
      } else {
        harness.overlays.claude.mcp = {
          serversRaw: mcpServerOverlays(safeServers ?? {}, this.name),
        };
      }
      imported.push(paths.mcp);
    }

    const capturedMcpServerNames = mcp
      ? Object.keys(
          (mcp.mcpServers as Record<string, unknown> | undefined) ?? {},
        ).filter((name) => !projectionFallbacks.has(name))
      : [];
    if (capturedProjectMcpServers.length > 0) {
      harness.overlays.claude.metadata = {
        ...harness.overlays.claude.metadata,
        projectMcpApprovalCaptured: true,
      };
      updateClaudeProjectMcpApprovalRequirements(
        harness,
        capturedProjectMcpServers,
      );
    }
    if (capturedUserProjectDisabledMcpServers.length > 0) {
      harness.overlays.claude.metadata = {
        ...harness.overlays.claude.metadata,
        projectDisabledMcpServersCaptured: true,
      };
      updateClaudeProjectDisabledMcpRequirements(
        harness,
        capturedUserProjectDisabledMcpServers,
      );
    }
    if (
      capturedRestrictiveMcpPermissions &&
      capturedMcpServerNames.length > 0
    ) {
      harness.overlays.claude.metadata = {
        ...harness.overlays.claude.metadata,
        mcpPermissionsCaptured: true,
      };
      updateClaudeMcpPermissionRequirements(
        harness,
        capturedMcpServerNames,
      );
    }
    if (capturedRestrictiveMcpHooks && capturedMcpServerNames.length > 0) {
      harness.overlays.claude.metadata = {
        ...harness.overlays.claude.metadata,
        mcpHooksCaptured: true,
      };
      updateClaudeMcpHookRequirements(harness, capturedMcpServerNames);
    }

    const disabledMcpjsonServers = asStringArray(
      harness.overlays.claude.metadata?.disabledMcpjsonServersRaw,
    ) ?? [];
    for (const name of disabledMcpjsonServers) {
      const server = harness.mcpServers[name];
      if (server && !projectionFallbacks.has(name)) {
        harness.mcpServers[name] = { ...server, enabled: false };
      }
    }
    if (capturedMcpPolicy !== undefined) {
      updateClaudeMcpPolicyRequirements(
        harness,
        capturedMcpPolicy,
        projectionFallbacks,
      );
    }

    if (options.includeLocal && paths.localSettings) {
      const local = await readJsonObject(paths.localSettings, nativeRoot);
      if (local) {
        const redacted = redactSecrets(local, paths.localSettings);
        warnings.push(...redacted.warnings);
        if (options.write) {
          await writeJsonAtomicInside(
            context.storeDir,
            join(context.storeDir, ".local", "claude.settings.json"),
            redacted.value,
          );
        }
        imported.push(paths.localSettings);
        warnings.push({
          code: "local-overlay-only",
          message:
            "settings.local.json was retained as a Claude-only local overlay and will not be projected or committed automatically",
          path: paths.localSettings,
          fidelity: "target-only" as const,
        });
      }
    }

    return { harness, warnings, imported };
  }

  async apply(
    harness: CanonicalHarness,
    context: AdapterContext,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    const paths = claudePaths(context);
    const writer = new ManagedWriter({
      ...options,
      storeDir: context.storeDir,
      target: this.name,
      allowedRoot: context.scope === "project" ? context.targetRoot : dirname(context.targetRoot),
    });
    await writer.load();
    const existingSettings = await readJsonObject(
      paths.settings,
      captureBoundary(context),
    );
    const preservedSettingsPath = join(
      context.storeDir,
      ".local",
      "preserved",
      `${this.name}-settings.json`,
    );
    let preservedUnmanagedSettings = options.ignoreLocalBase
      ? null
      : await readJsonObject(preservedSettingsPath, context.storeDir);
    if (!writer.owns(paths.settings) && !options.ignoreLocalBase) {
      if (existingSettings) {
        preservedUnmanagedSettings = existingSettings;
        if (!options.dryRun) {
          await writeJsonAtomicInside(
            context.storeDir,
            preservedSettingsPath,
            existingSettings,
          );
        }
      } else {
        preservedUnmanagedSettings = {};
        if (!options.dryRun) {
          await assertSafeStorePath(context.storeDir, preservedSettingsPath);
          await rm(preservedSettingsPath, { force: true });
        }
      }
    }
    preservedUnmanagedSettings ??= {};
    const projectionWarnings: AdapterWarning[] = [];

    const instructionSource = resolveInside(
      context.storeDir,
      harness.instructions.root,
    );
    const primaryInstructionsExist = await pathExists(paths.instructions);
    const alternateInstructionsExist = paths.alternateInstructions
      ? await pathExists(paths.alternateInstructions)
      : false;
    if (
      paths.alternateInstructions &&
      primaryInstructionsExist &&
      alternateInstructionsExist
    ) {
      const retired = await writer.retire(
        paths.alternateInstructions,
        "both Claude project instruction filenames are active",
      );
      if (retired) {
        await writer.file(instructionSource, paths.instructions);
      } else {
        writer.retain(paths.instructions);
        projectionWarnings.push({
          code: "multiple-claude-instructions",
          message:
            `Both ${paths.instructions} and ${paths.alternateInstructions} exist; ` +
            "projection stopped so Claude cannot read conflicting instruction sources",
          path: paths.alternateInstructions,
          fidelity: "unsupported",
        });
      }
    } else {
      const instructionDestination =
        paths.alternateInstructions &&
        !primaryInstructionsExist &&
        alternateInstructionsExist
          ? paths.alternateInstructions
          : paths.instructions;
      await writer.file(instructionSource, instructionDestination);
    }
    for (const rule of harness.rules.filter(
      (entry) => entry.portable !== false || entry.targets?.claude,
    )) {
      const source = resolveInside(context.storeDir, rule.path);
      const data = deepMerge(
        rule.targets?.claude ?? {},
        rule.globs ? { paths: rule.globs } : {},
      );
      const destination = resolveInside(
        paths.rules,
        relative(resolveInside(context.storeDir, "rules"), source),
      );
      if (Object.keys(data).length === 0) {
        await writer.file(source, destination);
      } else {
        const body = await readFile(source, "utf8");
        await writer.text(
          destination,
          stringifyFrontmatter(data, body),
        );
      }
    }
    for (const skill of harness.skills) {
      await writer.directory(
        resolveInside(context.storeDir, skill.path),
        join(paths.skills, skill.name),
      );
    }
    for (const style of harness.outputStyles ?? []) {
      await writer.file(
        resolveInside(context.storeDir, style.path),
        join(paths.outputStyles, style.name),
      );
    }
    // Gated on the LAYOUT, not on claudePaths, so one decision governs both the
    // bytes and any future handling of the commands. Per entry, never the
    // parent directory — copyFileAtomic creates nested parents itself.
    const hookScriptLayout = this.hookScripts(context);
    if (hookScriptLayout) {
      for (const entry of harness.hookScripts ?? []) {
        await writer.materialize(
          resolveInside(context.storeDir, entry.path),
          join(hookScriptLayout.dir, entry.name),
        );
      }
    }
    for (const [name, agent] of Object.entries(harness.agents)) {
      const destination = resolveInside(
        paths.agents,
        agent.nativePaths?.claude ?? `${name}.md`,
      );
      const usesConservativeFallback =
        agentHasOnlyForeignTargetCapabilities(agent, this.name);
      if (usesConservativeFallback) {
        projectionWarnings.push({
          code: "agent-capabilities-conservative-fallback",
          message: `${name}'s portable prompt was projected to Claude with read-only discovery tools and plan permission mode because it has no explicit Claude capability overlay`,
          path: destination,
          fidelity: "compatible",
        });
      }
      const body = await readFile(
        resolveInside(context.storeDir, agent.instructionsFile),
        "utf8",
      );
      const portableAgent = {
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.tools ? { tools: agent.tools } : {}),
        ...(agent.disallowedTools
          ? { disallowedTools: agent.disallowedTools }
          : {}),
        ...(agent.filesystem === "read-only"
          ? { permissionMode: "plan" }
          : {}),
      };
      const fallback = usesConservativeFallback
        ? { tools: ["Read", "Glob", "Grep"], permissionMode: "plan" }
        : {};
      await writer.text(
        destination,
        stringifyFrontmatter(
          renderClaudeEnvironmentReferences(
            deepMerge(
              deepMerge(fallback, portableAgent),
              deepMerge(agent.targets?.claude ?? {}, {
                name,
                description: agent.description,
              }),
            ),
          ),
          body,
        ),
      );
    }
    for (const [name, command] of Object.entries(harness.commands)) {
      const body = await readFile(
        resolveInside(context.storeDir, command.promptFile),
        "utf8",
      );
      await writer.text(
        join(paths.commands, `${name}.md`),
        stringifyFrontmatter(
          deepMerge(command.targets?.claude ?? {}, {
            description: command.description,
            "argument-hint": command.argumentHint,
          }),
          body,
        ),
      );
    }

    const rawPermissions = isRecord(
      harness.overlays.claude.metadata?.permissionsRaw,
    )
      ? harness.overlays.claude.metadata.permissionsRaw
      : {};
    const rawHooks = isRecord(harness.overlays.claude.metadata?.hooksRaw)
      ? harness.overlays.claude.metadata.hooksRaw
      : {};
    const claudeMcpOverlay = harness.overlays.claude.mcp ?? {};
    const rawMcpServers = isRecord(claudeMcpOverlay.serversRaw)
      ? claudeMcpOverlay.serversRaw
      : {};
    const renderedPermissions = deepMerge(
      rawPermissions,
      renderClaudePermissions(harness.permissions),
    );
    const rawDisabledMcpServers = asStringArray(
      harness.overlays.claude.metadata?.disabledMcpjsonServersRaw,
    ) ?? [];
    const canonicalMcpNames = new Set(Object.keys(harness.mcpServers));
    const disabledMcpServers = new Set(
      rawDisabledMcpServers.filter(
        (name) =>
          !canonicalMcpNames.has(name) ||
          harness.mcpServers[name]?.enabled !== true,
      ),
    );
    for (const [name, server] of Object.entries(harness.mcpServers)) {
      const hasUnsupportedToolFilter =
        server.enabledTools !== undefined ||
        (server.disabledTools?.length ?? 0) > 0;
      const hasUnavailableNativeFeatures = mcpRequiresUnavailableNativeFeatures(
        server,
        this.name,
        context.scope,
      );
      const hasUnresolvedNativeSecret = containsEnvironmentReference(
        rawMcpServers[name],
      );
      if (
        server.enabled === false ||
        hasUnsupportedToolFilter ||
        server.cwd ||
        hasUnavailableNativeFeatures ||
        hasUnresolvedNativeSecret
      ) {
        disabledMcpServers.add(name);
      }
      if (hasUnavailableNativeFeatures) {
        projectionWarnings.push({
          code: "mcp-target-feature-not-projected",
          message:
            `${name} requires native MCP features unavailable to Claude in ${context.scope} scope; ` +
            "the server was disabled instead of being started with incomplete authentication or runtime semantics",
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
      if (hasUnresolvedNativeSecret) {
        projectionWarnings.push({
          code: "mcp-native-secret-not-projected",
          message:
            `${name} contains a redacted Claude-native MCP value outside Claude's documented expansion fields; ` +
            "the server was disabled instead of using partial configuration",
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
      if (hasUnsupportedToolFilter) {
        projectionWarnings.push({
          code: "mcp-tool-filter-not-projected",
          message:
            `Claude does not document per-server tool filters in .mcp.json; ${name} was disabled as a fail-closed fallback`,
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
      if (server.cwd) {
        projectionWarnings.push({
          code: "mcp-cwd-not-projected",
          message:
            `Claude does not document per-server cwd in .mcp.json; ${name} was disabled instead of running in a different directory`,
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
      if (server.startupTimeoutMs !== undefined) {
        projectionWarnings.push({
          code: "mcp-timeout-not-projected",
          message:
            `Claude configures MCP startup timeout with MCP_TIMEOUT, so the per-server startup timeout for ${name} was retained canonically but not emitted`,
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
    }
    const settings = deepMerge(deepMerge(
      preservedUnmanagedSettings,
      harness.overlays.claude.settings ?? {},
    ), {
      ...(Object.keys(renderedPermissions).length > 0
        ? { permissions: renderedPermissions }
        : {}),
      ...(Object.keys(rawHooks).length > 0
        ? { hooks: renderClaudeEnvironmentReferences(rawHooks) }
        : Object.keys(harness.hooks).length > 0
          ? { hooks: renderClaudeEnvironmentReferences(renderHooks(harness.hooks)) }
          : {}),
      ...(disabledMcpServers.size > 0
        ? { disabledMcpjsonServers: [...disabledMcpServers].sort() }
        : {}),
    });
    if (Object.keys(settings).length > 0) {
      const scrubbed = scrubEnvironmentReferences(settings);
      if (scrubbed.removed > 0) {
        writer.warnings.push(
          `${paths.settings}: omitted ${scrubbed.removed} redacted secret reference(s); Claude only documents expansion for selected MCP fields`,
        );
      }
      await writer.json(paths.settings, scrubbed.value);
    }
    if (Object.keys(preservedUnmanagedSettings).length > 0) {
      projectionWarnings.push({
        code: "claude-local-settings-base-preserved",
        message:
          "Applied the machine-local preserved Claude settings base; canonical values take precedence and the base is excluded from Git",
        path: preservedSettingsPath,
        fidelity: "target-only",
      });
    }
    const unsupportedPermissionKeys = [
      harness.permissions.filesystem !== undefined ? "filesystem" : null,
      harness.permissions.network !== undefined ? "network" : null,
      harness.permissions.approval !== undefined ? "approval" : null,
    ].filter((key): key is string => key !== null);
    if (unsupportedPermissionKeys.length > 0) {
      projectionWarnings.push({
        code: "permissions-not-projected",
        message: `Claude settings have no lossless adapter for canonical ${unsupportedPermissionKeys.join(", ")}; those restrictions remain canonical and require a reviewed target-local policy`,
        path: paths.settings,
        fidelity: "unsupported",
      });
    }

    if (context.scope === "project" && (
      Object.keys(harness.mcpServers).length > 0 ||
      Object.keys(harness.overlays.claude.mcp ?? {}).length > 0
    )) {
      await writer.json(
        paths.mcp,
        renderClaudeEnvironmentReferences(deepMerge(withoutKeys(claudeMcpOverlay, ["serversRaw"]), {
          mcpServers: mergeMcpServerOverlays(
            rawMcpServers,
            renderMcpServers(harness.mcpServers, "camel"),
            harness.mcpServers,
            this.name,
          ),
        })),
      );
    }

    if (context.scope === "user" && Object.keys(harness.mcpServers).length > 0) {
      writer.warnings.push(
        `${paths.mcp}: user MCP was captured but not rewritten because ~/.claude.json mixes OAuth, trust, UI, and runtime state`,
      );
    }

    await writer.finish();

    return {
      target: this.name,
      written: writer.written,
      linked: writer.linked,
      removed: writer.removed,
      skipped: writer.skipped,
      warnings: [
        ...writer.warnings.map((message) => ({
          code: "write-skipped",
          message,
          fidelity: "target-only" as const,
        })),
        ...projectionWarnings,
      ],
    };
  }

  async fingerprint(context: AdapterContext): Promise<string> {
    return fingerprintManagedTarget(context.storeDir, this.name);
  }

  watchPaths(context: AdapterContext): string[] {
    const paths = claudePaths(context);
    return [
      paths.instructions,
      ...(paths.alternateInstructions ? [paths.alternateInstructions] : []),
      paths.sharedInstructions,
      paths.rules,
      paths.skills,
      paths.agents,
      paths.commands,
      paths.settings,
      paths.mcp,
      // The daemon's share of this entry is latency only — the audit timer
      // finds a native edit either way. The correctness consumers are
      // migration's compare-and-swap snapshot, the controller footprint, and
      // the topology check.
      //
      // INVARIANT: this directory must never itself become a projection
      // destination. assertSafeProjectTopology resolves every non-instruction
      // watched leaf, so a watched directory that is a symlink into the store
      // makes every command throw. Per-FILE projection keeps it real.
      paths.hookScripts,
      paths.outputStyles,
    ];
  }

  hookScripts(context: AdapterContext): HookScriptLayout | null {
    const paths = claudePaths(context);
    return {
      dir: paths.hookScripts,
      commandPrefix: context.scope === "project"
        ? "$CLAUDE_PROJECT_DIR/.claude/hooks"
        : "$HOME/.claude/hooks",
    };
  }
}

function claudeMcpProjectionFallbacks(
  harness: CanonicalHarness,
  scope: AdapterContext["scope"],
): Set<string> {
  const overlay = harness.overlays.claude.mcp ?? {};
  const rawServers = isRecord(overlay.serversRaw) ? overlay.serversRaw : {};
  return new Set(
    Object.entries(harness.mcpServers).flatMap(([name, server]) => {
      const generatedFallback =
        mcpRequiresUnavailableNativeFeatures(server, "claude", scope) ||
        server.cwd !== undefined ||
        server.enabledTools !== undefined ||
        (server.disabledTools?.length ?? 0) > 0 ||
        containsEnvironmentReference(rawServers[name]);
      return generatedFallback ? [name] : [];
    }),
  );
}

function claudePaths(context: AdapterContext) {
  const base = context.targetRoot;
  if (context.scope === "user") {
    return {
      instructions: join(base, "CLAUDE.md"),
      rules: join(base, "rules"),
      skills: join(base, "skills"),
      agents: join(base, "agents"),
      commands: join(base, "commands"),
      settings: join(base, "settings.json"),
      hookScripts: join(base, "hooks"),
      outputStyles: join(base, "output-styles"),
      localSettings: undefined,
      mcp: join(base, "..", ".claude.json"),
      alternateInstructions: undefined,
      sharedInstructions: join(base, "..", "AGENTS.md"),
    };
  }
  return {
    instructions: join(base, "CLAUDE.md"),
    rules: join(base, ".claude", "rules"),
    skills: join(base, ".claude", "skills"),
    agents: join(base, ".claude", "agents"),
    commands: join(base, ".claude", "commands"),
    settings: join(base, ".claude", "settings.json"),
    hookScripts: join(base, ".claude", "hooks"),
    outputStyles: join(base, ".claude", "output-styles"),
    localSettings: join(base, ".claude", "settings.local.json"),
    mcp: join(base, ".mcp.json"),
    alternateInstructions: join(base, ".claude", "CLAUDE.md"),
    sharedInstructions: join(base, "AGENTS.md"),
  };
}

async function importClaudeInstruction(
  source: string,
  sharedInstructions: string,
  storeDir: string,
  harness: CanonicalHarness,
  write: boolean,
  managedPaths?: readonly string[],
  nativeRoot = join(source, ".."),
  canonicalSourceStoreDir?: string,
): Promise<{ sources: string[]; expanded: boolean }> {
  if (!capturePathAllowed(source, managedPaths)) {
    return { sources: [], expanded: false };
  }
  const destination = resolveInside(storeDir, harness.instructions.root);
  const canonicalEquivalents = canonicalSourceStoreDir
    ? [
        destination,
        resolveInside(canonicalSourceStoreDir, harness.instructions.root),
      ]
    : destination;
  await assertNativeImportPath(source, nativeRoot, canonicalEquivalents);
  const sourceText = await readTextIfExists(source);
  if (sourceText === null) return { sources: [], expanded: false };
  const imports = scanAgentsImports(sourceText);
  if (imports.paths.length === 0) {
    await importInstruction(
      source,
      storeDir,
      harness,
      write,
      managedPaths,
      nativeRoot,
      canonicalSourceStoreDir,
    );
    return { sources: [source], expanded: false };
  }

  for (const importedPath of imports.paths) {
    const resolvedImport = resolve(dirname(source), importedPath);
    if (resolvedImport !== resolve(sharedInstructions)) {
      throw new Error(
        `${source}: AGENTS.md import ${importedPath} does not resolve to ${sharedInstructions}; flatten or relocate it before migration`,
      );
    }
  }

  await assertNativeImportPath(
    sharedInstructions,
    nativeRoot,
    canonicalEquivalents,
  );
  const sharedText = await readTextIfExists(sharedInstructions);
  if (sharedText === null) {
    throw new Error(
      `${source}: references AGENTS.md, but ${sharedInstructions} does not exist`,
    );
  }
  if (scanAgentsImports(sharedText).paths.length > 0) {
    throw new Error(`${sharedInstructions}: recursive @AGENTS.md import detected`);
  }
  const expanded = scanAgentsImports(sourceText, sharedText.trimEnd()).output;
  if (write) {
    await writeTextAtomicInside(
      storeDir,
      resolveInside(storeDir, harness.instructions.root),
      expanded.endsWith("\n") ? expanded : `${expanded}\n`,
    );
  }
  return { sources: [source, sharedInstructions], expanded: true };
}

function scanAgentsImports(
  input: string,
  replacement?: string,
): { output: string; paths: string[] } {
  let fence: "`" | "~" | null = null;
  const paths: string[] = [];
  const output = input.split("\n").map((line) => {
    const fenceMatch = /^[\t ]*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~";
      fence = fence === null ? marker : fence === marker ? null : fence;
      return line;
    }
    if (fence !== null) return line;
    return line.replace(
      /@((?:(?:\.\.?\/)*)AGENTS\.md)\b/gu,
      (match, importedPath: string) => {
        paths.push(importedPath);
        return replacement ?? match;
      },
    );
  });
  return { output: output.join("\n"), paths };
}

function captureClaudePermissions(value: unknown): PortablePermissions {
  if (!isRecord(value)) return {};
  const commandAllow = asStringArray(value.allow);
  const commandDeny = asStringArray(value.deny);
  const commandAsk = asStringArray(value.ask);
  return {
    ...(commandAllow ? { commandAllow } : {}),
    ...(commandDeny ? { commandDeny } : {}),
    ...(commandAsk ? { commandAsk } : {}),
  };
}

function assertClaudePortableSettingsShape(
  settings: Record<string, unknown>,
  path: string,
): void {
  if (settings.permissions !== undefined && !isRecord(settings.permissions)) {
    throw new Error(`${path}.permissions: expected an object`);
  }
  if (isRecord(settings.permissions)) {
    for (const key of ["allow", "deny", "ask"] as const) {
      if (
        settings.permissions[key] !== undefined &&
        asStringArray(settings.permissions[key]) === undefined
      ) {
        throw new Error(`${path}.permissions.${key}: expected an array of strings`);
      }
    }
    if (
      settings.permissions.defaultMode !== undefined &&
      ![
        "default",
        "manual",
        "acceptEdits",
        "plan",
        "auto",
        "dontAsk",
        "bypassPermissions",
      ].includes(String(settings.permissions.defaultMode))
    ) {
      throw new Error(`${path}.permissions.defaultMode: unsupported permission mode`);
    }
  }
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
    throw new Error(`${path}.hooks: expected an object`);
  }
  if (
    settings.disabledMcpjsonServers !== undefined &&
    asStringArray(settings.disabledMcpjsonServers) === undefined
  ) {
    throw new Error(
      `${path}.disabledMcpjsonServers: expected an array of strings`,
    );
  }
  if (
    settings.enabledMcpjsonServers !== undefined &&
    asStringArray(settings.enabledMcpjsonServers) === undefined
  ) {
    throw new Error(
      `${path}.enabledMcpjsonServers: expected an array of strings`,
    );
  }
  if (
    settings.enableAllProjectMcpServers !== undefined &&
    typeof settings.enableAllProjectMcpServers !== "boolean"
  ) {
    throw new Error(
      `${path}.enableAllProjectMcpServers: expected a boolean`,
    );
  }
  for (const key of ["allowedMcpServers", "deniedMcpServers"] as const) {
    if (settings[key] === undefined) continue;
    assertClaudeMcpPolicyList(settings[key], `${path}.${key}`, key === "allowedMcpServers");
  }
}

function assertClaudeMcpPolicyList(
  value: unknown,
  path: string,
  allowlist: boolean,
): void {
  if (!Array.isArray(value)) {
    throw new Error(`${path}: expected an array`);
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) {
      throw new Error(
        `${path}[${index}]: expected exactly one serverName, serverUrl, or serverCommand matcher`,
      );
    }
    if (entry.serverName !== undefined) {
      if (
        typeof entry.serverName !== "string" ||
        entry.serverName.length === 0 ||
        (allowlist && !/^[A-Za-z0-9_-]+$/u.test(entry.serverName))
      ) {
        throw new Error(`${path}[${index}].serverName: invalid server name matcher`);
      }
      continue;
    }
    if (entry.serverUrl !== undefined) {
      if (typeof entry.serverUrl !== "string" || entry.serverUrl.length === 0) {
        throw new Error(`${path}[${index}].serverUrl: expected a non-empty string`);
      }
      continue;
    }
    if (
      !Array.isArray(entry.serverCommand) ||
      entry.serverCommand.length === 0 ||
      entry.serverCommand.some(
        (part) => typeof part !== "string" || part.length === 0,
      )
    ) {
      throw new Error(
        `${path}[${index}].serverCommand: expected a non-empty array of strings`,
      );
    }
  }
}

function hasClaudeMcpPolicy(settings: Record<string, unknown>): boolean {
  return settings.allowedMcpServers !== undefined ||
    (Array.isArray(settings.deniedMcpServers) && settings.deniedMcpServers.length > 0);
}

function hasRestrictiveClaudeMcpPermissions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.defaultMode === "dontAsk" || value.defaultMode === "plan") {
    return true;
  }
  return ["ask", "deny"].some((key) =>
    (asStringArray(value[key]) ?? []).some((rule) =>
      !rule.includes("(") && (/^mcp__/u.test(rule) || rule.includes("*"))
    )
  );
}

function updateClaudeMcpPolicyRequirements(
  harness: CanonicalHarness,
  policyActive: boolean,
  excludedServers: ReadonlySet<string>,
): void {
  for (const [name, server] of Object.entries(harness.mcpServers)) {
    if (excludedServers.has(name)) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.claude ?? []).filter(
      (feature) => feature !== "settings.mcpPolicy",
    );
    if (policyActive) features.push("settings.mcpPolicy");
    if (features.length > 0) requirements.claude = features;
    else delete requirements.claude;
    if (Object.keys(requirements).length > 0) {
      server.requiredNativeFeatures = requirements;
    } else {
      delete server.requiredNativeFeatures;
    }
  }
}

function updateClaudeProjectMcpApprovalRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.claude ?? []).filter(
      (feature) => feature !== "settings.projectMcpApproval",
    );
    features.push("settings.projectMcpApproval");
    requirements.claude = features;
    server.requiredNativeFeatures = requirements;
  }
}

function updateClaudeProjectDisabledMcpRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.claude ?? []).filter(
      (feature) => feature !== "projects.disabledMcpServers",
    );
    features.push("projects.disabledMcpServers");
    requirements.claude = features;
    server.requiredNativeFeatures = requirements;
  }
}

function captureClaudeProjectDisabledMcpServers(
  value: unknown,
  path: string,
): Set<string> {
  if (value === undefined) return new Set();
  if (!isRecord(value)) {
    throw new Error(`${path}: expected an object of project state entries`);
  }
  const disabled = new Set<string>();
  for (const [projectPath, rawProject] of Object.entries(value)) {
    if (!isRecord(rawProject)) {
      throw new Error(`${path}.${projectPath}: expected a project state object`);
    }
    if (rawProject.disabledMcpServers === undefined) continue;
    const names = asStringArray(rawProject.disabledMcpServers);
    if (!names) {
      throw new Error(
        `${path}.${projectPath}.disabledMcpServers: expected an array of strings`,
      );
    }
    for (const name of names) disabled.add(name);
  }
  return disabled;
}

function updateClaudeMcpPermissionRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.claude ?? []).filter(
      (feature) => feature !== "settings.mcpPermissions",
    );
    features.push("settings.mcpPermissions");
    requirements.claude = features;
    server.requiredNativeFeatures = requirements;
  }
}

function updateClaudeMcpHookRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.claude ?? []).filter(
      (feature) => feature !== "settings.mcpHooks",
    );
    features.push("settings.mcpHooks");
    requirements.claude = features;
    server.requiredNativeFeatures = requirements;
  }
}

function renderClaudePermissions(value: PortablePermissions): Record<string, unknown> {
  return {
    ...(value.commandAllow ? { allow: value.commandAllow } : {}),
    ...(value.commandDeny ? { deny: value.commandDeny } : {}),
    ...(value.commandAsk ? { ask: value.commandAsk } : {}),
  };
}
