/**
 * Every Claude query the fork opens carries the runner's variables (`endpoint.ts`), so lastdrop's plugin
 * in that Claude Code answers its Agent types through the fork. Applied around the routing wrapper
 * (`queryRunnerLive.ts`), on every Claude instance (Z.ai and OpenRouter too: the variables pick no
 * account and change no endpoint), and only once the runner routes are bound.
 */
import { runnerEnvironment } from "./endpoint.ts";

interface OpenInput {
  readonly threadId: string;
  readonly options: { readonly env?: Readonly<Record<string, string | undefined>> | undefined };
}

/** The open input with the thread's runner variables in its environment; unchanged while unbound. */
export const withRunnerEnvironment = <I extends OpenInput>(
  input: I,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  variables: (threadId: string) => Record<string, string> | undefined = runnerEnvironment,
): I => {
  const added = variables(input.threadId);
  if (added === undefined) return input;
  // As the SDK reads it: the query's own environment, else the server's.
  const base = input.options.env ?? hostEnvironment;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  return { ...input, options: { ...input.options, env: { ...env, ...added } } };
};
