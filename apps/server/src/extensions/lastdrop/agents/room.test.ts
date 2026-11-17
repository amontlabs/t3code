import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";
import type { PoolRoom } from "@t3tools/lastdrop-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AgentStep } from "./catalog.ts";
import {
  makeRoom,
  POOL_OUT_MS,
  readingFromLimits,
  type RoomMark,
  type RoomReading,
} from "./room.ts";
import { makeStoredMap } from "./store.ts";

const T0 = Date.UTC(2026, 10, 17, 12);
const MIN = 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const until = (ms: number) =>
  `reached a usage limit (until ${iso(ms).slice(0, 16).replace("T", " ")} UTC)`;

const CLAUDE: AgentStep = {
  provider: "claude",
  instanceId: ProviderInstanceId.make("claudeAgent"),
  providerLabel: "Claude",
  model: "sonnet",
};
const ANTIGRAVITY: AgentStep = {
  provider: "antigravity",
  instanceId: ProviderInstanceId.make("antigravity"),
  providerLabel: "Antigravity",
  model: "claude-sonnet-5-5",
};

describe("the agents' room", () => {
  it.effect("an entry on an account pool is out only while every account is at a limit", () =>
    Effect.gen(function* () {
      let at = T0;
      let pool: PoolRoom | null = { full: undefined, roomReadAt: T0 - MIN };
      const marks = makeStoredMap<RoomMark | number>();
      // An older server kept one account's weekly reset against the whole pool, as a bare end time.
      marks.set("claudeAgent\u0000sonnet", T0 + 3 * 24 * 60 * MIN);
      const room = makeRoom(() => at, marks, {
        pool: () => ({ room: () => Effect.succeed(pool), refresh: Effect.void }),
      });
      // Another account has room: so does the entry, and the old mark goes.
      assert.isUndefined(yield* room.out(CLAUDE));
      assert.deepEqual(marks.entries(), []);

      pool = {
        full: [{ name: "main", window: "weekly", until: T0 + 60 * MIN }, { name: "claude-2" }],
        roomReadAt: undefined,
      };
      assert.equal(
        yield* room.out(CLAUDE),
        "has no account with room (main: week used up until 2026-11-17 13:00 UTC; claude-2: at its limit)",
      );

      // A run ended at a limit although a reading showed room. The entry is out, but not until the reset one
      // account gave: a reading taken since that shows room brings it back...
      pool = { full: undefined, roomReadAt: T0 - MIN };
      yield* room.markOut(CLAUDE, iso(T0 + 3 * 24 * 60 * MIN));
      assert.equal(yield* room.out(CLAUDE), until(T0 + POOL_OUT_MS));
      pool = { full: undefined, roomReadAt: T0 + MIN };
      assert.isUndefined(yield* room.out(CLAUDE));
      // ...and so does the pool's own short hold running out without one.
      pool = { full: undefined, roomReadAt: undefined };
      yield* room.markOut(CLAUDE, null);
      at = T0 + POOL_OUT_MS;
      assert.isUndefined(yield* room.out(CLAUDE));
    }),
  );

  it.effect("another entry's limit stands until a reading taken after it shows room", () =>
    Effect.gen(function* () {
      let at = T0;
      let reading: RoomReading | undefined = { at: T0 - MIN, full: false, account: "a" };
      const marks = makeStoredMap<RoomMark | number>();
      const room = makeRoom(() => at, marks, { reading: () => Effect.succeed(reading) });
      const end = T0 + 60 * MIN;
      yield* room.markOut(ANTIGRAVITY, iso(end));
      // The reading from before the limit says nothing against it, nor does a newer one that shows it used up.
      assert.equal(yield* room.out(ANTIGRAVITY), until(end));
      reading = { at: T0 + MIN, full: true, account: "a" };
      assert.equal(yield* room.out(ANTIGRAVITY), until(end));
      // A reset used since, in the app or outside it: the next reading shows room.
      reading = { at: T0 + 2 * MIN, full: false, account: "a" };
      assert.isUndefined(yield* room.out(ANTIGRAVITY));

      // Another sign-in's limit is not this one's, whatever its reading says.
      reading = { at: T0, full: true, account: "a" };
      yield* room.markOut(ANTIGRAVITY, iso(end));
      reading = { at: T0, full: true, account: "b" };
      assert.isUndefined(yield* room.out(ANTIGRAVITY));

      // An older file's bare end time counts as seen when first read: only a later reading speaks against it.
      marks.set("antigravity\u0000claude-sonnet-5-5", end);
      reading = { at: T0 - MIN, full: false, account: "a" };
      assert.equal(yield* room.out(ANTIGRAVITY), until(end));
      reading = undefined;
      at = end;
      assert.isUndefined(yield* room.out(ANTIGRAVITY));
    }),
  );

  it.effect("reads an instance's usage again at most once every two minutes", () =>
    Effect.gen(function* () {
      let at = T0;
      const reads: Array<string> = [];
      let accounts: PoolRoom | null = { full: undefined, roomReadAt: undefined };
      const room = makeRoom(() => at, undefined, {
        pool: (step) =>
          step.provider === "claude"
            ? {
                room: () => Effect.succeed(accounts),
                refresh: Effect.sync(() => void reads.push("claude accounts")),
              }
            : undefined,
        refresh: (step) => Effect.sync(() => void reads.push(step.instanceId)),
      });
      const chain = [ANTIGRAVITY, { ...ANTIGRAVITY, model: "claude-opus-5-5" }, CLAUDE];
      yield* room.refresh(chain);
      yield* room.refresh(chain);
      assert.deepEqual(reads, ["antigravity", "claude accounts"]);
      // A pool with no account here judges nothing: the instance's own usage is what is read again.
      at = T0 + 2 * MIN;
      accounts = null;
      yield* room.refresh([ANTIGRAVITY, CLAUDE]);
      assert.deepEqual(reads.slice(2), ["antigravity", "claudeAgent"]);
    }),
  );

  it("reads an instance's limits for the model's own windows", () => {
    const limits = {
      checkedAt: iso(T0),
      credentialFingerprint: "google-1",
      windows: [
        { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 100 },
        {
          id: "3p-weekly",
          kind: "weekly",
          label: "Claude & GPT (shared) · Weekly",
          usedPercent: 40,
        },
      ],
    } as unknown as ServerProviderUsageLimits;
    assert.deepEqual(readingFromLimits(limits, "claude-sonnet-5-5", T0 + MIN), {
      at: T0,
      full: false,
      account: "google-1",
    });
    assert.isTrue(readingFromLimits(limits, "gemini-3.8-flash", T0 + MIN)?.full);
    // No window is named after the model: any used-up window counts, unless its reset has passed.
    assert.isTrue(readingFromLimits(limits, "glm-5.3-flash", T0 + MIN)?.full);
    const passed = {
      ...limits,
      windows: [{ ...limits.windows[0]!, resetsAt: iso(T0) }],
    } as unknown as ServerProviderUsageLimits;
    assert.isFalse(readingFromLimits(passed, "glm-5.3-flash", T0 + MIN)?.full);
    assert.isUndefined(
      readingFromLimits(
        { ...limits, unavailable: { reason: "probeFailed" } } as ServerProviderUsageLimits,
        "claude-sonnet-5-5",
        T0,
      ),
    );
  });
});
