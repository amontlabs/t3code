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
  onLastdropSources,
  publishLastdropSources,
  resetLastdropSources,
  toUsageWindow,
} from "./limitSources.ts";
import { wrap } from "./limitSourcesLive.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;

const account = (overrides: Partial<AccountView>): AccountView => ({
  key: "main",
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
  terminalLogin: false,
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
          email: "b@example.com",
          plan: "Ultra",
          windows: [{ label: "Weekly", usedPercent: 10, resetsAt: NOW + 24 * HOUR }],
        }),
        account({ key: "claude-3", signIn: "needsSignIn", windows: [] }),
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

  it("a never-read account (no or non-finite read time) never blocks the others", () => {
    const source = lastdropLimitSource({
      accounts: accounts([
        account({ key: "never", readAt: -Infinity, windows: [] }),
        account({
          key: "odd",
          readAt: Number.NaN,
          windows: [{ label: "Weekly", usedPercent: 3, resetsAt: Number.POSITIVE_INFINITY }],
          resets: { count: 1, expiries: [Number.NEGATIVE_INFINITY] },
        }),
        account({ windows: [{ label: "Weekly", usedPercent: 7 }] }),
      ]),
      endpoints: undefined,
      now: NOW,
    });
    assert.ok(source);
    const [never, odd, main] = source.accounts;
    assert.strictEqual(never?.usageLimits.checkedAt, "2026-11-15T12:00:00.000Z");
    assert.strictEqual(never?.usageLimits.unavailable?.message, "No reading yet.");
    assert.isUndefined(odd?.usageLimits.windows[0]?.resetsAt);
    assert.isUndefined(odd?.usageLimits.resetCredits?.nextExpiresAt);
    assert.strictEqual(main?.usageLimits.windows[0]?.usedPercent, 7);
  });

  it("sends no reset count for an account a T3 provider reports, so its Use reset stays", () => {
    const resets = { count: 2, expiries: [NOW + HOUR] };
    const source = lastdropLimitSource({
      accounts: accounts([
        account({
          email: "Own@Example.com",
          windows: [{ label: "Weekly", usedPercent: 1 }],
          resets,
        }),
        account({
          key: "other",
          email: "other@example.com",
          windows: [{ label: "Weekly", usedPercent: 1 }],
          resets,
        }),
      ]),
      endpoints: undefined,
      now: NOW,
      nativeEmails: new Set(["own@example.com"]),
    });
    assert.isUndefined(source?.accounts[0]?.usageLimits.resetCredits);
    assert.strictEqual(source?.accounts[1]?.usageLimits.resetCredits?.availableCount, 2);
  });

  it("an account whose read failed shows its error, not its last numbers", () => {
    const source = lastdropLimitSource({
      accounts: accounts([
        account({ windows: [{ label: "Weekly", usedPercent: 9 }], error: "Anthropic said 500." }),
      ]),
      endpoints: undefined,
      now: NOW,
    });
    const limits = source?.accounts[0]?.usageLimits;
    assert.deepStrictEqual(limits?.windows, []);
    assert.strictEqual(limits?.unavailable?.message, "Anthropic said 500.");
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

  it("adds each Codex account as a Codex driver row: its windows, or why it has none", () => {
    const windows = [
      { id: "primary", kind: "session", label: "Session", usedPercent: 10 },
    ] as const;
    const source = lastdropLimitSource({
      accounts: undefined,
      codex: {
        accounts: [
          {
            key: "Work",
            title: "Work",
            signedIn: true,
            email: "w@x.y",
            usageLimits: { checkedAt: "2026-11-15T12:00:00.000Z", windows },
          },
          { key: "Home", title: "Home", signedIn: false },
          { key: "New", title: "New", signedIn: true },
        ],
      },
      endpoints: undefined,
      now: NOW,
    });
    assert.deepStrictEqual(
      source?.accounts.map((entry) => [
        entry.id,
        entry.driver,
        entry.usageLimits.windows.length,
        entry.usageLimits.unavailable?.message,
      ]),
      [
        ["codex-Work", "codex", 1, undefined],
        ["codex-Home", "codex", 0, "Signed out."],
        ["codex-New", "codex", 0, "No reading yet."],
      ],
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

describe("the feed", () => {
  it("publishes an unchanged reading once, even with accounts that have no reading", () => {
    resetLastdropSources();
    const at = (now: number) =>
      lastdropLimitSource({
        accounts: accounts([
          account({ key: "never", readAt: undefined, windows: [] }),
          account({ windows: [{ label: "Weekly", usedPercent: 1 }] }),
        ]),
        endpoints: undefined,
        now,
      })!;
    assert.isTrue(publishLastdropSources([at(NOW)]));
    assert.isFalse(publishLastdropSources([at(NOW + 15_000)]));
    resetLastdropSources();
  });

  it("is emptied by a reset (the publisher layer's start and end), and listeners hear it", () => {
    const heard: number[] = [];
    const stop = onLastdropSources((snapshots) => heard.push(snapshots.length));
    publishLastdropSources([{ ...hub, id: LASTDROP_SOURCE_ID }]);
    resetLastdropSources();
    stop();
    assert.deepStrictEqual(currentLastdropSources(), []);
    assert.deepStrictEqual(heard, [1, 0]);
  });
});

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
