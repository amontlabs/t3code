/**
 * Each account's limits, one bar per window per account (`usageLimitsView.ts`), after lastdrop's own panel: a
 * provider's logo and name, then each account with its plan and where new work goes, Session and Weekly side by
 * side with their resets, and a slim line per model week or other limit. `card` is the Usage button's hover;
 * `page` is **Usage → Limits**, with banked resets to redeem.
 */
import type { ServerProvider } from "@t3tools/contracts";
import type { ReactElement, SVGProps } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { OpenRouterIcon } from "~/components/Icons";
import { ResetCredits } from "~/components/usage/UsageLimits";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { LimitEntry, LimitGroup, LimitMeter } from "./usageLimitsView";

type Variant = "card" | "page";

/** Z.ai's mark (lastdrop's `Logos.swift`). */
function ZaiIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" {...props}>
      <path d="M51.57 23.67l-4.33 6.17c-0.67 0.97-1.80 1.57-3.00 1.57H20.57V23.63C20.53 23.67 51.57 23.67 51.57 23.67z M81.00,23.67 L43.80,76.37 L19.00,76.37 L56.20,23.67 Z M48.43 76.37l4.37-6.20c0.67-0.97 1.80-1.57 3.00-1.57h23.63v7.77H48.43z" />
    </svg>
  );
}

function ProviderLogo({
  driver,
  label,
  className,
}: {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly className: string;
}) {
  if (driver === "Zai") return <ZaiIcon className={cn(className, "text-foreground")} aria-hidden />;
  if (driver === "OpenRouter") {
    return <OpenRouterIcon className={cn(className, "text-foreground")} aria-hidden />;
  }
  return (
    <ProviderInstanceIcon
      driverKind={driver}
      displayName={label}
      showBadge={false}
      className={className}
      iconClassName={className}
    />
  );
}

const NEXT_HELP: Readonly<Record<string, string>> = {
  Threads: "New Claude threads start on this account: it has the most room, counted in plan sizes.",
  Subagents: "New Claude subagents run here: the smallest plan with room under lastdrop's ceiling.",
};

/** Hovering `children` shows `tip`; without a tip, just `children`. */
function Tip({
  tip,
  children,
}: {
  readonly tip: string | undefined;
  readonly children: ReactElement;
}) {
  if (!tip) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="top">{tip}</TooltipPopup>
    </Tooltip>
  );
}

const nextHelp = (badge: string) =>
  NEXT_HELP[badge] ?? `New ${badge} subagents run here: the smallest plan with ${badge} room left.`;

