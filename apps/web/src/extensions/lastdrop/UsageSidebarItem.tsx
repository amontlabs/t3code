/**
 * The sidebar's Usage button with a hover card listing each account's limits (`usageHoverView.ts`). Same
 * props and look as T3's `SidebarUtilityItem`, which `SidebarChrome.tsx` renders for its other buttons; the
 * card replaces the plain "Usage" tooltip. Clicking still opens **Usage**.
 */
import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { providerClients } from "~/components/settings/providerDriverMeta";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { environmentPresentations } from "~/state/presentation";

import { type HoverAccount, usageHoverGroups } from "./usageHoverView";

function AccountRow({ account }: { readonly account: HoverAccount }) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{account.name}</span>
        {account.plan ? (
          <span className="shrink-0 text-muted-foreground text-xs">{account.plan}</span>
        ) : null}
      </div>
      {account.notice ? (
        <span className="text-muted-foreground text-xs">{account.notice}</span>
      ) : (
        account.windows.map((window) => (
          <div key={window.id} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate text-muted-foreground">{window.label}</span>
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full",
                  window.leftPercent <= 10
                    ? "bg-destructive"
                    : window.leftPercent <= 30
                      ? "bg-warning"
                      : "bg-primary",
                )}
                style={{ width: `${window.leftPercent}%` }}
              />
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums">
              {window.leftPercent}% left
            </span>
            {window.resets ? (
              <span className="truncate text-muted-foreground">{window.resets}</span>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function UsageLimitsCard({ now }: { readonly now: number }) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const groups = usageHoverGroups(
    presentations,
    now,
    (driver) => providerClients.get(driver)?.label,
  );
  return (
    <div className="flex max-h-[70vh] w-[26rem] flex-col gap-2 overflow-y-auto p-3 text-sm">
      <div className="font-medium">Usage limits</div>
      {groups.length === 0 ? (
        <span className="text-muted-foreground text-xs">No account reports limits yet.</span>
      ) : (
        groups.map((group) => (
          <section key={group.driver} className="flex flex-col">
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wide">
              <ProviderInstanceIcon
                driverKind={group.driver}
                displayName={group.label}
                size="compact"
                showBadge={false}
              />
              <span>{group.label}</span>
            </div>
            <div className="flex flex-col divide-y divide-border">
              {group.accounts.map((account) => (
                <AccountRow key={account.key} account={account} />
              ))}
            </div>
          </section>
        ))
      )}
      <div className="text-muted-foreground text-xs">Click for Usage.</div>
    </div>
  );
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
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  return (
    <SidebarMenuItem className="shrink-0">
      <PreviewCard onOpenChange={(open) => open && setOpenedAt(Date.now())}>
        <PreviewCardTrigger
          delay={200}
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <PreviewCardPopup side="top" align="start">
          <UsageLimitsCard now={openedAt} />
        </PreviewCardPopup>
      </PreviewCard>
    </SidebarMenuItem>
  );
}
