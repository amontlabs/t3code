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
