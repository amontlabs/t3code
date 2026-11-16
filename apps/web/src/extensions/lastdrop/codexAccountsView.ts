/**
 * What `GET /api/lastdrop/codex-accounts` answers (the server's `extensions/lastdrop/codex/accounts.ts`), and the
 * two bars each account shows.
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";

export const CODEX_ACCOUNTS_ROUTE = "/api/lastdrop/codex-accounts";

export interface CodexAccountView {
  readonly key: string;
  readonly title: string;
  readonly signedIn: boolean;
  readonly email?: string;
  readonly plan?: string;
  readonly usageLimits?: ServerProviderUsageLimits;
  readonly readAt?: number;
  readonly error?: string;
  readonly signIn?: { readonly url: string; readonly code: string };
  readonly signInError?: string;
}

export interface CodexAccountsView {
  readonly accounts: ReadonlyArray<CodexAccountView>;
  readonly next?: string;
}

export type CodexAccountsResponse = CodexAccountsView | { readonly unavailable: string };

export type CodexAccountChange =
  | { readonly action: "add"; readonly name: string }
  | { readonly action: "rename"; readonly key: string; readonly name: string }
  | { readonly action: "move"; readonly key: string; readonly by: -1 | 1 }
  | { readonly action: "remove"; readonly key: string }
  | { readonly action: "signIn"; readonly key: string }
  | { readonly action: "cancelSignIn"; readonly key: string };

export interface CodexMeter {
  readonly label: string;
  readonly used: number | undefined;
}

/** The 5-hour and the longest (weekly, or monthly on Free) window; unknown before a reading. */
export function codexMeters(account: CodexAccountView): ReadonlyArray<CodexMeter> {
  const windows = account.usageLimits?.windows ?? [];
  const session = windows.find((w) => w.kind === "session");
  const longest =
    windows.find((w) => w.kind === "weekly") ?? windows.find((w) => w.kind === "monthly");
  return [
    { label: "5-hour", used: session?.usedPercent },
    { label: longest?.kind === "monthly" ? "Monthly" : "Weekly", used: longest?.usedPercent },
  ];
}
