import type { CanonicalHarness } from "../types.js";

/**
 * The store-relative files a harness declares as canonical artifacts.
 *
 * Three subsystems must agree on this set or a store becomes silently
 * inconsistent: `hashCanonical` (the sole canonical-change signal), the capture
 * stage's copy-in/commit-out set, and the force-staged Git set. Declaring a kind
 * in two of the three yields artifacts that are edited but never projected, or
 * committed but never verified.
 *
 * Deliberately NOT included, because each caller owns it:
 * - the controller config path, which has no store-relative spelling;
 * - the absolute mapping, since each caller applies its own `resolveInside`;
 * - `.gitignore`, a store runtime file that only the Git set wants;
 * - `harness.yaml`, which three of the four call sites prepend but
 *   `createCaptureStage` deliberately writes separately.
 */
export function canonicalArtifactPaths(harness: CanonicalHarness): string[] {
  return [...new Set([
    harness.instructions.root,
    ...harness.rules.map((rule) => rule.path),
    ...harness.skills.map((skill) => skill.path),
    ...Object.values(harness.commands).map((command) => command.promptFile),
    ...Object.values(harness.agents).map((agent) => agent.instructionsFile),
    // Load-bearing: this list is also what `commitCaptureStage` moves back OUT
    // of the capture stage. Omit it and a migration reports SUCCESS while
    // leaving a harness.yaml that declares scripts the store does not contain,
    // because `hashCanonicalContent` hashes this same list and compares equal.
    ...(harness.hookScripts ?? []).map((entry) => entry.path),
    ...(harness.outputStyles ?? []).map((entry) => entry.path),
  ])];
}
