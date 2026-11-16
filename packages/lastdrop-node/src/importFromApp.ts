/**
 * "Import from the lastdrop app": copies the Z.ai and OpenRouter API keys from the standalone app's keychain
 * items into the fork's own, once, for a provider the fork has no key for (not the app's Z.ai web session, which
 * the fork can't renew). The only code that names the app's
 * services. After an import (even one that found nothing) a marker is written and the app is never looked at again.
 */
import * as NodeChildProcess from "node:child_process";

import type { EndpointProvider } from "@t3tools/lastdrop-core";

import { endpointKeyStatus, setEndpointKey } from "./endpointKeys.ts";
import { KEY_ITEMS } from "./endpoints.ts";
import { exists, writeAtomic } from "./files.ts";
import { readOwnKeychain } from "./keychain.ts";
import type { LastdropPaths } from "./paths.ts";

/** The app's keychain service, and its name before the rename. */
const APP_SERVICES = ["lastdrop", "Headroom"] as const;

const markerPath = (paths: LastdropPaths): string => `${paths.dataDir}/endpoint-keys-import.json`;

/** Whether the app has the item, without reading its secret (no `-w`, so no prompt). */
function appHasItem(security: string, service: string, item: string): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      security,
      ["find-generic-password", "-s", service, "-a", item],
      { timeout: 10_000 },
      (error) => resolve(error === null),
    );
  });
}

async function appItem(paths: LastdropPaths, item: string): Promise<string | undefined> {
  for (const service of APP_SERVICES) {
    const value = (await readOwnKeychain(paths.security, service, item))?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The providers the fork has no key for and the app has one for; empty once an import ran. */
export async function importableEndpointKeys(
  paths: LastdropPaths,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ReadonlyArray<EndpointProvider>> {
  if (await exists(markerPath(paths))) return [];
  const missing = (await endpointKeyStatus(paths, env)).filter((s) => s.place === "none");
  const found = await Promise.all(
    missing.map(async ({ provider }) => {
      for (const service of APP_SERVICES) {
        if (await appHasItem(paths.security, service, KEY_ITEMS[provider])) return provider;
      }
      return undefined;
    }),
  );
  return found.filter((p): p is EndpointProvider => p !== undefined);
}

/** Copies the importable keys, then marks the import done. Returns the providers that got a key. */
export async function importEndpointKeys(
  paths: LastdropPaths,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ReadonlyArray<EndpointProvider>> {
  const imported: EndpointProvider[] = [];
  for (const provider of await importableEndpointKeys(paths, env)) {
    const key = await appItem(paths, KEY_ITEMS[provider]);
    if (key === undefined || !(await setEndpointKey(paths, provider, key))) continue;
    imported.push(provider);
  }
  await writeAtomic(markerPath(paths), JSON.stringify({ importedAt: Date.now(), imported }));
  return imported;
}
