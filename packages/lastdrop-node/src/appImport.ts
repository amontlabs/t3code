/**
 * The one reader of the standalone lastdrop app's account list, for "Import from the lastdrop app". It only
 * reads, and only the names and order: the app's sign-ins stay the app's (sharing them would make the two apps
 * invalidate each other's rotating refresh tokens), so each imported account signs in again in the fork.
 */
import { type Account, isMain, loadAccountsConfig, pool } from "@t3tools/lastdrop-core";

import { readText } from "./files.ts";
import type { LastdropPaths } from "./paths.ts";

const appFolder = (p: Pick<LastdropPaths, "home">) =>
  `${p.home}/Library/Application Support/lastdrop`;

/** The app's Claude accounts in its order, Main included; empty when the app has none (or isn't there). */
export async function appClaudeAccounts(
  paths: Pick<LastdropPaths, "home">,
  now: number,
): Promise<ReadonlyArray<Account>> {
  const folder = appFolder(paths);
  const accounts = await readText(`${folder}/accounts.json`);
  const legacy = await readText(`${folder}/claude-accounts.json`);
  if (accounts === undefined && legacy === undefined) return [];
  const claude = pool(loadAccountsConfig({ accounts, legacy }, now), "claude");
  return claude.some((a) => !isMain(a)) ? claude : [];
}
