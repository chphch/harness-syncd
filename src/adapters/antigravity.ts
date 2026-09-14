import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  AdapterWarning,
  ApplyResult,
  CanonicalHarness,
  McpServer,
} from "../types.js";
import {
  assertNativeImportPath,
  assertSafeStorePath,
  listFilesRecursive,
  pathExists,
  resolveInside,
  copyTreeForImportInside,
  writeJsonAtomicInside,
  writeTextAtomicInside,
} from "../core/fs.js";
import { isRecord, parseFrontmatter, stringifyFrontmatter } from "../core/frontmatter.js";
import {
  containsEnvironmentReference,
  redactSecrets,
  scrubEnvironmentReferences,
} from "../core/secrets.js";
import { environmentReference } from "../core/secrets.js";
import { assertArtifactName } from "../core/validate.js";
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
  assertOptionalFrontmatterString,
  assertUniqueImportedNames,
  capturePathAllowed,
  captureMcpServers,
  cloneHarness,
  deepMerge,
  importInstruction,
  importRules,
  importSkills,
  hasMcpBlockingHooks,
  mergeCapturedMcpServers,
  mergeCapturedAgents,
  mcpExecutableContainsEnvironmentReference,
  mergeCapturedRules,
  mcpRequiresForeignNativeFeatures,
  mcpRequiresUnavailableNativeFeatures,
  mcpServerOverlays,
  mergeMcpServerOverlays,
  readJsoncObject,
  withoutKeys,
} from "./common.js";

export class AntigravityAdapter implements HarnessAdapter {
  readonly name = "antigravity" as const;

  async capture(
    current: CanonicalHarness,
    context: AdapterContext,
    options: CaptureOptions,
  ) {
    const harness = cloneHarness(current);
    const warnings = [];
    const imported: string[] = [];
    const paths = antigravityPaths(context);
    const nativeRoot = captureBoundary(context);
    const projectionFallbacks = antigravityMcpProjectionFallbacks(
      harness,
      context.scope,
    );
    let authoredMcpServerNames: string[] = [];

    const primaryInstructionsExist = await pathExists(paths.instructions);
    const alternateInstructionsExist = paths.alternateInstructions
      ? await pathExists(paths.alternateInstructions)
      : false;
    if (primaryInstructionsExist && alternateInstructionsExist) {
      warnings.push({
        code: "multiple-antigravity-instructions",
        message:
          `Both ${paths.instructions} and ${paths.alternateInstructions} exist; ` +
          `${paths.instructions} was imported and the alternate was left target-local`,
        path: paths.instructions,
        fidelity: "target-only" as const,
      });
    }
    const instructionSource = primaryInstructionsExist || !paths.alternateInstructions
      ? paths.instructions
      : paths.alternateInstructions;
    if (
      await importInstruction(
        instructionSource,
        context.storeDir,
        harness,
        options.write,
        options.managedPaths,
        nativeRoot,
        context.canonicalSourceStoreDir,
      )
    ) {
      imported.push(instructionSource);
    }

    if (options.includeAssets) {
      const capturedRules = paths.rules
        ? await importAntigravityRules(
            paths.rules,
            context.storeDir,
            options.write,
            options.managedPaths,
            nativeRoot,
          )
        : { rules: [], warnings: [] };
      const rules = capturedRules.rules;
      warnings.push(...capturedRules.warnings);
      if (rules.length > 0) {
        harness.rules = mergeCapturedRules(harness.rules, rules, this.name);
        imported.push(paths.rules!);
      }
      const skills = await importAntigravitySkills(
        paths.skills,
        context.storeDir,
        options.write,
        options.managedPaths,
        warnings,
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
        imported.push(paths.skills[0]!);
      }
      const agents = await importAntigravityAgents(
        paths.agents,
        context.storeDir,
        options.write,
        options.managedPaths,
        warnings,
        nativeRoot,
      );
      if (Object.keys(agents).length > 0) {
        harness.agents = mergeCapturedAgents(harness.agents, agents);
        imported.push(paths.agents);
      }
    }

    const mcp = capturePathAllowed(paths.mcp, options.managedPaths)
      ? await readJsoncObject(paths.mcp, nativeRoot)
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
      const safeServers = safe.mcpServers as Record<string, unknown> | undefined;
      harness.mcpServers = mergeCapturedMcpServers(
        harness.mcpServers,
        captured.servers,
        this.name,
        projectionFallbacks,
      );
      warnings.push(...captured.warnings);
      const projectServerNames = context.scope === "project"
        ? Object.keys(captured.servers).filter(
            (name) => !projectionFallbacks.has(name),
          )
        : [];
      authoredMcpServerNames = Object.keys(captured.servers).filter(
        (name) => !projectionFallbacks.has(name),
      );
      if (projectServerNames.length > 0) {
        harness.overlays.antigravity.metadata = {
          ...harness.overlays.antigravity.metadata,
          projectTrustCaptured: true,
        };
        updateAntigravityProjectTrustRequirements(
          harness,
          projectServerNames,
        );
      }
      harness.overlays.antigravity.mcp = {
        ...safe,
        mcpServers: mcpServerOverlays(safeServers ?? {}, this.name),
      };
      imported.push(paths.mcp);
    }

