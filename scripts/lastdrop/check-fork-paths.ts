/**
 * The fork's guard: every change since the upstream tag lives in a fork-owned path, or in a seam
 * listed in `seams.json` within its line budget. Run on every PR and sync.
 *
 *   node scripts/lastdrop/check-fork-paths.ts [--base <upstream-tag>]
 *
 * Without `--base`, the base is the newest stable upstream tag (vX.Y.Z) reachable from HEAD.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - A small sync CLI; git output and one JSON file.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A small sync CLI; git output and one JSON file.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export interface SeamsConfig {
  readonly allowed: ReadonlyArray<string>;
  readonly exempt: ReadonlyArray<string>;
  readonly seams: Readonly<Record<string, { readonly budget: number; readonly why: string }>>;
}

export interface ChangedFile {
  readonly path: string;
  /** Added + deleted lines; null for binary files. */
  readonly changed: number | null;
}

export type Violation =
  | { readonly _tag: "OutsideAllowedPaths"; readonly path: string }
  | {
      readonly _tag: "OverBudget";
      readonly path: string;
      readonly changed: number | null;
      readonly budget: number;
    };

const globToRegExp = (glob: string): RegExp => {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
};

export function checkForkPaths(
  files: ReadonlyArray<ChangedFile>,
  config: SeamsConfig,
): ReadonlyArray<Violation> {
  const owned = [...config.allowed, ...config.exempt].map(globToRegExp);
  const violations: Array<Violation> = [];
  for (const file of files) {
    if (owned.some((pattern) => pattern.test(file.path))) continue;
    const seam = config.seams[file.path];
    if (seam === undefined) {
      violations.push({ _tag: "OutsideAllowedPaths", path: file.path });
    } else if (file.changed === null || file.changed > seam.budget) {
      violations.push({
        _tag: "OverBudget",
        path: file.path,
        changed: file.changed,
        budget: seam.budget,
      });
    }
  }
  return violations;
}

/** Parses `git diff --numstat -z --no-renames`. */
export function parseNumstat(output: string): ReadonlyArray<ChangedFile> {
  return output
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const [added, deleted, path] = record.split("\t") as [string, string, string];
      const changed = added === "-" || deleted === "-" ? null : Number(added) + Number(deleted);
      return { path, changed };
    });
}

export function describeViolation(violation: Violation): string {
  return violation._tag === "OutsideAllowedPaths"
    ? `${violation.path}: a T3 file that is not a seam. Move the change into a fork folder, or add the seam to scripts/lastdrop/seams.json and FORK.md.`
    : `${violation.path}: ${violation.changed ?? "binary"} changed lines, over its budget of ${violation.budget}.`;
}

const git = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function main(argv: ReadonlyArray<string>): number {
  const baseFlag = argv.indexOf("--base");
  const base =
    baseFlag >= 0
      ? argv[baseFlag + 1]
      : git([
          "describe",
          "--tags",
          "--abbrev=0",
          "--match",
          "v[0-9]*.[0-9]*.[0-9]*",
          "--exclude",
          "*-*",
          "HEAD",
        ]).trim();
  if (!base) {
    process.stderr.write("check-fork-paths: no upstream base tag; pass --base <tag>.\n");
    return 2;
  }
  const config = JSON.parse(
    NodeFS.readFileSync(new URL("./seams.json", import.meta.url), "utf8"),
  ) as SeamsConfig;
  const files = parseNumstat(git(["diff", "--numstat", "-z", "--no-renames", `${base}...HEAD`]));
  const violations = checkForkPaths(files, config);
  for (const violation of violations) process.stderr.write(`${describeViolation(violation)}\n`);
  process.stdout.write(
    `check-fork-paths: ${files.length} files changed since ${base}, ${violations.length} violations.\n`,
  );
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
