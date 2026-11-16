import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { routedCodexBinary } from "./accounts.ts";

const HOME = "/home/u";
const codex = ProviderDriverKind.make("codex");
const binaryOf = (instances: Record<string, unknown>) =>
  routedCodexBinary(
    instances as ServerSettings["providerInstances"],
    { PATH: "/bin" },
    `${HOME}/.codex`,
  ).pipe(Effect.provideService(HostProcess.HomeDirectory, HOME));

describe("the Codex lastdrop's usage reads and sign-ins run", () => {
  it.effect("is the routed instance's binary path, the default instance first", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* binaryOf({}), "codex");
      assert.strictEqual(
        yield* binaryOf({ codex: { driver: codex, config: { binaryPath: "~/bin/codex" } } }),
        `${HOME}/bin/codex`,
      );
      // Instances lastdrop never routes keep their own Codex: managed, a shadow or other home, disabled.
      assert.strictEqual(
        yield* binaryOf({
          managed: { driver: codex, config: { setupMode: "managed", binaryPath: "/m/codex" } },
          shadow: { driver: codex, config: { shadowHomePath: "/s", binaryPath: "/s/codex" } },
          other: {
            driver: codex,
            environment: [{ name: "CODEX_HOME", value: "/elsewhere", sensitive: false }],
            config: { binaryPath: "/o/codex" },
          },
          off: { driver: codex, enabled: false, config: { binaryPath: "/off/codex" } },
          work: { driver: codex, config: { binaryPath: "/w/codex" } },
          codex: { driver: codex, config: { binaryPath: "/opt/codex" } },
        }),
        "/opt/codex",
      );
    }),
  );
});