    const hooks = capturePathAllowed(paths.hooks, options.managedPaths)
      ? await readJsoncObject(paths.hooks, nativeRoot)
      : null;
    if (hooks) {
      const redacted = redactSecrets(hooks, paths.hooks);
      warnings.push(...redacted.warnings);
      const hasMcpHookGate = hasAntigravityMcpBlockingHooks(
        redacted.value,
        paths.hooks,
      );
      if (
        authoredMcpServerNames.length > 0 &&
        hasMcpHookGate
      ) {
        updateAntigravityMcpHookRequirements(
          harness,
          authoredMcpServerNames,
        );
      }
      harness.overlays.antigravity.metadata = {
        ...harness.overlays.antigravity.metadata,
        hooksRaw: redacted.value,
        ...(hasMcpHookGate && authoredMcpServerNames.length > 0
          ? { mcpHooksCaptured: true }
          : {}),
      };
      imported.push(paths.hooks);
      warnings.push({
        code: "hooks-retained-as-overlay",
        message:
          "Antigravity named hook sets were retained as a target-only overlay; they were not promoted because tool and decision schemas differ",
        path: paths.hooks,
        fidelity: "target-only" as const,
      });
    }

    if (paths.settings) {
      const settings = capturePathAllowed(paths.settings, options.managedPaths)
        ? await readJsoncObject(paths.settings, nativeRoot)
        : null;
      if (settings) {
        const redacted = redactSecrets(settings, paths.settings);
        warnings.push(...redacted.warnings);
        assertAntigravityPermissionShape(redacted.value, paths.settings);
        if (
          authoredMcpServerNames.length > 0 &&
          hasRestrictiveAntigravityMcpPermissions(redacted.value.permissions)
        ) {
          harness.overlays.antigravity.metadata = {
            ...harness.overlays.antigravity.metadata,
            mcpPermissionsCaptured: true,
          };
          updateAntigravityMcpPermissionRequirements(
            harness,
            authoredMcpServerNames,
          );
        }
        harness.overlays.antigravity.settings = redacted.value;
        imported.push(paths.settings);
      }
    }

