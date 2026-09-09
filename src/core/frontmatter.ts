import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface FrontmatterDocument {
  data: Record<string, unknown>;
  body: string;
}

const DELIMITER = "---";

export function parseFrontmatter(input: string): FrontmatterDocument {
  const normalized = input.replaceAll("\r\n", "\n");
  if (!normalized.startsWith(`${DELIMITER}\n`)) {
    return { data: {}, body: normalized };
  }

  const end = normalized.indexOf(`\n${DELIMITER}\n`, DELIMITER.length + 1);
  if (end < 0) {
    throw new Error("Invalid frontmatter: missing closing --- delimiter");
  }

  const raw = normalized.slice(DELIMITER.length + 1, end);
  const parsed = parseYaml(raw);
  if (!isRecord(parsed)) {
    throw new Error("Invalid frontmatter: YAML metadata must be an object");
  }
  const data = parsed;
  return {
    data,
    body: normalized.slice(end + DELIMITER.length + 2),
  };
}

export function stringifyFrontmatter(
  data: Record<string, unknown>,
  body: string,
): string {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
