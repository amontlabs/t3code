// The fork's own Claude accounts: editing the list, the sign-in folders and keychain items removal touches,
// the one-time import of the app's names and order, and signing in through a fake `claude auth login`. All in
// a temporary home.
import * as NodeFS from "node:fs";

import {
  append,
  emptyConfig,
  encodeAccountsConfig,
  keychainService,
  pool,
} from "@t3tools/lastdrop-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AccountChangeError, ClaudeAccounts } from "./claudeAccounts.ts";
import { loadAccounts } from "./claudeSignIn.ts";
import { AccountsMonitor } from "./monitor.ts";
import { accountsFile, claudeFolder } from "./paths.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

let t: TestHome;
let accounts: ClaudeAccounts;
beforeEach(() => {
  t = makeTestHome();
  const monitor = new AccountsMonitor({
    paths: t.paths,
    env: {},
    fetch: () => Promise.reject(new Error("no network")),
    sessionId: "s",
    renew: async () => false,
  });
  accounts = new ClaudeAccounts({ paths: t.paths, monitor, env: { PATH: "/usr/bin:/bin" } });
});
afterEach(() => {
  accounts.logins.cancelAll();
  t.remove();
});

const keys = async () => pool(await loadAccounts(t.paths, 0), "claude").map((a) => a.key);
const appFile = () => `${t.paths.home}/Library/Application Support/lastdrop/accounts.json`;
/** The list an older fork kept: its Main stood for Claude Code's own login. */
const olderList = () =>
  t.write(
    accountsFile(t.paths),
    encodeAccountsConfig(append(emptyConfig(), { provider: "claude", key: "main", addedAt: 0 })),
  );

describe("the fork's Claude accounts", () => {
  it("adds, renames, reorders and removes, deleting only the removed account's own sign-in", async () => {
    olderList();
    const { view } = await accounts.change({ action: "add", name: "My Work" });
    expect(view.accounts.map((a) => [a.key, a.name])).toEqual([
      ["main", undefined],
      ["My-Work", "My Work"],
    ]);
    const folder = claudeFolder(t.paths, "My-Work")!;
    expect(folder).toBe(`${t.paths.dataDir}/accounts/My-Work`);
    expect(NodeFS.statSync(folder).isDirectory()).toBe(true);
    await expect(accounts.change({ action: "add", name: "my work" })).rejects.toBeInstanceOf(
      AccountChangeError,
    );

    await accounts.change({ action: "add", name: "Pro" });
    await accounts.change({ action: "move", key: "Pro", by: -1 });
    await accounts.change({ action: "move", key: "Pro", by: -1 });
    expect(await keys()).toEqual(["Pro", "main", "My-Work"]);
    await accounts.change({ action: "rename", key: "Pro", name: "Personal" });
    expect(pool(await loadAccounts(t.paths, 0), "claude")[0]?.name).toBe("Personal");

    t.setKeychain(keychainService(folder), "work sign-in");
    t.setKeychain(keychainService(claudeFolder(t.paths, "Pro")), "pro sign-in");
    t.setKeychain("Claude Code-credentials", "Claude Code's own sign-in");
    await accounts.change({ action: "remove", key: "My-Work" });
    expect(await keys()).toEqual(["Pro", "main"]);
    expect(NodeFS.existsSync(folder)).toBe(false);
    expect(t.hasKeychain(keychainService(folder))).toBe(false);
    expect(t.hasKeychain(keychainService(claudeFolder(t.paths, "Pro")))).toBe(true);
    expect(t.hasKeychain("Claude Code-credentials")).toBe(true);
    // Main is an account like the others: removing it deletes its own folder and item, never Claude Code's.
    const main = claudeFolder(t.paths, "main")!;
    t.setKeychain(keychainService(main), "main sign-in");
    await accounts.change({ action: "remove", key: "main" });
    expect(await keys()).toEqual(["Pro"]);
    expect(t.hasKeychain(keychainService(main))).toBe(false);
    expect(t.hasKeychain("Claude Code-credentials")).toBe(true);
  });

  it("imports the app's names and order once, never writing to the app's folder", async () => {
    const base = emptyConfig();
    const app = encodeAccountsConfig({
      ...base,
      accounts: [
        { provider: "claude", key: "Pro", name: "Personal", addedAt: 0 },
        { provider: "claude", key: "main", addedAt: 0 },
        { provider: "claude", key: "Team", addedAt: 0 },
        ...base.accounts,
      ],
    });
    t.write(appFile(), app);
    olderList();
    expect((await accounts.view()).importable).toBe(2);

    const { view } = await accounts.change({ action: "import" });
    expect(view.accounts.map((a) => [a.key, a.name, a.signIn])).toEqual([
      ["Pro", "Personal", "signedOut"],
      ["main", undefined, "signedOut"],
      ["Team", undefined, "signedOut"],
    ]);
    expect(view.importable).toBeUndefined();
    expect(NodeFS.statSync(claudeFolder(t.paths, "Team")!).isDirectory()).toBe(true);
    expect(NodeFS.readFileSync(appFile(), "utf8")).toBe(app);
    expect(NodeFS.readdirSync(`${t.paths.home}/Library/Application Support/lastdrop`)).toEqual([
      "accounts.json",
    ]);
    await expect(accounts.change({ action: "import" })).rejects.toThrow("added here already");
  });

  it("signs an account in with the code its sign-in page shows", async () => {
    // Claude Code's `auth login` without a terminal: prints the page's URL, then reads the code.
    t.write(
      `${t.paths.home}/.local/bin/claude`,
      `#!/bin/sh
[ "$1 $2" = "auth login" ] || exit 2
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s"
printf "Paste code here if prompted > "
read code
if [ "$code" = "good" ]; then
  printf '{"oauthAccount":{"accountUuid":"u-1","emailAddress":"pro@example.com"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
  exit 0
fi
echo "OAuth error: Invalid code"
exit 1
`,
    );
    NodeFS.chmodSync(`${t.paths.home}/.local/bin/claude`, 0o755);
    olderList();
    await accounts.change({ action: "add", name: "Pro" });
    // An older list's Main signs in in its own folder like any account.
    expect((await accounts.change({ action: "signIn", key: "main" })).signInUrl).toContain(
      "https://claude.com/",
    );
    await accounts.change({ action: "cancelSignIn", key: "main" });

    const started = await accounts.change({ action: "signIn", key: "Pro" });
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=s";
    expect(started.signInUrl).toBe(url);
    expect(started.view.accounts.find((a) => a.key === "Pro")?.signInUrl).toBe(url);
    await expect(
      accounts.change({ action: "submitCode", key: "Pro", code: "bad" }),
    ).rejects.toThrow("OAuth error: Invalid code");
    expect((await accounts.view()).accounts.find((a) => a.key === "Pro")).toMatchObject({
      signInError: "OAuth error: Invalid code",
    });

    await accounts.change({ action: "signIn", key: "Pro" });
    const { view } = await accounts.change({ action: "submitCode", key: "Pro", code: " good " });
    const pro = view.accounts.find((a) => a.key === "Pro");
    expect(pro?.email).toBe("pro@example.com");
    expect(pro?.signInUrl).toBeUndefined();
    expect(pro?.signInError).toBeUndefined();
    // Claude Code ran in the account's own folder.
    expect(NodeFS.existsSync(`${claudeFolder(t.paths, "Pro")}/.claude.json`)).toBe(true);
    expect(NodeFS.existsSync(accountsFile(t.paths))).toBe(true);
  });
});
