import { UsageLimitSourceId, type UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import type { AccountView, AccountsView } from "@t3tools/lastdrop-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { UsageLimitSources } from "../../usage/UsageLimitSources.ts";
import type { EndpointsView } from "./endpointsView.ts";
import {
  currentLastdropSources,
  LASTDROP_SOURCE_ID,
  lastdropLimitSource,
  publishLastdropSources,
  toUsageWindow,
} from "./limitSources.ts";
import { wrap } from "./limitSourcesLive.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;

const account = (overrides: Partial<AccountView>): AccountView => ({
  key: "main",
  isMain: true,
  signIn: "ok",
  signInEndsSoon: false,
  windows: [],
  readAt: NOW - 60_000,
  ...overrides,
});

const accounts = (list: AccountView[]): AccountsView => ({
  updatedAt: NOW,
  sessionThreshold: 90,
  weeklyThreshold: 95,
  accounts: list,
});

describe("toUsageWindow", () => {
  it("uses T3's Claude ids, kinds and labels", () => {
    assert.deepStrictEqual(toUsageWindow({ label: "Session", usedPercent: 12.5, resetsAt: NOW }), {
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent: 12.5,
      resetsAt: "2026-11-15T12:00:00.000Z",
    });
    assert.strictEqual(toUsageWindow({ label: "Weekly", usedPercent: 40 })?.id, "seven_day");
    const scoped = toUsageWindow({ label: "Fable Weekly", usedPercent: 101 });
    assert.strictEqual(scoped?.id, "seven_day_fable");
    assert.strictEqual(scoped?.label, "Weekly · Fable");
    assert.strictEqual(scoped?.usedPercent, 100);
    assert.strictEqual(toUsageWindow({ label: "Web Searches", usedPercent: 3 })?.kind, "other");
    assert.isUndefined(toUsageWindow({ label: "Weekly" }));
  });
});

describe("lastdropLimitSource", () => {
  it("is undefined with nothing to show", () => {
    assert.isUndefined(
      lastdropLimitSource({ accounts: undefined, endpoints: undefined, now: NOW }),
    );
  });

  it("lists every Claude account, Ultra without a session window", () => {
    const source = lastdropLimitSource({
      accounts: accounts([
        account({
          email: "a@example.com",
          plan: "Max 20x",
          windows: [
            { label: "Session", usedPercent: 30, resetsAt: NOW + HOUR },
            { label: "Weekly", usedPercent: 50, resetsAt: NOW + 48 * HOUR },
          ],
          resets: { count: 1, expiries: [NOW + 96 * HOUR] },
        }),
        account({
          key: "claude-2",
          isMain: false,
          email: "b@example.com",
          plan: "Ultra",
          windows: [{ label: "Weekly", usedPercent: 10, resetsAt: NOW + 24 * HOUR }],
        }),
        account({ key: "claude-3", isMain: false, signIn: "needsSignIn", windows: [] }),
      ]),
      endpoints: undefined,
      now: NOW,
    });
    assert.ok(source);
    assert.strictEqual(source.id, LASTDROP_SOURCE_ID);
    assert.strictEqual(source.kind, "cliproxy");
    const [main, ultra, signedOut] = source.accounts;
    assert.strictEqual(main?.driver, "claudeAgent");
    assert.strictEqual(main?.email, "a@example.com");
    assert.strictEqual(main?.plan, "Max 20x");
    assert.deepStrictEqual(
      main?.usageLimits.windows.map((window) => window.id),
      ["five_hour", "seven_day"],
    );
    assert.strictEqual(main?.usageLimits.checkedAt, "2026-11-15T11:59:00.000Z");
    assert.strictEqual(main?.usageLimits.resetCredits?.availableCount, 1);
    assert.isUndefined(main?.usageLimits.resetCredits?.nextCreditId);
    assert.deepStrictEqual(
      ultra?.usageLimits.windows.map((window) => window.id),
      ["seven_day"],
    );
    assert.strictEqual(signedOut?.usageLimits.unavailable?.message, "Needs sign-in.");
  });

  it("adds configured Z.ai and OpenRouter with their own drivers", () => {
    const endpoints: EndpointsView = {
      updatedAt: NOW,
      endpoints: [
        {
          provider: "zai",
          title: "Z.ai",
          instanceId: "zai",
          configured: true,
          instance: "ours",
          readAt: NOW,
          usage: {
            title: "Z.ai",
            plan: "Pro",
            windows: [
              { label: "Session", usedPercent: 5 },
              { label: "Weekly", usedPercent: 20 },
            ],
          },
        },
        {
          provider: "openrouter",
          title: "OpenRouter",
          instanceId: "openrouter",
          configured: true,
          instance: "ours",
          error: "OpenRouter refused the key.",
        },
        {
          provider: "openrouter",
          title: "Unused",
          instanceId: "x",
          configured: false,
          instance: "none",
        },
      ],
    };
    const source = lastdropLimitSource({ accounts: undefined, endpoints, now: NOW });
    assert.deepStrictEqual(
      source?.accounts.map((entry) => [entry.id, entry.driver, entry.usageLimits.windows.length]),
      [
        ["Z.ai", "Zai", 2],
        ["OpenRouter", "OpenRouter", 0],
      ],
    );
    assert.strictEqual(
      source?.accounts[1]?.usageLimits.unavailable?.message,
      "OpenRouter refused the key.",
    );
  });
});

const hub: UsageLimitSourceSnapshot = {
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: "2026-11-15T12:00:00.000Z",
  accounts: [],
};

const fakeSources = Layer.succeed(
  UsageLimitSources,
  UsageLimitSources.of({
    current: Effect.succeed([hub]),
    streamChanges: Stream.make([hub]),
    refresh: Effect.void,
    consumeResetCredit: () => Effect.succeed({ outcome: "reset" }),
  }),
);

describe("wrap", () => {
  it.effect("adds lastdrop's source after T3's and refuses to spend its resets", () =>
    Effect.gen(function* () {
      const sources = yield* UsageLimitSources;
      publishLastdropSources([]);
      assert.deepStrictEqual(yield* sources.current, [hub]);
      const source = lastdropLimitSource({
        accounts: accounts([account({ windows: [{ label: "Weekly", usedPercent: 1 }] })]),
        endpoints: undefined,
        now: NOW,
      });
      assert.ok(source);
      assert.isTrue(publishLastdropSources([source]));
      assert.isFalse(
        publishLastdropSources([{ ...source, checkedAt: "2026-11-15T13:00:00.000Z" }]),
      );
      assert.deepStrictEqual(
        (yield* sources.current).map((entry) => entry.id),
        ["hub", "lastdrop"],
      );
      const first = yield* sources.streamChanges.pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(
        [...first].flatMap((list) => list.map((entry) => entry.id)),
        ["hub", "lastdrop"],
      );
      const refused = yield* sources
        .consumeResetCredit({ sourceId: LASTDROP_SOURCE_ID, accountId: "main", creditId: "x" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      const passed = yield* sources.consumeResetCredit({
        sourceId: hub.id,
        accountId: "a",
        creditId: "x",
      });
      assert.strictEqual(passed.outcome, "reset");
      publishLastdropSources([]);
      assert.deepStrictEqual(currentLastdropSources(), []);
    }).pipe(Effect.provide(wrap(fakeSources))),
  );
});
