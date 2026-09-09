import type { TargetName } from "../types.js";
import type { HarnessAdapter } from "./adapter.js";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

const adapters: Record<TargetName, HarnessAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  antigravity: new AntigravityAdapter(),
};

export function getAdapter(target: TargetName): HarnessAdapter {
  return adapters[target];
}

export function allAdapters(): HarnessAdapter[] {
  return Object.values(adapters);
}
