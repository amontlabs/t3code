/**
 * The wrapper as the server runs it, over lastdrop's files. Not under vitest (T3's tests build this layer) nor with
 * `LASTDROP_CODEX_ROUTING=0`; there T3's factory is returned unchanged. With no fork account signed in, every session
 * opens as T3 would.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexAppServerClientFactory } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { wrapCodexClientFactory } from "./factory.ts";
import { lastdropCodexRouting } from "./routing.ts";

export const wrapLive = <E, R>(
  factory: Layer.Layer<CodexAppServerClientFactory, E, R>,
): Layer.Layer<CodexAppServerClientFactory, E, R> =>
  Layer.effect(
    CodexAppServerClientFactory,
    Effect.gen(function* () {
      const inner = yield* CodexAppServerClientFactory;
      const live = yield* lastdropCodexRouting;
      if (live === undefined) return inner;
      return CodexAppServerClientFactory.of(wrapCodexClientFactory(inner, live));
    }),
  ).pipe(Layer.provide(factory));
