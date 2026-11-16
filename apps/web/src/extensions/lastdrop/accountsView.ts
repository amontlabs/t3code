/**
 * The accounts view as the server sends it (`AccountsView` in `@t3tools/lastdrop-node`'s monitor.ts; kept
 * here so the web needs no dependency on the server's packages), and how the section words it.
 */
export type SignInState = "ok" | "needsSignIn" | "signedOut";

export interface AccountView {
  readonly key: string;
  readonly name?: string;
  readonly isMain: boolean;
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
}

export interface AccountsView {
  readonly updatedAt: number;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
  readonly accounts: ReadonlyArray<AccountView>;
}

export type AccountsResponse = AccountsView | { readonly unavailable: string };

/** "Main", the account's name, or its folder's. */
export const accountTitle = (a: Pick<AccountView, "isMain" | "name" | "key">): string =>
  a.name ?? (a.isMain ? "Main" : a.key);

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
