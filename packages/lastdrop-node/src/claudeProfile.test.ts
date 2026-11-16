// Ported from headroom Tests/LastDropTests/ClaudeProfileTests.swift, the folder cases (see PORTING.md). Every
// file is in a temporary home.
import * as NodeFS from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { TERMINAL_KEY } from "@t3tools/lastdrop-core";

import { prepareProfile, runEnvironment, withoutCallerIdentity } from "./claudeProfile.ts";
import { ClaudeUsage } from "./claudeUsage.ts";
import { claudeFolder, profileDirectory } from "./paths.ts";
import { StatusStore } from "./statusStore.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

const mainUUID = "614646e1-0000-0000-0000-000000000001";
const otherUUID = "12c3cbaa-0000-0000-0000-000000000002";
const usage = (uuid: string, at = 1) => ({ accountUuid: uuid, fetchedAtMs: at });
const mainConfig = (): Record<string, unknown> => ({
  oauthAccount: { accountUuid: mainUUID },
  cachedUsageUtilization: usage(mainUUID),
  modelAccessCache: ["main"],
  userID: "main-device",
  startupPrefetchedAt: 1,
  mcpServers: { t3: { command: "t3" } },
  projects: { "/repo": { hasTrustDialogAccepted: true } },
  hasCompletedOnboarding: true,
  numStartups: 501,
  someKeyFromTheFuture: "shared",
});
const uuidOf = (c: Record<string, unknown>) =>
  (c["oauthAccount"] as { accountUuid?: string } | undefined)?.accountUuid;

let t: TestHome;
let folder: string;
let shared: string;
let mainFile: string;
let profile: string;

beforeEach(() => {
  t = makeTestHome();
  folder = claudeFolder(t.paths, "claude-2")!;
  shared = t.paths.sharedClaude;
  mainFile = t.paths.sharedConfig;
  profile = profileDirectory(folder);
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.mkdirSync(shared, { recursive: true });
});
afterEach(() => t.remove());

const link = (path: string) => NodeFS.readlinkSync(path);
const has = (path: string) => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

