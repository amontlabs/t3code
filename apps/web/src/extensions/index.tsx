/**
 * lastdrop's web extensions. T3's components render these at small seams listed in FORK.md.
 * With an empty map nothing renders, so the web app behaves exactly as upstream.
 */
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { ComponentType } from "react";

export interface ExtensionInstanceSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}

/** Extra settings sections for a provider instance, by driver kind. */
const extensionInstanceSections: Readonly<
  Record<string, ComponentType<ExtensionInstanceSectionProps>>
> = {};

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
