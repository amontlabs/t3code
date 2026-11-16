/**
 * **Usage → Limits** with one bar per account and window, in place of T3's pooled bars (`UsageLimits.tsx` seam):
 * several Claude accounts are separate limits that lastdrop routes between, so a shared bar hides which one is
 * out. Same props as T3's `UsageLimitsPooled`.
 */
import { collectExternalUsageLinks, type LimitPresentations } from "@t3tools/shared/usageLimits";
import { ExternalLinkIcon } from "lucide-react";

import { providerClients } from "~/components/settings/providerDriverMeta";
import { Button } from "~/components/ui/button";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { useLimitNames } from "./lastdropRoute";
import { UsageLimitsList } from "./UsageLimitsList";
import { limitGroups } from "./usageLimitsView";

export function UsageLimitsByAccount({
  presentations,
  now,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
}) {
  const names = useLimitNames(usePrimaryEnvironmentId());
  const groups = limitGroups({
    presentations,
    now,
    driverLabel: (driver) => providerClients.get(driver)?.label,
    ...names,
  });
  const links = collectExternalUsageLinks(presentations);
  return (
    <div className="flex flex-col gap-6">
      {groups.length === 0 && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      <UsageLimitsList groups={groups} variant="page" now={now} />
      {links.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-4"
        >
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-medium">{link.label}</h2>
            <p className="text-xs break-words text-muted-foreground">
              {[link.accounts.join(", "), link.message].filter(Boolean).join(" · ")}
            </p>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
    </div>
  );
}
