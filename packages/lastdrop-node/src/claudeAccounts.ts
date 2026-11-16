/**
 * The fork's own Claude accounts, Main's included: the list in `<dataDir>/accounts.json` and each account's
 * sign-in folder `<dataDir>/accounts/<key>` (its keychain item is named after it), so a terminal sign-in never
 * changes them. Editing the list, signing in, and the one-time import of the app's names and order.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import {
  type Account,
  type AccountsConfig,
  accountId,
  add,
  keychainService,
  MAIN_KEY,
  move,
  pool,
  remove,
  rename,
} from "@t3tools/lastdrop-core";

import { appClaudeAccounts } from "./appImport.ts";
import { ClaudeLogins, SignInError } from "./claudeLogin.ts";
import { loadAccounts, saveAccounts } from "./claudeSignIn.ts";
import type { AccountView, AccountsMonitor, AccountsView } from "./monitor.ts";
import { claudeFolder, type LastdropPaths } from "./paths.ts";

/** The accounts view with what only the settings section needs. */
export interface ClaudeAccountsView extends AccountsView {
  readonly accounts: ReadonlyArray<
    AccountView & {
      /** A sign-in started from a client, waiting for the code its page shows. */
      readonly signInUrl?: string | undefined;
      readonly signInError?: string | undefined;
    }
  >;
  /** How many accounts "Import from the lastdrop app" would add; set only while the fork has none. */
  readonly importable?: number | undefined;
}

export type AccountChange =
  | { readonly action: "add"; readonly name: string }
  | { readonly action: "rename"; readonly key: string; readonly name: string }
  | { readonly action: "move"; readonly key: string; readonly by: -1 | 1 }
  | { readonly action: "remove"; readonly key: string }
  | { readonly action: "import" }
  | { readonly action: "signIn"; readonly key: string }
  | { readonly action: "submitCode"; readonly key: string; readonly code: string }
  | { readonly action: "cancelSignIn"; readonly key: string };

/** A change that can't be made; its message is for the user. */
export class AccountChangeError extends Error {}

export interface ClaudeAccountsOptions {
  readonly paths: LastdropPaths;
  readonly monitor: AccountsMonitor;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** For tests: how long a sign-in waits for its URL and for its end. */
  readonly loginTimeouts?: { readonly url: number; readonly finish: number };
}

export class ClaudeAccounts {
  readonly logins: ClaudeLogins;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: ClaudeAccountsOptions;

  constructor(options: ClaudeAccountsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.logins = new ClaudeLogins({
      paths: options.paths,
      env: options.env,
      ...(options.loginTimeouts
        ? {
            urlTimeoutMs: options.loginTimeouts.url,
            finishTimeoutMs: options.loginTimeouts.finish,
          }
        : {}),
      onSignedIn: (key) => {
        options.log?.(`signed the ${key} account in`);
        options.monitor.keeper.recheck(key);
        options.monitor.markDue(key);
      },
    });
  }

  async view(): Promise<ClaudeAccountsView> {
    return this.decorate(await this.options.monitor.view());
  }

