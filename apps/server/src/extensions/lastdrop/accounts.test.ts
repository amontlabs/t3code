import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { LastdropAccounts, layer } from "./accounts.ts";

// T3's own server tests start this layer too: under vitest it must never read the real keychain, the
// real `~/.claude*` or ask Anthropic.
it.effect("stays off under the test runner", () =>
  Effect.gen(function* () {
    const accounts = yield* LastdropAccounts;
    assert.isUndefined(yield* accounts.view);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "lastdrop-accounts-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  ),
);
