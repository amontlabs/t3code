/**
 * An MCP form's own "for this session" and "always" choices on Claude's approval card and in the answer its
 * server gets: T3's adapter shows fixed options and fills every approval as "once". Applied where the fork already
 * wraps Claude: the query's `onElicitation` and the instance's session runtime. The test pins the adapter's side.
 */
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  describeMcpElicitation,
  toMcpElicitationResponse,
} from "../../provider/CodexMcpElicitation.ts";

type ScopedDecision = Extract<ProviderApprovalDecision, "acceptForSession" | "acceptAlways">;
type Content = NonNullable<ElicitationResult["content"]>;

/** What a form offers beyond "once": each scope's label and the filled form that grants it. */
export type ElicitationChoices = ReadonlyMap<
  ScopedDecision,
  { readonly label: string; readonly answer: ElicitationResult }
>;

/** The adapter's native id for an elicitation's request and card, from the SDK's control request id. */
const nativeIdOf = (sdkRequestId: string) => `mcp-elicitation:${sdkRequestId}`;

const isScoped = (decision: ProviderApprovalDecision | undefined): decision is ScopedDecision =>
  decision === "acceptForSession" || decision === "acceptAlways";

// As the adapter's `withoutSchemaDefaults`: the card collects consent only, so a schema default must never
// fill a field the user did not see.
const withoutSchemaDefaults = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return schema;
  }
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        key,
        typeof field === "object" && field !== null
          ? Object.fromEntries(Object.entries(field).filter(([name]) => name !== "default"))
          : field,
      ]),
    ),
  };
};

/**
 * What the card may offer for a form that carries its own consent choice (a once value, a scope value or a
 * persistence flag the card fills): the scopes the form offers, none when it offers only once. Undefined for a
 * form with no such field, where T3's card, session grant and answer stand.
 */
export function elicitationChoices(request: ElicitationRequest): ElicitationChoices | undefined {
  if (request.mode === "url" || request.requestedSchema === undefined) return undefined;
  // No `_meta`: the CLI drops a reply's `_meta.persist`, so only a scope the form's content carries counts.
  const payload = {
    serverName: request.serverName,
    threadId: "",
    message: request.message,
    mode: "form" as const,
    requestedSchema: withoutSchemaDefaults(request.requestedSchema),
  };
  const choices = new Map<ScopedDecision, { label: string; answer: ElicitationResult }>();
  for (const option of describeMcpElicitation(
    payload as Parameters<typeof describeMcpElicitation>[0],
  ).options) {
    if (!isScoped(option.decision)) continue;
    // Offered only when this fills as an accept; without defaults each value is an enum string or a boolean.
    const { content } = toMcpElicitationResponse(payload, option.decision);
    choices.set(option.decision, {
      label: option.label,
      answer: { action: "accept", content: content as Content },
    });
  }
  if (choices.size > 0) return choices;
  const once = toMcpElicitationResponse(payload, "accept").content;
  const fillsAField = typeof once === "object" && once !== null && Object.keys(once).length > 0;
  return fillsAField ? choices : undefined;
}

/** T3's card options as the form allows: only the scopes it offers, under its labels, "always" before Approve. */
function withChoices(
  options: ReadonlyArray<ProviderApprovalOption>,
  choices: ElicitationChoices,
): ReadonlyArray<ProviderApprovalOption> {
  const session = choices.get("acceptForSession");
  const always = choices.get("acceptAlways");
  return options.flatMap((option) => {
    if (option.decision === "acceptForSession") {
      return session === undefined ? [] : [{ ...option, label: session.label }];
    }
    if (option.decision === "accept" && always !== undefined) {
      return [{ decision: "acceptAlways" as const, label: always.label }, option];
    }
    return [option];
  });
}

interface OpenInput {
  readonly providerSessionId: string;
  readonly options: {
    readonly onElicitation?:
      | ((
          request: ElicitationRequest,
          options: { signal: AbortSignal; requestId: string },
        ) => Promise<ElicitationResult | null>)
      | undefined;
  };
}

type Adapter = ProviderAdapter.ProviderAdapterV2["Service"];
type AdapterEvent = ProviderAdapter.ProviderAdapterV2Event;