  /** Makes one change; changes run one at a time. Returns the view after it, and a sign-in's URL. */
  change(
    change: AccountChange,
  ): Promise<{ readonly view: ClaudeAccountsView; readonly signInUrl?: string }> {
    const run = this.queue.then(() => this.apply(change));
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(
    change: AccountChange,
  ): Promise<{ readonly view: ClaudeAccountsView; readonly signInUrl?: string }> {
    const { paths } = this.options;
    let signInUrl: string | undefined;
    try {
      switch (change.action) {
        case "add": {
          const config = await loadAccounts(paths, this.now());
          const name = change.name.trim();
          const added = add(config, "claude", name, this.now());
          if (added === undefined) {
            throw new AccountChangeError(
              name === "" ? "Give the account a name." : `An account named ${name} exists already.`,
            );
          }
          const { key } = added.account;
          await NodeFSP.mkdir(claudeFolder(paths, key)!, { recursive: true, mode: 0o700 });
          await saveAccounts(
            paths,
            name === key ? added.config : rename(added.config, accountId(added.account), name),
          );
          this.options.log?.(`added the ${key} account`);
          break;
        }
        case "rename":
          await this.edit(change.key, (config, id) => rename(config, id, change.name));
          break;
        case "move":
          await this.edit(change.key, (config, id) => move(config, id, change.by));
          break;
        case "remove": {
          await this.edit(change.key, (config, id) => remove(config, id));
          this.logins.cancel(change.key);
          await this.forgetSignIn(change.key);
          this.options.log?.(`removed the ${change.key} account`);
          break;
        }
        case "import":
          await this.importFromApp();
          break;
        case "signIn":
          await this.edit(change.key, (config) => config);
          signInUrl = await this.logins.start(change.key);
          break;
        case "submitCode":
          await this.logins.submit(change.key, change.code);
          break;
        case "cancelSignIn":
          this.logins.cancel(change.key);
          break;
      }
    } catch (error) {
      if (error instanceof SignInError) throw new AccountChangeError(error.message);
      throw error;
    }
    const view = await this.decorate(await this.options.monitor.refresh());
    return signInUrl === undefined ? { view } : { view, signInUrl };
  }

  /** Applies `change` to the list when the Claude account `key` is on it; returns that account. */
  private async edit(
    key: string,
    change: (config: AccountsConfig, id: string) => AccountsConfig,
  ): Promise<Account> {
    const config = await loadAccounts(this.options.paths, this.now());
    const account = pool(config, "claude").find((a) => a.key === key);
    if (account === undefined) throw new AccountChangeError(`There's no account ${key}.`);
    const next = change(config, accountId(account));
    if (next !== config) await saveAccounts(this.options.paths, next);
    return account;
  }

  /**
   * Deletes the account's sign-in folder and its keychain item: only ever the fork's own (a folder outside the
   * fork's data folder, from a live check's override, is left alone).
   */
  private async forgetSignIn(key: string): Promise<void> {
    const { paths } = this.options;
    const folder = claudeFolder(paths, key);
    if (folder === undefined || !folder.startsWith(`${paths.dataDir}/`)) return;
    await deleteKeychainItems(paths.security, keychainService(folder));
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }

  /**
   * The app's Claude accounts' names and order (its Main too), each to sign in again here. Only while the fork
   * has no account but an older list's Main.
   */
  private async importFromApp(): Promise<void> {
    const { paths } = this.options;
    const now = this.now();
    const config = await loadAccounts(paths, now);
    const own = pool(config, "claude");
    if (!onlyOldMain(own)) throw new AccountChangeError("Accounts were added here already.");
    const app = await appClaudeAccounts(paths, now);
    if (app.length === 0)
      throw new AccountChangeError("The lastdrop app has no accounts to import.");
    const claude = app.map(
      (a): Account =>
        own.find((o) => o.key === a.key) ?? {
          provider: "claude",
          key: a.key,
          ...(a.name === undefined ? {} : { name: a.name }),
          addedAt: now,
          notifyAt: 1,
        },
    );
    for (const a of claude) {
      await NodeFSP.mkdir(claudeFolder(paths, a.key)!, { recursive: true, mode: 0o700 });
    }
    await saveAccounts(paths, {
      ...config,
      accounts: [...claude, ...config.accounts.filter((a) => a.provider !== "claude")],
    });
    this.options.log?.(`imported ${claude.length - own.length} accounts from the lastdrop app`);
  }

  private async decorate(view: AccountsView): Promise<ClaudeAccountsView> {
    const accounts = view.accounts.map((account) => {
      const signInUrl = this.logins.pendingUrl(account.key);
      const signInError = this.logins.failure(account.key);
      return signInUrl === undefined && signInError === undefined
        ? account
        : {
            ...account,
            ...(signInUrl === undefined ? {} : { signInUrl }),
            ...(signInError === undefined ? {} : { signInError }),
          };
    });
    const importable = onlyOldMain(view.accounts)
      ? (await appClaudeAccounts(this.options.paths, this.now())).filter(
          (a) => !view.accounts.some((o) => o.key === a.key),
        ).length
      : 0;
    return { ...view, accounts, ...(importable > 0 ? { importable } : {}) };
  }
}

/** No account, or only the `main` an older list had (Claude Code's own login back then). */
const onlyOldMain = (accounts: ReadonlyArray<{ readonly key: string }>) =>
  accounts.every((a) => a.key === MAIN_KEY);

/** Deletes every keychain item of `service` (Claude Code keeps one per folder). */
async function deleteKeychainItems(security: string, service: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const deleted = await new Promise<boolean>((resolve) =>
      NodeChildProcess.execFile(security, ["delete-generic-password", "-s", service], (error) =>
        resolve(error === null),
      ),
    );
    if (!deleted) return;
  }
}
