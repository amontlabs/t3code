/**
 * The sidebar's Usage button with a hover card listing each account's limits (`UsageLimitsList.tsx`). Same props
 * and look as T3's `SidebarUtilityItem`, which `SidebarChrome.tsx` renders for its other buttons; the card replaces
 * the plain "Usage" tooltip. Clicking still opens **Usage**.
 */
import { useAtomValue } from "@effect/atom-react";
import { useId, useState, type ReactNode } from "react";

import { providerClients } from "~/components/settings/providerDriverMeta";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";

import type { AccountsResponse } from "./accountsView";
import { ACCOUNTS_ROUTE, useRoute } from "./lastdropRoute";
import { UsageLimitsList } from "./UsageLimitsList";
import { limitGroups, limitsSummary } from "./usageLimitsView";

/** Every account's limits, with lastdrop's names and next-work badges while `active` (read from the server). */
function useLimitGroups(now: number, active: boolean) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const accounts = useRoute<AccountsResponse>(usePrimaryEnvironmentId(), ACCOUNTS_ROUTE, active);
  const lastdrop =
    accounts.state === "loaded" && !("unavailable" in accounts.response)
      ? accounts.response.accounts
      : undefined;
  return limitGroups({
    presentations,
    now,
    driverLabel: (driver) => providerClients.get(driver)?.label,
    lastdrop,
  });
}

export function UsageSidebarItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  // Keyboard focus opens the card too; screen readers get it as the button's description, the name stays "Usage".
  const summaryId = useId();
  const groups = useLimitGroups(openedAt, open);
  return (
    <SidebarMenuItem className="shrink-0">
      <span id={summaryId} className="sr-only">
        {limitsSummary(groups)}
      </span>
      <PreviewCard
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setOpenedAt(Date.now());
        }}
      >
        <PreviewCardTrigger
          delay={200}
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-describedby={summaryId}
              onClick={onClick}
              size="icon"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <PreviewCardPopup side="top" align="start">
          <div className="max-h-[70vh] w-80 overflow-y-auto px-3 py-2.5">
            {groups.length === 0 ? (
              <span className="text-muted-foreground text-xs">No account reports limits yet.</span>
            ) : (
              <UsageLimitsList groups={groups} variant="card" now={openedAt} />
            )}
          </div>
        </PreviewCardPopup>
      </PreviewCard>
    </SidebarMenuItem>
  );
}
