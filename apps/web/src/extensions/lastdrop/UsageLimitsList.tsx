/**
 * Each account's limits (`usageLimitsView.ts`), after lastdrop's own panel. `card` is the Usage button's hover;
 * `page` is **Usage → Limits**: banked resets to redeem, OpenRouter's spend per key, and drag handles that set
 * the order both follow.
 */
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type KeyboardSensorProps,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ServerProvider, UsageLimitSourceKey } from "@t3tools/contracts";
import { GripVerticalIcon } from "lucide-react";
import type { ReactElement, ReactNode, SVGProps } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { OpenRouterIcon } from "~/components/Icons";
import { ResetCredits } from "~/components/usage/UsageLimits";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { LimitOrder } from "./usageLimitsOrder";
import type { LimitEntry, LimitGroup, LimitMeter } from "./usageLimitsView";

type Variant = "card" | "page";
type Reorder = (update: (order: LimitOrder) => LimitOrder) => void;

const leftText = (meter: LimitMeter) => meter.detail ?? `${meter.leftPercent}% left`;
const dollars = (amount: number) => `$${amount.toFixed(2)}`;

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
        <span className="shrink-0 tabular-nums text-foreground">{leftText(meter)}</span>
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
      <span className="shrink-0 tabular-nums text-foreground">{leftText(meter)}</span>
      {meter.resets ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">
          {meter.resets.replace(/^Resets in /, "")}
        </span>
      ) : null}
    </div>
  );
}

/** One OpenRouter key's spend (lastdrop's `KeyRow`): its total, what's left of its limit, today and this month. */
function KeyRow({ spend }: { readonly spend: UsageLimitSourceKey }) {
  const limit = spend.limit !== undefined && spend.limit > 0 ? spend.limit : undefined;
  const left =
    limit === undefined ? undefined : (spend.limitRemaining ?? Math.max(limit - spend.total, 0));
  const periods = [
    spend.today === undefined ? undefined : `Today ${dollars(spend.today)}`,
    spend.month === undefined ? undefined : `This month ${dollars(spend.month)}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            "min-w-0 truncate",
            spend.disabled ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {spend.name}
          {spend.disabled ? " (disabled)" : ""}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{dollars(spend.total)}</span>
      </div>
      {limit !== undefined && left !== undefined ? (
        <>
          <Bar
            meter={{
              id: spend.name,
              label: spend.name,
              leftPercent: Math.round(Math.min(Math.max((left / limit) * 100, 0), 100)),
              resets: null,
            }}
            className="h-1"
          />
          <span className="tabular-nums text-muted-foreground">
            {dollars(left)} of {dollars(limit)} left
          </span>
        </>
      ) : null}
      {periods.length > 0 ? (
        <span className="tabular-nums text-muted-foreground">{periods.join(" · ")}</span>
      ) : null}
    </div>
  );
}

/** A row the page's list can drag; `children` gets the handle to place, or null where nothing can move. */
function Sortable({
  id,
  label,
  enabled,
  className,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly className?: string;
  readonly children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !enabled });
  const handle = enabled ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${label}`}
      className="flex size-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
    >
      <GripVerticalIcon className="size-3.5" />
    </button>
  ) : null;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && "relative z-10 rounded-lg bg-background shadow-md")}
    >
      {children(handle)}
    </div>
  );
}

/**
 * dnd-kit's keyboard sensor, listening on the handle instead of the document: Base UI's dialog stops arrow keys
 * (and Escape, which would close the Usage dialog) before they reach the document. dnd-kit adds the listener a
 * tick after construction, so swapping it here takes effect.
 */
class HandleKeyboardSensor extends KeyboardSensor {
  constructor(props: KeyboardSensorProps) {
    super(props);
    const handle = props.event.target;
    if (!(handle instanceof HTMLElement)) return;
    const added: Array<(event: Event) => void> = [];
    Object.assign(this, {
      listeners: {
        add: (_type: string, handler: (event: Event) => void) => {
          const listener = (event: Event) => {
            event.stopPropagation();
            handler(event);
          };
          added.push(listener);
          handle.addEventListener("keydown", listener);
        },
        removeAll: () => {
          for (const listener of added.splice(0)) handle.removeEventListener("keydown", listener);
        },
      },
    });
  }
}

