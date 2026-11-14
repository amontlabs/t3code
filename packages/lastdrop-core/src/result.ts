/**
 * What Claude Code's `result` event says about the account: a usage limit (move on), a model the plan lacks
 * (another model works), an expired sign-in, or a passing error (retry, then move on).
 *
 * Port of the Claude-account parts of headroom's `SubagentRunner.parse`/`classify` and `Result`. The Z.ai and
 * OpenRouter endpoint rules come with those providers (plan step 6).
 */
import { transientReason } from "./transientError.ts";

export interface ClaudeResult {
  readonly text: string;
  readonly isError: boolean;
  /** Anthropic refused for usage limits; nothing to gain from retrying on the same account. */
  readonly limitReached: boolean;
  /** The plan doesn't include the model ("Fable 5.1 requires usage credits"); another model works. */
  readonly modelUnavailable: boolean;
  /** Failed for a reason no limit or model flag says: here, a 401 (the sign-in expired). */
  readonly unavailable: boolean;
  /** Claude Code's `api_error_status`, when it reported one. */
  readonly apiErrorStatus: number | undefined;
  /** Why the error is a passing one, once `classifyResult` found it is. */
  readonly transient?: string | undefined;
  /** Refused before any work by the caller's own check (never a passing error). */
  readonly refused?: boolean | undefined;
  readonly turns: number;
  readonly permissionDenials: number;
  /** Tool uses seen while it ran; the caller counts them from the stream. */
  readonly toolUses: number;
  readonly durationMs: number;
  /** Input tokens including both cache counts. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Claude Code says "You've hit your session limit" / "weekly limit" / "Opus limit", not only "your limit". */
export function mentionsLimit(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("usage limit") ||
    t.includes("limit reached") ||
    t.includes("rate limit") ||
    /hit your (\w+ )?limit/u.test(t)
  );
}

export function modelUnavailable(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("switch to another model") ||
    t.includes("requires usage credits") ||
    t.includes("not available on your plan")
  );
}

/** Claude Code's result event (`--output-format json`, the last stream-json line, or the SDK's result). */
export function parseClaudeResult(root: Readonly<Record<string, unknown>>): ClaudeResult {
  const num = (value: unknown) => (typeof value === "number" ? value : undefined);
  const text = typeof root["result"] === "string" ? root["result"] : "";
  const isError = root["is_error"] === true;
  const statusValue = num(root["api_error_status"]);
  const status = statusValue === undefined ? undefined : Math.trunc(statusValue);
  const model = isError && modelUnavailable(text);
  const limit =
    isError &&
    !model &&
    (status === 429 || root["api_error"] === "usage_limit_reached" || mentionsLimit(text));
  const usage = isRecord(root["usage"]) ? root["usage"] : {};
  const count = (key: string) => num(usage[key]) ?? 0;
  const cacheRead = count("cache_read_input_tokens");
  const cacheCreation = count("cache_creation_input_tokens");
  return {
    text,
    isError,
    limitReached: limit,
    modelUnavailable: model,
    // A Claude account whose sign-in expired can't take the run, but another model or provider may.
    unavailable: isError && status === 401,
    apiErrorStatus: status,
    turns: Math.trunc(num(root["num_turns"]) ?? 0),
    permissionDenials: Array.isArray(root["permission_denials"])
      ? root["permission_denials"].length
      : 0,
    toolUses: 0,
    durationMs: Math.trunc(num(root["duration_ms"]) ?? 0),
    inputTokens: Math.trunc(count("input_tokens") + cacheRead + cacheCreation),
    outputTokens: Math.trunc(count("output_tokens")),
    cacheReadInputTokens: Math.trunc(cacheRead),
    cacheCreationInputTokens: Math.trunc(cacheCreation),
  };
}

/**
 * Marks a failed result whose error is a passing one (`transientReason`). A usage limit, a model the plan
 * lacks, or a refusal by the run's own check is never one. `signInWorks` is asked only for an
 * authentication failure.
 */
export function classifyResult(result: ClaudeResult, signInWorks: () => boolean): ClaudeResult {
  if (!result.isError || result.limitReached || result.modelUnavailable || result.refused)
    return result;
  const reason = transientReason(result.text, result.apiErrorStatus, signInWorks);
  if (reason === undefined) return result;
  // Not a sign-in to fix.
  return { ...result, transient: reason, unavailable: false };
}

/**
 * Failed with nothing done, because the account or model couldn't take it, or kept failing with a passing
 * error: what a fallback is for. Anything after a tool use, and any other error, is not.
 */
export function failedToStart(r: ClaudeResult): boolean {
  return (
    r.isError &&
    r.toolUses === 0 &&
    (r.unavailable || r.limitReached || r.modelUnavailable || r.transient !== undefined)
  );
}

/** The error is one the work should be handed on for, as at a usage limit, once retries are spent. */
export function handsOn(r: ClaudeResult): boolean {
  return r.limitReached || r.transient !== undefined;
}
