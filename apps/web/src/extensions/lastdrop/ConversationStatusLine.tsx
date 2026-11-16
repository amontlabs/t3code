/**
 * Context usage and prompt cache state under the last message (`ChatView.tsx` seam). The cache part shows
 * from 15 minutes before expiry, then "Cache expired" until the next turn.
 */
import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { GaugeIcon, HourglassIcon, TimerOffIcon } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "~/timestampFormat";

import { cacheText, conversationStatus, formatTokens } from "./conversationStatusView";

/** T3's timeline footer, with the status line first while the thread is idle and reports usage. */
export function withConversationStatus(
  footer: ReactNode,
  usage: OrchestrationV2ProviderTurnTokenUsage | null,
  idle: boolean,
): ReactNode {
  if (usage === null || !idle) return footer;
  return (
    <>
      <ConversationStatusLine usage={usage} />
      {footer}
    </>
  );
}

function ConversationStatusLine({
  usage,
}: {
  readonly usage: OrchestrationV2ProviderTurnTokenUsage;
}) {
  const nowMinute = useNowMinute();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const expiresAtMs = usage.promptCacheExpiresAt ? Date.parse(usage.promptCacheExpiresAt) : null;
  // The minute clock alone would flip to "expired" up to a minute late.
  const deadline = deadlineStore(expiresAtMs);
  const expired = useSyncExternalStore(deadline.subscribe, deadline.getSnapshot);
  const minuteMs = Date.parse(`${nowMinute}:00Z`);
  const nowMs = expired && expiresAtMs !== null ? Math.max(minuteMs, expiresAtMs) : minuteMs;
  const status = conversationStatus(usage, nowMs);
  const tokens = formatTokens(status.usedTokens);
  const cache = status.cache;
  const cacheShown = cache?.state === "expired" || cache?.state === "expiring";
  // The cache text already names the token count.
  const context =
    status.maxTokens === null
      ? cacheShown
        ? null
        : `Context ${tokens}`
      : cacheShown
        ? `Context ${status.usedPercent}%`
        : `Context ${status.usedPercent}% · ${tokens} / ${formatTokens(status.maxTokens)}`;
  const at =
    cache === null
      ? ""
      : formatUpcomingTimestamp(new Date(cache.expiresAtMs).toISOString(), timestampFormat, nowMs);

  return (
    <div
      className={cn(
        "mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-1 pb-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0",
        cache?.state === "expired"
          ? "font-medium text-error-foreground"
          : cache?.state === "expiring"
            ? "text-warning-foreground"
            : "text-muted-foreground",
      )}
    >
      {cache?.state === "expired" ? (
        <TimerOffIcon />
      ) : cache?.state === "expiring" ? (
        <HourglassIcon />
      ) : (
        <GaugeIcon />
      )}
      {cache?.state === "expired" ? (
        <span className="min-w-0 truncate">
          {cacheText(cache, at)} · the next message re-reads {tokens} tokens
        </span>
      ) : cache?.state === "expiring" ? (
        <span className="min-w-0 truncate">
          {cacheText(cache, at)} · {tokens} tokens cached
        </span>
      ) : null}
      {cacheShown && context !== null ? <span aria-hidden="true">·</span> : null}
      {context === null ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground">{context}</span>
      )}
    </div>
  );
}
