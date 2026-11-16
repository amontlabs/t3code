/**
 * The wrapper as the server runs it, over lastdrop's files. Not under vitest (T3's tests build this layer) nor with
 * `LASTDROP_CODEX_ROUTING=0`; there T3's factory is returned unchanged. With no fork account signed in, every session
 * opens as T3 would.
 */
import { codexAccountFiles, fileLogger } from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../../config.ts";
import { CodexAppServerClientFactory } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { lastdropDataDir } from "../../dataDir.ts";
import { wrapCodexClientFactory } from "./factory.ts";
import { makeCodexRouting } from "./routing.ts";

export const wrapLive = <E, R>(
  factory: Layer.Layer<CodexAppServerClientFactory, E, R>,
): Layer.Layer<CodexAppServerClientFactory, E, R> =>
  Layer.effect(
    CodexAppServerClientFactory,
    Effect.gen(function* () {
      const inner = yield* CodexAppServerClientFactory;
      const setting = (name: string) =>
        Config.String(name).pipe(Config.option, Effect.orElseSucceed(Option.none));
      const underTest = yield* setting("VITEST");
      const off = yield* setting("LASTDROP_CODEX_ROUTING");
      const config = yield* Effect.serviceOption(ServerConfig);
      if (
        underTest._tag === "Some" ||
        (off._tag === "Some" && off.value === "0") ||
        Option.isNone(config)
      ) {
        return inner;
      }
      const dataDir = lastdropDataDir(config.value);
      const home = yield* HostProcess.HomeDirectory;
      const log = fileLogger(`${dataDir}/lastdrop.log`);
      return CodexAppServerClientFactory.of(
        wrapCodexClientFactory(inner, {
          routing: makeCodexRouting({ files: codexAccountFiles(dataDir), now: Date.now, log }),
          sharedHome: `${home}/.codex`,
        }),
      );
    }),
  ).pipe(Layer.provide(factory));
