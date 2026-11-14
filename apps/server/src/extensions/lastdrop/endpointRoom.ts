/**
 * Z.ai and OpenRouter as the agents driver sees them: whether the provider has room (from the usage lastdrop
 * last read, `endpoints.ts` keeps it current), and whether a failed run was a usage limit (their own error
 * classes beside T3's). Plain module state: the agents driver reads it, the endpoints service writes it.
 */
import {
  endpointLimitReached,
  endpointOutUntil,
  type EndpointProvider,
  type EndpointWindow,
  isEndpointProvider,
} from "@t3tools/lastdrop-node";

interface Reading {
  readonly windows: ReadonlyArray<EndpointWindow>;
  readonly at: number;
}

const readings = new Map<string, Reading>();
let thresholds = { sessionThreshold: 0.9, weeklyThreshold: 0.9 };

/** The endpoints service's latest reading of the provider's instance. */
export const setReading = (instanceId: string, reading: Reading | undefined): void => {
  if (reading === undefined) readings.delete(instanceId);
  else readings.set(instanceId, reading);
};

export const setThresholds = (next: typeof thresholds): void => {
  thresholds = next;
};

/** Until when (epoch ms) the instance's provider is out of room; undefined when it has room or is unknown. */
export const outUntil = (instanceId: string, now: number): number | undefined =>
  endpointOutUntil(readings.get(instanceId), thresholds, now);

/**
 * Whether a failed run on `provider` ended at a usage limit: Z.ai's and OpenRouter's own classes first
 * (Z.ai throttling is a 429 but no limit; OpenRouter's 402 is one), T3's class otherwise.
 */
export const isUsageLimit = (
  provider: string,
  failure:
    | { readonly class: string; readonly message?: string; readonly code?: string | null }
    | undefined,
): boolean => {
  if (failure === undefined) return false;
  const own = isEndpointProvider(provider)
    ? endpointLimitReached(provider as EndpointProvider, failure)
    : undefined;
  return own ?? failure.class === "usage_limit";
};

/** Tests start clean. */
export const reset = (): void => {
  readings.clear();
  thresholds = { sessionThreshold: 0.9, weeklyThreshold: 0.9 };
};
