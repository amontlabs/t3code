/**
 * Z.ai and OpenRouter as T3 Claude instances: reconcile (fake and T3's real settings service), catalog
 * facts, the inline `--settings` as T3 parses it, step 4's predicate on the real env, room and limit classes.
 */
// @effect-diagnostics nodeBuiltinImport:off - A temporary ownership file.
// T3's settings module first: it loads the extension lists, which must not be reached halfway through
// another server module.
import "../../serverSettings.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import { isLastdropEndpointEnvironment } from "@t3tools/lastdrop-node";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import type { AgentStep } from "./agents/catalog.ts";
import { makeRoom } from "./agents/room.ts";
import * as EndpointRoom from "./endpointRoom.ts";
import {
  catalogFacts,
  desiredInstance,
  fileOwnership,
  type Ownership,
  readCatalogFile,
  reconcileInstance,
  type Remembered,
  roleModel,
  type Want,
  wantFor,
} from "./endpoints.ts";

const ZAI = ProviderInstanceId.make("zai");
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
  desiredInstance({ provider: "zai", home: "/h/.t3/lastdrop/endpoints/zai", facts, listed: [] });

const memoryOwnership = (ids: ReadonlyArray<string> = []): Ownership & { ids: Set<string> } => {
  const set = new Set(ids);
  const remembered = new Map<string, Remembered>();
  return {
    ids: set,
    has: (id) => set.has(id),
    claim: (id) => void set.add(id),
    release: (id) => void set.delete(id),
    remember: (id, choices) => void remembered.set(id, choices),
    remembered: (id) => remembered.get(id),
  };
};

/** A fake settings store with T3's create/upsert/remove rules. */
const fakeSettings = (initial: ProviderInstanceConfigMap = {}) => {
  let instances: Record<string, ProviderInstanceConfig> = { ...initial };
  const mutations: ProviderInstanceMutation[] = [];
  return {
    mutations,
    get instances() {
      return instances as ProviderInstanceConfigMap;
    },
    set: (id: string, instance: ProviderInstanceConfig) => {
      instances = { ...instances, [id]: instance };
    },
    read: Effect.sync(() => instances as ProviderInstanceConfigMap),
    mutate: (mutation: ProviderInstanceMutation) =>
      Effect.suspend(() => {
        mutations.push(mutation);
        if (mutation.operation === "create" && instances[mutation.instanceId] !== undefined) {
          return Effect.fail("exists" as const);
        }
        if (mutation.operation === "remove") {
          const { [mutation.instanceId]: _gone, ...rest } = instances;
          instances = rest;
        } else instances = { ...instances, [mutation.instanceId]: mutation.instance };
        return Effect.void;
      }),
  };
};

const fakeRead = (settings: { readonly instances: ProviderInstanceConfigMap }) =>
  settings.instances[ZAI];

const present = (spec = desired().spec.instance): Want => ({ kind: "present", spec });

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

  it("tells a missing catalog apart from one that can't be read right now", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-catalog-"));
    try {
      assert.equal(readCatalogFile(`${dir}/none.json`).state, "missing");
      NodeFS.writeFileSync(`${dir}/half.json`, `{"agents": [`);
      assert.equal(readCatalogFile(`${dir}/half.json`).state, "unreadable");
      NodeFS.writeFileSync(`${dir}/ok.json`, JSON.stringify(catalog));
      assert.equal(readCatalogFile(`${dir}/ok.json`).state, "ok");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the instance's launch arguments, as T3 parses them", () => {
  it("carries the endpoint's environment inline in --settings", () => {
    const { spec, environment } = desired();
    const flags = parseCliArgs(spec.instance.config.launchArgs).flags;
    const settings = JSON.parse(flags.settings ?? "") as { env: Record<string, string> };
    assert.deepEqual(settings.env, environment);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    // A home path with a space changes nothing: no path is in the arguments.
    const spaced = desiredInstance({
      provider: "zai",
      home: "/Users/a b/.t3/lastdrop/endpoints/zai",
      facts: catalogFacts(catalog),
      listed: [],
    });
    assert.deepEqual(
      JSON.parse(parseCliArgs(spaced.spec.instance.config.launchArgs).flags.settings ?? ""),
      { env: environment },
    );
  });
});

