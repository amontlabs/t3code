/**
 * Z.ai and OpenRouter as T3 Claude instances: what lastdrop asks T3's settings service for (made, kept
 * current, removed, the user's own instance left alone), the catalog facts the instance is built from, the
 * room the agents driver reads from their usage, and their own usage-limit classes.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AgentStep } from "./agents/catalog.ts";
import { makeRoom } from "./agents/room.ts";
import * as EndpointRoom from "./endpointRoom.ts";
import { catalogFacts, desiredInstance, reconcileInstance, roleModel } from "./endpoints.ts";

const ZAI = "zai";
const now = Date.UTC(2026, 10, 14, 12);
const markEnd = "2026-11-14T12:10:00.000Z";

const catalog = {
  agents: [
    {
      name: "cheap",
      provider: "zai",
      model: "glm-5.3-flash",
      enabled: true,
      fallbacks: [{ provider: "openrouter", model: "qwen/q4" }],
    },
    { name: "off", provider: "openrouter", model: "never/used", enabled: false },
    {
      name: "build",
      provider: "antigravity",
      model: "x",
      enabled: true,
      fallbacks: [{ provider: "zai", model: "glm-5.3" }],
    },
  ],
  judges: { zai: { model: "glm-5.4" }, antigravity: { model: "g" } },
};

const desired = (facts = catalogFacts(catalog)) =>
  desiredInstance({
    provider: "zai",
    home: "/h/.t3/lastdrop/endpoints/zai",
    sessionSettings: "/h/.t3/lastdrop/endpoints/zai/session-settings.json",
    facts,
    listed: [],
  });

const run = (input: {
  instances: ProviderInstanceConfigMap;
  spec: ReturnType<typeof desired>["spec"]["instance"] | undefined;
  owned: boolean;
}) =>
  Effect.gen(function* () {
    const mutations: ProviderInstanceMutation[] = [];
    const result = yield* reconcileInstance({
      ...input,
      instanceId: ZAI,
      mutate: (mutation) => Effect.sync(() => void mutations.push(mutation)),
    });
    return { result, mutations };
  });

const asStored = (
  instance: ReturnType<typeof desired>["spec"]["instance"],
  extra: Partial<ProviderInstanceConfig> = {},
): ProviderInstanceConfigMap => ({
  [ProviderInstanceId.make(ZAI)]: {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instance.displayName,
    environment: instance.environment,
    enabled: instance.enabled,
    config: { ...instance.config, autoCompactWindow: "" },
    ...extra,
  },
});

describe("catalog facts", () => {
  it("lists each endpoint's models, primary entries first, enabled agents only, and the judges", () => {
    const facts = catalogFacts(catalog);
    assert.deepEqual(facts.models, { zai: ["glm-5.3-flash", "glm-5.3"], openrouter: ["qwen/q4"] });
    assert.deepEqual(facts.judges, { zai: "glm-5.4" });
    assert.equal(roleModel("zai", facts), "glm-5.3-flash");
    assert.equal(roleModel("openrouter", facts), "qwen/q4");
    const empty = catalogFacts(undefined);
    assert.equal(roleModel("zai", empty), "glm-5.3");
    assert.equal(roleModel("openrouter", empty), undefined);
  });

  it("pins the roles to the catalog's model and auto mode's judge to the chosen one", () => {
    const { spec, environment } = desired();
    assert.equal(environment.ANTHROPIC_MODEL, "glm-5.3-flash");
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, "glm-5.3-flash");
    assert.equal(environment.CLAUDE_CODE_AUTO_MODE_MODEL, "glm-5.4");
    assert.equal(spec.instanceId, "zai");
    assert.equal(spec.instance.displayName, "Z.ai (lastdrop)");
  });
});

describe("reconcile", () => {
  it.effect("makes the instance through T3's settings service when the id is free", () =>
    Effect.gen(function* () {
      const { spec } = desired();
      const { result, mutations } = yield* run({
        instances: {},
        spec: spec.instance,
        owned: false,
      });
      assert.deepEqual(result, { outcome: "created", owned: true });
      assert.equal(mutations.length, 1);
      const mutation = mutations[0]!;
      assert.equal(mutation.operation, "upsert");
      if (mutation.operation === "remove") return;
      assert.equal(mutation.instanceId, "zai");
      assert.equal(mutation.instance.driver, "claudeAgent");
      assert.equal(mutation.instance.enabled, true);
      assert.deepEqual(
        (mutation.instance.config as Record<string, unknown>).homePath,
        "/h/.t3/lastdrop/endpoints/zai",
      );
    }),
  );

  it.effect("leaves its own unchanged instance alone, and keeps the user's on/off choice", () =>
    Effect.gen(function* () {
      const { spec } = desired();
      const same = yield* run({
        instances: asStored(spec.instance),
        spec: spec.instance,
        owned: true,
      });
      assert.deepEqual(same, { result: { outcome: "unchanged", owned: true }, mutations: [] });

      const changed = desired(catalogFacts({ ...catalog, judges: {} }));
      const off = asStored(spec.instance, { enabled: false, accentColor: "#f00" });
      const { result, mutations } = yield* run({
        instances: off,
        spec: changed.spec.instance,
        owned: true,
      });
      assert.deepEqual(result, { outcome: "updated", owned: true });
      const mutation = mutations[0]!;
      if (mutation.operation === "remove") return assert.fail("expected an upsert");
      assert.equal(mutation.instance.enabled, false);
      assert.equal(mutation.instance.accentColor, "#f00");
      // T3's own fields of the config stay.
      assert.equal((mutation.instance.config as Record<string, unknown>).autoCompactWindow, "");
      const judge = mutation.instance.environment?.find(
        (v) => v.name === "CLAUDE_CODE_AUTO_MODE_MODEL",
      );
      assert.equal(judge?.value, "glm-5.3");
    }),
  );

  it.effect("never touches the user's own instance under the id", () =>
    Effect.gen(function* () {
      const { spec } = desired();
      const users: ProviderInstanceConfigMap = {
        [ProviderInstanceId.make(ZAI)]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Mine",
        },
      };
      const kept = yield* run({ instances: users, spec: spec.instance, owned: false });
      assert.deepEqual(kept, { result: { outcome: "userOwned", owned: false }, mutations: [] });
      const gone = yield* run({ instances: users, spec: undefined, owned: false });
      assert.deepEqual(gone, { result: { outcome: "absent", owned: false }, mutations: [] });
    }),
  );

  it.effect("removes its instance when the provider is removed", () =>
    Effect.gen(function* () {
      const { spec } = desired();
      const { result, mutations } = yield* run({
        instances: asStored(spec.instance),
        spec: undefined,
        owned: true,
      });
      assert.deepEqual(result, { outcome: "removed", owned: false });
      assert.deepEqual(mutations, [
        { operation: "remove", instanceId: ProviderInstanceId.make(ZAI) },
      ]);
      const already = yield* run({ instances: {}, spec: undefined, owned: true });
      assert.deepEqual(already, { result: { outcome: "absent", owned: false }, mutations: [] });
    }),
  );
});

describe("room from usage", () => {
  const step: AgentStep = {
    provider: "zai",
    instanceId: ProviderInstanceId.make(ZAI),
    providerLabel: "Z.ai",
    model: "glm-5.3-flash",
  };

  it.effect("skips an entry whose provider is over its threshold, until the window resets", () =>
    Effect.gen(function* () {
      EndpointRoom.reset();
      const room = makeRoom(
        () => now,
        undefined,
        (s, at) => EndpointRoom.outUntil(s.instanceId, at),
      );
      assert.isTrue(yield* room.hasRoom(step));
      const reset = now + 3_600_000;
      EndpointRoom.setReading(ZAI, {
        at: now - 60_000,
        windows: [{ label: "Session", usedPercent: 92, resetsAt: reset }],
      });
      assert.isFalse(yield* room.hasRoom(step));
      assert.equal(room.outUntil(step), reset);
      EndpointRoom.setThresholds({ sessionThreshold: 0.95, weeklyThreshold: 0.95 });
      assert.isTrue(yield* room.hasRoom(step));
      // A mark from a run at a limit still counts.
      yield* room.markOut(step, markEnd);
      assert.equal(room.outUntil(step), now + 600_000);
      EndpointRoom.reset();
    }),
  );

  it("counts Z.ai's exhausted windows and OpenRouter's 402 as limits, Z.ai throttling not", () => {
    const zaiLimit = {
      class: "usage_limit",
      code: "api_error_429",
      message: 'API Error: 429 {"error":{"code":"1310"}}',
    };
    assert.isTrue(EndpointRoom.isUsageLimit("zai", zaiLimit));
    assert.isFalse(
      EndpointRoom.isUsageLimit("zai", {
        class: "usage_limit",
        code: "api_error_429",
        message: "API Error: 1302: rate limit",
      }),
    );
    assert.isTrue(
      EndpointRoom.isUsageLimit("openrouter", {
        class: "provider_error",
        code: "api_error_402",
        message: "Insufficient credits",
      }),
    );
    assert.isTrue(
      EndpointRoom.isUsageLimit("openrouter", {
        class: "usage_limit",
        code: "api_error_429",
        message: "x",
      }),
    );
    assert.isTrue(
      EndpointRoom.isUsageLimit("claude", { class: "usage_limit", code: null, message: "1302" }),
    );
    assert.isFalse(
      EndpointRoom.isUsageLimit("codex", { class: "provider_error", code: null, message: "x" }),
    );
    assert.isFalse(EndpointRoom.isUsageLimit("zai", undefined));
  });
});