    return { harness, warnings, imported };
  }

  async apply(
    harness: CanonicalHarness,
    context: AdapterContext,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    const paths = antigravityPaths(context);
    const writer = new ManagedWriter({
      ...options,
      storeDir: context.storeDir,
      target: this.name,
      allowedRoot: context.scope === "project" ? context.targetRoot : dirname(context.targetRoot),
    });
    await writer.load();
    const existingMcp = await readJsoncObject(
      paths.mcp,
      captureBoundary(context),
    );
    const preservedMcpPath = join(
      context.storeDir,
      ".local",
      "preserved",
      `${this.name}-mcp.json`,
    );
    let preservedMcp = options.ignoreLocalBase
      ? null
      : await readJsoncObject(preservedMcpPath, context.storeDir);
    if (!writer.owns(paths.mcp) && !options.ignoreLocalBase) {
      if (existingMcp) {
        preservedMcp = existingMcp;
        if (!options.dryRun) {
          await writeJsonAtomicInside(
            context.storeDir,
            preservedMcpPath,
            existingMcp,
          );
        }
      } else {
        preservedMcp = {};
        if (!options.dryRun) {
          await assertSafeStorePath(context.storeDir, preservedMcpPath);
          await rm(preservedMcpPath, { force: true });
        }
      }
    }
    preservedMcp ??= {};
    let scrubbedReferences = 0;
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
        "both Antigravity instruction filenames are active",
      );
      if (retired) {
        await writer.file(instructionSource, paths.instructions);
      } else {
        writer.retain(paths.instructions);
        projectionWarnings.push({
          code: "multiple-antigravity-instructions",
          message:
            `Both ${paths.instructions} and ${paths.alternateInstructions} exist; ` +
            "projection stopped so Antigravity cannot read conflicting instruction sources",
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
    for (const rule of paths.rules
      ? harness.rules.filter(
          (entry) => entry.portable !== false || entry.targets?.antigravity,
        )
      : []) {
      const source = resolveInside(context.storeDir, rule.path);
      const destination = resolveInside(
        paths.rules!,
        relative(join(context.storeDir, "rules"), source),
      );
      const body = await readFile(source, "utf8");
      let rendered: string;
      if (rule.globs) {
        rendered = stringifyFrontmatter(
          deepMerge(rule.targets?.antigravity ?? {}, {
            trigger: "glob",
            globs: rule.globs,
          }),
          body,
        );
      } else {
        const raw = rule.targets?.antigravity ?? {};
        if (Object.keys(raw).length > 0) {
          rendered = stringifyFrontmatter(raw, body);
        } else {
          rendered = body;
        }
      }
      if (rendered.length > MAX_ANTIGRAVITY_RULE_CHARACTERS) {
        writer.retain(destination);
        writer.skipped.push(destination);
        projectionWarnings.push(ruleTooLongWarning(destination, rendered.length));
        continue;
      }
      // Rules are materialized so later projections can enforce Antigravity's
      // length limit before replacing the native file.
      await writer.text(destination, rendered);
    }
    for (const skill of harness.skills) {
      for (const skillsRoot of paths.skills) {
        const destination = join(skillsRoot, skill.name);
        const legacyStandalone = `${destination}.md`;
        if (await pathExists(legacyStandalone)) {
          const retired = await writer.retire(
            legacyStandalone,
            `standalone Antigravity skill conflicts with managed bundle ${skill.name}`,
          );
          if (!retired) {
            writer.retain(destination);
            projectionWarnings.push({
              code: "multiple-antigravity-skill-layouts",
              message: `${legacyStandalone} was left active, so bundle projection stopped to avoid duplicate skill definitions`,
              path: legacyStandalone,
              fidelity: "unsupported",
            });
            continue;
          }
        }
        await writer.directory(
          resolveInside(context.storeDir, skill.path),
          destination,
        );
      }
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
      for (const skillsRoot of paths.skills) {
        const destination = join(skillsRoot, skillName, "SKILL.md");
        const legacyStandalone = join(skillsRoot, `${skillName}.md`);
        if (await pathExists(legacyStandalone)) {
          const retired = await writer.retire(
            legacyStandalone,
            `standalone Antigravity skill conflicts with projected command ${skillName}`,
          );
          if (!retired) {
            writer.retain(join(skillsRoot, skillName));
            projectionWarnings.push({
              code: "multiple-antigravity-skill-layouts",
              message: `${legacyStandalone} was left active, so command projection stopped to avoid duplicate skill definitions`,
              path: legacyStandalone,
              fidelity: "unsupported",
            });
            continue;
          }
        }
        await writer.text(
          destination,
          stringifyFrontmatter(
            {
              name: skillName,
              description: command.description ?? `Run the ${name} workflow`,
            },
            body,
          ),
        );
      }
    }
    for (const [name, agent] of Object.entries(harness.agents)) {
      const destination = resolveInside(
        paths.agents,
        agent.nativePaths?.antigravity ?? `${name}.md`,
      );
      const usesConservativeFallback =
        agentHasOnlyForeignTargetCapabilities(agent, this.name);
      if (usesConservativeFallback) {
        projectionWarnings.push({
          code: "agent-capabilities-conservative-fallback",
          message: `${name}'s portable prompt was projected to Antigravity with an explicit empty tool set because it has no explicit Antigravity capability overlay`,
          path: destination,
          fidelity: "compatible",
        });
      }
      if (containsEnvironmentReference(agent.targets?.antigravity)) {
        writer.retain(destination);
        projectionWarnings.push({
          code: "agent-secret-reference-not-projected",
          message: `${name} contains redacted target-native credentials that Antigravity does not document how to expand; its native file was not emitted`,
          path: destination,
          fidelity: "unsupported",
        });
        continue;
      }
      const body = await readFile(
        resolveInside(context.storeDir, agent.instructionsFile),
        "utf8",
      );
      await writer.text(
        destination,
        stringifyFrontmatter(
          deepMerge(
            usesConservativeFallback ? { tools: [] } : {},
            deepMerge(agent.targets?.antigravity ?? {}, {
              name,
              description: agent.description,
            }),
          ),
          body,
        ),
      );
    }

    const rawHooks = isRecord(harness.overlays.antigravity.metadata?.hooksRaw)
      ? harness.overlays.antigravity.metadata.hooksRaw
      : {};
    const omitRawHooks = containsEnvironmentReference(rawHooks);
    const unresolvedHookGateNames = new Set(
      Object.entries(harness.mcpServers).flatMap(([name, server]) =>
        omitRawHooks &&
        server.requiredNativeFeatures?.antigravity?.includes(
          "settings.mcpHooks",
        )
          ? [name]
          : [],
      ),
    );

    if (
      Object.keys(harness.mcpServers).length > 0 ||
      Object.keys(harness.overlays.antigravity.mcp ?? {}).length > 0 ||
      Object.keys(preservedMcp).length > 0
    ) {
      const raw = harness.overlays.antigravity.mcp ?? {};
      const rawServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
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
      const supportedServers = Object.fromEntries(
        Object.entries(harness.mcpServers).filter(
          ([name]) => !unsupportedExecutableSecretNames.has(name),
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
      const projectedMcp = scrubEnvironmentReferences(deepMerge(
        deepMerge(preservedMcp, withoutKeys(raw, ["mcpServers"])),
        {
          mcpServers: mergeNamedServers(
            rawServers,
            renderAntigravityMcp(supportedServers),
            harness.mcpServers,
            this.name,
          ),
        },
      ));
      scrubbedReferences += projectedMcp.removed;
      await writer.json(paths.mcp, projectedMcp.value);
      for (const [name] of unsupportedExecutableSecretServers) {
        projectionWarnings.push({
          code: "mcp-executable-secret-not-projected",
          message: `${name} contains a redacted credential in an executable MCP field that Antigravity does not document how to expand; the whole server was omitted`,
          path: paths.mcp,
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
        projectionWarnings.push({
          code: "mcp-target-feature-not-projected",
          message:
            `${name} requires native MCP features unavailable to Antigravity in ${context.scope} scope; ` +
            "the server was disabled instead of being started with incomplete authentication or runtime semantics",
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
      for (const name of unresolvedNativeSecretNames) {
        projectionWarnings.push({
          code: "mcp-native-secret-not-projected",
          message:
            `${name} contains a redacted Antigravity-native MCP value, but Antigravity does not document expansion there; ` +
            "the server was disabled instead of using partial authentication",
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
      for (const name of unresolvedHookGateNames) {
        projectionWarnings.push({
          code: "mcp-native-hook-not-projected",
          message:
            `${name} depends on an Antigravity-native blocking hook that contains a redacted credential; ` +
            "the server was disabled because that hook could not be emitted",
          path: paths.mcp,
          fidelity: "unsupported",
        });
      }
    }

    if (Object.keys(rawHooks).length > 0) {
      if (omitRawHooks) {
        await writer.retire(
          paths.hooks,
          "redacted hook credentials cannot be represented by Antigravity's documented hook schema",
        );
        projectionWarnings.push({
          code: "hook-secret-reference-not-projected",
          message:
            "Antigravity hook configuration containing redacted credentials was not emitted; configure the hook in a machine-local native file",
          path: paths.hooks,
          fidelity: "unsupported",
        });
      } else {
        await writer.json(paths.hooks, rawHooks);
      }
    }
    if (paths.settings && Object.keys(harness.overlays.antigravity.settings ?? {}).length > 0) {
      const settings = scrubEnvironmentReferences(
        harness.overlays.antigravity.settings,
      );
      scrubbedReferences += settings.removed;
      await writer.json(paths.settings, settings.value);
    }

    await writer.finish();
    const adapterWarnings: AdapterWarning[] = [
      ...projectionWarnings,
      ...writer.warnings.map((message) => ({
        code: "write-skipped",
        message,
        fidelity: "target-only" as const,
      })),
    ];
    if (Object.keys(preservedMcp).length > 0) {
      adapterWarnings.push({
        code: "antigravity-local-mcp-base-preserved",
        message:
          "Applied the machine-local preserved Antigravity MCP base; canonical values take precedence and the base is excluded from Git",
        path: preservedMcpPath,
        fidelity: "target-only",
      });
    }
    if (Object.keys(harness.permissions).length > 0) {
      adapterWarnings.push({
        code: "permissions-not-projected",
        message:
          "Antigravity permissions are intentionally left target-local because project settings have no stable public schema",
        fidelity: "unsupported" as const,
      });
    }
    if (Object.keys(harness.hooks).length > 0 && Object.keys(rawHooks).length === 0) {
      adapterWarnings.push({
        code: "hooks-not-projected",
        message:
          "Cross-target hooks were not projected because Antigravity's stdin, tool IDs, and decision schema require a dispatcher",
        fidelity: "unsupported",
      });
    }
    if ((harness.hookScripts?.length ?? 0) > 0) {
      adapterWarnings.push({
        code: "hook-scripts-not-projected",
        message:
          "Hook scripts were not projected to Antigravity: it documents no hook-script directory, so there is no location to write them to",
        fidelity: "unsupported" as const,
      });
    }
    const unsupportedEnabledToolFilters = Object.entries(
      harness.mcpServers,
    ).filter(([, server]) => server.enabledTools !== undefined);
    for (const [name] of unsupportedEnabledToolFilters) {
      adapterWarnings.push({
        code: "mcp-enabled-tools-not-projected",
        message:
          `Antigravity's public MCP schema does not support enabledTools; ${name} was disabled instead of widening its tool set`,
        path: paths.mcp,
        fidelity: "unsupported",
      });
    }
    const unsupportedBearerTokens = Object.entries(harness.mcpServers).filter(
      ([, server]) => server.bearerTokenEnvVar !== undefined,
    );
    for (const [name] of unsupportedBearerTokens) {
      adapterWarnings.push({
        code: "mcp-bearer-token-not-projected",
        message:
          `Antigravity does not document environment expansion for MCP headers; ${name} was disabled instead of starting without its Bearer token`,
        path: paths.mcp,
        fidelity: "unsupported",
      });
    }
    const unsupportedEnvironmentServers = Object.entries(
      harness.mcpServers,
    ).filter(([, server]) =>
      containsEnvironmentReference(server.env) ||
      containsEnvironmentReference(server.headers)
    );
    for (const [name] of unsupportedEnvironmentServers) {
      adapterWarnings.push({
        code: "mcp-env-reference-not-projected",
        message:
          `Antigravity does not document environment expansion in MCP env/headers; ${name} was disabled instead of starting with omitted values`,
        path: paths.mcp,
        fidelity: "unsupported",
      });
    }
    const unresolvedMcpSecrets =
      countEnvironmentReferences(harness.mcpServers) + scrubbedReferences;
    if (
      unresolvedMcpSecrets > 0 &&
      unsupportedEnvironmentServers.length === 0
    ) {
      adapterWarnings.push({
        code: "mcp-env-reference-not-projected",
        message: `${unresolvedMcpSecrets} MCP secret reference(s) were omitted because Antigravity does not document environment substitution in mcp_config.json; configure them in a machine-local native overlay`,
        fidelity: "unsupported",
      });
    }
    return {
      target: this.name,
      written: writer.written,
      linked: writer.linked,
      removed: writer.removed,
      skipped: writer.skipped,
      warnings: adapterWarnings,
    };
  }

  async fingerprint(context: AdapterContext): Promise<string> {
    return fingerprintManagedTarget(context.storeDir, this.name);
  }

  watchPaths(context: AdapterContext): string[] {
    const paths = antigravityPaths(context);
    return [
      paths.instructions,
      ...(paths.alternateInstructions ? [paths.alternateInstructions] : []),
      ...(paths.rules ? [paths.rules] : []),
      ...paths.skills,
      paths.agents,
      paths.mcp,
      paths.hooks,
      ...(paths.settings ? [paths.settings] : []),
    ];
  }

  /** Antigravity documents hook CONFIG at .agents/hooks.json but no directory for
   * the scripts those hooks run. */
  hookScripts(_context: AdapterContext): HookScriptLayout | null {
    return null;
  }
}

function antigravityMcpProjectionFallbacks(
  harness: CanonicalHarness,
  scope: AdapterContext["scope"],
): Set<string> {
  const overlay = harness.overlays.antigravity.mcp ?? {};
  const rawServers = isRecord(overlay.mcpServers) ? overlay.mcpServers : {};
  return new Set(
    Object.entries(harness.mcpServers).flatMap(([name, server]) => {
      const generatedFallback =
        mcpRequiresUnavailableNativeFeatures(
          server,
          "antigravity",
          scope,
        ) ||
        server.enabledTools !== undefined ||
        server.bearerTokenEnvVar !== undefined ||
        containsEnvironmentReference(server.env) ||
        containsEnvironmentReference(server.headers) ||
        mcpExecutableContainsEnvironmentReference(server) ||
        containsEnvironmentReference(rawServers[name]);
      return generatedFallback ? [name] : [];
    }),
  );
}

function antigravityPaths(context: AdapterContext) {
  if (context.scope === "user") {
    return {
      instructions: join(context.targetRoot, "GEMINI.md"),
      rules: undefined,
      skills: [
        join(context.targetRoot, "config", "skills"),
        join(context.targetRoot, "antigravity-cli", "skills"),
        join(context.targetRoot, "antigravity", "skills"),
      ],
      agents: join(context.targetRoot, "config", "agents"),
      mcp: join(context.targetRoot, "config", "mcp_config.json"),
      hooks: join(context.targetRoot, "config", "hooks.json"),
      settings: join(context.targetRoot, "antigravity-cli", "settings.json"),
      alternateInstructions: undefined,
    };
  }
  return {
    instructions: join(context.targetRoot, "AGENTS.md"),
    rules: join(context.targetRoot, ".agents", "rules"),
    skills: [join(context.targetRoot, ".agents", "skills")],
    agents: join(context.targetRoot, ".agents", "agents"),
    mcp: join(context.targetRoot, ".agents", "mcp_config.json"),
    hooks: join(context.targetRoot, ".agents", "hooks.json"),
    settings: undefined,
    alternateInstructions: join(context.targetRoot, "GEMINI.md"),
  };
}

async function importAntigravityAgents(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  managedPaths?: readonly string[],
  warningSink?: AdapterWarning[],
  nativeRoot = sourceDir,
): Promise<CanonicalHarness["agents"]> {
  if (!(await pathExists(sourceDir))) return {};
  await assertNativeImportPath(sourceDir, nativeRoot);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const agents: CanonicalHarness["agents"] = {};
  const discovered: Array<{
    source: string;
    name: string;
    parsed: ReturnType<typeof parseFrontmatter>;
  }> = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `native Antigravity agent import contains a symlink: ${join(sourceDir, entry.name)}`,
      );
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(
        `native Antigravity agent import contains a non-regular entry: ${join(sourceDir, entry.name)}`,
      );
    }
    if (entry.isFile() && !entry.name.endsWith(".md")) continue;
    const expectedName = entry.isDirectory()
      ? entry.name
      : basename(entry.name, ".md");
    const source = entry.isDirectory()
      ? join(sourceDir, entry.name, "agent.md")
      : join(sourceDir, entry.name);
    if (!capturePathAllowed(source, managedPaths)) continue;
    if (!(await pathExists(source)) || !source.endsWith(".md")) continue;
    if (!(await lstat(source)).isFile()) {
      throw new Error(
        `native Antigravity agent definition is not a regular file: ${source}`,
      );
    }
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
    const instructionsFile = `agents/${name}.md`;
    if (write) {
      await writeTextAtomicInside(
        storeDir,
        join(storeDir, instructionsFile),
        parsed.body,
      );
    }
    agents[name] = {
      description: asString(parsed.data.description) ?? name,
      instructionsFile,
      targets: { antigravity: parsed.data },
      nativePaths: {
        antigravity: relative(sourceDir, source).split(sep).join("/"),
      },
    };
  }
  return agents;
}

async function importAntigravitySkills(
  roots: string[],
  storeDir: string,
  write: boolean,
  managedPaths?: readonly string[],
  warningSink?: AdapterWarning[],
  nativeRoot = roots[0] ?? storeDir,
  canonicalSourceStoreDir?: string,
  excludeSkills: readonly string[] = [],
): Promise<CanonicalHarness["skills"]> {
  const found = new Map<string, { name: string; path: string; source: string; standalone: boolean }>();
  for (const root of roots) {
    for (const skill of await importSkills(
      root,
      storeDir,
      false,
      managedPaths,
      nativeRoot,
      canonicalSourceStoreDir,
      excludeSkills,
    )) {
      if (!found.has(skill.name)) {
        found.set(skill.name, {
          ...skill,
          source: join(root, skill.name),
          standalone: false,
        });
      }
    }
    if (!(await pathExists(root))) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.isFile()) {
        throw new Error(
          `native skill import contains a non-regular Markdown file: ${join(root, entry.name)}`,
        );
      }
      if (!capturePathAllowed(join(root, entry.name), managedPaths)) continue;
      const name = basename(entry.name, ".md");
      if (excludeSkills.includes(name)) continue;
      assertArtifactName(name, "skill");
      if (!found.has(name)) {
        found.set(name, {
          name,
          path: `skills/${name}`,
          source: join(root, entry.name),
          standalone: true,
        });
      } else {
        warningSink?.push({
          code: "multiple-antigravity-skill-layouts",
          message: `Both a bundle and standalone skill named ${name} exist; the bundle was selected and installation must retire the standalone file`,
          path: join(root, entry.name),
          fidelity: "target-only",
        });
      }
    }
  }
  if (write) {
    for (const skill of found.values()) {
      if (skill.standalone) {
        const destination = join(storeDir, skill.path, "SKILL.md");
        await assertNativeImportPath(skill.source, nativeRoot, destination);
        await writeTextAtomicInside(
          storeDir,
          destination,
          await readFile(skill.source, "utf8"),
        );
      } else {
        await assertNativeImportPath(
          skill.source,
          nativeRoot,
          canonicalSourceStoreDir
            ? [
                join(storeDir, skill.path),
                resolveInside(canonicalSourceStoreDir, skill.path),
              ]
            : join(storeDir, skill.path),
        );
        await copyTreeForImportInside(
          storeDir,
          skill.source,
          join(storeDir, skill.path),
        );
      }
    }
  }
  return [...found.values()]
    .map(({ name, path }) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function importAntigravityRules(
  sourceDir: string,
  storeDir: string,
  write: boolean,
  managedPaths?: readonly string[],
  nativeRoot = sourceDir,
): Promise<{
  rules: CanonicalHarness["rules"];
  warnings: AdapterWarning[];
}> {
  if (await pathExists(sourceDir)) {
    await assertNativeImportPath(sourceDir, nativeRoot);
  }
  const files = (await listFilesRecursive(sourceDir)).filter((file) =>
    file.endsWith(".md"),
  );
  const rules: CanonicalHarness["rules"] = [];
  const warnings: AdapterWarning[] = [];
  for (const file of files) {
    const source = join(sourceDir, file);
    if (!capturePathAllowed(source, managedPaths)) continue;
    await assertNativeImportPath(
      source,
      nativeRoot,
      join(storeDir, "rules", file),
    );
    const content = await readFile(source, "utf8");
    if (content.length > MAX_ANTIGRAVITY_RULE_CHARACTERS) {
      warnings.push(ruleTooLongWarning(source, content.length));
      continue;
    }
    const parsed = parseFrontmatter(content);
    const trigger = asString(parsed.data.trigger);
    const globs = asStringArray(parsed.data.globs ?? parsed.data.paths);
    const portable =
      trigger === undefined ||
      trigger === "always_on" ||
      (trigger === "glob" && Boolean(globs));
    if (write) {
      await writeTextAtomicInside(
        storeDir,
        join(storeDir, "rules", file),
        parsed.body,
      );
    }
    rules.push({
      path: `rules/${file}`,
      ...(trigger === "glob" && globs ? { globs } : {}),
      ...(portable ? {} : { portable: false }),
      targets: { antigravity: parsed.data },
    });
  }
  return { rules, warnings };
}

function renderAntigravityMcp(
  servers: Record<string, McpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const omitsEnvironment =
        containsEnvironmentReference(server.env) ||
        containsEnvironmentReference(server.headers);
      const hasForeignNativeFeatures = mcpRequiresForeignNativeFeatures(
        server,
        "antigravity",
      );
      return [
        name,
        {
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: server.args } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(withoutEnvironmentReferences(server.env)
          ? { env: withoutEnvironmentReferences(server.env) }
          : {}),
        ...(server.url ? { serverUrl: server.url } : {}),
        ...(withoutEnvironmentReferences(server.headers)
          ? { headers: withoutEnvironmentReferences(server.headers) }
          : {}),
        ...(server.enabled !== undefined ||
            server.enabledTools !== undefined ||
            server.bearerTokenEnvVar !== undefined ||
            omitsEnvironment ||
            hasForeignNativeFeatures
          ? {
              disabled:
                server.enabled === false ||
                server.enabledTools !== undefined ||
                server.bearerTokenEnvVar !== undefined ||
                omitsEnvironment ||
                hasForeignNativeFeatures,
            }
          : {}),
        ...(server.disabledTools ? { disabledTools: server.disabledTools } : {}),
        ...(server.startupTimeoutMs !== undefined
          ? { timeoutSeconds: server.startupTimeoutMs / 1000 }
          : {}),
        },
      ];
    }),
  );
}

const mergeNamedServers = mergeMcpServerOverlays;

function updateAntigravityProjectTrustRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.antigravity ?? []).filter(
      (feature) => feature !== "settings.projectTrust",
    );
    features.push("settings.projectTrust");
    requirements.antigravity = features;
    server.requiredNativeFeatures = requirements;
  }
}

function updateAntigravityMcpPermissionRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  updateAntigravitySettingsRequirement(
    harness,
    serverNames,
    "settings.mcpPermissions",
  );
}

