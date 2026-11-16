// The Codex wrapper's assumptions about T3's Codex adapter, pinned so an upstream change fails here, loudly,
// instead of silently routing nothing. When one fails after a sync: read what upstream changed, adapt
// `factory.ts` (never the adapter), then update the pin.
// @effect-diagnostics nodeBuiltinImport:off - reads T3's own sources to pin the seam.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type * as CodexClient from "effect-codex-app-server/client";

import type * as CodexAdapterV2 from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { CodexOpenInput } from "./factory.ts";

const here = NodePath.dirname(new URL(import.meta.url).pathname);
const source = (relative: string) => NodeFS.readFileSync(NodePath.join(here, relative), "utf8");

// Type-level pins: a field added, renamed or removed upstream breaks the typecheck here.
const factoryMethods: Record<keyof CodexAdapterV2.CodexAppServerClientFactoryShape, true> = {
  open: true,
};
const openFields: Record<keyof CodexOpenInput, true> = {
  instanceId: true,
  threadId: true,
  providerSessionId: true,
  runtimePolicy: true,
  settings: true,
  environment: true,
};
type Client = CodexClient.CodexAppServerClient["Service"];
// The client methods the wrapper replaces must stay on the client.
const clientMethods: Pick<
  Record<keyof Client, true>,
  "raw" | "request" | "handleServerNotification"
> = {
  raw: true,
  request: true,
  handleServerNotification: true,
};
const rawMethods: Pick<Record<keyof Client["raw"], true>, "request"> = { request: true };

const ADAPTER = "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";

describe("the Codex wrapper's contract with T3's Codex adapter", () => {
  it("the factory and its input have the shape the wrapper wraps", () => {
    assert.lengthOf(Object.keys(factoryMethods), 1);
    assert.lengthOf(Object.keys(openFields), 6);
    assert.lengthOf(Object.keys(clientMethods), 3);
    assert.lengthOf(Object.keys(rawMethods), 1);
  });

  it("every Codex process still opens through the wrapped factory layer", () => {
    const seam = source("../../../provider/ProviderOrchestrationAdapterInfrastructure.ts");
    assert.include(
      seam,
      "Extensions.wrapCodexAppServerClientFactory(CodexAdapterV2.layerAppServerClientFactory)",
    );
  });

  it("the factory spawns with the settings' home as CODEX_HOME and the settings' launch arguments", () => {
    const adapter = source(ADAPTER);
    assert.include(
      adapter,
      "...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),",
    );
    assert.include(adapter, "resolveCodexLaunchArgs(input.settings.launchArgs, input.environment)");
    // A session opens with the T3 thread the wrapper records, and never spawns outside the factory.
    assert.match(
      adapter,
      /clientFactory\.open\(\{\s+instanceId: adapterOptions\.instanceId,\s+threadId: input\.threadId,/u,
    );
  });

  it("native thread ids come back on thread/start, thread/resume and thread/fork, and usage updates reach the client", () => {
    const adapter = source(ADAPTER);
    assert.include(adapter, '"thread/start",');
    assert.include(adapter, 'client.raw.request("thread/resume", { threadId, ...params })');
    assert.include(adapter, 'client.request("thread/fork", {');
    assert.match(adapter, /thread: response\.thread,/u);
    assert.include(adapter, 'client.handleServerNotification("account/rateLimits/updated"');
  });

  it("a managed instance (T3's own ChatGPT sign-in) is still marked by its setup mode", () => {
    const runtime = source("../../../provider/CodexManagedRuntime.ts");
    assert.include(runtime, 'setupMode: "managed",');
  });
});