/** A vertical drag list of `ids`; dropping one calls `onMove` with the new order. */
function SortableList({
  ids,
  onMove,
  children,
}: {
  readonly ids: ReadonlyArray<string>;
  readonly onMove: (next: ReadonlyArray<string>) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(HandleKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const list = [...ids];
    onMove(
      arrayMove(list, list.indexOf(String(event.active.id)), list.indexOf(String(event.over.id))),
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

function Entry({
  entry,
  group,
  alone,
  variant,
  now,
  handle = null,
}: {
  readonly entry: LimitEntry;
  readonly group: LimitGroup;
  /** The page's drag handle, in place of the logo's room. */
  readonly handle?: ReactNode;
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
          (handle ?? <span aria-hidden className={cn("shrink-0", logo)} />)
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
        {variant === "page" && entry.keys.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
            {entry.keys.map((spend) => (
              <KeyRow key={spend.name} spend={spend} />
            ))}
          </div>
        ) : null}
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
  onReorder,
}: {
  readonly groups: ReadonlyArray<LimitGroup>;
  readonly variant: Variant;
  readonly now: number;
  /** Lets the page drag providers and accounts; the card only follows the order. */
  readonly onReorder?: Reorder | undefined;
}) {
  const sortable = variant === "page" && onReorder !== undefined;
  const providerIds = groups.map((group) => String(group.driver));
  const sections = groups.map((group) => {
    const alone = group.entries.length === 1;
    const accountIds = group.entries.map((entry) => entry.orderId);
    const entries = group.entries.map((entry) =>
      sortable ? (
        <Sortable
          key={entry.key}
          id={entry.orderId}
          label={entry.name}
          enabled={group.entries.length > 1}
        >
          {(handle) => (
            <Entry
              entry={entry}
              group={group}
              alone={false}
              variant={variant}
              now={now}
              handle={handle}
            />
          )}
        </Sortable>
      ) : (
        <Entry
          key={entry.key}
          entry={entry}
          group={group}
          alone={alone && variant === "card"}
          variant={variant}
          now={now}
        />
      ),
    );
    const section = (handle: ReactNode) => (
      <section className="flex flex-col gap-1">
        {alone && variant === "card" ? null : (
          <h2
            className={cn(
              "flex items-center gap-1.5 font-medium",
              variant === "page" ? "pb-1 text-sm text-foreground" : "text-xs text-muted-foreground",
            )}
          >
            <ProviderLogo
              driver={group.driver}
              label={group.label}
              className={variant === "page" ? "size-4" : "size-3.5"}
            />
            {group.label}
            {handle ? <span className="ms-auto flex">{handle}</span> : null}
          </h2>
        )}
        {variant === "page" ? (
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
            {sortable ? (
              <SortableList
                ids={accountIds}
                onMove={(next) =>
                  onReorder((order) => ({
                    ...order,
                    accounts: { ...order.accounts, [String(group.driver)]: [...next] },
                  }))
                }
              >
                {entries}
              </SortableList>
            ) : (
              entries
            )}
          </div>
        ) : (
          entries
        )}
      </section>
    );
    return sortable ? (
      <Sortable
        key={group.driver}
        id={String(group.driver)}
        label={group.label}
        enabled={groups.length > 1}
      >
        {section}
      </Sortable>
    ) : (
      <div key={group.driver}>{section(null)}</div>
    );
  });
  return (
    <div className={cn("flex flex-col", variant === "page" ? "gap-6" : "gap-2")}>
      {sortable ? (
        <SortableList
          ids={providerIds}
          onMove={(next) => onReorder((order) => ({ ...order, providers: [...next] }))}
        >
          {sections}
        </SortableList>
      ) : (
        sections
      )}
    </div>
  );
}
