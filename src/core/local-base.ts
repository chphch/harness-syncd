import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TargetName } from "../types.js";
import { assertSafeStorePath } from "./fs.js";

const LOCAL_BASE_FILE: Record<TargetName, string> = {
  claude: "claude-settings.json",
  codex: "codex-config.toml",
  antigravity: "antigravity-mcp.json",
};

export async function clearPreservedLocalBase(
  storeDir: string,
  target: TargetName,
): Promise<void> {
  const path = join(storeDir, ".local", "preserved", LOCAL_BASE_FILE[target]);
  await assertSafeStorePath(storeDir, path);
  await rm(path, { force: true });
}
