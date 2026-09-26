import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TargetName } from "../types.js";
import { assertSafeStorePath, readTextIfExists, writeTextAtomicInside } from "./fs.js";

const LOCAL_BASE_FILE: Record<TargetName, string> = {
  claude: "claude-settings.json",
  codex: "codex-config.toml",
  antigravity: "antigravity-mcp.json",
};

function localBasePath(storeDir: string, target: TargetName): string {
  return join(storeDir, ".local", "preserved", LOCAL_BASE_FILE[target]);
}

export async function clearPreservedLocalBase(
  storeDir: string,
  target: TargetName,
): Promise<void> {
  const path = localBasePath(storeDir, target);
  await assertSafeStorePath(storeDir, path);
  await rm(path, { force: true });
}

/** The takeover base's content, or null when this target has none. */
export async function readPreservedLocalBase(
  storeDir: string,
  target: TargetName,
): Promise<string | null> {
  const path = localBasePath(storeDir, target);
  await assertSafeStorePath(storeDir, path);
  return readTextIfExists(path);
}

/** Put back what readPreservedLocalBase returned; null leaves no base. */
export async function restorePreservedLocalBase(
  storeDir: string,
  target: TargetName,
  content: string | null,
): Promise<void> {
  if (content === null) return;
  await writeTextAtomicInside(storeDir, localBasePath(storeDir, target), content);
}