describe("the query-runner wrapper's predicate (step 4 must skip these)", () => {
  it.effect(
    "holds on the process env T3 builds from the instance, and not on a plain Claude env",
    () =>
      Effect.gen(function* () {
        const host = {
          PATH: "/bin",
          HOME: "/Users/x",
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        };
        const env = yield* mergeProviderInstanceEnvironment(
          desired().spec.instance.environment,
          host,
        );
        assert.isTrue(isLastdropEndpointEnvironment(env));
        assert.isFalse(isLastdropEndpointEnvironment(host));
        assert.equal(env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
      }),
  );
});

describe("reconcile", () => {
  it.effect("makes the instance with T3's create, after recording ownership on disk", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-own-"));
      const file = `${dir}/endpoint-instances.json`;
      const settings = fakeSettings();
      const ownership = fileOwnership(file);
      const result = yield* reconcileInstance({
        instanceId: ZAI,
        want: present(),
        ownership,
        read: settings.read,
        mutate: (mutation) =>
          Effect.sync(() => assert.isTrue(fileOwnership(file).has(ZAI))).pipe(
            Effect.andThen(settings.mutate(mutation)),
          ),
      });
      assert.deepEqual(result, { outcome: "created", ours: true });
      assert.equal(settings.mutations[0]?.operation, "create");
      const made = settings.instances[ZAI]!;
      assert.equal(made.enabled, true);
      assert.equal((made.config as Record<string, unknown>).lastdropEndpoint, "zai");

      // A crash right after T3 saved it: a fresh read of the file still owns it.
      const crashed = fakeSettings();
      const crashFile = `${dir}/crash.json`;
      yield* reconcileInstance({
        instanceId: ZAI,
        want: present(),
        ownership: fileOwnership(crashFile),
        read: crashed.read,
        mutate: (mutation) => crashed.mutate(mutation).pipe(Effect.andThen(Effect.die("crash"))),
      }).pipe(Effect.exit);
      assert.isTrue(fileOwnership(crashFile).has(ZAI));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }),
  );

  it.effect("loses the race to a user's instance saved meanwhile, and lets it go", () =>
    Effect.gen(function* () {
      const settings = fakeSettings();
      const ownership = memoryOwnership();
      let reads = 0;
      const result = yield* reconcileInstance({
        instanceId: ZAI,
        want: present(),
        ownership,
        // The first read sees no instance; then the user saves theirs before lastdrop's create.
        read: Effect.suspend(() => {
          if (reads++ === 1) return settings.read;
          return settings.read.pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                settings.set(ZAI, {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  displayName: "Mine",
                }),
              ),
            ),
          );
        }),
        mutate: settings.mutate,
      });
      assert.deepEqual(result, { outcome: "raced", ours: false });
      assert.equal(settings.instances[ZAI]?.displayName, "Mine");
      assert.isFalse(ownership.has(ZAI));
    }),
  );

  it.effect("never touches the user's own instance under the id, even when the id is listed", () =>
    Effect.gen(function* () {
      const users = fakeSettings({
        [ZAI]: { driver: ProviderDriverKind.make("claudeAgent"), displayName: "Mine" },
      });
      const ownership = memoryOwnership([ZAI]);
      for (const want of [present(), { kind: "remove" } as const, { kind: "keep" } as const]) {
        const result = yield* reconcileInstance({
          instanceId: ZAI,
          want,
          ownership,
          read: users.read,
          mutate: users.mutate,
        });
        assert.equal(result.outcome, "userOwned");
      }
      assert.deepEqual(users.mutations, []);
      assert.isFalse(ownership.has(ZAI));
    }),
  );

  it.effect(
    "updates only lastdrop's fields, keeping the user's name, switch, colour and variables",
    () =>
      Effect.gen(function* () {
        const settings = fakeSettings();
        const ownership = memoryOwnership();
        const run = (want: Want) =>
          reconcileInstance({
            instanceId: ZAI,
            want,
            ownership,
            read: settings.read,
            mutate: settings.mutate,
          });
        yield* run(present());
        const made = settings.instances[ZAI]!;
        settings.set(ZAI, {
          ...made,
          displayName: "GLM",
          enabled: false,
          accentColor: "#f00",
          environment: [
            ...(made.environment ?? []),
            { name: "MY_VAR", value: "1", sensitive: false },
          ],
        });
        assert.equal((yield* run(present())).outcome, "unchanged");
        const changed = desired(catalogFacts({ ...catalog, judges: {} })).spec.instance;
        assert.equal((yield* run(present(changed))).outcome, "updated");
        const after = settings.instances[ZAI]!;
        assert.equal(after.displayName, "GLM");
        assert.equal(after.enabled, false);
        assert.equal(after.accentColor, "#f00");
        assert.equal(after.environment?.find((v) => v.name === "MY_VAR")?.value, "1");
        assert.equal(
          after.environment?.find((v) => v.name === "CLAUDE_CODE_AUTO_MODE_MODEL")?.value,
          "glm-5.3",
        );
        assert.equal((yield* run(present(changed))).outcome, "unchanged");
      }),
  );

  it.effect(
    "keeps everything on doubt, removes on a definite absence, and puts the user's choices back",
    () =>
      Effect.gen(function* () {
        const settings = fakeSettings();
        const ownership = memoryOwnership();
        const run = (want: Want) =>
          reconcileInstance({
            instanceId: ZAI,
            want,
            ownership,
            read: settings.read,
            mutate: settings.mutate,
          });
        yield* run(present());
        settings.set(ZAI, { ...settings.instances[ZAI]!, enabled: false, accentColor: "#0f0" });
        const before = settings.mutations.length;
        assert.equal((yield* run({ kind: "keep" })).outcome, "kept");
        assert.equal(settings.mutations.length, before);
        assert.equal((yield* run({ kind: "remove" })).outcome, "removed");
        assert.isUndefined(settings.instances[ZAI]);
        assert.equal((yield* run({ kind: "keep" })).outcome, "absent");
        assert.equal((yield* run(present())).outcome, "created");
        const remade: ProviderInstanceConfig | undefined = fakeRead(settings);
        assert.equal(remade?.enabled, false);
        assert.equal(remade?.accentColor, "#0f0");
      }),
  );

  it.effect("adopts a marked instance whose id the file lost", () =>
    Effect.gen(function* () {
      const settings = fakeSettings();
      yield* reconcileInstance({
        instanceId: ZAI,
        want: present(),
        ownership: memoryOwnership(),
        read: settings.read,
        mutate: settings.mutate,
      });
      const fresh = memoryOwnership();
      const result = yield* reconcileInstance({
        instanceId: ZAI,
        want: present(),
        ownership: fresh,
        read: settings.read,
        mutate: settings.mutate,
      });
      assert.equal(result.outcome, "unchanged");
      assert.isTrue(fresh.has(ZAI));
    }),
  );
});