describe("the profile folder", () => {
  it("prepare builds the profile and leaves everything else alone", async () => {
    t.write(mainFile, mainConfig());
    const mainBefore = NodeFS.readFileSync(mainFile);
    const folderConfig = {
      oauthAccount: { accountUuid: otherUUID },
      userID: "other-device",
      projects: {},
    };
    t.write(`${folder}/.claude.json`, folderConfig);
    NodeFS.mkdirSync(`${folder}/projects/old`, { recursive: true }); // from the earlier design
    for (const name of ["projects", "plugins", "backups", "sessions"])
      NodeFS.mkdirSync(`${shared}/${name}`, { recursive: true });
    for (const name of [
      "settings.json",
      "CLAUDE.md",
      "imported.md",
      ".last-cleanup",
      ".claude.json",
      "mcp-needs-auth-cache.json",
      "remote-settings.json",
    ])
      t.write(`${shared}/${name}`, "{}");

    expect(await prepareProfile(t.paths, folder)).toBe(profile);

    // Folders and the user's files are Main's; the config, its backups and Claude Code's own files aren't linked.
    for (const name of [
      "projects",
      "plugins",
      "sessions",
      "settings.json",
      "CLAUDE.md",
      "imported.md",
    ])
      expect(link(`${profile}/${name}`), name).toBe(`${shared}/${name}`);
    for (const name of [
      "backups",
      ".last-cleanup",
      "mcp-needs-auth-cache.json",
      "remote-settings.json",
    ])
      expect(has(`${profile}/${name}`), name).toBe(false);
    expect(NodeFS.lstatSync(`${profile}/.claude.json`).isSymbolicLink()).toBe(false);
    const config = t.read(`${profile}/.claude.json`);
    expect(uuidOf(config)).toBe(otherUUID);
    expect(config["userID"]).toBe("other-device");
    expect(config["cachedUsageUtilization"]).toBeUndefined();
    expect(Object.keys(config["mcpServers"] as object)).toEqual(["t3"]);
    expect((config["projects"] as Record<string, unknown>)["/repo"]).toBeDefined();
    expect(NodeFS.statSync(`${profile}/.claude.json`).mode & 0o777).toBe(0o600);
    expect(has(`${profile}/.claude.json.lock`)).toBe(false);

    // Main's config, the sign-in folder and its old conversations are as they were.
    expect(NodeFS.readFileSync(mainFile)).toEqual(mainBefore);
    expect(t.read(`${folder}/.claude.json`)).toEqual(folderConfig);
    expect(has(`${folder}/projects/old`)).toBe(true);
    expect(NodeFS.readdirSync(`${shared}/projects`)).toEqual([]);
  });

  it("the next start keeps the account's answers and takes Main's changes", async () => {
    t.write(mainFile, mainConfig());
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: otherUUID } });
    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    // A session on the account keeps its answer, and adds a server in its own file.
    let config = t.read(`${profile}/.claude.json`);
    config["cachedUsageUtilization"] = usage(otherUUID, 42);
    config["mcpServers"] = { t3: {}, addedInTheAccount: {} };
    t.write(`${profile}/.claude.json`, config);
    // Meanwhile Main fetched its own usage and the user changed its servers.
    t.write(mainFile, {
      ...mainConfig(),
      cachedUsageUtilization: usage(mainUUID, 77),
      mcpServers: { linear: {} },
    });

    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    config = t.read(`${profile}/.claude.json`);
    expect(config["cachedUsageUtilization"]).toEqual(usage(otherUUID, 42));
    expect(Object.keys(config["mcpServers"] as object)).toEqual(["linear"]);
    expect(
      (t.read(mainFile)["cachedUsageUtilization"] as { accountUuid: string }).accountUuid,
    ).toBe(mainUUID);
  });

  it("nothing in the profile is replaced", async () => {
    t.write(mainFile, mainConfig());
    NodeFS.mkdirSync(`${shared}/projects`, { recursive: true });
    NodeFS.mkdirSync(`${shared}/tasks`, { recursive: true });
    // Claude Code made a folder in the profile before `~/.claude` had one, and a link points elsewhere.
    NodeFS.mkdirSync(`${profile}/tasks`, { recursive: true });
    NodeFS.writeFileSync(`${profile}/tasks/a`, "kept");
    NodeFS.symlinkSync("/nonexistent-elsewhere", `${profile}/projects`);
    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    expect(NodeFS.readFileSync(`${profile}/tasks/a`, "utf8")).toBe("kept");
    expect(link(`${profile}/projects`)).toBe("/nonexistent-elsewhere");
    // What `~/.claude` gains later is linked at the next start.
    NodeFS.mkdirSync(`${shared}/skills`, { recursive: true });
    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    expect(link(`${profile}/skills`)).toBe(`${shared}/skills`);
  });

  it("an unchanged config is not rewritten", async () => {
    t.write(mainFile, mainConfig());
    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    const file = `${profile}/.claude.json`;
    // A session saved it since, in Claude Code's own layout: the same config still.
    t.write(file, t.read(file));
    const old = new Date(1_000_000_000);
    NodeFS.utimesSync(file, old, old);
    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    expect(NodeFS.statSync(file).mtimeMs).toBe(old.getTime());
  });

  it("many runners starting at once leave one whole config", async () => {
    t.write(mainFile, mainConfig());
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: otherUUID } });
    const results = await Promise.all(
      Array.from({ length: 16 }, () => prepareProfile(t.paths, folder)),
    );
    expect(results.every((r) => r === profile)).toBe(true);
    const config = t.read(`${profile}/.claude.json`);
    expect(uuidOf(config)).toBe(otherUUID);
    expect(Object.keys(config["mcpServers"] as object)).toEqual(["t3"]);
    // No lock and no half-written file is left behind.
    expect(NodeFS.readdirSync(profile)).toEqual([".claude.json", "projects"]);
  });

  it("a held lock or an unreadable Main config leaves the profile as it is", async () => {
    // No profile yet and nothing to build it from: the session runs in `~/.claude`.
    expect(await prepareProfile(t.paths, folder)).toBeUndefined();
    t.write(mainFile, "{ half a fi");
    expect(await prepareProfile(t.paths, folder)).toBeUndefined();
    const neverAdded = claudeFolder(t.paths, "never-added")!;
    expect(await prepareProfile(t.paths, neverAdded)).toBeUndefined();
    expect(has(neverAdded)).toBe(false);

    t.write(mainFile, mainConfig());
    expect(await prepareProfile(t.paths, folder)).toBe(profile);
    const file = `${profile}/.claude.json`;
    const before = NodeFS.readFileSync(file);
    // Main's config is being rewritten, or unreadable: the profile from last time still serves.
    t.write(mainFile, "{ half a fi");
    expect(await prepareProfile(t.paths, folder)).toBe(profile);
    expect(NodeFS.readFileSync(file)).toEqual(before);
    // A Claude Code session holds the config lock: its save isn't crossed, and its lock is left alone.
    t.write(mainFile, { ...mainConfig(), numStartups: 502 });
    NodeFS.mkdirSync(`${file}.lock`);
    expect(await prepareProfile(t.paths, folder)).toBe(profile);
    expect(NodeFS.readFileSync(file)).toEqual(before);
    expect(has(`${file}.lock`)).toBe(true);
    NodeFS.rmdirSync(`${file}.lock`);
    expect(await prepareProfile(t.paths, folder)).toBe(profile);
    expect(t.read(file)["numStartups"]).toBe(502);
  });
});

