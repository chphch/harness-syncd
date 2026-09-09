import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".local",
  "backups",
  "conflicts",
]);
const EXCLUDED_FILES = new Set([
  ".lock",
  ".managed.json",
  ".state.json",
]);
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  {
    name: "authorization-credential",
    pattern:
      /\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic)\s+(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[A-Za-z0-9+/_=.-]{12,}/iu,
  },
  {
    name: "basic-auth-credential",
    pattern:
      /(?:^|\s)(?:--user(?:=|\s+)|-u\s*)["']?[^:\s"']+:(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[^\s"']{8,}/iu,
  },
  {
    name: "url-userinfo-credential",
    pattern:
      /\b[a-z][a-z\d+.-]*:\/\/(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\}:\$\{(?:env:)?[A-Z_][A-Z0-9_]*\}@)[^/:@\s]+:(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[^/@\s]{8,}@/iu,
  },
  {
    name: "url-query-credential",
    pattern:
      /[?&](?:access_token|api_key|key|password|secret|token)=(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[^&#\s]{8,}/iu,
  },
  {
    name: "command-env-credential",
    pattern:
      /\b[A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|CREDENTIAL)[A-Z0-9_]*=(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[^\s"';|&]{12,}/u,
  },
  {
    name: "command-flag-credential",
    pattern:
      /(?:^|\s)--?(?:api[-_]?key|token|access[-_]?token|password|passwd|secret|authorization|credential|private[-_]?key|cookie|session[-_]?key)(?:=|\s+)["']?(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[^\s"',}\];|&]{12,}/iu,
  },
  {
    name: "literal-secret-field",
    pattern:
      /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password|passwd|authorization|credential|private[_-]?key|cookie|session[_-]?key)["']?\s*[=:]\s*["']?(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\})[^\s"',}\]]{12,}/iu,
  },
];

export async function scanStoreForSecrets(storeDir: string): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  const files = await listScannableEntries(storeDir, "", findings);
  for (const file of files) {
    let input: string;
    const absolute = join(storeDir, file);
    let handle;
    try {
      // O_NOFOLLOW closes the lstat/read race on platforms that support it.
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) {
        findings.push({ path: file, line: 0, rule: "non-regular-file" });
        continue;
      }
      if (info.size > MAX_SCANNED_FILE_BYTES) {
        findings.push({ path: file, line: 0, rule: "oversized-text-file" });
        continue;
      }
      input = await handle.readFile("utf8");
    } catch {
      findings.push({ path: file, line: 0, rule: "unreadable-text-file" });
      continue;
    } finally {
      await handle?.close();
    }
    for (const [index, line] of input.split("\n").entries()) {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ path: file, line: index + 1, rule: rule.name });
        }
      }
    }
  }
  return findings.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule),
  );
}

async function listScannableEntries(
  storeDir: string,
  current: string,
  findings: SecretFinding[],
): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(join(storeDir, current), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = join(current, entry.name);
    if (entry.isDirectory()) {
      const excluded = entry.name.toLowerCase() === ".git" ||
        (current === "" && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()));
      if (!excluded) {
        output.push(
          ...(await listScannableEntries(storeDir, relativePath, findings)),
        );
      }
      continue;
    }
    if (current === "" && EXCLUDED_FILES.has(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      findings.push({ path: relativePath, line: 0, rule: "symbolic-link-not-scanned" });
      continue;
    }
    const info = await lstat(join(storeDir, relativePath));
    if (!info.isFile()) {
      findings.push({ path: relativePath, line: 0, rule: "non-regular-file" });
      continue;
    }
    output.push(relativePath);
  }
  return output.sort();
}
