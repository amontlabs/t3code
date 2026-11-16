// Ported from headroom Tests/LastDropTests/AccountsTests.swift and ClaudeAccountsTests.swift (see PORTING.md).
import { describe, expect, it } from "vite-plus/test";

import {
  type AccountsConfig,
  type ProviderId,
  DEFAULT_THRESHOLD,
  PROVIDERS,
  accountId,
  add,
  append,
  claudeView,
  decodeAccountsConfig,
  decodeClaudeAccountsConfig,
  emptyConfig,
  encodeAccountsConfig,
  findAccount,
  loadAccountsConfig,
  mainAccount,
  migrateClaudeAccounts,
  move,
  normalizeClaude,
  orderedClaude,
  pool,
  remove,
  replaceClaudePool,
  slug,
} from "./accountsConfig.ts";

const keys = (c: AccountsConfig, p: ProviderId) => pool(c, p).map((a) => a.key);
const now = 1_800_000_000_000;

const added = (c: AccountsConfig, p: ProviderId, name: string) => {
  const r = add(c, p, name, now);
  if (!r) throw new Error(`not added: ${name}`);
  return r;
};

describe("accounts", () => {
  it("every provider but Claude has one main account", () => {
    const config = emptyConfig();
    for (const p of PROVIDERS) expect(keys(config, p)).toEqual(p === "claude" ? [] : ["main"]);
  });

  it("an account's id", () => {
    expect(accountId(mainAccount("zai"))).toBe("zai.main");
    expect(accountId({ provider: "codex", key: "work" })).toBe("codex.work");
  });

  it("adding goes to the end of its own pool", () => {
    let config = emptyConfig();
    let r = added(config, "codex", "work");
    expect(accountId(r.account)).toBe("codex.work");
    r = added((config = r.config), "claude", "my pro");
    expect(r.account.key).toBe("my-pro");
    r = added((config = r.config), "codex", "home");
    config = r.config;
    expect(accountId(r.account)).toBe("codex.home");
    expect(keys(config, "codex")).toEqual(["main", "work", "home"]);
    expect(keys(config, "claude")).toEqual(["my-pro"]);
    const codexEnd = config.accounts.findLastIndex((a) => a.provider === "codex");
    expect(config.accounts.findIndex((a) => a.provider === "antigravity")).toBe(codexEnd + 1);
  });

  it("adding refuses unusable and taken names", () => {
    let config = emptyConfig();
    expect(add(config, "zai", "../", now)).toBeUndefined();
    expect(add(config, "zai", "Main", now)).toBeUndefined();
    config = added(config, "zai", "work").config;
    expect(add(config, "zai", "Work", now)).toBeUndefined();
    expect(add(config, "codex", "work", now)).toBeDefined(); // names are per provider
    expect(add(config, "claude", "Main", now)?.account.key).toBe("Main"); // a Claude account like any other
  });

  it("moving stays inside the pool", () => {
    let config = emptyConfig();
    config = added(config, "codex", "a").config;
    config = added(config, "zai", "x").config;
    config = added(config, "codex", "b").config;
    config = move(config, "codex.b", -1);
    expect(keys(config, "codex")).toEqual(["main", "b", "a"]);
    config = move(config, "codex.main", 1);
    expect(keys(config, "codex")).toEqual(["b", "main", "a"]);
    config = move(config, "codex.b", -1); // already first
    expect(keys(config, "codex")).toEqual(["b", "main", "a"]);
    expect(keys(config, "zai")).toEqual(["main", "x"]);
  });

  it("main accounts can't be removed, but Claude's can", () => {
    let config = added(emptyConfig(), "openrouter", "team").config;
    config = remove(config, "openrouter.main");
    config = remove(config, "openrouter.team");
    expect(keys(config, "openrouter")).toEqual(["main"]);
    config = decodeAccountsConfig(
      `{"accounts":[{"provider":"claude","key":"main","addedAt":1},{"provider":"claude","key":"Pro","addedAt":2}]}`,
      now,
    )!;
    config = remove(config, "claude.main");
    expect(keys(config, "claude")).toEqual(["Pro"]);
    expect(keys(decodeAccountsConfig(encodeAccountsConfig(config), now)!, "claude")).toEqual([
      "Pro",
    ]);
  });

  it("normalize drops duplicates and restores main", () => {
    const json = `{"accounts":[{"provider":"codex","key":"a","addedAt":1},{"provider":"codex","key":"a","addedAt":2}],"weeklyThreshold":0.5}`;
    const config = decodeAccountsConfig(json, now)!;
    expect(keys(config, "codex")).toEqual(["main", "a"]);
    expect(pool(config, "codex")[1]!.addedAt).toBe(1000);
    expect(config.weeklyThreshold).toBe(0.5);
    expect(config.sessionThreshold).toBe(DEFAULT_THRESHOLD);
    expect(keys(config, "zai")).toEqual(["main"]);
  });

  const legacyJSON = `{"accounts":[{"id":"Pro","addedAt":100},{"id":"Team","addedAt":200}],"order":["Pro","main","Team"],
     "sessionThreshold":0.75,"weeklyThreshold":0.95}`;

  it("migrating the old Claude list keeps its order and thresholds", () => {
    const old = decodeClaudeAccountsConfig(legacyJSON, now)!;
    const config = migrateClaudeAccounts(old);
    expect(keys(config, "claude")).toEqual(["Pro", "main", "Team"]);
    expect(pool(config, "claude")[0]!.addedAt).toBe(100_000);
    expect(config.sessionThreshold).toBe(0.75);
    expect(config.weeklyThreshold).toBe(0.95);
    for (const p of PROVIDERS) if (p !== "claude") expect(keys(config, p)).toEqual(["main"]);
    // The runners' view of it is the old list.
    const claude = claudeView(config);
    expect(claude.order).toEqual(old.order);
    expect(claude.accounts).toEqual(old.accounts);
    expect(claude.sessionThreshold).toBe(0.75);
  });

  it("load migrates until saved, then reads its own file", () => {
    expect(loadAccountsConfig({}, now)).toEqual(emptyConfig());
    let config = loadAccountsConfig({ legacy: legacyJSON }, now);
    expect(keys(config, "claude")).toEqual(["Pro", "main", "Team"]);
    config = append(config, { provider: "codex", key: "work", addedAt: 300_000 });
    const saved = encodeAccountsConfig(config);
    expect(loadAccountsConfig({ accounts: saved, legacy: legacyJSON }, now)).toEqual(config);
  });

  it("replacing the Claude pool leaves other providers alone", () => {
    let config = added(emptyConfig(), "codex", "work").config;
    const claude = claudeView(config);
    config = replaceClaudePool(config, {
      ...claude,
      accounts: [...claude.accounts, { id: "Pro", addedAt: now }],
      order: ["Pro", "main"],
      weeklyThreshold: 0.5,
    });
    expect(keys(config, "claude")).toEqual(["Pro", "main"]);
    expect(keys(config, "codex")).toEqual(["main", "work"]);
    expect(config.weeklyThreshold).toBe(0.5);
    expect(config.accounts[0]!.provider).toBe("claude"); // the Claude pool keeps its place
  });

  it("new accounts notify at the limit and show nothing", () => {
    const fresh = added(emptyConfig(), "codex", "work").account;
    expect(fresh.menuBar).toBeUndefined();
    expect(fresh.notifyAt).toBe(1);
    // Saved before these settings existed.
    const old = decodeAccountsConfig(
      `{"accounts":[{"provider":"codex","key":"work","addedAt":1}]}`,
      now,
    )!;
    const work = findAccount(old, "codex.work")!;
    expect(work.menuBar).toBeUndefined();
    expect(work.notifyAt).toBeUndefined();
  });

  it("saving the Claude list keeps each account's settings", () => {
    let config = append(emptyConfig(), {
      provider: "claude",
      key: "Pro",
      name: "Work",
      addedAt: now,
      menuBar: "both",
      notifyAt: 0.9,
    });
    config = replaceClaudePool(config, claudeView(config));
    const pro = findAccount(config, "claude.Pro");
    expect(pro?.name).toBe("Work");
    expect(pro?.menuBar).toBe("both");
    expect(pro?.notifyAt).toBe(0.9);
  });
});

describe("Claude accounts", () => {
  it("slug", () => {
    expect(slug("Pro")).toBe("Pro");
    expect(slug("  my work/acct ")).toBe("my-work-acct");
    expect(slug("../")).toBe("");
  });

  it("normalize keeps one main and adds accounts", () => {
    let c = normalizeClaude({
      accounts: [{ id: "Pro", addedAt: now }],
      order: ["gone", "main", "main"],
      sessionThreshold: 0.9,
      weeklyThreshold: 0.9,
    });
    expect(c.order).toEqual(["main", "Pro"]);
    c = normalizeClaude({ ...c, order: ["Pro"] });
    expect(c.order).toEqual(["main", "Pro"]);
    expect(orderedClaude(c).map((a) => a.id)).toEqual(["main", "Pro"]);
  });

  it("old threshold file still loads", () => {
    const config = decodeClaudeAccountsConfig(
      `{"order":["main"],"newSessionThreshold":0.85}`,
      now,
    )!;
    expect(config.sessionThreshold).toBe(DEFAULT_THRESHOLD);
  });
});
