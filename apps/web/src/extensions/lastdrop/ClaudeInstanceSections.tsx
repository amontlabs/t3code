/**
 * What lastdrop adds to a Claude-driver card, after its Accounts section (`AccountsSection.tsx`, left as it is):
 * on lastdrop's own Z.ai or OpenRouter instance, that provider's key; on T3's main Claude instance, both keys
 * (the place to add the first one); on any other Claude instance, nothing more.
 */
import type { ExtensionInstanceSectionProps } from "../index";
import { AccountsSection } from "./AccountsSection";
import { EndpointKeysSection } from "./EndpointKeysSection";
import { ENDPOINTS_ROUTE, useRoute } from "./lastdropRoute";
import type { EndpointsResponse } from "./accountsView";

export function ClaudeInstanceSections(props: ExtensionInstanceSectionProps) {
  const endpoints = useRoute<EndpointsResponse>(props.environmentId, ENDPOINTS_ROUTE);
  const own =
    endpoints.state === "loaded" && !("unavailable" in endpoints.response)
      ? endpoints.response.endpoints.find(
          (e) => e.instance === "ours" && e.instanceId === props.instanceId,
        )
      : undefined;
  return (
    <>
      <AccountsSection {...props} />
      {own !== undefined ? (
        <EndpointKeysSection {...props} only={own.provider} />
      ) : (props.instanceId as string) === (props.provider.driver as string) ? (
        <EndpointKeysSection {...props} />
      ) : null}
    </>
  );
}
