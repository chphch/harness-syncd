import type { AdapterWarning } from "../types.js";

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key|authorization|cookie|session[_-]?key)/i;
const ENV_REFERENCE = /^\$\{(?:env:)?[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}$/;
const AUTH_ENV_REFERENCE = /^(?:Bearer|Basic)\s+\$\{(?:env:)?[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}$/i;

export function environmentReference(value: string): string | null {
  const match = /^\$\{env:([A-Z_][A-Z0-9_]*)\}$/.exec(value);
  return match?.[1] ?? null;
}

export function containsEnvironmentReference(value: unknown): boolean {
  if (typeof value === "string") {
    return /\$\{env:[A-Z_][A-Z0-9_]*\}/u.test(value);
  }
  if (Array.isArray(value)) return value.some(containsEnvironmentReference);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsEnvironmentReference);
}

export interface RedactionResult<T> {
  value: T;
  warnings: AdapterWarning[];
}

export interface ReferenceScrubResult<T> {
  value: T;
  removed: number;
}

export function redactSecrets<T>(value: T, prefix = "config"): RedactionResult<T> {
  const warnings: AdapterWarning[] = [];
  const redacted = visit(value, prefix, warnings) as T;
  return { value: redacted, warnings };
}

function visit(
  value: unknown,
  path: string,
  warnings: AdapterWarning[],
): unknown {
  if (Array.isArray(value)) {
    const output = value.map((entry, index) =>
      visit(entry, `${path}[${index}]`, warnings),
    );
    if (path.endsWith(".args")) redactSensitiveArguments(output, path, warnings);
    return output;
  }
  if (value instanceof Date) return value;
  if (typeof value !== "object" || value === null) {
    if (
      typeof value === "string" &&
      /\.(?:url|serverUrl|httpUrl)$/u.test(path)
    ) {
      return redactUrl(value, path, warnings);
    }
    if (typeof value === "string" && /\.command$/u.test(path)) {
      return redactCommandSecrets(value, path, warnings);
    }
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      key === "bearer_token_env_var" &&
      typeof entry === "string"
    ) {
      // Codex documents this field as the *name* of an environment variable,
      // not as the token itself. Preserve it for schema validation/adaptation.
      output[key] = entry;
    } else if (
      SECRET_KEY.test(key) &&
      typeof entry === "string" &&
      entry.length > 0 &&
      !ENV_REFERENCE.test(entry) &&
      !AUTH_ENV_REFERENCE.test(entry)
    ) {
      const envName = key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      output[key] = `\${env:${envName}}`;
      warnings.push({
        code: "secret-redacted",
        message: `redacted a likely secret at ${childPath}; provide it through ${envName}`,
        path: childPath,
        fidelity: "compatible",
      });
    } else {
      output[key] = visit(entry, childPath, warnings);
    }
  }
  return output;
}

function redactCommandSecrets(
  value: string,
  path: string,
  warnings: AdapterWarning[],
): string {
  const assignmentsRedacted = value.replace(
    /(?<![?&])\b([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|]+))/gu,
    (match, key: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const literal = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!SECRET_KEY.test(key) || ENV_REFERENCE.test(literal)) return match;
      const envName = key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      warnings.push({
        code: "secret-redacted",
        message: `redacted a likely command credential at ${path}; provide it through ${envName}`,
        path,
        fidelity: "compatible",
      });
      return `${key}=\${env:${envName}}`;
    },
  );
  const flagsRedacted = redactCommandFlagSecrets(
    assignmentsRedacted,
    path,
    warnings,
  );
  return redactUrl(
    redactBasicAuthText(flagsRedacted, path, warnings),
    path,
    warnings,
  );
}

