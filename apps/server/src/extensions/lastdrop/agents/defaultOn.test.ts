/**
 * "lastdrop agents" is on in a fresh home (`defaultOn.ts`): after the start-up write, the thread
 * gate (`resolveProjectProviderInstanceEnabled`, what refuses a thread) and the Settings switch
 * (`resolveProviderInstanceEnabled` on the hydrated instance) agree, and a user's own switch is kept.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// serverSettings.ts first, as T3's hydration test does: it breaks an import cycle through the extensions.
import { ServerSettingsService } from "../../../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../../../provider/ProviderInstanceRegistryHydration.ts";
import { ensureAgentsInstanceOn, LASTDROP_AGENTS_INSTANCE as LASTDROP } from "./defaultOn.ts";
import { LASTDROP_AGENTS_DRIVER } from "./settings.ts";

const PROJECT = ProjectId.make("project-1");

/** What the switch shows and what the thread gate decides, at machine and project level. */
const read = (settings: ServerSettings) => {
  const hydrated = deriveProviderInstanceConfigMap(settings)[LASTDROP];
  return {
    switchOn: hydrated !== undefined && resolveProviderInstanceEnabled(hydrated),
    machine: resolveProjectProviderInstanceEnabled(settings, null, LASTDROP),
    project: resolveProjectProviderInstanceEnabled(settings, PROJECT, LASTDROP),
  };
};

/** Runs the start-up write twice against T3's test settings service. */
const start = (overrides: Parameters<typeof ServerSettingsService.layerTest>[0] = {}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const before = read(yield* settings.getSettings);
    const outcome = yield* ensureAgentsInstanceOn(settings);
    const after = yield* settings.getSettings;
    const again = yield* ensureAgentsInstanceOn(settings);
    return { before, outcome, again, after, state: read(after) };
  }).pipe(Effect.provide(ServerSettingsService.layerTest(overrides)));

const ON = { switchOn: true, machine: true, project: true };
const OFF = { switchOn: false, machine: false, project: false };

describe("lastdrop agents on by default", () => {
  it.effect("a fresh home gets the instance on, so threads run and the switch says so", () =>
    Effect.gen(function* () {
      const run = yield* start();
      // The bug this fixes: without the write, the switch is on and the gate refuses.
      assert.deepStrictEqual(run.before, { switchOn: true, machine: false, project: false });
      assert.strictEqual(run.outcome, "created");
      assert.deepStrictEqual(run.after.providerInstances[LASTDROP], {
        driver: LASTDROP_AGENTS_DRIVER,
        enabled: true,
      });
      assert.deepStrictEqual(run.state, ON);
      assert.strictEqual(run.again, "kept");
    }),
  );

  it.effect("a user who switched it off stays off", () =>
    Effect.gen(function* () {
      const run = yield* start({
        providerInstances: { [LASTDROP]: { driver: LASTDROP_AGENTS_DRIVER, enabled: false } },
      });
      assert.strictEqual(run.outcome, "kept");
      assert.strictEqual(run.after.providerInstances[LASTDROP]?.enabled, false);
      assert.deepStrictEqual(run.state, OFF);
    }),
  );

  it.effect("a user's entry is left as it is, including its other fields", () =>
    Effect.gen(function* () {
      const entry = { driver: LASTDROP_AGENTS_DRIVER, enabled: true, accentColor: "#0f0" };
      const run = yield* start({ providerInstances: { [LASTDROP]: entry } });
      assert.strictEqual(run.outcome, "kept");
      assert.deepStrictEqual(run.after.providerInstances[LASTDROP], entry);
      assert.deepStrictEqual(run.state, ON);
    }),
  );

  it.effect("a project override still turns it off for that project only", () =>
    Effect.gen(function* () {
      const run = yield* start({
        projectSettingsOverrides: {
          [PROJECT]: { providerInstances: { [LASTDROP]: { enabled: false } } },
        },
      });
      assert.strictEqual(run.outcome, "created");
      assert.deepStrictEqual(run.state, { switchOn: true, machine: true, project: false });
    }),
  );

  it.effect("an entry written between the read and the write wins", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const userEntry = { driver: LASTDROP_AGENTS_DRIVER, enabled: false };
      const outcome = yield* ensureAgentsInstanceOn({
        // A stale read: the switch writes its entry right after it.
        getSettings: settings.getSettings.pipe(
          Effect.tap(() =>
            settings.updateProviderInstance({
              operation: "upsert",
              instanceId: LASTDROP,
              instance: userEntry,
            }),
          ),
          Effect.map((current) => ({ ...current, providerInstances: {} })),
        ),
        updateProviderInstance: settings.updateProviderInstance,
      });
      assert.strictEqual(outcome, "raced");
      assert.deepStrictEqual((yield* settings.getSettings).providerInstances[LASTDROP], userEntry);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );
});
