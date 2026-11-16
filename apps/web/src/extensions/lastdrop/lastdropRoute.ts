/**
 * Reads lastdrop's HTTP routes (`GET /api/lastdrop/accounts`, `/endpoints`) from an environment, polling while
 * `active`. A remote (DPoP) connection gets none: the accounts live on the Mac that runs them.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { usePreparedConnection } from "~/state/session";

export const ACCOUNTS_ROUTE = "/api/lastdrop/accounts";
export const ENDPOINTS_ROUTE = "/api/lastdrop/endpoints";
const REFRESH_MS = 30_000;

export type Load<T> =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "loaded"; readonly response: T };

/** One read of a lastdrop route; never throws. */
async function readRoute<T>(
  route: string,
  baseUrl: string,
  bearer: string | undefined,
): Promise<Load<T>> {
  const response = await fetch(new URL(route, baseUrl), {
    credentials: bearer === undefined ? "include" : "omit",
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  }).catch(() => undefined);
  if (response === undefined)
    return { state: "failed", message: "The server couldn't be reached." };
  if (!response.ok) return { state: "failed", message: `The server answered ${response.status}.` };
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  return body === undefined
    ? { state: "failed", message: "The server's answer wasn't accounts." }
    : { state: "loaded", response: body };
}

export function useRoute<T>(
  environmentId: EnvironmentId | null,
  route: string,
  active = true,
): Load<T> {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrUndefined(prepared);
  const baseUrl = connection?.httpBaseUrl;
  const authorization = connection?.httpAuthorization ?? null;
  const bearer = authorization?._tag === "Bearer" ? authorization.token : undefined;
  const remote = authorization?._tag === "Dpop";
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls the server's lastdrop route on a timer while active.
  useEffect(() => {
    if (!active || baseUrl === undefined || remote) return;
    let stopped = false;
    const read = () =>
      void readRoute<T>(route, baseUrl, bearer).then((next) => {
        if (!stopped) setLoad(next);
      });
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, route, baseUrl, bearer, remote]);

  return remote ? { state: "failed", message: "Accounts show on the Mac that runs them." } : load;
}