function updateAntigravityMcpHookRequirements(
  harness: CanonicalHarness,
  serverNames: readonly string[],
): void {
  updateAntigravitySettingsRequirement(
    harness,
    serverNames,
    "settings.mcpHooks",
  );
}

function updateAntigravitySettingsRequirement(
  harness: CanonicalHarness,
  serverNames: readonly string[],
  feature: string,
): void {
  for (const name of serverNames) {
    const server = harness.mcpServers[name];
    if (!server) continue;
    const requirements = { ...(server.requiredNativeFeatures ?? {}) };
    const features = (requirements.antigravity ?? []).filter(
      (entry) => entry !== feature,
    );
    features.push(feature);
    requirements.antigravity = features;
    server.requiredNativeFeatures = requirements;
  }
}

function assertAntigravityPermissionShape(
  settings: Record<string, unknown>,
  path: string,
): void {
  if (settings.permissions === undefined) return;
  if (!isRecord(settings.permissions)) {
    throw new Error(`${path}.permissions: expected an object`);
  }
  for (const key of ["allow", "ask", "deny"] as const) {
    if (
      settings.permissions[key] !== undefined &&
      asStringArray(settings.permissions[key]) === undefined
    ) {
      throw new Error(`${path}.permissions.${key}: expected an array of strings`);
    }
  }
}

