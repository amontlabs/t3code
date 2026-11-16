/**
 * Context usage as a ring beside the send button (`ChatComposer.tsx` seam), with exact tokens, the
 * auto-compact point and the prompt cache in its tooltip. Reads the thread itself, once it exists on the server.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { useSyncExternalStore } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import {
  useQuietThreadProjection,
  useQuietThreadVisibleTurnItems,
  useThreadShell,
} from "~/state/entities";
import { formatUpcomingTimestamp } from "~/timestampFormat";

import { cacheText, conversationStatus, formatTokens } from "./conversationStatusView";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextRing({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  // A draft's thread has no server detail until its shell arrives.
  const ref = useThreadShell(threadRef) === null ? null : threadRef;
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const items = useQuietThreadVisibleTurnItems(ref);
  const nowMinute = useNowMinute();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const providerThread = projection?.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const usage = latestProviderTurnTokenUsage(
    projection?.providerTurns ?? [],
    projection,
    providerThread,
  );
  const expiresAtMs = usage?.promptCacheExpiresAt ? Date.parse(usage.promptCacheExpiresAt) : null;
  const deadline = deadlineStore(expiresAtMs);
  const expired = useSyncExternalStore(deadline.subscribe, deadline.getSnapshot);
  const snapshot =
    projection === null ? null : deriveLatestContextWindowSnapshot(items, usage, providerThread);
  if (snapshot === null) return null;

  const minuteMs = Date.parse(`${nowMinute}:00Z`);
  const nowMs = expired && expiresAtMs !== null ? Math.max(minuteMs, expiresAtMs) : minuteMs;
  const cache = usage === null ? null : conversationStatus(usage, nowMs).cache;
  const maxTokens =
    snapshot.maxTokens != null && snapshot.maxTokens > 0 ? snapshot.maxTokens : null;
  const used =
    maxTokens === null || snapshot.usedPercentage === null
      ? null
      : Math.round(Math.max(0, Math.min(100, snapshot.usedPercentage)));
  const tone = used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null;
  const tokens = formatTokens(snapshot.usedTokens);
  const threshold = snapshot.autoCompactThreshold ?? null;
  const label = used === null ? `Context: ${tokens} tokens used` : `Context: ${used}% used`;
  const cacheAt =
    cache === null
      ? ""
      : formatUpcomingTimestamp(new Date(cache.expiresAtMs).toISOString(), timestampFormat, nowMs);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={label}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1 rounded-md px-1 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              tone === "error"
                ? "text-error-foreground"
                : tone === "warning"
                  ? "text-warning-foreground"
                  : "text-muted-foreground",
            )}
          >
            <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
              <circle
                cx="8"
                cy="8"
                r={RADIUS}
                fill="none"
                strokeWidth="2"
                className="stroke-current opacity-25"
              />
              {used !== null && used > 0 ? (
                <circle
                  cx="8"
                  cy="8"
                  r={RADIUS}
                  fill="none"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - used / 100)}
                  className="stroke-current"
                />
              ) : null}
            </svg>
            <span>{used === null ? tokens : `${used}%`}</span>
          </div>
        }
      />
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="text-foreground">{label}</span>
          {maxTokens !== null ? (
            <span className="text-muted-foreground">
              {tokens} of {formatTokens(maxTokens)} tokens
            </span>
          ) : null}
          {threshold !== null && threshold > 0 ? (
            <span className="text-muted-foreground">
              Compacts automatically at about {formatTokens(threshold)} tokens
            </span>
          ) : null}
          {cache === null ? null : (
            <span
              className={
                cache.state === "expired"
                  ? "text-error-foreground"
                  : cache.state === "expiring"
                    ? "text-warning-foreground"
                    : "text-muted-foreground"
              }
            >
              {cacheText(cache, cacheAt)}
            </span>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