describe("shared conversations in a profile (step 4 live finding)", () => {
  it("a profile made before Main has any conversation still links them", async () => {
    t.write(mainFile, { oauthAccount: { accountUuid: "u-main" } });
    expect(has(`${shared}/projects`)).toBe(false);
    await prepareProfile(t.paths, folder);
    expect(link(`${profile}/projects`)).toBe(`${shared}/projects`);
  });

  it("a profile's own projects folder is folded into the shared one, then linked", async () => {
    t.write(mainFile, { oauthAccount: { accountUuid: "u-main" } });
    t.write(`${profile}/projects/p/kept-to-itself.jsonl`, '{"type":"user"}\n');
    t.write(`${shared}/projects/p/twin.jsonl`, "shared copy\n");
    t.write(`${profile}/projects/p/twin.jsonl`, "own copy\n");
    await prepareProfile(t.paths, folder);
    expect(link(`${profile}/projects`)).toBe(`${shared}/projects`);
    expect(NodeFS.readFileSync(`${shared}/projects/p/kept-to-itself.jsonl`, "utf8")).toContain(
      "user",
    );
    // The twin already in the shared folder wins; the profile's copy is kept aside, never deleted.
    expect(NodeFS.readFileSync(`${shared}/projects/p/twin.jsonl`, "utf8")).toBe("shared copy\n");
    const aside = NodeFS.readdirSync(profile).find((n) => n.startsWith("projects.before-sharing-"));
    expect(aside).toBeDefined();
    expect(NodeFS.readFileSync(`${profile}/${aside}/p/twin.jsonl`, "utf8")).toBe("own copy\n");
  });
});

describe("where the profile is used", () => {
  it("the run environment runs an account in its profile", async () => {
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: otherUUID } });
    const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/elsewhere", CLAUDE_CODE_ACCOUNT_UUID: "u1" };
    // Without Main's config there's no profile: the account's sign-in in `~/.claude`, as before.
    expect((await runEnvironment(t.paths, "claude-2", base))["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    t.write(mainFile, mainConfig());
    const env = await runEnvironment(t.paths, "claude-2", base);
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(profile);
    expect(env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(folder);
    expect(uuidOf(t.read(`${profile}/.claude.json`))).toBe(otherUUID);
    // The runner drops the caller's identity and keeps the account's profile.
    const runner = await runEnvironment(t.paths, "claude-2", withoutCallerIdentity(base));
    expect(runner["CLAUDE_CONFIG_DIR"]).toBe(env["CLAUDE_CONFIG_DIR"]);
    expect(runner["CLAUDE_CODE_ACCOUNT_UUID"]).toBeUndefined();
    // Main signs in through its own folder, like any account; only Claude Code's own login runs as it is.
    const main = await runEnvironment(t.paths, "main", base);
    expect(main["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(claudeFolder(t.paths, "main"));
    const terminal = await runEnvironment(t.paths, TERMINAL_KEY, base);
    expect(terminal["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(terminal["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBeUndefined();
  });

  it("the usage cache is read from the profile", async () => {
    t.write(mainFile, mainConfig());
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: otherUUID } });
    expect(await prepareProfile(t.paths, folder)).toBeDefined();
    const provider = new ClaudeUsage({
      paths: t.paths,
      statuses: new StatusStore(`${t.paths.dataDir}/usage.json`),
      fetch: () => Promise.reject(new Error("no network in tests")),
      version: async () => "2.1.321",
      sessionId: "s",
      now: () => 1_800_000_000_000,
    });
    expect(provider.cacheFiles("claude-2")).toEqual([
      mainFile,
      `${profile}/.claude.json`,
      `${folder}/.claude.json`,
    ]);
    expect(await provider.cachedUsage("claude-2")).toBeUndefined();
    const config = t.read(`${profile}/.claude.json`);
    config["cachedUsageUtilization"] = {
      accountUuid: otherUUID,
      fetchedAtMs: 1_800_000_000_000 - 60_000,
      utilization: { five_hour: { utilization: 26, resets_at: "2099-01-01T00:00:00+00:00" } },
    };
    t.write(`${profile}/.claude.json`, config);
    expect(await provider.cachedUsage("claude-2")).toBeDefined();
  });
});
