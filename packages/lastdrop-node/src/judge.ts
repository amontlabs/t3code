/**
 * The command judge's I/O (headroom `PermissionRules.load`, `CommandJudge.judge`,
 * `AntigravityBackend.executable`): the user's Claude Code settings files, the standalone catalog's
 * judge setting (read only), and one `agy -p … --mode plan` per check from an empty folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  addPermissions,
  catalogJudge,
  DEFAULT_JUDGE,
  EMPTY_RULES,
  JUDGE_TIMEOUT_SECONDS,
  judgeArguments,
  judgeUnavailable,
  agyModelUnavailable,
  NESTED_MARKER,
  parseVerdict,
  type AgentJudge,
  type PermissionRules,
  type Verdict,
} from "@t3tools/lastdrop-core";

/** The judge's pure half, for the server (which depends on lastdrop-node only). */
export {
  actionLabel,
  checkRules,
  decideAction,
  DEFAULT_JUDGE,
  EMPTY_CONTEXT,
  readOnlyCommands,
  recordCall,
  verdictSummary,
  type AgentJudge,
  type Decision,
  type JudgeAction,
  type JudgeContext,
  type JudgePolicy,
  type PermissionRules,
  type Verdict,
} from "@t3tools/lastdrop-core";

const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

const gitRoot = (directory: string): string | undefined => {
  let current = NodePath.resolve(directory);
  while (current !== "/") {
    if (NodeFS.existsSync(NodePath.join(current, ".git"))) return current;
    current = NodePath.dirname(current);
  }
  return undefined;
};

/** The main checkout of a linked worktree, from its `.git` file ("gitdir: <main>/.git/worktrees/<name>"). */
const mainCheckout = (directory: string): string | undefined => {
  const root = gitRoot(directory);
  if (root === undefined) return undefined;
  let text: string;
  try {
    text = NodeFS.readFileSync(NodePath.join(root, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const line = text.split("\n").find((entry) => entry.startsWith("gitdir: "));
  const gitdir = line?.slice(8);
  const at = gitdir?.indexOf("/.git/worktrees/") ?? -1;
  return gitdir === undefined || at < 0 ? undefined : gitdir.slice(0, at);
};

/** The settings files whose `Bash(...)` rules apply in `cwd`, in order. */
export const permissionSettingsFiles = (input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly managed?: string;
}): Array<string> => {
  const env = input.env ?? process.env;
  const home = input.home ?? NodeOS.homedir();
  const config =
    env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
      ? env.CLAUDE_CONFIG_DIR
      : `${home}/.claude`;
  const files = [`${config}/settings.json`, input.managed ?? MANAGED_SETTINGS];
  const roots = [input.cwd];
  const root = gitRoot(input.cwd);
  if (root !== undefined && root !== input.cwd) roots.push(root);
  // In a linked worktree, the main checkout's untracked settings.local.json applies too.
  const main = mainCheckout(input.cwd);
  if (main !== undefined && !roots.includes(main)) roots.push(main);
  for (const each of roots)
    files.push(`${each}/.claude/settings.json`, `${each}/.claude/settings.local.json`);
  return files;
};

/**
 * User settings (`$CLAUDE_CONFIG_DIR` or `~/.claude`), managed settings, and the project's
 * `.claude/settings.json` and `.claude/settings.local.json` in `cwd`, its git root and, from a
 * worktree, the main checkout. A file that is missing or doesn't parse adds nothing.
 */
export const loadPermissionRules = (
  input: Parameters<typeof permissionSettingsFiles>[0],
): PermissionRules => {
  let rules = EMPTY_RULES;
  for (const file of permissionSettingsFiles(input)) {
    try {
      const root: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      if (typeof root !== "object" || root === null || Array.isArray(root)) continue;
      rules = addPermissions(rules, (root as Record<string, unknown>).permissions ?? {});
    } catch {
      continue;
    }
  }
  return rules;
};

/** The Antigravity judge the user chose in the standalone app (`agent-catalog.json` `judges`), read only. */
export const readCatalogJudge = (catalogFile: string): AgentJudge => {
  try {
    return catalogJudge(JSON.parse(NodeFS.readFileSync(catalogFile, "utf8")));
  } catch {
    return DEFAULT_JUDGE;
  }
};

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `agy`: `~/.local/bin`, then `PATH`, then Homebrew. */
export const findAgy = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = NodeOS.homedir(),
): string | undefined =>
  [
    `${home}/.local/bin/agy`,
    ...(env.PATH ?? "")
      .split(":")
      .filter((entry) => entry !== "")
      .map((entry) => `${entry}/agy`),
    "/opt/homebrew/bin/agy",
  ].find(isExecutable);

const oneLine = (text: string): string =>
  Array.from(text.trim()).slice(-200).join("").replaceAll("\n", " ");

/**
 * Runs the judge with `judge`'s model and effort. Every failure is a deny with its reason; a model
 * `agy` won't run is named as such, never swapped for another. Never throws.
 */
export const runCommandJudge = async (
  prompt: string,
  options: {
    readonly executable: string | undefined;
    readonly judge?: AgentJudge;
    readonly env?: NodeJS.ProcessEnv;
    /** Seconds before the process is killed; `JUDGE_TIMEOUT_SECONDS` + 30 by default. */
    readonly killAfterSeconds?: number;
  },
): Promise<Verdict> => {
  const judge = options.judge ?? DEFAULT_JUDGE;
  if (options.executable === undefined)
    return { allow: false, failure: "Antigravity (`agy`) was not found on this Mac" };
  let empty: string;
  try {
    empty = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lastdrop-judge-"));
  } catch {
    return { allow: false, failure: "could not make its empty folder" };
  }
  try {
    const result = await new Promise<
      | { readonly started: false }
      | {
          readonly started: true;
          readonly stdout: string;
          readonly stderr: string;
          readonly code: number | null;
          readonly killed: boolean;
        }
    >((resolve) => {
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(options.executable!, judgeArguments(prompt, judge), {
          cwd: empty,
          env: { ...(options.env ?? process.env), [NESTED_MARKER]: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve({ started: false });
        return;
      }
      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const killer = setTimeout(
        () => {
          killed = true;
          child.kill("SIGKILL");
        },
        (options.killAfterSeconds ?? JUDGE_TIMEOUT_SECONDS + 30) * 1000,
      );
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        resolve({ started: false });
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        resolve({ started: true, stdout, stderr, code, killed: killed || signal !== null });
      });
    });
    if (!result.started) return { allow: false, failure: "could not start agy" };
    const verdict = parseVerdict(result.stdout);
    if (verdict.failure === undefined) return verdict;
    if (result.killed) return { allow: false, failure: "timed out" };
    if (result.code !== 0) {
      const detail = oneLine(result.stderr.trim() === "" ? result.stdout : result.stderr);
      if (agyModelUnavailable(detail))
        return { allow: false, failure: `${judgeUnavailable(judge)} (${detail})` };
      return {
        allow: false,
        failure: `agy exited with status ${result.code}${detail === "" ? "" : ` (${detail})`}`,
      };
    }
    return verdict;
  } finally {
    await NodeFSP.rm(empty, { recursive: true, force: true }).catch(() => {});
  }
};
