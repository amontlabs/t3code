/**
 * Setting, clearing and listing the Z.ai and OpenRouter keys in the fork's keychain service. The reader is
 * `endpoints.ts` (`probeOwnKeychain`) and the key helper script; both decode what `writeOwnKeychain` encodes, so
 * a key set here is the key Claude Code gets. A key is never returned, only whether there is one.
 */
import * as NodeChildProcess from "node:child_process";

import { ENDPOINT_PROVIDERS, ENDPOINT_TITLES, type EndpointProvider } from "@t3tools/lastdrop-core";

import { fallbackEndpointKey, KEY_ITEMS, KEYCHAIN_SERVICE } from "./endpoints.ts";
import { probeOwnKeychain, writeOwnKeychain } from "./keychain.ts";
import type { LastdropPaths } from "./paths.ts";

/** Where a provider's key is: the fork's keychain item, Z.ai's key file or an environment variable, or nowhere. */
export type KeyPlace = "own" | "other" | "none" | "unreadable";

export interface EndpointKeyStatus {
  readonly provider: EndpointProvider;
  readonly title: string;
  readonly place: KeyPlace;
}

type Env = Readonly<Record<string, string | undefined>>;

export async function endpointKeyStatus(
  paths: LastdropPaths,
  env: Env = {},
): Promise<ReadonlyArray<EndpointKeyStatus>> {
  return Promise.all(
    ENDPOINT_PROVIDERS.map(async (provider) => {
      const own = await probeOwnKeychain(paths.security, KEYCHAIN_SERVICE, KEY_ITEMS[provider]);
      const place: KeyPlace =
        own.state === "found"
          ? "own"
          : (await fallbackEndpointKey(provider, paths, env)) !== undefined
            ? "other"
            : own.state === "unreadable"
              ? "unreadable"
              : "none";
      return { provider, title: ENDPOINT_TITLES[provider], place };
    }),
  );
}

/** Stores the provider's key; true only once it reads back as given. */
export async function setEndpointKey(
  paths: LastdropPaths,
  provider: EndpointProvider,
  key: string,
): Promise<boolean> {
  const value = key.trim();
  if (value === "") return false;
  if (!(await writeOwnKeychain(paths.security, KEYCHAIN_SERVICE, KEY_ITEMS[provider], value))) {
    return false;
  }
  const read = await probeOwnKeychain(paths.security, KEYCHAIN_SERVICE, KEY_ITEMS[provider]);
  return read.state === "found" && read.value === value;
}

/** `security`'s exit code when an item isn't there (errSecItemNotFound). */
const ITEM_NOT_FOUND = 44;

function deleteItem(security: string, item: string): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      security,
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", item],
      { timeout: 10_000 },
      (error) => resolve(error === null || (error as { code?: unknown }).code === ITEM_NOT_FOUND),
    );
  });
}

/** Removes the provider's key from the fork's keychain service; false when it stays. */
export function clearEndpointKey(
  paths: LastdropPaths,
  provider: EndpointProvider,
): Promise<boolean> {
  return deleteItem(paths.security, KEY_ITEMS[provider]);
}