function hasRestrictiveAntigravityMcpPermissions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["ask", "deny"].some((key) =>
    (asStringArray(value[key]) ?? []).some((rule) =>
      rule === "*" || /^mcp(?:\(|$)/iu.test(rule)
    )
  );
}

function hasAntigravityMcpBlockingHooks(
  value: unknown,
  path: string,
): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([name, definition]) => {
    if (!isRecord(definition) || definition.enabled === false) return false;
    return hasMcpBlockingHooks(definition, `${path}.${name}`);
  });
}

function withoutEnvironmentReferences(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(
    ([, entry]) => !environmentReference(entry),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const MAX_ANTIGRAVITY_RULE_CHARACTERS = 12_000;

function ruleTooLongWarning(path: string, length: number): AdapterWarning {
  return {
    code: "antigravity-rule-too-long",
    message:
      `${path} has ${String(length)} characters; Antigravity rules are limited ` +
      `to ${String(MAX_ANTIGRAVITY_RULE_CHARACTERS)}, so it was not imported or projected`,
    path,
    fidelity: "unsupported",
  };
}

function countEnvironmentReferences(servers: Record<string, McpServer>): number {
  let count = 0;
  for (const server of Object.values(servers)) {
    for (const value of [server.env, server.headers]) {
      if (!value) continue;
      count += Object.values(value).filter((entry) => environmentReference(entry)).length;
    }
  }
  return count;
}