function Bar({ meter, className }: { readonly meter: LimitMeter; readonly className: string }) {
  const left = meter.leftPercent;
  return (
    <span
      role="meter"
      aria-label={`${meter.label} left`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={left}
      aria-valuetext={`${left}% left`}
      className={cn("block overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className={cn(
          "block h-full rounded-full",
          left <= 10 ? "bg-destructive" : left <= 30 ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${left}%` }}
      />
    </span>
  );
}

/** "Session 91% left", a bar, and when it resets. */
function MainMeter({ meter, variant }: { readonly meter: LimitMeter; readonly variant: Variant }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div
        className={cn(
          "flex items-baseline justify-between gap-2",
          variant === "page" ? "text-sm" : "text-xs",
        )}
      >
        <span className="truncate text-muted-foreground">{meter.label}</span>
        <span className="shrink-0 tabular-nums text-foreground">{meter.leftPercent}% left</span>
      </div>
      <Bar meter={meter} className={variant === "page" ? "h-2" : "h-1"} />
      {meter.resets ? (
        <span className="text-2xs tabular-nums text-muted-foreground/70">{meter.resets}</span>
      ) : null}
    </div>
  );
}

/** A model's week ("Fable") or another limit on one line: name, a slim bar, what's left, its reset. */
function MoreMeter({ meter, variant }: { readonly meter: LimitMeter; readonly variant: Variant }) {
  const label = meter.label.replace(/^Weekly · /, "");
  return (
    <div className={cn("flex items-center gap-2", variant === "page" ? "text-sm" : "text-xs")}>
      <span className="max-w-[45%] shrink-0 truncate text-muted-foreground">{label}</span>
      <Bar
        meter={meter}
        className={cn("min-w-8 flex-1", variant === "page" ? "h-1.5" : "h-[3px]")}
      />
      <span className="shrink-0 tabular-nums text-foreground">{meter.leftPercent}% left</span>
      {meter.resets ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">
          {meter.resets.replace(/^Resets in /, "")}
        </span>
      ) : null}
    </div>
  );
}

function Entry({
  entry,
  group,
  alone,
  variant,
  now,
}: {
  readonly entry: LimitEntry;
  readonly group: LimitGroup;
  /** The provider's only account: it carries the provider's logo and name. */
  readonly alone: boolean;
  readonly variant: Variant;
  readonly now: number;
}) {
  const title = alone ? group.label : entry.name;
  const tip = alone ? [entry.name, entry.detail].filter(Boolean).join(" · ") : entry.detail;
  const detail = alone ? undefined : entry.detail;
  const logo = variant === "page" ? "size-4" : "size-3.5";
  const redeem = entry.account?.redeem;
  const credits = entry.account?.limits.resetCredits;
  return (
    <div
      className={cn("flex flex-col", variant === "page" ? "gap-2.5 px-4 py-3" : "gap-1.5 py-1.5")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {alone ? (
          <ProviderLogo driver={group.driver} label={group.label} className={logo} />
        ) : (
          <span aria-hidden className={cn("shrink-0", logo)} />
        )}
        <Tip tip={tip}>
          <span
            className={cn(
              "min-w-0 truncate font-medium text-foreground",
              variant === "page" ? "text-sm" : "text-xs",
            )}
          >
            {title}
          </span>
        </Tip>
        {entry.plan && entry.plan !== title ? (
          <Badge variant="secondary" size="sm">
            {entry.plan}
          </Badge>
        ) : null}
        {variant === "page" && detail ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
        {entry.nextFor.length > 0 ? (
          <span className="ms-auto flex shrink-0 items-center gap-1">
            {entry.nextFor.map((badge) => (
              <Tip key={badge} tip={nextHelp(badge)}>
                <Badge variant="info" size="sm">
                  {badge}
                </Badge>
              </Tip>
            ))}
          </span>
        ) : null}
      </div>
      <div className={cn("flex flex-col", variant === "page" ? "gap-2 ps-5.5" : "gap-1.5 ps-5")}>
        {entry.notice ? (
          <span className="text-xs text-muted-foreground">{entry.notice}</span>
        ) : (
          <>
            {entry.main.length > 0 ? (
              <div className={cn("flex", variant === "page" ? "gap-6" : "gap-3.5")}>
                {entry.main.map((meter) => (
                  <MainMeter key={meter.id} meter={meter} variant={variant} />
                ))}
              </div>
            ) : null}
            {entry.more.map((meter) => (
              <MoreMeter key={meter.id} meter={meter} variant={variant} />
            ))}
          </>
        )}
        {variant === "page" && redeem && credits ? (
          <ResetCredits
            environmentId={redeem.environmentId}
            input={redeem.input}
            credits={credits}
            now={now}
          />
        ) : null}
      </div>
    </div>
  );
}

export function UsageLimitsList({
  groups,
  variant,
  now,
}: {
  readonly groups: ReadonlyArray<LimitGroup>;
  readonly variant: Variant;
  readonly now: number;
}) {
  return (
    <div className={cn("flex flex-col", variant === "page" ? "gap-6" : "gap-2")}>
      {groups.map((group) => {
        const alone = group.entries.length === 1;
        const entries = group.entries.map((entry) => (
          <Entry
            key={entry.key}
            entry={entry}
            group={group}
            alone={alone && variant === "card"}
            variant={variant}
            now={now}
          />
        ));
        return (
          <section key={group.driver} className="flex flex-col gap-1">
            {alone && variant === "card" ? null : (
              <h2
                className={cn(
                  "flex items-center gap-1.5 font-medium",
                  variant === "page"
                    ? "pb-1 text-sm text-foreground"
                    : "text-xs text-muted-foreground",
                )}
              >
                <ProviderLogo
                  driver={group.driver}
                  label={group.label}
                  className={variant === "page" ? "size-4" : "size-3.5"}
                />
                {group.label}
              </h2>
            )}
            {variant === "page" ? (
              <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                {entries}
              </div>
            ) : (
              entries
            )}
          </section>
        );
      })}
    </div>
  );
}
