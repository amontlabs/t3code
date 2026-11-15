/**
 * agy's own tool calls, as its ACP session sent them (verbatim title, kind, `rawInput`), seen through
 * the Antigravity driver's `onSessionEvent` (a seam). T3's turn items keep only a summary of a call,
 * so lastdrop's command answers read what would really run from here. Bounded, newest kept.
 */
import type { AcpSessionRuntimeEvent } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface RawToolCall {
  readonly title?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  readonly meta?: unknown;
}

const MAX_CALLS = 1_000;
const calls = new Map<string, RawToolCall>();
const waiters = new Map<string, Array<(call: RawToolCall) => void>>();

const key = (instanceId: string, toolCallId: string) => `${instanceId}\u0001${toolCallId}`;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The seam's call, for every event of an Antigravity instance's sessions. Never throws. */
export const observeAntigravitySessionEvent = (
  instanceId: string,
  event: AcpSessionRuntimeEvent,
): void => {
  if (event._tag !== "ToolCallUpdated") return;
  const data = event.toolCall.data;
  const id = key(instanceId, event.toolCall.toolCallId);
  const previous = calls.get(id);
  const title = text(data.title) ?? previous?.title;
  const name = text(data.name) ?? previous?.name;
  const kind = text(data.kind) ?? previous?.kind;
  const rawInput = data.rawInput ?? previous?.rawInput;
  const meta = data.meta ?? previous?.meta;
  const call: RawToolCall = {
    ...(title === undefined ? {} : { title }),
    ...(name === undefined ? {} : { name }),
    ...(kind === undefined ? {} : { kind }),
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(meta === undefined ? {} : { meta }),
  };
  calls.delete(id);
  calls.set(id, call);
  while (calls.size > MAX_CALLS) calls.delete(calls.keys().next().value!);
  const waiting = waiters.get(id);
  if (waiting !== undefined) {
    waiters.delete(id);
    for (const resolve of waiting) resolve(call);
  }
};

/** The call as agy sent it, waiting up to `wait` for its update to arrive; undefined if it never does. */
export const rawToolCall = (
  instanceId: string,
  toolCallId: string,
  wait: Duration.Input,
): Effect.Effect<RawToolCall | undefined> => {
  const id = key(instanceId, toolCallId);
  const known = calls.get(id);
  if (known !== undefined) return Effect.succeed(known);
  return Effect.callback<RawToolCall>((resume) => {
    const onCall = (call: RawToolCall) => resume(Effect.succeed(call));
    waiters.set(id, [...(waiters.get(id) ?? []), onCall]);
    return Effect.sync(() => {
      const list = waiters.get(id)?.filter((each) => each !== onCall);
      if (list === undefined || list.length === 0) waiters.delete(id);
      else waiters.set(id, list);
    });
  }).pipe(
    Effect.timeoutOption(wait),
    Effect.map((found) => (Option.isSome(found) ? found.value : undefined)),
  );
};