describe("what lastdrop wants", () => {
  const facts = catalogFacts(catalog);
  const build = (f: typeof facts) => desired(f).spec;
  it("keeps on doubt and removes only on a definite answer", () => {
    const want = (
      state: { presence: "configured" | "absent" | "unknown"; problem?: string },
      opts: {
        facts?: typeof facts | undefined;
        listed?: [] | undefined;
        provider?: "zai" | "openrouter";
      } = {},
    ) =>
      wantFor({
        state,
        facts: "facts" in opts ? opts.facts : facts,
        listed: "listed" in opts ? opts.listed : [],
        build,
        provider: opts.provider ?? "zai",
      }).kind;
    assert.equal(want({ presence: "absent" }), "remove");
    assert.equal(want({ presence: "unknown" }), "keep");
    assert.equal(want({ presence: "configured", problem: "management key" }), "remove");
    assert.equal(want({ presence: "configured" }), "present");
    assert.equal(want({ presence: "configured" }, { facts: undefined }), "keep");
    assert.equal(
      want({ presence: "configured" }, { provider: "openrouter", listed: undefined }),
      "keep",
    );
    assert.equal(
      want(
        { presence: "configured" },
        { provider: "openrouter", listed: undefined, facts: catalogFacts({}) },
      ),
      "present",
    );
  });
});

const layerServerSettings = ServerSettingsModule.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "lastdrop-endpoints-test-" })),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

describe("through T3's real settings service", () => {
  it.effect("writes once, then nothing while unchanged; the user's switch survives an update", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const ownership = memoryOwnership();
      const writes: ProviderInstanceMutation[] = [];
      const run = (want: Want) =>
        reconcileInstance({
          instanceId: ZAI,
          want,
          ownership,
          read: service.getSettings.pipe(Effect.map((s) => s.providerInstances)),
          mutate: (mutation) =>
            Effect.sync(() => void writes.push(mutation)).pipe(
              Effect.andThen(service.updateProviderInstance(mutation)),
              Effect.asVoid,
            ),
        });
      assert.equal((yield* run(present())).outcome, "created");
      assert.equal((yield* run(present())).outcome, "unchanged");
      assert.equal((yield* run(present())).outcome, "unchanged");
      assert.equal(writes.length, 1);

      // The user turns it off in T3's settings.
      const saved = (yield* service.getSettings).providerInstances[ZAI]!;
      yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: ZAI,
        instance: { ...saved, enabled: false },
      });
      assert.equal((yield* run(present())).outcome, "unchanged");
      const changed = desired(catalogFacts({ ...catalog, judges: {} })).spec.instance;
      assert.equal((yield* run(present(changed))).outcome, "updated");
      assert.equal((yield* run(present(changed))).outcome, "unchanged");
      assert.equal(writes.length, 2);
      const after = (yield* service.getSettings).providerInstances[ZAI]!;
      assert.equal(after.enabled, false);
      assert.equal(after.displayName, "Z.ai");
    }).pipe(Effect.provide(layerServerSettings)),
  );
});

describe("room from usage", () => {
  const step: AgentStep = {
    provider: "zai",
    instanceId: ZAI,
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
    // A number that only looks like a code keeps T3's own reading.
    assert.isFalse(
      EndpointRoom.isUsageLimit("zai", {
        class: "provider_error",
        code: "api_error_400",
        message: "Prompt is 1320 tokens too long",
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
