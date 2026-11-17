// An MCP form's own scopes on Claude's card and in its answer, against a fake of T3's adapter: the same card
// options, native id and answers as `onElicitationEffect` in ClaudeAdapterV2.ts, which the last test pins.
// @effect-diagnostics nodeBuiltinImport:off - reads T3's adapter source to pin what the wrapper relies on.
import * as NodeFS from "node:fs";

import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { claudeMcpElicitationAcceptance } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { elicitationChoices, makeElicitationChoices } from "./claudeElicitation.ts";

const T3_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
];

/** LCU's app approval: `session` and `always` are there only when the app may be remembered. */
const lcuForm = (scopes: ReadonlyArray<"session" | "always">): ElicitationRequest => ({
  serverName: "lcu",
  message: "Allow computer use of Notes?",
  mode: "form",
  requestedSchema: {
    type: "object",
    properties: {
      choice: {
        type: "string",
        enum: ["once", ...scopes, "decline"],
        enumNames: [
          "Allow once",
          ...scopes.map((scope) =>
            scope === "session" ? "Allow for this session" : "Always allow",
          ),
          "Decline",
        ],
      },
    },
    required: ["choice"],
  },
});

const approvalOnly: ElicitationRequest = {
  serverName: "deploys",
  message: "Deploy web to production?",
  mode: "form",
  requestedSchema: { type: "object", properties: {} },
};

const once = { action: "accept", content: { choice: "once" } } satisfies ElicitationResult;
const session = { action: "accept", content: { choice: "session" } } satisfies ElicitationResult;
const always = { action: "accept", content: { choice: "always" } } satisfies ElicitationResult;

