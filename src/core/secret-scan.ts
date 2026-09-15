import { GENERATED_DIRECTORY_NAMES } from "./fs.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  /** Hash of the offending line, present only on line-level findings. It is
   * what an allowlist entry pins to, so an approval stops applying the moment
   * the line's bytes change. File-level findings carry none and therefore
   * cannot be pre-approved at all. */
  lineHash?: string;
}

/** The one normalisation for a scanned line. A single trailing CR is dropped so
 * the same content hashes alike in LF and CRLF files; nothing else is trimmed,
 * because two different secrets must never collapse onto one hash. */
export function hashScannedLine(line: string): string {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

const EXCLUDED_DIRECTORIES = new Set([
  ".local",
  "backups",
  "conflicts",
]);
// Machine-generated at any depth, and derived from sources that are scanned
// anyway. Unlike a NUL-byte heuristic this cannot hide an authored file.
const EXCLUDED_DIRECTORIES_AT_ANY_DEPTH = new Set<string>([
  ".git",
  ...GENERATED_DIRECTORY_NAMES,
]);
const EXCLUDED_FILES = new Set([
  ".lock",
  ".managed.json",
  ".state.json",
]);
/** Exported so a gate that screens one candidate before it enters the store
 * uses the same number the store-wide scan refuses on, rather than a second
 * copy of it that can drift. */
export const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
const MIN_LITERAL_SECRET_LENGTH = 12;
const SECRET_FIELD_NAME =
  "(?:api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password|passwd|authorization|credential|private[_-]?key|cookie|session[_-]?key)";
// Any non-alphanumeric prefix, so that a field name embedded in a compound key
// (db_password, config.password, openai_api_key) is still recognised.
const SECRET_FIELD_ASSIGNMENT = new RegExp(
  `(?:^|[^A-Za-z\\d])(?:(["'])${SECRET_FIELD_NAME}\\1|${SECRET_FIELD_NAME})\\s*[=:]\\s*`,
  "giu",
);

// A plist spreads one assignment across two lines, so no single-line rule above
// can see it. Bare `key` is deliberately NOT part of SECRET_FIELD_NAME, which is
// what keeps this from matching every `<key>` tag in the file.
const PLIST_SECRET_KEY = new RegExp(
  `^\\s*<key>\\s*[A-Za-z\\d_.\\- ]*?${SECRET_FIELD_NAME}[A-Za-z\\d_.\\- ]*\\s*</key>\\s*$`,
  "iu",
);
const PLIST_STRING_VALUE = /^\s*<string>\s*([^<]*?)\s*<\/string>\s*$/u;

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
      const bytes = await handle.readFile();
      if (bytes.includes(0)) {
        findings.push({ path: file, line: 0, rule: "binary-file-not-scanned" });
        continue;
      }
      input = bytes.toString("utf8");
    } catch {
      findings.push({ path: file, line: 0, rule: "unreadable-text-file" });
      continue;
    } finally {
      await handle?.close();
    }
    findings.push(...scanTextForSecrets(file, input));
  }
  return findings.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule),
  );
}

/**
 * The per-file half of the scan. Exported so anything that screens a single
 * candidate before it enters the store runs the SAME code the store-wide scan
 * runs — two implementations would drift, and the one that drifts silently is
 * always the gate.
 */
export function scanTextForSecrets(path: string, input: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = input.split("\n");
  for (const [index, line] of lines.entries()) {
    // Hashed from the bytes this scan already read: re-reading the file at
    // gate time would open a window where the scan saw a credential and the
    // hash saw a placeholder.
    const lineHash = hashScannedLine(line);
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ path, line: index + 1, rule: rule.name, lineHash });
      }
    }
    if (hasLiteralSecretField(line)) {
      findings.push({ path, line: index + 1, rule: "literal-secret-field", lineHash });
    }
  }
  findings.push(...scanPlistSecretFields(path, lines));
  return findings;
}

/**
 * `<key>API_TOKEN</key>` on one line and `<string>…</string>` on the next is one
 * assignment written across two lines, which every rule above misses by
 * construction. Measured before this rule existed: a plist carrying a real
 * `xoxb-` Slack token produced ZERO findings, while the identical secret
 * written `token: xoxb-…` produced `literal-secret-field`.
 *
 * The finding is reported against the VALUE line so an allowlist approval pins
 * the bytes that carry the secret, not the key that names it — and so the
 * approval lapses the moment the secret is rotated.
 */
function scanPlistSecretFields(path: string, lines: readonly string[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of lines.entries()) {
    if (!PLIST_SECRET_KEY.test(line)) continue;
    const next = lines[index + 1] ?? "";
    const value = PLIST_STRING_VALUE.exec(next)?.[1];
    if (value === undefined) continue;
    // A path is not a credential, and an EnvironmentVariables dict is mostly
    // paths. Measured against this box's 50 real plists, admitting them is the
    // difference between zero false positives and a rule nobody can ship.
    if (value.startsWith("/") || value.startsWith("~/")) continue;
    if (!hasLiteralSecretValue(value)) continue;
    findings.push({
      path,
      line: index + 2,
      rule: "plist-secret-field",
      lineHash: hashScannedLine(next),
    });
  }
  return findings;
}

function hasLiteralSecretField(line: string): boolean {
  for (const match of line.matchAll(SECRET_FIELD_ASSIGNMENT)) {
    const remainder = line.slice((match.index ?? 0) + match[0].length);
    if (hasLiteralSecretValue(remainder)) return true;
  }
  return false;
}

function hasLiteralSecretValue(input: string): boolean {
  const quote = input[0];
  if (quote === '"' || quote === "'") {
    const value = readQuotedValue(input, quote);
    return value !== null &&
      value.length >= MIN_LITERAL_SECRET_LENGTH &&
      !containsDynamicReference(value);
  }

  const candidate = /^[^\s"',}\];|&]+/u.exec(input)?.[0];
  if (candidate === undefined || candidate.length < MIN_LITERAL_SECRET_LENGTH) {
    return false;
  }
  if (containsDynamicReference(candidate) || /[()[\]{}<>`]/u.test(candidate)) {
    return false;
  }
  // Digit-free only: a bare identifier reads as code, but letters interleaved
  // with digits (abc123def456ghi789) is a credible secret rather than a name.
  if (/^[A-Za-z_$][A-Za-z_$]*$/u.test(candidate)) return false;
  if (/^[A-Za-z_$][A-Za-z\d_$]*(?:\??\.[A-Za-z_$][A-Za-z\d_$]*)+$/u.test(candidate)) {
    return false;
  }
  return true;
}

function readQuotedValue(input: string, quote: '"' | "'"): string | null {
  let escaped = false;
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return input.slice(1, index);
    }
  }
  return null;
}

function containsDynamicReference(value: string): boolean {
  // `${` and `$(` match unterminated too: a quoted value is cut at the next
  // quote, so an interpolation or command substitution that spans quotes
  // (TOKEN="$(curl -X POST "$HOST/login") reaches this function without its
  // closing bracket and would otherwise read as a literal.
  return /\$\{|\$\(|\$env:[A-Za-z_][A-Za-z\d_]*|\$[A-Za-z_][A-Za-z\d_]*|%[A-Za-z_][A-Za-z\d_]*%|\{\{[^}]+\}\}|<%[^%]+%>/iu
    .test(value);
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
      const excluded = EXCLUDED_DIRECTORIES_AT_ANY_DEPTH.has(entry.name.toLowerCase()) ||
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
