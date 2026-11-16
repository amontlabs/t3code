/**
 * lastdrop's Claude accounts: each account's plan, 5-hour and weekly use, and sign-in state, from the server's
 * `GET /api/lastdrop/accounts`, with adding, signing in, renaming, reordering and removing through
 * `POST /api/lastdrop/accounts`; then Z.ai and OpenRouter (`GET /api/lastdrop/endpoints`). Shown on every
 * Claude-driver card; on lastdrop's own Z.ai or OpenRouter instance, only that provider.
 */
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { cn } from "~/lib/utils";

import type { ExtensionInstanceSectionProps } from "../index";
import type {
  AccountChange,
  AccountChangeResponse,
  AccountView,
  AccountsResponse,
  AccountsView,
  EndpointView,
  EndpointsResponse,
} from "./accountsView";
import {
  accountTitle,
  endpointMeters,
  endpointStatus,
  newestView,
  signInLabel,
  usedLabel,
} from "./accountsView";
import { ACCOUNTS_ROUTE, ENDPOINTS_ROUTE, useRoute, useRouteSender } from "./lastdropRoute";

/** Sends one change; resolves to an error message, or undefined once the view is updated. */
type Change = (change: AccountChange) => Promise<string | undefined>;

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

/** The waiting sign-in: the page to open wherever this client runs, and the code it shows. */
function SignInCode(props: { readonly account: AccountView; readonly change: Change }) {
  const { account, change } = props;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const failed = await change({ action: "submitCode", key: account.key, code });
    setBusy(false);
    setError(failed);
    if (failed === undefined) setCode("");
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <p className="text-xs text-muted-foreground">
        Open the sign-in page, sign in with the account for {accountTitle(account)}, then paste the
        code it shows.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="compact"
          variant="outline"
          render={<a href={account.signInUrl} target="_blank" rel="noreferrer" />}
        >
          Open sign-in page
        </Button>
        <div className="min-w-40 flex-1">
          <Input
            size="compact"
            value={code}
            placeholder="Code"
            aria-label="Sign-in code"
            autoComplete="off"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <Button size="compact" type="submit" disabled={busy || code.trim() === ""}>
          Finish
        </Button>
        <Button
          size="compact"
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => void change({ action: "cancelSignIn", key: account.key })}
        >
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