/** T3's adapter for one session, as far as elicitations go: its card, and its answer per decision. */
const fakeAdapter = () => {
  const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const decisions: Array<ProviderApprovalDecision | undefined> = [];
  const waiting = new Map<string, (decision: ProviderApprovalDecision | undefined) => void>();
  const onElicitation = async (
    request: ElicitationRequest,
    options: { signal: AbortSignal; requestId: string },
  ): Promise<ElicitationResult | null> => {
    const acceptance = claudeMcpElicitationAcceptance(request);
    if (acceptance === undefined) return { action: "decline" };
    const requestId = `request-${options.requestId}`;
    events.push({
      type: "turn_item.updated",
      driver: "claudeAgent",
      turnItem: {
        type: "approval_request",
        requestId,
        requestKind: "mcp-elicitation",
        nativeItemRef: { nativeId: `mcp-elicitation:${options.requestId}` },
        options: T3_OPTIONS,
      },
    } as unknown as ProviderAdapter.ProviderAdapterV2Event);
    const decision = await new Promise<ProviderApprovalDecision | undefined>((resolve) =>
      waiting.set(requestId, resolve),
    );
    if (decision === "accept" || decision === "acceptForSession") return acceptance;
    return { action: decision === "cancel" ? "cancel" : "decline" };
  };
  const adapter = {
    openSession: () =>
      Effect.succeed({
        providerSessionId: "session-1",
        events: Stream.suspend(() => Stream.fromIterable(events)),
        respondToRuntimeRequest: (response: {
          readonly requestId: string;
          readonly decision?: ProviderApprovalDecision;
        }) =>
          Effect.sync(() => {
            decisions.push(response.decision);
            waiting.get(response.requestId)?.(response.decision);
          }),
      }),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  return { adapter, onElicitation, decisions };
};

const neverAborted = new AbortController().signal;

const decide = Effect.fnUntraced(function* (
  request: ElicitationRequest,
  ...decisions: ReadonlyArray<ProviderApprovalDecision>
) {
  const fake = fakeAdapter();
  const wrapper = makeElicitationChoices();
  const { options } = wrapper.onQuery({
    providerSessionId: "session-1",
    options: { onElicitation: fake.onElicitation },
  });
  const runtime = yield* wrapper
    .onAdapter(fake.adapter)
    .openSession({} as ProviderAdapter.ProviderAdapterV2OpenSessionInput);
  const answer = options.onElicitation?.(request, {
    signal: neverAborted,
    requestId: "sdk-1",
  });
  const card = (yield* Stream.runCollect(runtime.events)).at(-1);
  const item = card?.type === "turn_item.updated" ? card.turnItem : undefined;
  if (item?.type !== "approval_request") throw new Error("The adapter showed no card.");
  for (const decision of decisions) {
    yield* runtime.respondToRuntimeRequest({ requestId: item.requestId, decision });
  }
  return {
    options: item.options,
    answer: yield* Effect.promise(() => answer ?? Promise.resolve(null)),
    adapterSaw: fake.decisions,
  };
});

describe("an MCP form's own scopes on Claude's approval card", () => {
  it.effect.each([
    { decision: "accept", answer: once },
    // The server records these grants itself, so T3 approves once and keeps no grant of its own.
    { decision: "acceptForSession", answer: session },
    { decision: "acceptAlways", answer: always },
  ] as const)("answers $decision with the form filled for it", ({ decision, answer }) =>
    Effect.gen(function* () {
      const result = yield* decide(lcuForm(["session", "always"]), decision);
      assert.deepEqual(result.options, [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow" },
        { decision: "accept", label: "Approve" },
      ]);
      assert.deepEqual(result.answer, answer);
      assert.deepEqual(result.adapterSaw, ["accept"]);
    }).pipe(Effect.scoped),
  );

  // LCU leaves `session` and `always` out for an app it will not remember: T3's own session grant would
  // answer "once" for the rest of the session behind its back.
  it.effect.each([
    { scopes: [], shown: ["cancel", "decline", "accept"] },
    { scopes: ["always"], shown: ["cancel", "decline", "acceptAlways", "accept"] },
    { scopes: ["session"], shown: ["cancel", "decline", "acceptForSession", "accept"] },
  ] as const)("offers only the scopes a form with [$scopes] allows", ({ scopes, shown }) =>
    Effect.gen(function* () {
      const withheld = scopes[0] === "session" ? "acceptAlways" : "acceptForSession";
      const result = yield* decide(lcuForm(scopes), withheld);
      assert.deepEqual(
        result.options?.map((option) => option.decision),
        [...shown],
      );
      // A scope the card never showed is declined, and T3 never sees it.
      assert.deepEqual(result.answer, { action: "decline" });
      assert.deepEqual(result.adapterSaw, ["decline"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the first answer when a second one asks for a wider scope", () =>
    Effect.gen(function* () {
      const result = yield* decide(lcuForm(["session", "always"]), "accept", "acceptAlways");
      assert.deepEqual(result.answer, once);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "leaves T3's card, session grant and answer alone for a form with no choice of its own",
    () =>
      Effect.gen(function* () {
        const result = yield* decide(approvalOnly, "acceptForSession");
        assert.deepEqual(result.options, T3_OPTIONS);
        assert.deepEqual(result.answer, { action: "accept", content: {} });
        assert.deepEqual(result.adapterSaw, ["acceptForSession"]);
      }).pipe(Effect.scoped),
  );

  it("never fills a field from a schema default, and offers nothing for a URL or a form the card cannot fill", () => {
    const choice = { type: "string", enum: ["once", "always"] };
    // `apps` is a default the user never saw: the answer leaves it out.
    const withDefault = elicitationChoices({
      ...approvalOnly,
      requestedSchema: {
        type: "object",
        properties: { choice, apps: { type: "string", default: "all" } },
      },
    });
    assert.deepEqual(
      [...(withDefault?.values() ?? [])],
      [{ label: "Always allow", answer: always }],
    );
    for (const request of [
      { ...lcuForm(["session", "always"]), mode: "url", url: "https://example.com/auth" },
      {
        ...approvalOnly,
        requestedSchema: {
          type: "object",
          properties: { choice, apps: { type: "string", default: "all" } },
          required: ["apps"],
        },
      },
    ] satisfies ReadonlyArray<ElicitationRequest>) {
      assert.isUndefined(elicitationChoices(request));
    }
  });

  // When one fails after a sync: read what upstream changed, adapt `claudeElicitation.ts` (never the adapter).
  it("T3's adapter still names, shows and answers an elicitation as the wrapper expects", () => {
    const adapter = NodeFS.readFileSync(
      new URL("../../orchestration-v2/Adapters/ClaudeAdapterV2.ts", import.meta.url),
      "utf8",
    );
    assert.include(
      adapter,
      "const nativeRequestId = `mcp-elicitation:${callbackOptions.requestId}`;",
    );
    assert.include(adapter, "options: CLAUDE_MCP_ELICITATION_OPTIONS,");
    assert.match(
      adapter,
      /const CLAUDE_MCP_ELICITATION_OPTIONS[\s\S]{0,120}"cancel"[\s\S]{0,60}"decline"[\s\S]{0,80}"acceptForSession"[\s\S]{0,80}"accept", label: "Approve"/u,
    );
    // "accept" answers with the filled form and records no session grant of T3's.
    assert.match(adapter, /return resolved === "accept"\s+\? acceptance/u);
    assert.include(adapter, "onElicitation,");
    // The session id the query opens with is the one the session runtime reports: the two wrappers meet on it.
    assert.match(
      adapter,
      /\.open\(\{\s+threadId: turnInput\.threadId,\s+providerSessionId: input\.providerSessionId,\s+options: queryOptions,/u,
    );
    assert.match(
      adapter,
      /driver: CLAUDE_PROVIDER,\s+providerSessionId: input\.providerSessionId,[\s\S]{0,200}events: Stream\.fromEffectRepeat/u,
    );
  });
});
