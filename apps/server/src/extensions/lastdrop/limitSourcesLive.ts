/**
 * Wraps T3's `UsageLimitSources` (`server.ts` seam) to append lastdrop's source in `current` and `streamChanges`.
 * T3's layer sits below `Extensions.layer` in the server's stack, so the publisher reaches the wrapper through
 * the feed in `limitSources.ts`, not through a service.
 */
import { UsageLimitSourceError, type UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { UsageLimitSources } from "../../usage/UsageLimitSources.ts";
import { LastdropAccounts } from "./accounts.ts";
import { LastdropCodexAccounts } from "./codex/accounts.ts";
import { LastdropEndpoints } from "./endpointsView.ts";
import {
  CODEX_ROW,
  currentLastdropSources,
  LASTDROP_SOURCE_ID,
  lastdropLimitSource,
  lastdropRedeemer,
  onLastdropSources,
  publishLastdropSources,
  resetLastdropSources,
  setLastdropRedeemer,
} from "./limitSources.ts";

/** How often the publisher looks at the accounts and endpoints views (both are in memory or cheap reads). */
const PUBLISH_EVERY = "15 seconds";

const withOurs = (sources: ReadonlyArray<UsageLimitSourceSnapshot>) => {
  const ours = currentLastdropSources();
  return ours.length === 0 ? sources : [...sources, ...ours];
};

/** T3's service with lastdrop's source appended. */
export const wrap = <E, R>(
  inner: Layer.Layer<UsageLimitSources, E, R>,
): Layer.Layer<UsageLimitSources, E, R> =>
  Layer.effect(
    UsageLimitSources,
    Effect.gen(function* () {
      const base = yield* UsageLimitSources;
      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
        PubSub.shutdown,
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => onLastdropSources((next) => PubSub.publishUnsafe(changes, next))),
        (stop) => Effect.sync(stop),
      );
      const ours = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.make(currentLastdropSources()),
            Stream.fromSubscription(subscription),
          );
        }),
      );
      return UsageLimitSources.of({
        current: base.current.pipe(Effect.map(withOurs)),
        refresh: base.refresh,
        consumeResetCredit: Effect.fn("LastdropLimitSources.consumeResetCredit")(function* (input) {
          if (input.sourceId !== LASTDROP_SOURCE_ID) return yield* base.consumeResetCredit(input);
          const redeem = lastdropRedeemer();
          if (redeem === undefined) {
            return yield* new UsageLimitSourceError({
              detail: "lastdrop's accounts aren't running on this server.",
            });
          }
          return yield* redeem(input.accountId, input.creditId);
        }),
        get streamChanges() {
          return Stream.zipLatestWith(base.streamChanges, ours, (theirs, mine) =>
            mine.length === 0 ? theirs : [...theirs, ...mine],
          );
        },
      });
    }),
  ).pipe(Layer.provide(inner));

/**
 * Publishes lastdrop's source from the Claude and Codex accounts and the endpoints views. Off macOS and under vitest both are empty.
 * The feed's reading and the redeemer live as long as this layer: emptied when it builds and when it closes.
 */
export const publisher = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* LastdropAccounts;
    const codex = yield* LastdropCodexAccounts;
    const endpoints = yield* LastdropEndpoints;
    yield* Effect.acquireRelease(Effect.sync(resetLastdropSources), () =>
      Effect.sync(resetLastdropSources),
    );
    const publish = Effect.gen(function* () {
      const source = lastdropLimitSource({
        accounts: yield* accounts.view,
        codex: yield* codex.view,
        endpoints: yield* endpoints.view,
        now: yield* Clock.currentTimeMillis,
      });
      publishLastdropSources(source ? [source] : []);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("lastdrop limit source failed", cause)));
    const redeem = Effect.fn("LastdropLimitSources.redeem")(function* (
      accountId: string,
      creditId: string,
    ) {
      const claude = (yield* accounts.view)?.accounts.some((account) => account.key === accountId);
      const outcome = claude
        ? yield* accounts.redeemReset(accountId, creditId)
        : accountId.startsWith(CODEX_ROW)
          ? yield* codex.redeemReset(accountId.slice(CODEX_ROW.length), creditId)
          : yield* new UsageLimitSourceError({ detail: "This account has no resets to redeem." });
      yield* publish;
      return { outcome };
    });
    yield* Effect.acquireRelease(
      Effect.sync(() => setLastdropRedeemer(redeem)),
      (unset) => Effect.sync(unset),
    );
    yield* publish.pipe(Effect.repeat(Schedule.spaced(PUBLISH_EVERY)), Effect.forkScoped);
  }),
);
