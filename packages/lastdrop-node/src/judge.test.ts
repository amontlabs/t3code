// Ported from headroom Tests/LastDropTests/PermissionRulesTests.swift (loading) and CommandJudgeTests.swift
// (running `agy`, with fake scripts; see lastdrop-core's PORTING.md).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { verdictSummary } from "@t3tools/lastdrop-core";

import {
  findAgy,
  loadPermissionRules,
  makeJudgeLimit,
  readCatalogJudge,
  runCommandJudge,
} from "./judge.ts";

const folders: Array<string> = [];
const temp = (prefix: string) => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

const write = (path: string, object: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, JSON.stringify(object));
};

describe("PermissionRules loading", () => {
  it("loads user and project settings", () => {
    const home = temp("lastdrop-rules-");
    const project = NodePath.join(home, "repo/sub");
    NodeFS.mkdirSync(NodePath.join(home, "repo/.git"), { recursive: true });
    write(NodePath.join(home, ".claude/settings.json"), {
      permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm *)"] },
    });
    write(NodePath.join(project, ".claude/settings.json"), {
      permissions: { allow: ["Bash(npm test *)"] },
    });
    write(NodePath.join(home, "repo/.claude/settings.local.json"), {
      permissions: { ask: ["Bash(git push *)"], allow: ["Read(x)"] },
    });
    const managed = NodePath.join(home, "managed.json");
    const rules = loadPermissionRules({ cwd: project, env: {}, home, managed });
    expect(rules.allow).toEqual(["git status", "npm test *"]);
    expect(rules.deny).toEqual(["rm *"]);
    expect(rules.ask).toEqual(["git push *"]);
    // An agent's worktree also reads the main checkout's untracked local settings.
    const worktree = NodePath.join(home, "repo/.claude/worktrees/agent-x");
    NodeFS.mkdirSync(worktree, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(worktree, ".git"),
      `gitdir: ${home}/repo/.git/worktrees/agent-x\n`,
    );
    expect(loadPermissionRules({ cwd: worktree, env: {}, home, managed }).ask).toEqual([
      "git push *",
    ]);
    // CLAUDE_CONFIG_DIR replaces ~/.claude for user settings.
    const other = loadPermissionRules({
      cwd: "/nonexistent",
      env: { CLAUDE_CONFIG_DIR: NodePath.join(home, "repo/.claude") },
      home,
      managed,
    });
    expect(other.allow).toEqual([]);
    // Managed settings count (added: Swift reads the fixed path only).
    write(managed, { permissions: { deny: ["Bash(curl *)"] } });
    expect(loadPermissionRules({ cwd: "/nonexistent", env: {}, home, managed }).deny).toEqual([
      "rm *",
      "curl *",
    ]);
  });
});

const script = (folder: string, body: string) => {
  const path = NodePath.join(folder, `agy-${Math.random().toString(36).slice(2)}`);
  NodeFS.writeFileSync(path, `#!/bin/zsh\n${body}`, { mode: 0o700 });
  return path;
};

const ALLOW = `{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"ok"}`;