function AccountRow(props: {
  readonly account: AccountView;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
  readonly first: boolean;
  readonly last: boolean;
  /** Undefined where accounts can't change from here. */
  readonly change: Change | undefined;
}) {
  const { account, sessionThreshold, weeklyThreshold, first, last, change } = props;
  const signIn = signInLabel(account);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async (next: AccountChange) => {
    if (change === undefined) return;
    setBusy(true);
    const failed = await change(next);
    setBusy(false);
    setError(failed);
    return failed;
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (renaming === undefined) return;
    if ((await run({ action: "rename", key: account.key, name: renaming })) === undefined) {
      setRenaming(undefined);
    }
  };
  const note = error ?? account.signInError ?? account.signInDetail ?? account.error;
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        {renaming === undefined ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {accountTitle(account)}
            </span>
            {account.plan ? <Badge variant="secondary">{account.plan}</Badge> : null}
            <Badge variant={signIn.variant}>{signIn.text}</Badge>
            {account.email ? (
              <span className="truncate text-xs text-muted-foreground">{account.email}</span>
            ) : null}
          </div>
        ) : (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => void rename(event)}
          >
            <div className="min-w-0 flex-1">
              <Input
                size="compact"
                value={renaming}
                aria-label="Account name"
                autoFocus
                onChange={(event) => setRenaming(event.target.value)}
              />
            </div>
            <Button size="compact" type="submit" disabled={busy}>
              Save
            </Button>
            <Button
              size="compact"
              variant="ghost"
              type="button"
              onClick={() => setRenaming(undefined)}
            >
              Cancel
            </Button>
          </form>
        )}
        {change !== undefined && renaming === undefined ? (
          <div className="flex shrink-0 items-center gap-1">
            {!account.isMain && account.signInUrl === undefined ? (
              <Button
                size="compact"
                variant={account.signIn === "ok" ? "ghost" : "outline"}
                disabled={busy}
                onClick={() => void run({ action: "signIn", key: account.key })}
              >
                {account.signIn === "ok" ? "Sign in again" : "Sign in"}
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Move up"
              disabled={busy || first}
              onClick={() => void run({ action: "move", key: account.key, by: -1 })}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Move down"
              disabled={busy || last}
              onClick={() => void run({ action: "move", key: account.key, by: 1 })}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Rename"
              disabled={busy}
              onClick={() => setRenaming(accountTitle(account))}
            >
              <PencilIcon />
            </Button>
            {account.isMain ? null : (
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label="Remove"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2Icon />
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex gap-4">
        <Meter label="5-hour" used={account.session} limit={sessionThreshold} />
        <Meter label="Weekly" used={account.weekly} limit={weeklyThreshold} />
      </div>
      {change !== undefined && account.signInUrl !== undefined ? (
        <SignInCode account={account} change={change} />
      ) : null}
      {note ? (
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {note}
        </p>
      ) : null}
      <AlertDialog open={confirmRemove} onOpenChange={(open) => !busy && setConfirmRemove(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {accountTitle(account)}?</AlertDialogTitle>
            <AlertDialogDescription>
              lastdrop signs this account out here and stops routing work to it. Its threads stay;
              they continue on another account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run({ action: "remove", key: account.key }).then(
                  (failed) => failed === undefined && setConfirmRemove(false),
                )
              }
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

/** Adding an account, and the one-time import of the lastdrop app's names and order. */
function AddAccount(props: { readonly importable: number | undefined; readonly change: Change }) {
  const { importable, change } = props;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async (next: AccountChange) => {
    setBusy(true);
    const failed = await change(next);
    setBusy(false);
    setError(failed);
    return failed;
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if ((await run({ action: "add", name })) === undefined) setName("");
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void add(event)}>
        <div className="min-w-40 flex-1">
          <Input
            size="compact"
            value={name}
            placeholder="New account's name"
            aria-label="New account's name"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button size="compact" type="submit" disabled={busy || name.trim() === ""}>
          Add account
        </Button>
        {importable ? (
          <Button
            size="compact"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void run({ action: "import" })}
          >
            Import from the lastdrop app ({importable})
          </Button>
        ) : null}
      </form>
      {importable ? (
        <p className="text-xs text-muted-foreground">
          Importing copies the app's account names and order; each account then signs in here.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

function EndpointRow(props: {
  readonly endpoint: EndpointView;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
}) {
  const { endpoint, sessionThreshold, weeklyThreshold } = props;
  const status = endpointStatus(endpoint);
  const meters = endpointMeters(endpoint);
  const notes = [
    endpoint.problem,
    endpoint.error,
    ...(endpoint.usage?.windows ?? []).flatMap((w) =>
      w.detail ? [`${w.label}: ${w.detail}`] : [],
    ),
  ].filter((n): n is string => n !== undefined);
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{endpoint.title}</span>
        {endpoint.usage?.plan ? <Badge variant="secondary">{endpoint.usage.plan}</Badge> : null}
        <Badge variant={status.variant}>{status.text}</Badge>
        {endpoint.usage?.summary ? (
          <span className="text-xs text-muted-foreground">{endpoint.usage.summary} left</span>
        ) : null}
      </div>
      {meters.length > 0 ? (
        <div className="flex gap-4">
          {meters.map((w) => (
            <Meter
              key={w.label}
              label={w.label === "Session" ? "5-hour" : w.label}
              used={w.usedPercent}
              limit={
                w.label === "Session"
                  ? sessionThreshold
                  : w.label === "Weekly"
                    ? weeklyThreshold
                    : 1
              }
            />
          ))}
        </div>
      ) : null}
      {notes.length > 0 ? (
        <p className="text-xs text-muted-foreground">{notes.join(" · ")}</p>
      ) : null}
    </li>
  );
}

export function AccountsSection(props: ExtensionInstanceSectionProps) {
  const load = useRoute<AccountsResponse>(props.environmentId, ACCOUNTS_ROUTE);
  const send = useRouteSender(props.environmentId);
  const [changed, setChanged] = useState<AccountsView | undefined>();
  const change: Change | undefined =
    send === undefined || props.readOnly
      ? undefined
      : async (next) => {
          const result = await send<AccountChangeResponse>(ACCOUNTS_ROUTE, next);
          if (result.state === "failed") return result.message;
          if (result.state === "loaded") setChanged(result.response.view);
          return undefined;
        };
  const endpointsLoad = useRoute<EndpointsResponse>(props.environmentId, ENDPOINTS_ROUTE);
  const endpoints =
    endpointsLoad.state === "loaded" && !("unavailable" in endpointsLoad.response)
      ? endpointsLoad.response.endpoints.filter((e) => e.configured)
      : [];
  // lastdrop's own Z.ai or OpenRouter instance shows only that provider.
  const own = endpoints.find((e) => e.instance === "ours" && e.instanceId === props.instanceId);
  const note =
    load.state === "loading"
      ? "Reading accounts…"
      : load.state === "failed"
        ? load.message
        : "unavailable" in load.response
          ? load.response.unavailable
          : undefined;
  const view = newestView(
    load.state === "loaded" && !("unavailable" in load.response) ? load.response : undefined,
    changed,
  );
  const sessionThreshold = view?.sessionThreshold ?? 0.9;
  const weeklyThreshold = view?.weeklyThreshold ?? 0.9;
  if (own !== undefined) {
    return (
      <SettingsSection title="Usage">
        <ul className="divide-y divide-border text-sm">
          <EndpointRow
            endpoint={own}
            sessionThreshold={sessionThreshold}
            weeklyThreshold={weeklyThreshold}
          />
        </ul>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Accounts">
      <div className="text-sm">
        {view === undefined ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{note}</p>
        ) : (
          <ul className="divide-y divide-border">
            {view.accounts.map((account, index) => (
              <AccountRow
                key={account.key}
                account={account}
                sessionThreshold={view.sessionThreshold}
                weeklyThreshold={view.weeklyThreshold}
                first={index === 0}
                last={index === view.accounts.length - 1}
                change={change}
              />
            ))}
            {change === undefined ? null : (
              <AddAccount importable={view.importable} change={change} />
            )}
            {endpoints.map((endpoint) => (
              <EndpointRow
                key={endpoint.provider}
                endpoint={endpoint}
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
