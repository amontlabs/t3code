/**
 * The account pools behind the agents' Claude and Codex entries. Plain module state, like `endpointRoom.ts`:
 * each accounts service binds its pool when it starts, and the agents' room asks it instead of keeping an
 * opinion of its own (a limit is one account's, and the pool's router knows every account's room).
 */
import type { PoolRoom } from "@t3tools/lastdrop-node";
import * as Effect from "effect/Effect";

import type { AgentProvider } from "./catalog.ts";

export interface Pool {
  /**
   * The pool's room for a run on `model`, or null while it has no account here: the provider then runs on its
   * own single sign-in, which the agents' room tracks like any other instance.
   */
  readonly room: (model: string) => Effect.Effect<PoolRoom | null>;
  /** Reads every account's usage again from the provider. */
  readonly refresh: Effect.Effect<void>;
}

const pools = new Map<AgentProvider, Pool>();

export const bindPool = (provider: AgentProvider, pool: Pool): Effect.Effect<void> =>
  Effect.sync(() => {
    pools.set(provider, pool);
  });

export const unbindPool = (provider: AgentProvider): Effect.Effect<void> =>
  Effect.sync(() => {
    pools.delete(provider);
  });

export const poolOf = (provider: AgentProvider): Pool | undefined => pools.get(provider);
