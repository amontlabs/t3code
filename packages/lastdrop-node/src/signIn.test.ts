// The I/O around sign-ins: the fork's account list, the keychain through a fake `security`, the
// keeper's loop, and renewal by starting a fake `claude`. All in a temporary home (see PORTING.md).
import * as NodeFS from "node:fs";

import {
  append,
  emptyConfig,
  encodeAccountsConfig,
  keychainService,
  pool,
} from "@t3tools/lastdrop-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  claudeExecutable,
  installedClaudeCodeVersion,
  loadAccounts,
  readSignInFacts,
  renewSignIn,
  saveAccounts,
  signedInAccountOf,
  storedCredentials,
} from "./claudeSignIn.ts";
import { ClaudeKeeper } from "./keeper.ts";
import { readKeychain } from "./keychain.ts";
import { accountsFile, claudeFolder } from "./paths.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

let t: TestHome;
beforeEach(() => {
  t = makeTestHome();
});
afterEach(() => t.remove());

const blob = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt, subscriptionType: "pro" },
  });

describe("the account list", () => {
  it("is Main alone until the fork saves its own, and never the app's", async () => {
    expect(pool(await loadAccounts(t.paths, 0), "claude").map((a) => a.key)).toEqual(["main"]);
    t.write(
      `${t.paths.home}/Library/Application Support/lastdrop/accounts.json`,
      encodeAccountsConfig(append(emptyConfig(), { provider: "claude", key: "App", addedAt: 0 })),
    );
    expect(pool(await loadAccounts(t.paths, 0), "claude").map((a) => a.key)).toEqual(["main"]);
    const own = append(emptyConfig(), { provider: "claude", key: "Pro", addedAt: 1000 });
    await saveAccounts(t.paths, own);
    expect(NodeFS.readFileSync(accountsFile(t.paths), "utf8")).toBe(encodeAccountsConfig(own));
    expect(await loadAccounts(t.paths, 0)).toEqual(own);
  });
});

describe("the keychain and sign-ins", () => {
  it("reads Claude Code's item, else the folder's credentials file", async () => {
    const folder = claudeFolder(t.paths, "Pro")!;
    expect(await readKeychain(t.paths.security, "nothing")).toBeUndefined();
    expect(await storedCredentials(t.paths, folder)).toBeUndefined();
    t.write(`${folder}/.credentials.json`, blob(1));
    expect(await storedCredentials(t.paths, folder)).toBe(blob(1));
    t.setKeychain(keychainService(folder), blob(2));
    expect(await storedCredentials(t.paths, folder)).toBe(blob(2));
    // Main's is the unsuffixed item.
    t.setKeychain("Claude Code-credentials", blob(3_000_000_000_000));
    expect((await readSignInFacts(t.paths, undefined))?.expiresAt).toBe(3_000_000_000_000);
  });

  it("names the account a folder is signed in to", async () => {
    const folder = claudeFolder(t.paths, "Pro")!;
    t.write(`${folder}/.claude.json`, {
      oauthAccount: { accountUuid: "u", emailAddress: "a@example.com" },
    });
    expect(await signedInAccountOf(t.paths, folder)).toEqual({ uuid: "u", email: "a@example.com" });
    expect(await signedInAccountOf(t.paths, undefined)).toEqual({
      uuid: undefined,
      email: undefined,
    });
  });

  it("finds the installed Claude Code and its version", async () => {
    const versions = `${t.paths.home}/.local/share/claude/versions`;
    NodeFS.mkdirSync(versions, { recursive: true });
    NodeFS.writeFileSync(`${versions}/2.1.330`, "#!/bin/sh\n", { mode: 0o755 });
    NodeFS.mkdirSync(`${t.paths.home}/.local/bin`, { recursive: true });
    NodeFS.symlinkSync(`${versions}/2.1.330`, `${t.paths.home}/.local/bin/claude`);
    expect(await installedClaudeCodeVersion(t.paths)).toBe("2.1.330");
    expect(await claudeExecutable(t.paths, { PATH: "" })).toBe(`${t.paths.home}/.local/bin/claude`);
  });
});

describe("renewal", () => {
  it("starts Claude Code in the account's folder and sees the expiry move", async () => {
    const folder = claudeFolder(t.paths, "Pro")!;
    t.write(`${folder}/.credentials.json`, blob(4_000_000_000_000));
    const bin = `${t.root}/bin`;
    NodeFS.mkdirSync(bin);
    // A fake Claude Code: renews the sign-in where CLAUDE_CONFIG_DIR says, records its environment.
    const later = 4_000_028_800_000;
    NodeFS.writeFileSync(
      `${bin}/claude`,
      `#!/bin/sh
env > "${t.root}/claude-env"
printf '%s' '${blob(later)}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
cat > /dev/null
`,
      { mode: 0o755 },
    );
    const renewed = await renewSignIn(t.paths, "Pro", {
      env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_ENTRYPOINT: "cli", HOME: t.paths.home },
      pollMs: 50,
      polls: 100,
      now: () => 4_000_000_000_000,
    });
    expect(renewed).toBe(true);
    const env = NodeFS.readFileSync(`${t.root}/claude-env`, "utf8");
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${folder}\n`);
    expect(env).not.toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(env).not.toContain("CLAUDE_CODE_ENTRYPOINT");
    expect(env).toContain("LASTDROP_SUBAGENT=1");
    expect(env).toContain(`PWD=${t.paths.dataDir}/helper`);
  });

  it("the keeper renews a sign-in near expiry once, and says when only the user can help", async () => {
    let at = 1_800_000_000_000;
    const facts = new Map([
      ["main", { expiresAt: at + 120_000, endsAt: undefined, hasRefreshToken: true }],
      ["Pro", undefined],
    ]);
    const renewals: string[] = [];
    const renewed: string[] = [];
    const logs: string[] = [];
    const keeper = new ClaudeKeeper({
      readFacts: async (key) => facts.get(key),
      renew: async (key) => {
        renewals.push(key);
        facts.set(key, { expiresAt: at + 8 * 3_600_000, endsAt: undefined, hasRefreshToken: true });
        return true;
      },
      now: () => at,
      onRenewed: (key) => renewed.push(key),
      log: (line) => logs.push(line),
    });
    await keeper.tick(["main", "Pro"]);
    await keeper.settled();
    expect(renewals).toEqual(["main"]);
    expect(renewed).toEqual(["main"]);
    expect(keeper.signIns.get("Pro")?.state).toBe("signedOut");
    expect(logs).toEqual(["the Pro sign-in needs you: Not signed in to Claude Code."]);
    // Read again at the next tick (a renewal re-reads at once), then not before five minutes.
    at += 15_000;
    await keeper.tick(["main", "Pro"]);
    expect(keeper.signIns.get("main")).toMatchObject({
      state: "ok",
      expiresAt: at - 15_000 + 8 * 3_600_000,
    });
    const checked = keeper.signIns.get("main")!.checkedAt;
    at += 15_000;
    await keeper.tick(["main"]);
    expect(keeper.signIns.get("main")!.checkedAt).toBe(checked);
    expect(keeper.signIns.has("Pro")).toBe(false); // gone from the list: forgotten
    expect(renewals).toEqual(["main"]);
  });
});
