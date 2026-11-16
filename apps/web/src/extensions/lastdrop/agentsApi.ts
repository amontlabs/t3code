/**
 * Reads and writes lastdrop's agents (`/api/lastdrop/agents`) on an environment. A remote (DPoP) connection
 * gets none: the list lives on the Mac that runs the agents.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { usePreparedConnection } from "~/state/session";

import type { AgentRecord, AgentsEditorView } from "./agentsView";

const AGENTS_ROUTE = "/api/lastdrop/agents";
const IMPORT_ROUTE = "/api/lastdrop/agents/import";

export type AgentsLoad =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "loaded"; readonly view: AgentsEditorView };

export type AgentsWrite = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface Target {
  readonly baseUrl: string;
  readonly bearer: string | undefined;
}

/** One call of the route; never throws. */
async function call(
  target: Target,
  route: string,
  init: { readonly method: string; readonly body?: unknown },
): Promise<
  | { readonly ok: true; readonly view: AgentsEditorView }
  | { readonly ok: false; readonly message: string }
> {
  const response = await fetch(new URL(route, target.baseUrl), {
    method: init.method,
    credentials: target.bearer === undefined ? "include" : "omit",
    headers: {
      ...(target.bearer === undefined ? {} : { authorization: `Bearer ${target.bearer}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }).catch(() => undefined);
  if (response === undefined) return { ok: false, message: "The server couldn't be reached." };
  const body = (await response.json().catch(() => undefined)) as
    | (AgentsEditorView & { readonly error?: string })
    | undefined;
  if (!response.ok) {
    return {
      ok: false,
      message:
        response.status === 403
          ? "This session may not change providers."
          : (body?.error ?? `The server answered ${response.status}.`),
    };
  }
  return body === undefined || !Array.isArray(body.agents)
    ? { ok: false, message: "The server's answer wasn't the agents." }
    : { ok: true, view: body };
}

export function useAgentsEditor(environmentId: EnvironmentId | null) {
  const connection = Option.getOrUndefined(usePreparedConnection(environmentId));
  const baseUrl = connection?.httpBaseUrl;
  const authorization = connection?.httpAuthorization ?? null;
  const bearer = authorization?._tag === "Bearer" ? authorization.token : undefined;
  const remote = authorization?._tag === "Dpop";
  const [load, setLoad] = useState<AgentsLoad>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the server's agent list when the section opens.
  useEffect(() => {
    if (baseUrl === undefined || remote) return;
    let stopped = false;
    void call({ baseUrl, bearer }, AGENTS_ROUTE, { method: "GET" }).then((result) => {
      if (stopped) return;
      setLoad(
        result.ok
          ? { state: "loaded", view: result.view }
          : { state: "failed", message: result.message },
      );
    });
    return () => {
      stopped = true;
    };
  }, [baseUrl, bearer, remote]);

  /** Runs one write at a time; a refused write leaves the list as it was. */
  const write = async (route: string, method: string, body?: unknown): Promise<AgentsWrite> => {
    if (baseUrl === undefined || remote || busyRef.current) {
      return { ok: false, message: "Not ready." };
    }
    busyRef.current = true;
    setBusy(true);
    const result = await call({ baseUrl, bearer }, route, { method, body });
    busyRef.current = false;
    setBusy(false);
    if (result.ok) setLoad({ state: "loaded", view: result.view });
    return result.ok ? { ok: true } : result;
  };

  const save = (agents: ReadonlyArray<AgentRecord>) =>
    write(AGENTS_ROUTE, "PUT", {
      agents,
      ...(load.state === "loaded" ? { revision: load.view.revision } : {}),
    });
  const importFromApp = () => write(IMPORT_ROUTE, "POST");

  return {
    load: remote
      ? ({
          state: "failed",
          message: "Agents are edited on the Mac that runs them.",
        } satisfies AgentsLoad)
      : load,
    busy,
    save,
    importFromApp,
  };
}