function redactCommandFlagSecrets(
  value: string,
  path: string,
  warnings: AdapterWarning[],
): string {
  const headersRedacted = value.replace(
    /(^|[\s;&|])(--?(?:header|H)(?:=|\s+))(["']?)(Authorization\s*:\s*(?:Bearer|Basic)\s+)([^\s"';&|]+)\3/giu,
    (
      match,
      leading: string,
      flag: string,
      quote: string,
      header: string,
      credential: string,
    ) => {
      if (ENV_REFERENCE.test(credential)) return match;
      warnings.push({
        code: "secret-redacted",
        message: `redacted an authorization header at ${path}; provide it through AUTHORIZATION`,
        path,
        fidelity: "compatible",
      });
      return `${leading}${flag}${quote}${header}\${env:AUTHORIZATION}${quote}`;
    },
  );
  return headersRedacted.replace(
    /(^|[\s;&|])(--?(api[-_]?key|token|access[-_]?token|password|passwd|secret|authorization|credential|private[-_]?key|cookie|session[-_]?key))(\s+)(["']?)([^\s"';&|]+)\5/giu,
    (
      match,
      leading: string,
      flag: string,
      key: string,
      spacing: string,
      quote: string,
      literal: string,
    ) => {
      if (ENV_REFERENCE.test(literal)) return match;
      const envName = key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      warnings.push({
        code: "secret-redacted",
        message: `redacted a likely command credential at ${path}; provide it through ${envName}`,
        path,
        fidelity: "compatible",
      });
      return `${leading}${flag}${spacing}${quote}\${env:${envName}}${quote}`;
    },
  );
}

export function renderClaudeEnvironmentReferences<T>(value: T): T {
  return transformStrings(value, (entry) =>
    entry.replace(/\$\{env:([A-Z_][A-Z0-9_]*)\}/g, "\${$1}"),
  ) as T;
}

export function scrubEnvironmentReferences<T>(value: T): ReferenceScrubResult<T> {
  let removed = 0;
  const omit = Symbol("omit");
  const visitValue = (entry: unknown): unknown | typeof omit => {
    if (typeof entry === "string" && /\$\{env:[A-Z_][A-Z0-9_]*\}/u.test(entry)) {
      removed += 1;
      return omit;
    }
    if (entry instanceof Date) return entry;
    if (Array.isArray(entry)) {
      return entry.flatMap((item) => {
        const next = visitValue(item);
        return next === omit ? [] : [next];
      });
    }
    if (typeof entry !== "object" || entry === null) return entry;
    return Object.fromEntries(
      Object.entries(entry).flatMap(([key, item]) => {
        const next = visitValue(item);
        return next === omit ? [] : [[key, next]];
      }),
    );
  };
  const scrubbed = visitValue(value);
  return { value: (scrubbed === omit ? undefined : scrubbed) as T, removed };
}

function transformStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((entry) => transformStrings(entry, transform));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, transformStrings(entry, transform)]),
  );
}

function redactSensitiveArguments(
  args: unknown[],
  path: string,
  warnings: AdapterWarning[],
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== "string") continue;
    const argumentPath = `${path}[${index}]`;
    const redacted = redactArgumentAssignment(
      redactUrl(
        redactBasicAuthText(argument, argumentPath, warnings),
        argumentPath,
        warnings,
      ),
      argumentPath,
      warnings,
    );
    if (redacted !== argument) args[index] = redacted;
  }
  for (let index = 0; index < args.length - 1; index += 1) {
    const flag = args[index];
    const next = args[index + 1];
    if (
      typeof flag === "string" &&
      /^(?:--user|-u)$/u.test(flag) &&
      typeof next === "string"
    ) {
      const credential = /^([^:\s]+):(.+)$/u.exec(next);
      if (credential && !ENV_REFERENCE.test(credential[2]!)) {
        args[index + 1] = `${credential[1]}:\${env:BASIC_AUTH_PASSWORD}`;
        warnings.push({
          code: "secret-redacted",
          message: `redacted a Basic-auth password at ${path}[${index + 1}]; provide it through BASIC_AUTH_PASSWORD`,
          path: `${path}[${index + 1}]`,
          fidelity: "compatible",
        });
        index += 1;
        continue;
      }
    }
    if (
      typeof flag === "string" &&
      /^--?(?:header|H)$/u.test(flag) &&
      typeof next === "string"
    ) {
      const replaced = next.replace(
        /^(Authorization\s*:\s*(?:Bearer|Basic)\s+)(?!\$\{(?:env:)?[A-Z_][A-Z0-9_]*\}$).+/iu,
        "$1${env:AUTHORIZATION}",
      );
      if (replaced !== next) {
        args[index + 1] = replaced;
        warnings.push({
          code: "secret-redacted",
          message: `redacted an authorization header at ${path}[${index + 1}]; provide it through AUTHORIZATION`,
          path: `${path}[${index + 1}]`,
          fidelity: "compatible",
        });
        index += 1;
        continue;
      }
    }
    if (
      typeof flag !== "string" ||
      !/^--?(?:api[-_]?key|token|access[-_]?token|password|secret|authorization)$/iu.test(flag) ||
      typeof next !== "string" ||
      ENV_REFERENCE.test(next)
    ) {
      continue;
    }
    const envName = flag.replace(/^-+|[^a-zA-Z0-9]/g, "_").toUpperCase();
    args[index + 1] = `\${env:${envName}}`;
    warnings.push({
      code: "secret-redacted",
      message: `redacted a likely secret at ${path}[${index + 1}]; provide it through ${envName}`,
      path: `${path}[${index + 1}]`,
      fidelity: "compatible",
    });
    index += 1;
  }
}

