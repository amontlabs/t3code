/**
 * A lastdrop agent's own icon and color on its subagent cards (`V2LifecycleRow.tsx`,
 * `TimelineV2EventRow.tsx`), and the chain entry it runs on in the card's hover
 * (`SubagentTooltipContent.tsx`). Any other subagent keeps T3's provider avatar.
 */
import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
} from "@t3tools/contracts";
import {
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  BugIcon,
  CodeIcon,
  CompassIcon,
  CornerDownRightIcon,
  CpuIcon,
  DatabaseIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GaugeIcon,
  GitBranchIcon,
  LayersIcon,
  HammerIcon,
  LightbulbIcon,
  ListChecksIcon,
  LockIcon,
  MousePointerIcon,
  PaletteIcon,
  PenLineIcon,
  PuzzleIcon,
  RocketIcon,
  ScaleIcon,
  SearchIcon,
  ShieldIcon,
  FlameIcon,
  TargetIcon,
  TelescopeIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  EyeIcon,
  type LucideIcon,
} from "lucide-react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";

import {
  LASTDROP_AGENT_COLORS,
  lastdropAgentLook,
  lastdropAgentRunningEntry,
  type LastdropAgentColor,
  type LastdropAgentIcon,
} from "./agentLook";

export const AGENT_ICON_COMPONENTS: Readonly<Record<LastdropAgentIcon, LucideIcon>> = {
  bot: BotIcon,
  eye: EyeIcon,
  hammer: HammerIcon,
  wrench: WrenchIcon,
  scale: ScaleIcon,
  search: SearchIcon,
  telescope: TelescopeIcon,
  compass: CompassIcon,
  bug: BugIcon,
  zap: ZapIcon,
  shield: ShieldIcon,
  lock: LockIcon,
  "mouse-pointer": MousePointerIcon,
  brain: BrainIcon,
  lightbulb: LightbulbIcon,
  flame: FlameIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  cpu: CpuIcon,
  database: DatabaseIcon,
  "git-branch": GitBranchIcon,
  layers: LayersIcon,
  "file-text": FileTextIcon,
  "list-checks": ListChecksIcon,
  "book-open": BookOpenIcon,
  "pen-line": PenLineIcon,
  "flask-conical": FlaskConicalIcon,
  rocket: RocketIcon,
  target: TargetIcon,
  gauge: GaugeIcon,
  palette: PaletteIcon,
  puzzle: PuzzleIcon,
};

const LASTDROP_AGENTS = "lastdropAgents";

/** The agent's icon on its color, or on T3's muted circle when it has no color. */
export function AgentGlyph(props: {
  readonly icon: LastdropAgentIcon | null;
  readonly color: string | null;
  readonly className?: string;
  readonly iconClassName?: string;
}) {
  const Icon = AGENT_ICON_COMPONENTS[props.icon ?? "bot"];
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        props.color === null
          ? "border border-border/70 bg-muted text-muted-foreground"
          : "text-white",
        props.className,
      )}
      style={props.color === null ? undefined : { backgroundColor: props.color }}
    >
      <Icon className={cn("size-3.5", props.iconClassName)} />
    </span>
  );
}

/**
 * `icon|color` of the agent `model` names on a `lastdropAgents` instance (a delegated task's record
 * keeps the agent's name as its model), or null for any other subagent or an agent with neither.
 * A string, so provider pushes that change nothing here don't re-render the card.
 */
export function useLastdropAgentLookKey(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  model: string | null | undefined,
): string | null {
  return useAtomValue(serverEnvironment.providersValueAtom(environmentId), (providers) => {
    if (model == null) return null;
    const provider = providers?.find((candidate) => candidate.instanceId === providerInstanceId);
    if (provider?.driver !== LASTDROP_AGENTS) return null;
    const look = lastdropAgentLook(provider.models.find((candidate) => candidate.slug === model));
    if (look === null || (look.icon === null && look.color === null)) return null;
    return `${look.icon ?? ""}|${look.color ?? ""}`;
  });
}

