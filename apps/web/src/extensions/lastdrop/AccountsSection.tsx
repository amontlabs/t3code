/**
 * lastdrop's Claude accounts, read only: each account's plan, 5-hour and weekly use, and sign-in state, from
 * the server's `GET /api/lastdrop/accounts`. Shown on the Claude provider's settings card.
 */
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { cn } from "~/lib/utils";
import { usePreparedConnection } from "~/state/session";

import type { ExtensionInstanceSectionProps } from "../index";
import type { AccountView, AccountsResponse } from "./accountsView";
import { accountTitle, signInLabel, usedLabel } from "./accountsView";

const ACCOUNTS_ROUTE = "/api/lastdrop/accounts";
const REFRESH_MS = 30_000;

type Load =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "loaded"; readonly response: AccountsResponse };

/** One read of the route; never throws. */
async function readAccounts(baseUrl: string, bearer: string | undefined): Promise<Load> {
  const response = await fetch(new URL(ACCOUNTS_ROUTE, baseUrl), {
    credentials: bearer === undefined ? "include" : "omit",
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  }).catch(() => undefined);
  if (response === undefined)
    return { state: "failed", message: "The server couldn't be reached." };
  if (!response.ok) return { state: "failed", message: `The server answered ${response.status}.` };
  const body = (await response.json().catch(() => undefined)) as AccountsResponse | undefined;
  return body === undefined
    ? { state: "failed", message: "The server's answer wasn't accounts." }
    : { state: "loaded", response: body };
}

function useAccounts(environmentId: ExtensionInstanceSectionProps["environmentId"]): Load {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrUndefined(prepared);
  const baseUrl = connection?.httpBaseUrl;
  const authorization = connection?.httpAuthorization ?? null;
  const bearer = authorization?._tag === "Bearer" ? authorization.token : undefined;
  const remote = authorization?._tag === "Dpop";
  const [load, setLoad] = useState<Load>({ state: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls the server's accounts route on a timer while mounted.
  useEffect(() => {
    if (baseUrl === undefined || remote) return;
    let stopped = false;
    const read = () =>
      void readAccounts(baseUrl, bearer).then((next) => {
        if (!stopped) setLoad(next);
      });
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [baseUrl, bearer, remote]);

  return remote ? { state: "failed", message: "Accounts show on the Mac that runs them." } : load;
}

function Meter(props: {
  readonly label: string;
  readonly used: number | undefined;
  readonly limit: number;
}) {
  const { label, used, limit } = props;
  const width = used === undefined ? 0 : Math.min(Math.max(used, 0), 100);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{usedLabel(used)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            used !== undefined && used >= limit * 100 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function AccountRow(props: {
  readonly account: AccountView;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
}) {
  const { account, sessionThreshold, weeklyThreshold } = props;
  const signIn = signInLabel(account);
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {accountTitle(account)}
        </span>
        {account.plan ? <Badge variant="secondary">{account.plan}</Badge> : null}
        <Badge variant={signIn.variant}>{signIn.text}</Badge>
        {account.email ? (
          <span className="truncate text-xs text-muted-foreground">{account.email}</span>
        ) : null}
      </div>
      <div className="flex gap-4">
        <Meter label="5-hour" used={account.session} limit={sessionThreshold} />
        <Meter label="Weekly" used={account.weekly} limit={weeklyThreshold} />
      </div>
      {account.signInDetail || account.error ? (
        <p className="text-xs text-muted-foreground">{account.signInDetail ?? account.error}</p>
      ) : null}
    </li>
  );
}

export function AccountsSection(props: ExtensionInstanceSectionProps) {
  const load = useAccounts(props.environmentId);
  const note =
    load.state === "loading"
      ? "Reading accounts…"
      : load.state === "failed"
        ? load.message
        : "unavailable" in load.response
          ? load.response.unavailable
          : undefined;
  const view =
    load.state === "loaded" && !("unavailable" in load.response) ? load.response : undefined;
  return (
    <SettingsSection title="Accounts">
      <div className="text-sm">
        {view === undefined ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{note}</p>
        ) : (
          <ul className="divide-y divide-border">
            {view.accounts.map((account) => (
              <AccountRow
                key={account.key}
                account={account}
                sessionThreshold={view.sessionThreshold}
                weeklyThreshold={view.weeklyThreshold}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