describe("CommandJudge running agy", () => {
  it("denies when the judge fails or hangs", async () => {
    const folder = temp("lastdrop-judge-test-");
    const args = NodePath.join(folder, "args");
    const good = script(folder, `printf '%s\\n' "$@" > ${args}; pwd >> ${args}; print '${ALLOW}'`);
    const verdict = await runCommandJudge("PROMPT", { executable: good });
    expect(verdict.allow).toBe(true);
    const lines = NodeFS.readFileSync(args, "utf8")
      .split("\n")
      .filter((entry) => entry !== "");
    expect(lines.slice(0, 11)).toEqual([
      "-p",
      "PROMPT",
      "--mode",
      "plan",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "low",
      "--disable-slash-commands",
      "--print-timeout",
      "120s",
    ]);
    expect(lines[11], "runs from an empty folder of its own").toContain("lastdrop-judge-");
    const failing = script(folder, "print -u2 'authentication required'; exit 3");
    const failed = await runCommandJudge("PROMPT", { executable: failing });
    expect(failed.allow).toBe(false);
    expect(verdictSummary(failed)).toBe(
      "judge failed: agy exited with status 3 (authentication required)",
    );
    const missing = await runCommandJudge("PROMPT", { executable: NodePath.join(folder, "none") });
    expect(missing).toEqual({ allow: false, failure: "could not start agy" });
    // A judge that hangs is killed and refuses (added: Swift's 150 s kill is not run in its tests).
    // A judge that hangs past the kill time is refused as timed out.
    const hung = await runCommandJudge("PROMPT", {
      executable: script(folder, "sleep 30"),
      killAfterSeconds: 0.3,
    });
    expect(hung).toEqual({ allow: false, failure: "timed out" });
    // Its child keeps the pipes open after agy itself is gone: the whole group is killed, and the
    // verdict comes at once (review item 4). Here the session closes.
    const pidFile = NodePath.join(folder, "child.pid");
    const controller = new AbortController();
    const pending = runCommandJudge("PROMPT", {
      executable: script(folder, `sleep 30 & print $! > ${pidFile}; wait`),
      signal: controller.signal,
    });
    await expect
      .poll(() => NodeFS.existsSync(pidFile) && NodeFS.readFileSync(pidFile, "utf8").trim() !== "")
      .toBe(true);
    const child = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
    controller.abort();
    expect(await pending).toEqual({ allow: false, failure: "the session closed" });
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { message: "the judge's own child is killed too" }).toBe(false);
    // Aborted before it started: refused without running.
    const early = new AbortController();
    early.abort();
    expect(
      await runCommandJudge("PROMPT", {
        executable: script(folder, "sleep 30"),
        signal: early.signal,
      }),
    ).toEqual({
      allow: false,
      failure: "the session closed",
    });
    expect(await runCommandJudge("PROMPT", { executable: undefined })).toEqual({
      allow: false,
      failure: "Antigravity (`agy`) was not found on this Mac",
    });
  });

  it("runs the configured model and effort, and names a model agy won't run", async () => {
    const folder = temp("lastdrop-judge-setting-");
    const args = NodePath.join(folder, "args");
    const path = script(folder, `printf '%s\\n' "$@" > ${args}; print '${ALLOW}'`);
    await runCommandJudge("P", {
      executable: path,
      judge: { model: "gemini-4-argon", effort: "high" },
    });
    let lines = NodeFS.readFileSync(args, "utf8").split("\n");
    expect(lines.slice(4, 8)).toEqual(["--model", "gemini-4-argon", "--effort", "high"]);
    await runCommandJudge("P", { executable: path, judge: { model: "gemini-4-argon" } });
    lines = NodeFS.readFileSync(args, "utf8").split("\n");
    expect(lines.slice(4, 7), "no effort, no --effort").toEqual([
      "--model",
      "gemini-4-argon",
      "--disable-slash-commands",
    ]);
    const unknown = script(folder, "print -u2 'Unknown model ID: nope'; exit 1");
    const missing = await runCommandJudge("P", {
      executable: unknown,
      judge: { model: "nope", effort: "low" },
    });
    expect(missing.allow).toBe(false);
    expect(missing.failure).toMatch(/^the command judge nope · low is not available/);
  });

  it("finds agy and reads the catalog's judge (added)", () => {
    const home = temp("lastdrop-agy-");
    expect(findAgy({ PATH: "" }, home)).toBe(
      NodeFS.existsSync("/opt/homebrew/bin/agy") ? "/opt/homebrew/bin/agy" : undefined,
    );
    const bin = NodePath.join(home, ".local/bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bin, "agy"), "#!/bin/sh\n", { mode: 0o700 });
    expect(findAgy({ PATH: "" }, home)).toBe(NodePath.join(bin, "agy"));
    const catalog = NodePath.join(home, "agent-catalog.json");
    expect(readCatalogJudge(catalog)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
    write(catalog, { agents: [], judges: { antigravity: { model: "gemini-4-argon" } } });
    expect(readCatalogJudge(catalog)).toEqual({ model: "gemini-4-argon" });
  });
});

describe("judge limit (review item 6)", () => {
  it("runs at most the limit at once, in order", async () => {
    const limit = makeJudgeLimit(2);
    let running = 0;
    let most = 0;
    const started: Array<number> = [];
    const release = new Map<number, () => void>();
    const tasks = [0, 1, 2, 3].map((n) =>
      limit(async () => {
        running += 1;
        most = Math.max(most, running);
        started.push(n);
        await new Promise<void>((resolve) => release.set(n, resolve));
        running -= 1;
      }),
    );
    await expect.poll(() => started).toEqual([0, 1]);
    release.get(0)!();
    await expect.poll(() => started).toEqual([0, 1, 2]);
    release.get(1)!();
    await expect.poll(() => started).toEqual([0, 1, 2, 3]);
    release.get(2)!();
    release.get(3)!();
    await Promise.all(tasks);
    expect(most).toBe(2);
  });
});
