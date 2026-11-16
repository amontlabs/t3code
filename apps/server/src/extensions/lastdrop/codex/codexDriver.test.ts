import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BUILT_IN_DRIVERS } from "../../../provider/builtInDrivers.ts";
import { CodexDriver } from "../../../provider/Drivers/CodexDriver.ts";
import { accountSnapshot, insulateCodex, LastdropCodexDriver } from "./codexDriver.ts";

const model = (slug: string): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
});

// T3's CLI-login instance after a terminal `codex logout` (`accountProbeStatus` in CodexProvider.ts).
const signedOut: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.130.0",
  status: "error",
  auth: { status: "unauthenticated" },
  message: "Codex CLI is not authenticated. Run `codex login` and try again.",
  checkedAt: "2026-11-16T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-16T12:00:00.000Z",
    windows: [],
    unavailable: { reason: "probeFailed" },
  },
};

const { instanceId: _id, driver: _driver, ...draftBase } = signedOut;
const accountDraft: ServerProviderDraft = {
  ...draftBase,
  version: "0.131.0",
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt", email: "a@example.com", label: "Pro" },
  message: undefined,
  models: [model("gpt-6.1-sol")],
};

/** A text generation that says which home ran it. */
const textGenerationOn = (home: string): ProviderTextGeneration =>
  ({
    generateThreadTitle: () => Effect.succeed({ title: home }),
  }) as unknown as ProviderTextGeneration;

const skill = (name: string): ServerProvider["skills"][number] => ({
  name,
  path: `${name}/SKILL.md`,
  enabled: true,
});

const instanceWith = (snapshot: ServerProvider): ProviderInstance =>
  ({
    instanceId: snapshot.instanceId,
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.make(snapshot),
    },
    // T3's read runs an app-server in `~/.codex`.
    snapshotForCwd: (cwd: string) =>
      Effect.succeed({ ...snapshot, skills: [skill(`~/.codex:${cwd}`)] }),
    textGeneration: textGenerationOn("~/.codex"),
  }) as unknown as ProviderInstance;

describe("T3's Codex driver as lastdrop runs it", () => {
  it("reads a signed-out Codex login from the fork account: its models, signed in as lastdrop's accounts", () => {
    const insulated = accountSnapshot(signedOut, accountDraft);
    assert.strictEqual(insulated.status, "ready");
    assert.deepStrictEqual(insulated.auth, {
      status: "authenticated",
      type: "lastdrop",
      label: "lastdrop accounts",
    });
    assert.deepStrictEqual(insulated.models, [model("gpt-6.1-sol")]);
    assert.strictEqual(insulated.version, "0.131.0");
    assert.strictEqual(insulated.instanceId, signedOut.instanceId);
    // The account's limits are lastdrop's limit source's row; the terminal login's would read as T3's.
    assert.isUndefined(insulated.usageLimits);
    assert.isUndefined(insulated.message);
    // No account, a failed account probe, a signed-in or missing Codex: T3's snapshot as it is.
    assert.strictEqual(accountSnapshot(signedOut, undefined), signedOut);
    const failed = { ...accountDraft, status: "error" as const };
    assert.strictEqual(accountSnapshot(signedOut, failed), signedOut);
    const signedIn = {
      ...signedOut,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
    };
    assert.strictEqual(accountSnapshot(signedIn, accountDraft), signedIn);
    const missing = { ...signedOut, installed: false };
    assert.strictEqual(accountSnapshot(missing, accountDraft), missing);
  });

  it.effect(
    "probes the picked account once per T3 check and runs text generation and skills there",
    () =>
      Effect.gen(function* () {
        const probed: string[] = [];
        let account: { account: string; home: string } | undefined = { account: "A", home: "/a" };
        const instance = insulateCodex(instanceWith(signedOut), {
          pick: Effect.sync(() => account),
          probe: (home) =>
            Effect.sync(() => {
              probed.push(home);
              return accountDraft;
            }),
          skills: (home, cwd) => Effect.succeed([skill(`${home}:${cwd}`)]),
          textGeneration: (home) => Effect.succeed(textGenerationOn(home)),
        });
        const generate = instance.textGeneration.generateThreadTitle as (
          input: unknown,
        ) => Effect.Effect<{ readonly title: string }>;
        assert.strictEqual((yield* instance.snapshot.getSnapshot).status, "ready");
        assert.strictEqual((yield* instance.snapshot.refresh).status, "ready");
        assert.deepStrictEqual(probed, ["/a"]);
        assert.strictEqual((yield* generate({})).title, "/a");
        const workspace = yield* instance.snapshotForCwd!("/repo");
        assert.deepStrictEqual(workspace.skills, [skill("/a:/repo")]);
        assert.strictEqual(workspace.status, "ready");

        // With no fork account signed in, T3's own login: its snapshot, text generation and skills.
        account = undefined;
        const plain = insulateCodex(instanceWith(signedOut), {
          pick: Effect.sync(() => account),
          probe: () => Effect.die("no account to probe"),
          skills: () => Effect.die("no account to probe"),
          textGeneration: () => Effect.die("no account to run on"),
        });
        assert.strictEqual(yield* plain.snapshot.getSnapshot, signedOut);
        const plainGenerate = plain.textGeneration.generateThreadTitle as typeof generate;
        assert.strictEqual((yield* plainGenerate({})).title, "~/.codex");
        assert.deepStrictEqual((yield* plain.snapshotForCwd!("/repo")).skills, [
          skill("~/.codex:/repo"),
        ]);
      }),
  );

  // The fork's driver replaces T3's without a seam of its own: it comes last in the server's driver list, and the
  // registry keeps the last driver of a kind (`claudeDriver.test.ts` pins that rule). If a sync breaks it, the
  // Codex card is T3's again.
  it("is the Codex driver the server's registry keeps", () => {
    const codex = BUILT_IN_DRIVERS.filter((d) => d.driverKind === "codex");
    assert.deepStrictEqual(codex, [CodexDriver, LastdropCodexDriver]);
    const { create: _t3, ...t3 } = CodexDriver;
    const { create: _fork, ...fork } = LastdropCodexDriver;
    assert.deepStrictEqual(
      { ...fork, defaultConfig: fork.defaultConfig() },
      { ...t3, defaultConfig: t3.defaultConfig() },
    );
  });
});
