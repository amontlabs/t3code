import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { lastdropDataDir, resolveLastdropDataDir } from "./dataDir.ts";

it("puts lastdrop's files beside T3's folders in the T3 home", () => {
  assert.equal(
    lastdropDataDir({ baseDir: "/Users/a/.t3", stateDir: "/Users/a/.t3/userdata" }),
    "/Users/a/.t3/lastdrop",
  );
  assert.equal(
    lastdropDataDir({ baseDir: "/Users/a/.t3", stateDir: "/Users/a/.t3/dev" }),
    "/Users/a/.t3/dev/lastdrop",
  );
});

it.effect("resolves under the running server's home", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    assert.equal(yield* resolveLastdropDataDir, lastdropDataDir(config));
    assert.isTrue((yield* resolveLastdropDataDir).startsWith(config.baseDir));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "lastdrop-data-dir-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