/** The card's avatar for an agent with a look (`useLastdropAgentLookKey`), with T3's status dot. */
export function LastdropSubagentAvatar(props: {
  readonly lookKey: string;
  readonly dotClass: string | undefined;
}) {
  const [icon, color] = props.lookKey.split("|");
  return (
    <span className="relative inline-flex shrink-0 ring-2 ring-background rounded-full">
      <AgentGlyph
        icon={(icon || null) as LastdropAgentIcon | null}
        color={color || null}
        className="size-6"
      />
      {props.dotClass === undefined ? null : (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
            props.dotClass,
          )}
        />
      )}
    </span>
  );
}

/** The chain entry an agent thread runs on, with its provider and the model's name there. */
function runningEntry(input: {
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string | null | undefined;
  readonly threadId: string | null | undefined;
}) {
  const agents = input.providers?.find(
    (provider) => provider.instanceId === input.providerInstanceId,
  );
  if (agents?.driver !== LASTDROP_AGENTS || input.model == null) return null;
  const look = lastdropAgentLook(agents.models.find((model) => model.slug === input.model));
  const running = look === null ? null : lastdropAgentRunningEntry(look, input.threadId);
  if (look === null || running === null) return null;
  const { index, entry } = running;
  const provider = input.providers?.find((candidate) => candidate.instanceId === entry.instanceId);
  const providerModel = provider?.models.find(
    (candidate) => candidate.slug === entry.model || candidate.aliases?.includes(entry.model),
  );
  return {
    look,
    index,
    entry,
    provider,
    modelName: providerModel?.name ?? entry.model,
    providerName: provider?.displayName ?? entry.instanceId,
    /** "fallback 1 of 2" past the first entry, else null. */
    fallback: index > 0 ? `fallback ${index} of ${look.chain.length - 1}` : null,
  };
}

function EntryProviderIcon(props: { readonly provider: ServerProvider | undefined }) {
  return props.provider ? (
    <ProviderInstanceIcon
      driverKind={props.provider.driver}
      displayName={props.provider.displayName ?? props.provider.driver}
      acpRegistryIconUrl={props.provider.iconUrl}
      iconClassName="size-3 shrink-0"
    />
  ) : null;
}

/**
 * In a lastdrop agent's hover: the chain entry the child thread runs on, its provider and model,
 * and which fallback it is when it isn't the first. Nothing for any other subagent.
 */
export function LastdropAgentHoverRow(props: {
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model?: string | null | undefined;
  readonly threadId?: string | null | undefined;
}) {
  const running = runningEntry({
    providers: props.providers,
    providerInstanceId: props.providerInstanceId,
    model: props.model,
    threadId: props.threadId,
  });
  if (running === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
      <EntryProviderIcon provider={running.provider} />
      <span className="min-w-0 truncate text-foreground/75">
        {running.modelName}
        {running.entry.effort ? ` · ${running.entry.effort}` : ""}
        <span className="text-muted-foreground">
          {` on ${running.providerName}`}
          {running.fallback === null ? "" : ` · ${running.fallback}`}
        </span>
      </span>
    </div>
  );
}

/**
 * The composer's model trigger on a lastdrop agent (`ComposerControlsBar.tsx` seam): the agent's
 * icon before its name, then the model its thread runs on and the effort, smaller. Nothing to
 * override on any other model. A thread not yet started names the agent's first entry.
 */
export function useLastdropAgentTrigger(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly effortSuffix: ReactNode;
}): { readonly triggerIcon?: ReactNode; readonly triggerSuffix?: ReactNode } {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(input.environmentId));
  const running = runningEntry({
    providers: providers ?? undefined,
    providerInstanceId: input.instanceId,
    model: input.model,
    threadId: input.threadRef?.threadId,
  });
  if (running === null) return {};
  const { look } = running;
  return {
    ...(look.icon === null && look.color === null
      ? {}
      : {
          triggerIcon: (
            <AgentGlyph
              icon={look.icon}
              color={look.color}
              className="size-4"
              iconClassName="size-2.5"
            />
          ),
        }),
    triggerSuffix: (
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground group-hover/model-trigger:text-foreground">
        <span className="truncate">{running.modelName}</span>
        {input.effortSuffix === null ? null : (
          <>
            <span aria-hidden>·</span>
            {input.effortSuffix}
          </>
        )}
      </span>
    ),
  };
}

/** The colors the editor offers, in order. */
export const AGENT_COLOR_CHOICES = Object.entries(LASTDROP_AGENT_COLORS) as ReadonlyArray<
  readonly [LastdropAgentColor, string]
>;
