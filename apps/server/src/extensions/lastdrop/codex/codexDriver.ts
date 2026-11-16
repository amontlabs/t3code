/**
 * T3's Codex driver as lastdrop runs it, replacing T3's (the registry keeps the last driver of a kind). T3 probes
 * `~/.codex` (Codex's own `codex login`) for the CLI-login instance's status and models, and runs its titles and
 * commit messages there; lastdrop's threads don't use that login. See docs/lastdrop/independence.md, item 5.
 */
import {
  CodexSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { codexUsageReader } from "../../../provider/Drivers/codexUsage.ts";
import type { CodexDriverEnv } from "../../../provider/Drivers/CodexDriver.ts";
import type * as CodexUsageHistory from "../../../usage/CodexUsageHistory.ts";

/** How long the picked account is trusted between snapshot reads. */
const PICK_FOR_MS = 5_000;

/**
 * T3's snapshot while Codex's own login is out, read from the fork account's home instead: its status, version,
 * models, skills and commands, signed in as "lastdrop accounts". Its limits are left out (lastdrop's limit source
 * shows each account's), and so is anything when the account's own probe failed.
 */
export function accountSnapshot(
  snapshot: ServerProvider,
  account: ServerProviderDraft | undefined,
): ServerProvider {
  if (
    account === undefined ||
    !snapshot.installed ||
    snapshot.auth.status !== "unauthenticated" ||
    account.auth.status !== "authenticated" ||
    account.status === "error"
  ) {
    return snapshot;
  }
  const { message: _codexSignedOut, usageLimits: _terminalLimits, ...rest } = snapshot;
  return {
    ...rest,
    status: account.status,
    version: account.version ?? snapshot.version,
    models: account.models,
    skills: account.skills,
    slashCommands: account.slashCommands,
    auth: { status: "authenticated", type: "lastdrop", label: "lastdrop accounts" },
  };
}

/** What the insulated instance asks of lastdrop: the account, its probe and its text generation. */
export interface CodexAccountRunner {
  readonly pick: Effect.Effect<{ readonly account: string; readonly home: string } | undefined>;
  /** T3's provider check run in the account's home; undefined when it could not run. */
  readonly probe: (home: string) => Effect.Effect<ServerProviderDraft | undefined>;
  readonly textGeneration: (
    home: string,
    models: Effect.Effect<ReadonlyArray<ServerProviderModel>>,
  ) => Effect.Effect<ProviderTextGeneration>;
}

/** T3's instance with its snapshot read from the roomiest fork account while Codex's own login is out, and its text generation run there. */
export function insulateCodex(
  instance: ProviderInstance,
  runner: CodexAccountRunner,
): ProviderInstance {
  let picked:
    | { readonly at: number; readonly value: Effect.Success<typeof runner.pick> }
    | undefined;
  const pick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (picked !== undefined && now - picked.at < PICK_FOR_MS) return picked.value;
    const value = yield* runner.pick;
    picked = { at: now, value };
    return value;
  });
  // One probe per account and T3 check: T3's next refresh (a new `checkedAt`) reads the account again.
  let probed:
    | { readonly key: string; readonly draft: Effect.Effect<ServerProviderDraft | undefined> }
    | undefined;
  const probe = Effect.fn("LastdropCodexDriver.probe")(function* (home: string, checkedAt: string) {
    const key = `${home}@${checkedAt}`;
    if (probed?.key !== key) probed = { key, draft: yield* Effect.cached(runner.probe(home)) };
    return yield* probed.draft;
  });
  const insulated = (snapshot: ServerProvider): Effect.Effect<ServerProvider> =>
    !snapshot.installed || snapshot.auth.status !== "unauthenticated"
      ? Effect.succeed(snapshot)
      : Effect.flatMap(pick, (account) =>
          account === undefined
            ? Effect.succeed(snapshot)
            : Effect.map(probe(account.home, snapshot.checkedAt), (draft) =>
                accountSnapshot(snapshot, draft),
              ),
        );
  const { snapshot, snapshotForCwd, textGeneration } = instance;
  const getSnapshot = Effect.flatMap(snapshot.getSnapshot, insulated);
  const models = Effect.map(getSnapshot, (current) => current.models);
  // T3 runs these as `codex exec` in the instance's home, outside the client factory lastdrop wraps.
  const onAccount =
    <I, A, E>(run: (tg: ProviderTextGeneration) => (input: I) => Effect.Effect<A, E>) =>
    (input: I): Effect.Effect<A, E> =>
      Effect.flatMap(pick, (account) =>
        account === undefined
          ? run(textGeneration)(input)
          : Effect.flatMap(runner.textGeneration(account.home, models), (tg) => run(tg)(input)),
      );
  return {
    ...instance,
    snapshot: {
      ...snapshot,
      getSnapshot,
      refresh: Effect.flatMap(snapshot.refresh, insulated),
      streamChanges: Stream.mapEffect(snapshot.streamChanges, insulated),
    },
    ...(snapshotForCwd === undefined
      ? {}
      : {
          // The workspace's skills are T3's read for that folder; the rest follows the account.
          snapshotForCwd: (cwd: string) =>
            Effect.flatMap(snapshotForCwd(cwd), (workspace) =>
              Effect.map(insulated(workspace), (current) => ({
                ...workspace,
                ...current,
                skills: workspace.skills,
              })),
            ),
        }),
    textGeneration: {
      generateTranscriptionPostProcessing: onAccount(
        (tg) => tg.generateTranscriptionPostProcessing,
      ),
      generateCommitMessage: onAccount((tg) => tg.generateCommitMessage),
      generatePrContent: onAccount((tg) => tg.generatePrContent),
      generateBranchName: onAccount((tg) => tg.generateBranchName),
      generateThreadTitle: onAccount((tg) => tg.generateThreadTitle),
      generateReviewGuide: onAccount((tg) => tg.generateReviewGuide),
    },
  };
}

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/**
 * T3's driver's fields, restated: its module and this one import each other through the server's driver list,
 * so it is loaded only when an instance is created. `codexDriver.test.ts` pins that they stay equal.
 */
export const LastdropCodexDriver: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = {
  driverKind: ProviderDriverKind.make("codex"),
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: (input) =>
    Effect.promise(() => import("./codexDriverLive.ts")).pipe(
      Effect.flatMap((live) => live.create(input)),
    ),
};
