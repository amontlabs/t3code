/**
 * Reads lastdrop's HTTP routes (`GET /api/lastdrop/accounts`, `/codex-accounts`, `/endpoints`) from an environment, polling while
 * `active`, and posts account changes. A remote (DPoP) connection gets none: the accounts live on the Mac that
 * runs them (the server refuses its changes too).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { usePreparedConnection } from "~/state/session";

import type { AccountsResponse } from "./accountsView";
import { CODEX_ACCOUNTS_ROUTE, type CodexAccountsResponse } from "./codexAccountsView";

export const ACCOUNTS_ROUTE = "/api/lastdrop/accounts";
export const ENDPOINTS_ROUTE = "/api/lastdrop/endpoints";
const REFRESH_MS = 30_000;
const FAST_REFRESH_MS = 2_500;

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

/** One POST of a JSON body; a refusal's `{ error }` becomes the failure's message. Never throws. */
async function postRoute<T>(
  route: string,
  baseUrl: string,
  bearer: string | undefined,
  body: unknown,
): Promise<Load<T>> {
  const response = await fetch(new URL(route, baseUrl), {
    method: "POST",
    credentials: bearer === undefined ? "include" : "omit",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  if (response === undefined)
    return { state: "failed", message: "The server couldn't be reached." };
  const answer = (await response.json().catch(() => undefined)) as
    | (T & { readonly error?: string })
    | undefined;
  if (!response.ok || answer === undefined) {
    return {
      state: "failed",
      message: answer?.error ?? `The server answered ${response.status}.`,
    };
  }
  return { state: "loaded", response: answer };
}

function useConnection(environmentId: EnvironmentId | null) {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrUndefined(prepared);
  const authorization = connection?.httpAuthorization ?? null;
  return {
    baseUrl: connection?.httpBaseUrl,
    bearer: authorization?._tag === "Bearer" ? authorization.token : undefined,
    remote: authorization?._tag === "Dpop",
  };
}

/** Posts to a lastdrop route; undefined where changes aren't possible (no connection, or a remote one). */
export function useRouteSender(
  environmentId: EnvironmentId | null,
): (<T>(route: string, body: unknown) => Promise<Load<T>>) | undefined {
  const { baseUrl, bearer, remote } = useConnection(environmentId);
  if (baseUrl === undefined || remote) return undefined;
  return <T>(route: string, body: unknown) => postRoute<T>(route, baseUrl, bearer, body);
}

export function useRoute<T>(
  environmentId: EnvironmentId | null,
  route: string,
  active = true,
): Load<T> {
  return useLiveRoute<T>(environmentId, route, active)[0];
}

/**
 * `useRoute`, plus `show` for a newer answer (a change's) until the next read, and every `FAST_REFRESH_MS` while
 * `fastWhile` holds for what is shown (a sign-in waiting to complete).
 */
export function useLiveRoute<T>(
  environmentId: EnvironmentId | null,
  route: string,
  active = true,
  fastWhile?: (response: T) => boolean,
): readonly [Load<T>, (response: T) => void] {
  const { baseUrl, bearer, remote } = useConnection(environmentId);
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const fast = load.state === "loaded" && fastWhile?.(load.response) === true;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls the server's lastdrop route on a timer while active.
  useEffect(() => {
    if (!active || baseUrl === undefined || remote) return;
    let stopped = false;
    const read = () =>
      void readRoute<T>(route, baseUrl, bearer).then((next) => {
        if (!stopped) setLoad(next);
      });
    read();
    const timer = setInterval(read, fast ? FAST_REFRESH_MS : REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, route, baseUrl, bearer, remote, fast]);

  const show = (response: T) => setLoad({ state: "loaded", response });
  return [
    remote ? { state: "failed", message: "Accounts show on the Mac that runs them." } : load,
    show,
  ];
}

/** lastdrop's Claude and Codex accounts, which name the Usage rows, while `active`. */
export function useLimitNames(environmentId: EnvironmentId | null, active = true) {
  const claude = useRoute<AccountsResponse>(environmentId, ACCOUNTS_ROUTE, active);
  const codex = useRoute<CodexAccountsResponse>(environmentId, CODEX_ACCOUNTS_ROUTE, active);
  return {
    lastdrop:
      claude.state === "loaded" && !("unavailable" in claude.response)
        ? claude.response.accounts
        : undefined,
    lastdropCodex:
      codex.state === "loaded" && !("unavailable" in codex.response)
        ? codex.response.accounts
        : undefined,
  };
}
