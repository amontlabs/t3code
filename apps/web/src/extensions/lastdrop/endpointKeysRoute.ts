/**
 * The Z.ai and OpenRouter keys through the server's `/api/lastdrop/endpoints/keys` routes: where each key is, set,
 * clear, and import from the lastdrop app. The server never sends a key back. A remote (DPoP) connection gets
 * none: the keys live in the keychain of the Mac that runs the server.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { usePreparedConnection } from "~/state/session";

const KEYS_ROUTE = "/api/lastdrop/endpoints/keys";

export type EndpointProviderId = "zai" | "openrouter";
/** The fork's own keychain item, the key file or an environment variable, or none. */
export type KeyPlace = "own" | "other" | "none" | "unreadable";

export interface KeyStatusView {
  readonly provider: EndpointProviderId;
  readonly title: string;
  readonly place: KeyPlace;
}

export interface KeysView {
  readonly keys: ReadonlyArray<KeyStatusView>;
  readonly importable: ReadonlyArray<EndpointProviderId>;
}

export type KeysLoad =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | ({ readonly state: "loaded" } & KeysView);

type Request =
  | { readonly kind: "read" }
  | { readonly kind: "set"; readonly provider: EndpointProviderId; readonly key: string }
  | { readonly kind: "clear"; readonly provider: EndpointProviderId }
  | { readonly kind: "import" };

const urlFor = (request: Request): string =>
  request.kind === "read"
    ? KEYS_ROUTE
    : request.kind === "import"
      ? `${KEYS_ROUTE}/import`
      : request.kind === "clear"
        ? `${KEYS_ROUTE}/${request.provider}/clear`
        : `${KEYS_ROUTE}/${request.provider}`;

async function send(
  request: Request,
  baseUrl: string,
  bearer: string | undefined,
): Promise<KeysLoad> {
  const response = await fetch(new URL(urlFor(request), baseUrl), {
    // Writes are POST: T3's CORS allows only GET and POST, and the desktop renderer is cross-origin.
    method: request.kind === "read" ? "GET" : "POST",
    credentials: bearer === undefined ? "include" : "omit",
    headers: {
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      ...(request.kind === "set" ? { "content-type": "application/json" } : {}),
    },
    ...(request.kind === "set" ? { body: JSON.stringify({ key: request.key }) } : {}),
  }).catch(() => undefined);
  if (response === undefined)
    return { state: "failed", message: "The server couldn't be reached." };
  const body = (await response.json().catch(() => undefined)) as
    | (Partial<KeysView> & { error?: string; unavailable?: string })
    | undefined;
  if (!response.ok) {
    return { state: "failed", message: body?.error ?? `The server answered ${response.status}.` };
  }
  if (body?.unavailable !== undefined) return { state: "failed", message: body.unavailable };
  if (body?.keys === undefined)
    return { state: "failed", message: "The server's answer wasn't keys." };
  return { state: "loaded", keys: body.keys, importable: body.importable ?? [] };
}

export function useEndpointKeys(environmentId: EnvironmentId) {
  const connection = Option.getOrUndefined(usePreparedConnection(environmentId));
  const baseUrl = connection?.httpBaseUrl;
  const authorization = connection?.httpAuthorization ?? null;
  const bearer = authorization?._tag === "Bearer" ? authorization.token : undefined;
  const remote = authorization?._tag === "Dpop";
  const [load, setLoad] = useState<KeysLoad>({ state: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the server's key status when the section mounts.
  useEffect(() => {
    if (baseUrl === undefined || remote) return;
    let stopped = false;
    void send({ kind: "read" }, baseUrl, bearer).then((next) => {
      if (!stopped) setLoad(next);
    });
    return () => {
      stopped = true;
    };
  }, [baseUrl, bearer, remote]);

  /** Changes a key, and returns the server's complaint (the view stays as it was), or undefined on success. */
  const change = async (
    request: Exclude<Request, { kind: "read" }>,
  ): Promise<string | undefined> => {
    if (baseUrl === undefined) return "The server isn't ready.";
    const next = await send(request, baseUrl, bearer);
    if (next.state === "loaded") setLoad(next);
    return next.state === "failed" ? next.message : undefined;
  };

  return {
    load: remote
      ? ({ state: "failed", message: "Keys are set on the Mac that runs them." } as const)
      : load,
    change,
  };
}
