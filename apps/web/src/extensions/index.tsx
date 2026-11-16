/**
 * lastdrop's web extensions. T3's components render these at small seams listed in FORK.md.
 * With an empty map nothing renders, so the web app behaves exactly as upstream.
 */
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ComponentType } from "react";

import { AccountsSection } from "./lastdrop/AccountsSection";

export interface ExtensionInstanceSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}

/**
 * Extra settings sections for a provider instance, by driver kind. lastdrop's Claude accounts show on T3's
 * own Claude provider (`claudeAgent`), whose queries lastdrop will route across them.
 */
const extensionInstanceSections: Readonly<
  Record<string, ComponentType<ExtensionInstanceSectionProps>>
> = { claudeAgent: AccountsSection };

/** Renders the extension section for this instance's driver, if any. */
export function ExtensionInstanceSection(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean | undefined;
}) {
  const { environmentId, instanceId, provider, readOnly } = props;
  if (environmentId === undefined || provider === undefined) return null;
  const Section = extensionInstanceSections[provider.driver];
  if (Section === undefined) return null;
  return (
    <Section
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      readOnly={readOnly ?? false}
    />
  );
}

/** The backend each lastdrop model row runs on first, by the model's `subProvider`. */
const LASTDROP_BACKEND_DRIVERS: Readonly<Record<string, ProviderDriverKind>> = {
  Claude: ProviderDriverKind.make("claudeAgent"),
  "Z.ai": ProviderDriverKind.make("claudeAgent"),
  OpenRouter: ProviderDriverKind.make("claudeAgent"),
  Codex: ProviderDriverKind.make("codex"),
  Antigravity: ProviderDriverKind.make("antigravity"),
};

/**
 * The driver whose icon a model row shows: for lastdrop's agents, the backend the agent runs on
 * (Antigravity, Codex, Claude); for every other provider, its own.
 */
export function modelIconDriver(
  driverKind: ProviderDriverKind,
  subProvider: string | undefined,
): ProviderDriverKind {
  if (driverKind !== "lastdropAgents" || subProvider === undefined) return driverKind;
  return LASTDROP_BACKEND_DRIVERS[subProvider] ?? driverKind;
}

/** The sidebar's Usage button, with each account's limits on hover (`SidebarChrome.tsx` seam). */
export { UsageSidebarItem } from "./lastdrop/UsageSidebarItem";

/** **Usage → Limits** with one bar per account (`UsageLimits.tsx` seam). */
export { UsageLimitsByAccount } from "./lastdrop/UsageLimitsByAccount";

/** Sidebar warning when a fork update is stuck (`SidebarChrome.tsx` seam). */
export { LastdropSyncNotice } from "./lastdrop/SyncNotice";
