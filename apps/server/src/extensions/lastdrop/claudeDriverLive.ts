/**
 * `LastdropClaudeDriver.create` (claudeDriver.ts): T3's Claude instance, insulated from Claude Code's own login,
 * its approval cards carrying an MCP form's own scopes.
 */
import type { ClaudeSettings, ServerProvider } from "@t3tools/contracts";
import { isLastdropEndpointEnvironment, userAuthOverride } from "@t3tools/lastdrop-node";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { resolveClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "../../provider/Drivers/ClaudeDriver.ts";
import { mergeClaudeProcessEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { insulatedSnapshot } from "./claudeDriver.ts";
import { elicitationChoicesLive } from "./claudeElicitation.ts";
import { type LastdropRouting, lastdropRouting } from "./routing.ts";

/** How long "a lastdrop account can take work" is trusted between snapshot reads. */
const ACCOUNT_READY_FOR_MS = 5_000;

export const create: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path>["create"] =
  Effect.fn("LastdropClaudeDriver.create")(function* (input) {
    const created = yield* ClaudeDriver.create(input);
    // On every Claude instance, whichever account or endpoint it runs on (claudeElicitation.ts).
    const instance: ProviderInstance = {
      ...created,
      orchestrationAdapter: elicitationChoicesLive.onAdapter(created.orchestrationAdapter),
    };
    const routing = yield* lastdropRouting;
    if (routing === undefined) return instance;
    const processEnv = yield* mergeClaudeProcessEnvironment(
      input.config,
      input.environment,
      process.env,
    );
    if (userAuthOverride(processEnv) !== undefined || isLastdropEndpointEnvironment(processEnv)) {
      return instance;
    }
    const context = yield* Effect.context<ClaudeDriverEnv>();
    const config = {
      ...input.config,
      enabled: input.enabled,
      binaryPath: expandHomePath(input.config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies ClaudeSettings;
    const catalog = (yield* ModelCatalog.ModelCatalog)
      .current(ClaudeDriver.driverKind)
      .pipe(Effect.map(resolveClaudeModelCatalog));
    return insulate(instance, routing, processEnv, (env) =>
      makeClaudeTextGeneration(config, env, catalog).pipe(Effect.provideContext(context)),
    );
  });

function insulate(
  instance: ProviderInstance,
  routing: LastdropRouting,
  processEnv: NodeJS.ProcessEnv,
  textGenerationOn: (env: NodeJS.ProcessEnv) => Effect.Effect<ProviderTextGeneration>,
): ProviderInstance {
  let known: { readonly at: number; readonly ready: boolean } | undefined;
  const accountReady = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (known !== undefined && now - known.at < ACCOUNT_READY_FOR_MS) return known.ready;
    const { candidates } = yield* Effect.promise(() =>
      routing.router.candidates(undefined).catch(() => ({ candidates: [] })),
    );
    known = { at: now, ready: candidates.length > 0 };
    return known.ready;
  });
  const insulated = (snapshot: ServerProvider) =>
    Effect.map(accountReady, (ready) => insulatedSnapshot(snapshot, ready));
  const { snapshot, textGeneration } = instance;
  // T3 runs these as `claude -p` with the instance's environment, outside the query runner lastdrop wraps.
  const onAccount =
    <I, A, E>(run: (tg: ProviderTextGeneration) => (input: I) => Effect.Effect<A, E>) =>
    (input: I): Effect.Effect<A, E> =>
      Effect.promise(() => routing.router.oneOffEnvironment(undefined, processEnv)).pipe(
        Effect.flatMap((env) =>
          env === undefined
            ? run(textGeneration)(input)
            : Effect.flatMap(textGenerationOn(env), (tg) => run(tg)(input)),
        ),
      );
  return {
    ...instance,
    snapshot: {
      ...snapshot,
      getSnapshot: Effect.flatMap(snapshot.getSnapshot, insulated),
      refresh: Effect.flatMap(snapshot.refresh, insulated),
      streamChanges: Stream.mapEffect(snapshot.streamChanges, insulated),
    },
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