function redactArgumentAssignment(
  value: string,
  path: string,
  warnings: AdapterWarning[],
): string {
  const header = /^(--?(?:header|H)=)(Authorization\s*:\s*(?:Bearer|Basic)\s+)(.+)$/iu.exec(
    value,
  );
  if (header && !ENV_REFERENCE.test(header[3]!)) {
    warnings.push({
      code: "secret-redacted",
      message: `redacted an authorization header at ${path}; provide it through AUTHORIZATION`,
      path,
      fidelity: "compatible",
    });
    return `${header[1]}${header[2]}\${env:AUTHORIZATION}`;
  }

  const assignment = /^(--?)?([A-Za-z_][A-Za-z0-9_-]*)=(.+)$/u.exec(value);
  if (!assignment || !SECRET_KEY.test(assignment[2]!)) return value;
  const literal = assignment[3]!;
  if (ENV_REFERENCE.test(literal)) return value;
  const envName = assignment[2]!
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toUpperCase();
  warnings.push({
    code: "secret-redacted",
    message: `redacted a likely secret at ${path}; provide it through ${envName}`,
    path,
    fidelity: "compatible",
  });
  return `${assignment[1] ?? ""}${assignment[2]}=\${env:${envName}}`;
}

function redactBasicAuthText(
  value: string,
  path: string,
  warnings: AdapterWarning[],
): string {
  return value.replace(
    /(^|\s)((?:--user(?:=|\s+)|-u\s*))(["']?)([^:\s"']+):([^\s"']+)\3/giu,
    (
      match,
      leading: string,
      flag: string,
      quote: string,
      username: string,
      password: string,
    ) => {
      if (ENV_REFERENCE.test(password)) return match;
      warnings.push({
        code: "secret-redacted",
        message: `redacted a Basic-auth password at ${path}; provide it through BASIC_AUTH_PASSWORD`,
        path,
        fidelity: "compatible",
      });
      return `${leading}${flag}${quote}${username}:\${env:BASIC_AUTH_PASSWORD}${quote}`;
    },
  );
}

function redactUrl(
  value: string,
  path: string,
  warnings: AdapterWarning[],
): string {
  let output = value;
  output = output.replace(
    /([a-z][a-z\d+.-]*:\/\/)([^/:@\s]+):([^/@\s]+)@/giu,
    (_match, scheme: string, _user: string, _password: string) => {
      warnings.push({
        code: "secret-redacted",
        message: `redacted URL credentials at ${path}`,
        path,
        fidelity: "compatible",
      });
      return `${scheme}\${env:URL_USERNAME}:\${env:URL_PASSWORD}@`;
    },
  );
  output = output.replace(
    /([?&](?:access_token|api_key|key|password|secret|token)=)([^&#\s]+)/giu,
    (_match, prefix: string, _secret: string) => {
      const key = prefix.slice(1, -1).replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      warnings.push({
        code: "secret-redacted",
        message: `redacted a URL query credential at ${path}; provide it through ${key}`,
        path,
        fidelity: "compatible",
      });
      return `${prefix}\${env:${key}}`;
    },
  );
  return output;
}
