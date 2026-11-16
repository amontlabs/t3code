/**
 * T3's Claude driver as lastdrop runs it, replacing T3's (the registry keeps the last driver of a kind). T3
 * hides Claude's models while Claude Code's own login is signed out; lastdrop's threads don't use it. See
 * docs/lastdrop/claude-routing.md, "Claude Code's own login".
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { claudeUsageReader } from "../../provider/Drivers/claudeUsage.ts";
import type { ClaudeDriverEnv } from "../../provider/Drivers/ClaudeDriver.ts";

/** T3's snapshot, signed in while a lastdrop account can take work and only Claude Code's own login is out. */
export function insulatedSnapshot(snapshot: ServerProvider, accountReady: boolean): ServerProvider {
  if (!accountReady || !snapshot.installed || snapshot.auth.status !== "unauthenticated") {
    return snapshot;
  }
  const { message: _claudeCodeSignedOut, ...rest } = snapshot;
  return {
    ...rest,
    status: "ready",
    auth: { status: "authenticated", type: "lastdrop", label: "lastdrop accounts" },
  };
}

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * T3's driver's fields, restated: its module and this one import each other through the server's driver list,
 * so it is loaded only when an instance is created. `claudeDriver.test.ts` pins that they stay equal.
 */
export const LastdropClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: ProviderDriverKind.make("claudeAgent"),
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: (input) =>
    Effect.promise(() => import("./claudeDriverLive.ts")).pipe(
      Effect.flatMap((live) => live.create(input)),
    ),
};
