import { execFileSync } from "node:child_process";

/**
 * Build a chain of directories under `base` whose absolute path ends past this
 * platform's PATH_MAX, so that lstat of the deepest entry fails with
 * ENAMETOOLONG. The limit differs by platform (1,024 bytes on macOS, 4,096 on
 * Linux), so the depth comes from `getconf` rather than a constant: a tree
 * sized for macOS is an ordinary, readable tree on Linux. Relative mkdir and
 * cd work at any depth, which is how the chain gets past the limit at all;
 * the cd must be `cd -P`, since dash (Debian's /bin/sh) otherwise changes
 * into the logical path it builds by joining $PWD and the name, and that
 * chdir fails with ENAMETOOLONG once the path passes the limit.
 */
export function buildTreePastPathMax(base: string, options: { leafFile?: string } = {}): void {
  const reported = execFileSync("getconf", ["PATH_MAX", base], { encoding: "utf8" }).trim();
  const pathMax = Number(reported);
  if (!Number.isInteger(pathMax) || pathMax <= 0) {
    throw new Error(`getconf PATH_MAX ${base} reported no limit: ${reported}`);
  }
  const segment = "d".repeat(200);
  let depth = 0;
  while (base.length + depth * (segment.length + 1) < pathMax + 100) depth += 1;
  const leaf = options.leafFile === undefined ? "" : ' && : > "$4"';
  execFileSync("/bin/sh", [
    "-c",
    `cd -P "$1" && i=0 && while [ "$i" -lt "$2" ]; do mkdir "$3" && cd -P "$3" || exit 1; i=$((i+1)); done${leaf}`,
    "sh",
    base,
    String(depth),
    segment,
    ...(options.leafFile === undefined ? [] : [options.leafFile]),
  ]);
}
