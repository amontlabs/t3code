/**
 * The accounts view as the server sends it (`AccountsView` in `@t3tools/lastdrop-node`'s monitor.ts; kept
 * here so the web needs no dependency on the server's packages), and how the section words it.
 */
export type SignInState = "ok" | "needsSignIn" | "signedOut";

export interface AccountView {
  readonly key: string;
  readonly name?: string;
  readonly email?: string;
  readonly plan?: string;
  readonly signIn: SignInState;
  readonly signInDetail?: string;
  readonly signInEndsSoon: boolean;
  readonly session?: number;
  readonly weekly?: number;
  readonly readAt?: number;
  readonly error?: string;
  readonly rateLimitedUntil?: number;
  /** Where new work goes now: "Threads", "Subagents", or a model's subagents ("Fable"). */
  readonly nextFor?: ReadonlyArray<string>;
  /** A sign-in started here, waiting for the code its page shows. */
  readonly signInUrl?: string;
  readonly signInError?: string;
}

export interface AccountsView {
  readonly updatedAt: number;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
  readonly accounts: ReadonlyArray<AccountView>;
  /** No account can take work: Claude threads run on Claude Code's own login (`~/.claude`). */
  readonly terminalLogin: boolean;
  /** Accounts "Import from the lastdrop app" would add; only while there are none here. */
  readonly importable?: number;
}

/** One change to the accounts (`AccountChange` in lastdrop-node's claudeAccounts.ts). */
export type AccountChange =
  | { readonly action: "add"; readonly name: string }
  | { readonly action: "rename"; readonly key: string; readonly name: string }
  | { readonly action: "move"; readonly key: string; readonly by: -1 | 1 }
  | { readonly action: "remove"; readonly key: string }
  | { readonly action: "import" }
  | { readonly action: "signIn"; readonly key: string }
  | { readonly action: "submitCode"; readonly key: string; readonly code: string }
  | { readonly action: "cancelSignIn"; readonly key: string };

export interface AccountChangeResponse {
  readonly view: AccountsView;
  readonly signInUrl?: string;
}

/** The newer of the polled view and the last change's answer. */
export const newestView = (
  a: AccountsView | undefined,
  b: AccountsView | undefined,
): AccountsView | undefined =>
  a === undefined ? b : b === undefined ? a : b.updatedAt >= a.updatedAt ? b : a;

export type AccountsResponse = AccountsView | { readonly unavailable: string };

/** The account's name, else its folder's ("Main" for an older list's `main`). */
export const accountTitle = (a: Pick<AccountView, "name" | "key">): string =>
  a.name ?? (a.key === "main" ? "Main" : a.key);

export const usedLabel = (used: number | undefined): string =>
  used === undefined ? "Unknown" : `${Math.round(used)}% used`;

export function signInLabel(a: Pick<AccountView, "signIn" | "signInEndsSoon">): {
  readonly text: string;
  readonly variant: "success" | "warning" | "error";
} {
  switch (a.signIn) {
    case "ok":
      return a.signInEndsSoon
        ? { text: "Sign-in ends soon", variant: "warning" }
        : { text: "Signed in", variant: "success" };
    case "needsSignIn":
      return { text: "Needs sign-in", variant: "error" };
    case "signedOut":
      return { text: "Signed out", variant: "error" };
  }
}

/** Z.ai or OpenRouter, as `GET /api/lastdrop/endpoints` sends it (`EndpointView` in the server's endpointsView.ts). */
export interface EndpointWindowView {
  readonly label: string;
  readonly usedPercent?: number;
  readonly resetsAt?: number;
  readonly detail?: string;
}

export interface EndpointView {
  readonly provider: "zai" | "openrouter";
  readonly title: string;
  readonly instanceId: string;
  readonly configured: boolean;
  readonly problem?: string;
  readonly instance: "ours" | "user" | "none";
  readonly usage?: {
    readonly plan?: string;
    readonly windows: ReadonlyArray<EndpointWindowView>;
    readonly summary?: string;
  };
  readonly readAt?: number;
  readonly error?: string;
  readonly outUntil?: number;
}

export type EndpointsResponse =
  | { readonly updatedAt: number; readonly endpoints: ReadonlyArray<EndpointView> }
  | { readonly unavailable: string };

/** Where the provider stands for agents, in a few words. */
export function endpointStatus(e: EndpointView): {
  readonly text: string;
  readonly variant: "success" | "warning" | "error" | "secondary";
} {
  if (!e.configured) return { text: "No key", variant: "secondary" };
  if (e.problem !== undefined) return { text: "Can't run agents", variant: "error" };
  if (e.outUntil !== undefined) return { text: "Out of room", variant: "warning" };
  if (e.instance === "user") return { text: "Your instance", variant: "secondary" };
  return { text: "Ready", variant: "success" };
}

/** The endpoint's rows shown as meters: those with a share used. */
export const endpointMeters = (e: EndpointView): ReadonlyArray<EndpointWindowView> =>
  (e.usage?.windows ?? []).filter((w) => w.usedPercent !== undefined);
