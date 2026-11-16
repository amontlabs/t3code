/**
 * lastdrop's Codex accounts on a Codex provider's card: each account's 5-hour and weekly use and sign-in, with
 * adding, signing in (Codex's device page and code), renaming, reordering and removing, through
 * `GET`/`POST /api/lastdrop/codex-accounts`. New Codex threads open on the account with the most room.
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
import { usedLabel } from "./accountsView";
import {
  CODEX_ACCOUNTS_ROUTE,
  type CodexAccountChange,
  type CodexAccountView,
  type CodexAccountsResponse,
  type CodexAccountsView,
  codexMeters,
} from "./codexAccountsView";
import { type Load, useRoute, useRouteSender } from "./lastdropRoute";

/** Sends one change; resolves to an error message, or undefined once the view is updated. */
type Change = (change: CodexAccountChange) => Promise<string | undefined>;

function Meter(props: { readonly label: string; readonly used: number | undefined }) {
  const { label, used } = props;
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
            used !== undefined && used >= 100 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/** The waiting sign-in: Codex's page to open wherever this client runs, and the code to type there. */
function DeviceCode(props: { readonly account: CodexAccountView; readonly change: Change }) {
  const { account, change } = props;
  if (account.signIn === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Open the sign-in page, sign in with the ChatGPT account for {account.title}, and enter this
        code. The account shows as signed in here once Codex has it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="compact"
          variant="outline"
          render={<a href={account.signIn.url} target="_blank" rel="noreferrer" />}
        >
          Open sign-in page
        </Button>
        <code className="rounded bg-muted px-2 py-1 font-mono text-sm text-foreground">
          {account.signIn.code}
        </code>
        <Button
          size="compact"
          variant="ghost"
          onClick={() => void change({ action: "cancelSignIn", key: account.key })}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AccountRow(props: {
  readonly account: CodexAccountView;
  readonly next: boolean;
  readonly first: boolean;
  readonly last: boolean;
  /** Undefined where accounts can't change from here. */
  readonly change: Change | undefined;
}) {
  const { account, next, first, last, change } = props;
  const [renaming, setRenaming] = useState<string | undefined>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async (step: CodexAccountChange) => {
    if (change === undefined) return;
    setBusy(true);
    const failed = await change(step);
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
  const note = error ?? account.signInError ?? account.error;
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        {renaming === undefined ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{account.title}</span>
            {account.plan ? <Badge variant="secondary">{account.plan}</Badge> : null}
            <Badge variant={account.signedIn ? "success" : "error"}>
              {account.signedIn ? "Signed in" : "Signed out"}
            </Badge>
            {next ? <Badge variant="outline">New threads</Badge> : null}
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
            {account.signIn === undefined ? (
              <Button
                size="compact"
                variant={account.signedIn ? "ghost" : "outline"}
                disabled={busy}
                onClick={() => void run({ action: "signIn", key: account.key })}
              >
                {account.signedIn ? "Sign in again" : "Sign in"}
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
              onClick={() => setRenaming(account.title)}
            >
              <PencilIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label="Remove"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2Icon />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex gap-4">
        {codexMeters(account).map((meter) => (
          <Meter key={meter.label} label={meter.label} used={meter.used} />
        ))}
      </div>
      {change !== undefined ? <DeviceCode account={account} change={change} /> : null}
      {note ? (
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {note}
        </p>
      ) : null}
      <AlertDialog open={confirmRemove} onOpenChange={(open) => !busy && setConfirmRemove(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {account.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              lastdrop deletes this account's sign-in and stops opening Codex threads on it. Its
              threads stay; they continue on another account. Your terminal's Codex login is not
              touched.
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

function AddAccount(props: { readonly change: Change }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const failed = await props.change({ action: "add", name });
    setBusy(false);
    setError(failed);
    if (failed === undefined) setName("");
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void add(event)}>
        <div className="min-w-40 flex-1">
          <Input
            size="compact"
            value={name}
            placeholder="New account's name"
            aria-label="New Codex account's name"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button size="compact" type="submit" disabled={busy || name.trim() === ""}>
          Add account
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

export function CodexAccountsSection(props: ExtensionInstanceSectionProps) {
  const load = useRoute<CodexAccountsResponse>(props.environmentId, CODEX_ACCOUNTS_ROUTE);
  const send = useRouteSender(props.environmentId);
  // A change's answer shows until the next poll brings a newer read.
  const [changed, setChanged] = useState<
    { readonly view: CodexAccountsView; readonly after: Load<CodexAccountsResponse> } | undefined
  >();
  const change: Change | undefined =
    send === undefined || props.readOnly
      ? undefined
      : async (next) => {
          const result = await send<{ readonly view: CodexAccountsView }>(
            CODEX_ACCOUNTS_ROUTE,
            next,
          );
          if (result.state === "failed") return result.message;
          if (result.state === "loaded") setChanged({ view: result.response.view, after: load });
          return undefined;
        };
  const loaded =
    load.state === "loaded" && !("unavailable" in load.response) ? load.response : undefined;
  const view = changed !== undefined && changed.after === load ? changed.view : loaded;
  const note =
    load.state === "loading"
      ? "Reading accounts…"
      : load.state === "failed"
        ? load.message
        : "unavailable" in load.response
          ? load.response.unavailable
          : undefined;
  return (
    <SettingsSection title="Codex accounts">
      <div className="text-sm">
        {view === undefined ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{note}</p>
        ) : (
          <ul className="divide-y divide-border">
            {view.accounts.length === 0 ? (
              <li className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
                Add a ChatGPT account to let lastdrop open Codex threads on whichever has the most
                room. Until one is signed in, Codex uses your own login.
              </li>
            ) : null}
            {view.accounts.map((account, index) => (
              <AccountRow
                key={account.key}
                account={account}
                next={account.key === view.next}
                first={index === 0}
                last={index === view.accounts.length - 1}
                change={change}
              />
            ))}
            {change === undefined ? null : <AddAccount change={change} />}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