interface OpenElicitation {
  readonly choices: ElicitationChoices;
  requestId?: string;
  answered?: boolean;
  decision?: ScopedDecision;
}

export function makeElicitationChoices() {
  // The elicitations the adapter is answering: per provider session, by native id.
  const open = new Map<string, Map<string, OpenElicitation>>();

  /** The open input whose `onElicitation` answers with the scope the user chose on the card. */
  const onQuery = <I extends OpenInput>(input: I): I => {
    const inner = input.options.onElicitation;
    if (inner === undefined) return input;
    return {
      ...input,
      options: {
        ...input.options,
        onElicitation: async (
          request: ElicitationRequest,
          callbackOptions: { signal: AbortSignal; requestId: string },
        ) => {
          const choices = elicitationChoices(request);
          if (choices === undefined) return inner(request, callbackOptions);
          const entry: OpenElicitation = { choices };
          const nativeId = nativeIdOf(callbackOptions.requestId);
          const session = open.get(input.providerSessionId) ?? new Map<string, OpenElicitation>();
          open.set(input.providerSessionId, session.set(nativeId, entry));
          try {
            const result = await inner(request, callbackOptions);
            // Only an approval T3 itself let through is widened, and only to the scope picked on the card.
            return result?.action === "accept" && entry.decision !== undefined
              ? (choices.get(entry.decision)?.answer ?? result)
              : result;
          } finally {
            session.delete(nativeId);
            if (session.size === 0) open.delete(input.providerSessionId);
          }
        },
      },
    };
  };

  /** The adapter whose sessions show a form's scopes on its card and take them as answers. */
  const onAdapter = (adapter: Adapter): Adapter => ({
    ...adapter,
    openSession: (input) =>
      Effect.map(adapter.openSession(input), (runtime) => {
        const providerSessionId = String(runtime.providerSessionId);
        const show = (event: AdapterEvent): AdapterEvent => {
          if (event.type !== "turn_item.updated") return event;
          const item = event.turnItem;
          if (
            item.type !== "approval_request" ||
            item.requestKind !== "mcp-elicitation" ||
            item.options === undefined ||
            typeof item.nativeItemRef?.nativeId !== "string"
          ) {
            return event;
          }
          const entry = open.get(providerSessionId)?.get(item.nativeItemRef.nativeId);
          if (entry === undefined) return event;
          entry.requestId = String(item.requestId);
          return {
            ...event,
            turnItem: { ...item, options: withChoices(item.options, entry.choices) },
          };
        };
        const { subscribeEvents } = runtime;
        return {
          ...runtime,
          events: Stream.map(runtime.events, show),
          ...(subscribeEvents === undefined
            ? {}
            : {
                subscribeEvents: Effect.map(subscribeEvents, (subscription) => ({
                  ...subscription,
                  events: Stream.map(subscription.events, show),
                })),
              }),
          respondToRuntimeRequest: (response) =>
            Effect.suspend(() => {
              const requestId = String(response.requestId);
              // Only this session's elicitations: another session's response never reaches them.
              const entry = [...(open.get(providerSessionId)?.values() ?? [])].find(
                (candidate) => candidate.requestId === requestId,
              );
              if (entry === undefined) return runtime.respondToRuntimeRequest(response);
              const scope = isScoped(response.decision) ? response.decision : undefined;
              const offered = scope !== undefined && entry.choices.has(scope);
              // An offered scope is the server's grant to keep, so T3 approves once and keeps none of its own.
              // One the card never showed is declined: passed on, T3 would keep a grant the form withheld.
              const forwarded =
                scope === undefined
                  ? response
                  : { ...response, decision: offered ? ("accept" as const) : ("decline" as const) };
              // The first answer T3 takes stands: a later one cannot widen its scope.
              if (entry.answered) return runtime.respondToRuntimeRequest(forwarded);
              entry.answered = true;
              if (offered) entry.decision = scope;
              return runtime.respondToRuntimeRequest(forwarded).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    entry.answered = false;
                    delete entry.decision;
                  }),
                ),
              );
            }),
        };
      }),
  });

  return { onQuery, onAdapter };
}

/** The server's own: the query wrapper and the driver share it. */
export const elicitationChoicesLive = makeElicitationChoices();
